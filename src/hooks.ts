import { getString, getLocaleID, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { getPref, setPref } from "./utils/prefs";
import {
  ensureGhostscript,
  type CompressOptions,
  type Preset,
} from "./modules/compressor";
import {
  formatFailures,
  pickPdfAttachments,
  runBatch,
  type BatchSummary,
} from "./modules/batch";

// ============================================================================
// 插件装配层（工单 03/07/08/09）
// 编排逻辑在 src/modules/batch.ts（可测试），这里只负责 UI 与生命周期。
// 目标环境：Zotero 9.0.6。
// ============================================================================

const MENU_ID = "pdf-compress";
const PREFS_PANE_ID = "pdfcompress-prefpane";

/** 从首选项读出当前压缩选项。 */
function getCompressOptions(): CompressOptions {
  const mode = getPref("attachmentMode") === "copy" ? "copy" : "overwrite";
  // gainThreshold 以字符串存储（浮点 pref 在部分系统上有 4 字节限制）
  const threshold = Number.parseFloat(String(getPref("gainThreshold")));
  return {
    mode,
    gainThreshold:
      Number.isFinite(threshold) && threshold > 0 && threshold <= 1
        ? threshold
        : 0.98,
  };
}

/**
 * 执行一批压缩（UI 层）。
 * 编排与汇总见 batch.ts；本函数只负责进度窗口与结果提示。
 */
async function runCompression(items: any[], preset: Preset): Promise<void> {
  const options = getCompressOptions();
  const presetLabel = preset === "balanced" ? "均衡" : "激进";
  const showResult = getPref("showResultWindow") !== false;
  const autoCloseReader = getPref("autoCloseReader") !== false;

  const win = new ztoolkit.ProgressWindow(`压缩 PDF — ${presetLabel}`, {
    closeOnClick: true,
    closeTime: -1,
  });
  win
    .createLine({ text: "正在准备 Ghostscript…", type: "default", progress: 0 })
    .show();

  let gsRoot: string;
  try {
    const rootURI = await (Zotero as any).Plugins.getRootURI(
      addon.data.config.addonID,
    );
    gsRoot = await ensureGhostscript(rootURI);
  } catch (e: any) {
    win.changeLine({
      text: `Ghostscript 准备失败：${e?.message || e}`,
      type: "fail",
      progress: 100,
    });
    win.startCloseTimer(8000);
    return;
  }

  let summary: BatchSummary;
  try {
    summary = await runBatch(items, preset, gsRoot, options, {
      autoCloseReader,
      onStep: (text, progress) =>
        win.changeLine({ text, type: "default", progress }),
      log: (msg, err) => ztoolkit.log(msg, err),
    });
  } catch (e: any) {
    win.changeLine({
      text: `压缩失败：${e?.message || e}`,
      type: "fail",
      progress: 100,
    });
    win.startCloseTimer(8000);
    return;
  }

  if (!summary.total) {
    win.close();
    return;
  }

  if (showResult) {
    win.changeLine({
      text: summary.lines.join("　"),
      type: summary.failed.length ? "fail" : "success",
      progress: 100,
    });
    // 提示自动消失，不常驻
    win.startCloseTimer(summary.failed.length ? 10000 : 4000);
  } else {
    win.close();
  }

  // 失败详情仍然弹出（这是需要用户知晓的异常，不随提示开关关闭）
  if (summary.failed.length) {
    Services.prompt.alert(
      Zotero.getMainWindow() as any,
      `压缩失败 ${summary.failed.length} 个`,
      formatFailures(summary.failed),
    );
  }

  ztoolkit.log("[compress] summary", summary);
}

/**
 * 注册右键菜单。用官方 Zotero.MenuManager（工单 03 已验证）。
 * 结构：压缩 PDF ▸ 均衡压缩 / 激进压缩
 */
async function registerContextMenu(): Promise<void> {
  const menuManager = (Zotero as any).MenuManager;
  // 注意：getRootURI 是 async（工单 03 发现的坑）
  const rootURI = await Zotero.Plugins.getRootURI(addon.data.config.addonID);

  if (!menuManager?.registerMenu) {
    addon.data.protoError = "Zotero.MenuManager 不可用";
    return;
  }

  // registerMenu 返回内部使用的 mainKey（= CSS.escape(`${pluginID}-${menuID}`)），
  // 注销时必须原样传回。不要手写拼接：pluginID 里的 '@' 等字符会被 CSS.escape
  // 转义（pdfcompress@local → pdfcompress\@local），手写必然对不上（实测踩到）。
  const registeredKey = menuManager.registerMenu({
    menuID: MENU_ID,
    pluginID: addon.data.config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "submenu",
        l10nID: getLocaleID("compress-menu"),
        icon: `${rootURI}content/icons/favicon@0.5x.png`,
        onShowing: (_event: any, context: any) => {
          const pdfs = pickPdfAttachments(context?.items);
          context?.setEnabled?.(pdfs.length > 0);
          context?.setVisible?.(pdfs.length > 0);
        },
        menus: [
          {
            menuType: "menuitem",
            l10nID: getLocaleID("compress-balanced"),
            onCommand: async (_event: any, context: any) => {
              await runCompression(context?.items, "balanced");
            },
          },
          {
            menuType: "menuitem",
            l10nID: getLocaleID("compress-aggressive"),
            onCommand: async (_event: any, context: any) => {
              await runCompression(context?.items, "aggressive");
            },
          },
        ],
      },
    ],
  });
  if (typeof registeredKey === "string") {
    addon.data.registeredMenuKey = registeredKey;
  }
  addon.data.protoMenuMode = "MenuManager";
}

/**
 * 注册设置面板（Zotero 9 的 Zotero.PreferencePanes.register）。
 * 插件卸载/关闭时会自动注销。
 */
async function registerPrefsPane(): Promise<void> {
  const panes = (Zotero as any).PreferencePanes;
  if (!panes?.register) {
    ztoolkit.log("[compress] Zotero.PreferencePanes 不可用，跳过设置面板");
    return;
  }
  const rootURI = await Zotero.Plugins.getRootURI(addon.data.config.addonID);
  await panes.register({
    pluginID: addon.data.config.addonID,
    id: PREFS_PANE_ID,
    src: `${rootURI}content/preferences.xhtml`,
    // 面板标签；不提供则用插件名
    label: "PDF 压缩",
  });
  ztoolkit.log("[compress] 设置面板已注册");
}

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  try {
    await registerPrefsPane();
  } catch (e: any) {
    ztoolkit.log("[compress] registerPrefsPane threw", e?.message || e);
  }

  // 主窗口通常先于插件加载完成，须显式遍历（工单 03 发现的坑）
  await Promise.all(
    Zotero.getMainWindows().map((w: any) => onMainWindowLoad(w)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  // 必须把插件的 FTL 链接进主窗口 DOM，否则 MenuManager 设置的
  // data-l10n-id 解析不出文字，菜单项会显示为空白（实测踩到）。
  // 文件名由构建器按 namespace 重命名：addon.ftl → <addonRef>-addon.ftl
  try {
    (win as any).MozXULElement.insertFTLIfNeeded(
      `${addon.data.config.addonRef}-addon.ftl`,
    );
  } catch (e: any) {
    ztoolkit.log("[compress] insertFTLIfNeeded failed", e?.message || e);
  }

  try {
    await registerContextMenu();
  } catch (e: any) {
    addon.data.protoError = `registerContextMenu threw: ${e?.message || e}`;
    ztoolkit.log("[compress] registerContextMenu threw", e);
  }
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  try {
    // 用注册时拿到的 key 原样注销（registerMenu 的返回值）。
    // 见 registerContextMenu 里的说明：手写拼接对不上。
    const key = addon.data.registeredMenuKey;
    if (key) {
      (Zotero as any).MenuManager?.unregisterMenu?.(key);
    }
  } catch (e) {
    ztoolkit.log("[compress] unregisterMenu failed", e);
  }
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};