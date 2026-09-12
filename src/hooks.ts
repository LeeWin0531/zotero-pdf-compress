import { getString, getLocaleID, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { getPref, setPref } from "./utils/prefs";
import {
  compressAttachment,
  ensureGhostscript,
  type CompressResult,
  type CompressOptions,
  type Preset,
} from "./modules/compressor";

// ============================================================================
// 原型（工单 03 集成验证 + 工单 06 压缩核心 + 工单 09 设置面板）
// 目标环境：Zotero 9.0.6。
// ============================================================================

const MENU_ID = "pdf-compress";
const PREFS_PANE_ID = "pdfcompress-prefpane";

/** 从右键上下文中挑出 PDF 附件。 */
function pickPdfAttachments(items: any[]): any[] {
  return (items || []).filter(
    (it) =>
      it &&
      typeof it.isFileAttachment === "function" &&
      it.isFileAttachment() &&
      it.attachmentContentType === "application/pdf",
  );
}

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

/** 关闭正在阅读器中打开该附件的 reader（Windows 下会锁定文件，Q28）。 */
async function closeReadersFor(itemIDs: number[]): Promise<void> {
  const readers: any[] = (Zotero as any).Reader?._readers || [];
  for (const reader of readers) {
    try {
      if (itemIDs.includes(reader.itemID)) {
        await reader.close();
      }
    } catch (e) {
      ztoolkit.log("[compress] 关闭阅读器失败", e);
    }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 执行一批压缩，串行处理（Q21）。
 * 结果提示是否弹出由设置 `showResultWindow` 控制（默认开）。
 * 过程反馈用 Zotero 自带进度条，不用常驻的 ProgressWindow，避免挡阅读。
 */
async function runCompression(items: any[], preset: Preset): Promise<void> {
  const pdfs = pickPdfAttachments(items);
  if (!pdfs.length) return;

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

  if (autoCloseReader) {
    await closeReadersFor(pdfs.map((p) => p.id));
  }

  const results: CompressResult[] = [];
  let totalIn = 0;
  let totalOut = 0;

  for (let i = 0; i < pdfs.length; i++) {
    const item = pdfs[i];
    const title = item.getField?.("title") || `#${item.id}`;
    win.changeLine({
      text: `[${i + 1}/${pdfs.length}] ${title}`,
      type: "default",
      progress: Math.round((i / pdfs.length) * 100),
    });

    const r = await compressAttachment(item, preset, gsRoot, options);
    results.push(r);
    if (r.status === "ok" && r.inSize && r.outSize) {
      totalIn += r.inSize;
      totalOut += r.outSize;
    }
  }

  const ok = results.filter((r) => r.status === "ok");
  const noGain = results.filter((r) => r.status === "no-gain");
  const failed = results.filter((r) => r.status === "failed");

  const lines: string[] = [`成功压缩：${ok.length} 个`];
  if (ok.length) {
    lines.push(
      `节省：${formatBytes(totalIn - totalOut)}（${formatBytes(totalIn)} → ${formatBytes(totalOut)}）`,
    );
  }
  if (noGain.length) lines.push(`无收益（保留原文件）：${noGain.length} 个`);
  if (failed.length) lines.push(`失败：${failed.length} 个`);

  if (showResult) {
    win.changeLine({
      text: lines.join("　"),
      type: failed.length ? "fail" : "success",
      progress: 100,
    });
    // 提示自动消失，不常驻
    win.startCloseTimer(failed.length ? 10000 : 4000);
  } else {
    win.close();
  }

  // 失败详情仍然弹出（这是需要用户知晓的异常，不随提示开关关闭）
  if (failed.length) {
    const detail = failed
      .map((r) => `• ${r.title}\n  ${r.reason}: ${r.message || ""}`)
      .join("\n\n");
    Services.prompt.alert(
      Zotero.getMainWindow() as any,
      `压缩失败 ${failed.length} 个`,
      detail,
    );
  }

  ztoolkit.log("[compress] results", results);
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

  menuManager.registerMenu({
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
    (Zotero as any).MenuManager?.unregisterMenu?.(MENU_ID);
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