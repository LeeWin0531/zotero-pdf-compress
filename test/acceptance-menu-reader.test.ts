declare const assert: any;
import { config } from "../package.json";
import { ensureGhostscript } from "../src/modules/compressor";
import { closeReadersFor } from "../src/modules/batch";

// 工单 10 验收清单补充：
//  AC1 菜单注册/卸载干净性
//  AC5 阅读器占用实测（真实打开 reader 后压缩能自动关闭）

const LOG = "C:\\Users\\lwh\\AppData\\Local\\Temp\\pdfcompress-ac15.log";
const PAPER = "C:\\Users\\lwh\\AppData\\Local\\Temp\\gsfixtures\\paper.pdf";
const LINES: string[] = [];
function log(s: string) {
  LINES.push(String(s));
}
async function flush() {
  try {
    await (Zotero as any).File.putContentsAsync(LOG, LINES.join("\n"));
  } catch {
    /* ignore */
  }
}
const IOUtils: any = (globalThis as any).IOUtils;

describe("工单10 验收：菜单与阅读器", function () {
  this.timeout(300000);

  afterEach(async function () {
    await flush();
  });

  it("AC1 菜单已注册：子菜单与两个预设项都在，标签为中文", async function () {
    const win: any = Zotero.getMainWindow();
    const doc = win.document;
    const popup = doc.getElementById("zotero-itemmenu");
    assert.ok(popup, "找不到 zotero-itemmenu");

    // 用官方入口真实构建菜单（直接 dispatch popupshowing 拿不到，
    // 因为 MenuManager 是在 updateMenuPopup 里 append 自定义项的）
    const MM = (Zotero as any).MenuManager;
    const att = await Zotero.Attachments.importFromFile({
      file: PAPER,
      libraryID: Zotero.Libraries.userLibraryID,
      title: "菜单测试",
    } as any);
    const fakeEvent = new win.Event("popupshowing");
    MM.updateMenuPopup(popup, "main/library/item", {
      event: fakeEvent,
      getContext: () => ({ items: [att], tabType: "library" }),
    });
    await Zotero.Promise.delay(300);

    const customs = popup.querySelectorAll(".zotero-custom-menu-item");
    log("自定义菜单项数 = " + customs.length);
    customs.forEach((c: any, i: number) => {
      log(
        `[${i}] tag=${c.tagName} l10n=${c.dataset?.l10nId} label="${c.getAttribute?.("label") || ""}"`,
      );
    });

    // 找到我们的子菜单
    let submenu: any = null;
    for (const c of customs) {
      if (String(c.dataset?.l10nId || "").includes("compress-menu")) {
        submenu = c;
      }
    }
    log("找到压缩子菜单 = " + !!submenu);
    assert.ok(submenu, "未注册压缩子菜单");
    assert.equal(
      submenu.getAttribute("label"),
      "压缩 PDF",
      "子菜单标签不是「压缩 PDF」",
    );

    // 展开子菜单，检查两个预设项（子菜单在 popupshowing 时填充）
    const sub = submenu.querySelector("& > menupopup");
    assert.ok(sub, "子菜单没有 menupopup");
    sub.dispatchEvent(new win.Event("popupshowing", { bubbles: true }));
    await Zotero.Promise.delay(300);

    const labels: string[] = [];
    for (const ch of sub.children) {
      const l = ch.getAttribute?.("label") || "";
      const id = ch.dataset?.l10nId || "";
      if (id.includes("compress-")) labels.push(l);
    }
    log("预设项标签 = " + JSON.stringify(labels));
    assert.include(labels, "均衡压缩", "缺少「均衡压缩」");
    assert.include(labels, "激进压缩", "缺少「激进压缩」");
    log("AC1 菜单结构正确");

    await Zotero.Items.trashTx([att.id]);
  });

  it("AC1 卸载干净：unregisterMenu 用命名空间 key 后菜单消失", async function () {
    const win: any = Zotero.getMainWindow();
    const popup = win.document.getElementById("zotero-itemmenu");
    const MM = (Zotero as any).MenuManager;

    // MenuManager 内部把 menuID 存成 CSS.escape(`${pluginID}-${menuID}`)，
    // 因此必须用 registerMenu 返回的 key 注销。插件在 registerContextMenu
    // 里把该 key 记在 addon.data.registeredMenuKey，onShutdown 用它注销。
    const pluginData = (Zotero as any)[config.addonInstance].data;
    const key = pluginData.registeredMenuKey;
    log("插件记录的 registeredMenuKey = " + JSON.stringify(key));
    assert.isString(key, "插件未记录注册 key（卸载将无法移除菜单）");
    assert.isTrue(key.includes("pdf-compress"), "注册 key 不含 menuID");

    const ok = MM.unregisterMenu(key);
    log("unregisterMenu(" + key + ") 返回 = " + ok);
    assert.isTrue(ok, "unregisterMenu 返回 false（key 不对）");
    MM.updateMenuPopup(popup, "main/library/item", {});
    await Zotero.Promise.delay(200);

    const remaining: string[] = [];
    for (const c of popup.querySelectorAll(".zotero-custom-menu-item")) {
      remaining.push(String((c as any).dataset?.l10nId || ""));
    }
    log("卸载后剩余自定义项 l10n id = " + JSON.stringify(remaining));
    assert.isFalse(
      remaining.some((id) => id.includes("compress-menu")),
      "卸载后本插件菜单仍残留（onShutdown 的 unregisterMenu key 可能不对）",
    );
    log("AC1 卸载干净（本插件菜单已移除）");
  });

  it("AC5 阅读器占用：真实打开 PDF 后能自动关闭该 reader", async function () {
    const att = await Zotero.Attachments.importFromFile({
      file: PAPER,
      libraryID: Zotero.Libraries.userLibraryID,
      title: "阅读器占用测试",
    } as any);
    log("附件 id = " + att.id);

    // 真实打开阅读器
    await (Zotero as any).Reader.open(att.id);
    await Zotero.Promise.delay(2500);

    const readers: any[] = (Zotero as any).Reader?._readers || [];
    const mine = readers.filter((r) => r.itemID === att.id);
    log("匹配的已打开 reader 数 = " + mine.length);
    log("全部 reader itemID = " + JSON.stringify(readers.map((r) => r.itemID)));
    assert.isAtLeast(mine.length, 1, "阅读器未能打开，无法验证占用");

    // 调用插件的关闭逻辑
    const closed = await closeReadersFor([att.id]);
    await Zotero.Promise.delay(1500);
    log("closeReadersFor 关闭数量 = " + closed);

    const after: any[] = (Zotero as any).Reader?._readers || [];
    const stillOpen = after.filter((r) => r.itemID === att.id);
    log("关闭后仍打开的匹配 reader = " + stillOpen.length);
    assert.equal(stillOpen.length, 0, "阅读器未被关闭（文件仍被占用）");

    // 关闭后应能正常压缩（文件不再被锁）
    const gsRoot = await ensureGhostscript(
      await (Zotero as any).Plugins.getRootURI(config.addonID),
    );
    const { compressAttachment } = await import("../src/modules/compressor");
    const path = await att.getFilePathAsync();
    const sizeBefore = (await IOUtils.stat(path)).size;
    const r = await compressAttachment(att, "balanced", gsRoot);
    log("关闭阅读器后压缩 = " + JSON.stringify(r));
    assert.equal(r.status, "ok", "关闭阅读器后仍无法压缩");
    assert.isBelow((await IOUtils.stat(path)).size, sizeBefore);
    log("AC5 阅读器占用处理正确");

    await Zotero.Items.trashTx([att.id]);
  });
});
