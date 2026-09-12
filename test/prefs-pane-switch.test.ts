declare const assert: any;
import { config } from "../package.json";

// 验证设置面板切换：真实打开 preferences 窗口 → 选中本插件 pane → 断言它可见且其它 pane 被隐藏。
// 对应 bug：点了设置项仍显示上一个面板（根因是 preferences.xhtml 的 XML 声明使解析失败）。
const LOG = "C:\\Users\\lwh\\AppData\\Local\\Temp\\pdfcompress-pane-switch.log";
const LINES: string[] = [];
function log(s: string) {
  LINES.push(String(s));
}

async function flush() {
  try {
    await (Zotero as any).File.putContentsAsync(LOG, LINES.join("\n"));
  } catch (e: any) {
    try {
      (Zotero as any).logError(e);
    } catch {
      /* ignore */
    }
  }
}

async function openPrefs(): Promise<any> {
  let w = Services.wm.getMostRecentWindow("zotero:pref");
  if (w) return w;
  const main = Zotero.getMainWindow() as any;
  main.openDialog(
    "chrome://zotero/content/preferences/preferences.xhtml",
    "zotero-prefs",
    "chrome,titlebar,toolbar,centerscreen,resizable=yes",
  );
  for (let i = 0; i < 100; i++) {
    await Zotero.Promise.delay(100);
    w = Services.wm.getMostRecentWindow("zotero:pref");
    if (w?.Zotero_Preferences?.panes?.size) return w;
  }
  throw new Error("preferences 窗口未打开");
}

describe("验证：设置面板能正确切换", function () {
  this.timeout(120000);

  it("选中本插件 pane 后显示其内容、隐藏其它 pane", async function () {
    const problems: string[] = [];
    try {
      log("=== 开始 ===");
      const prefsWin: any = await openPrefs();
      log("preferences 窗口已打开");
      const P = prefsWin.Zotero_Preferences;

      let id: string | null = null;
      for (const [k, v] of P.panes) {
        if (v.pluginID === config.addonID) id = k;
      }
      log("本插件 pane id = " + id);
      if (!id) problems.push("panes 里找不到本插件 pane");

      if (id) {
        // 走官方导航 API —— 等价于用户点击侧栏项
        await P.navigateToPane(id);
        await Zotero.Promise.delay(500);

        const pane = P.panes.get(id);
        log("loaded = " + pane.loaded);
        log("container.hidden = " + pane.container.hidden);
        log("container 子元素数 = " + pane.container.children.length);

        const root = pane.container.querySelector("#pdfcompress-prefpane");
        log("根元素 #pdfcompress-prefpane 存在 = " + !!root);
        if (!root) {
          problems.push("面板根元素不存在（解析失败）");
        } else {
          log("根元素子控件数 = " + root.children.length);
          const l10n = root.querySelectorAll("[data-l10n-id]");
          log("带 data-l10n-id 的控件数 = " + l10n.length);
          const sample =
            root.querySelector("radio[data-l10n-id]")?.getAttribute("label") ||
            root.querySelector("radio[data-l10n-id]")?.textContent ||
            "";
          log("示例 radio 文本 = " + JSON.stringify(sample));
          if (!sample) problems.push("l10n 标签为空");
        }

        if (pane.container.hidden) problems.push("本面板仍不可见");

        const others: string[] = [];
        for (const [k, v] of P.panes) {
          if (k !== id && !v.container.hidden) others.push(String(k));
        }
        log("仍可见的其它 pane = " + JSON.stringify(others));
        if (others.length) problems.push("其它面板未隐藏: " + others.join(", "));
      }

      prefsWin.close();
    } catch (e: any) {
      log("THREW: " + (e?.message || String(e)));
      log("STACK: " + (e?.stack || ""));
      problems.push("抛异常: " + (e?.message || String(e)));
    }
    log("problems = " + JSON.stringify(problems));
    await flush();
    assert.deepEqual(problems, [], "面板切换问题：" + problems.join(" | "));
  });
});
