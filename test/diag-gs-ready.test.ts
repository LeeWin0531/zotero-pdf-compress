declare const assert: any;
import { config } from "../package.json";
import { ensureGhostscript } from "../src/modules/compressor";

// 诊断：ensureGhostscript 是否把「残缺的 Ghostscript 目录」误判为已就绪？
// 背景：用户的临时目录只剩 53/531 个文件（缺 lib/、iccprofiles/、Resource/Font
// 等），但 bin/gswin64c.exe 还在，于是完整性检查通过、永不重新解包。
const LOG = "C:\\Users\\lwh\\AppData\\Local\\Temp\\pdfcompress-diag-gs.log";
const LINES: string[] = [];
function log(s: string) {
  LINES.push(String(s));
}

describe("诊断：Ghostscript 就绪判定", function () {
  this.timeout(120000);

  it("检查 ensureGhostscript 返回的目录是否真的可用", async function () {
    const IOUtils: any = (globalThis as any).IOUtils;
    const PathUtils: any = (globalThis as any).PathUtils;
    try {
      const rootURI = await (Zotero as any).Plugins.getRootURI(config.addonID);
      log("rootURI = " + rootURI);

      const gsRoot = await ensureGhostscript(rootURI);
      log("ensureGhostscript 返回 = " + gsRoot);

      // 该目录实际有多少文件？
      const target = PathUtils.join(PathUtils.tempDir, "pdf-compress-gs");
      log("预期目录 = " + target);
      log("返回目录 == 预期目录 ? " + (gsRoot === target));

      // 数一下实际文件数
      let count = 0;
      const walk = async (dir: string) => {
        let children: string[] = [];
        try {
          children = await IOUtils.getChildren(dir);
        } catch {
          return;
        }
        for (const c of children) {
          const st = await IOUtils.stat(c);
          if (st.type === "directory") await walk(c);
          else count++;
        }
      };
      await walk(target);
      log("实际文件数 = " + count + "（完整应为 531）");

      // 关键文件是否存在
      const critical = [
        "bin/gswin64c.exe",
        "lib/Fontmap",
        "Resource/Init/gs_init.ps",
        "Resource/Font",
        "iccprofiles",
      ];
      for (const rel of critical) {
        const p = PathUtils.join(target, ...rel.split("/"));
        log(`  ${rel} 存在 = ` + (await IOUtils.exists(p)));
      }

      // lib 目录下的文件数（应为 220）
      let libCount = 0;
      try {
        const libs = await IOUtils.getChildren(PathUtils.join(target, "lib"));
        libCount = libs.length;
      } catch (e: any) {
        log("  读取 lib/ 失败: " + (e?.message || e));
      }
      log("lib/ 条目数 = " + libCount + "（完整应为 220）");

      log("");
      log("结论：若 exe 存在但 lib/ 为空 → ensureGhostscript 误判为已就绪");
    } catch (e: any) {
      log("FAILED: " + (e?.message || e) + "\n" + (e?.stack || ""));
    }
    await (Zotero as any).File.putContentsAsync(LOG, LINES.join("\n"));
    assert.ok(true);
  });
});