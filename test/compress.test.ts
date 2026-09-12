declare const assert: any;
import { config } from "../package.json";
import { compressAttachment, ensureGhostscript } from "../src/modules/compressor";

// 工单 06：压缩核心端到端验证。
// 运行：ZOTERO_PLUGIN_ZOTERO_BIN_PATH=F:\zotero7\zotero.exe npx zotero-plugin test --exit-on-finish

const SAMPLE =
  "C:\\Users\\lwh\\AppData\\Local\\Temp\\gssample\\sample.pdf";
const LOG = "C:\\Users\\lwh\\AppData\\Local\\Temp\\pdfcompress-test.log";

const IOUtils: any = (globalThis as any).IOUtils;

// 累积日志，最后一次性落盘（逐条 append 在测试沙箱里不可靠）
const LOGLINES: string[] = [];
const T0 = Date.now();
function log(...parts: any[]) {
  const line = `[+${Date.now() - T0}ms] ` + parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ");
  LOGLINES.push(line);
  try {
    console.log(line);
  } catch {
    /* ignore */
  }
}
async function flushLog() {
  try {
    await (Zotero as any).File.putContentsAsync(LOG, LOGLINES.join("\n"));
  } catch {
    /* ignore */
  }
}

describe("工单06 压缩核心", function () {
  this.timeout(600000);

  it("端到端：解包 GS、导入 PDF、两档压缩、原地覆盖、无收益处理", async function () {
    try {
      await runAll();
    } catch (e: any) {
      log("测试失败:", e?.message || String(e), "| stack:", e?.stack || "");
      await flushLog();
      throw e;
    }
    await flushLog();
  });
});

async function runAll() {
  // --- 1. 解包内置 Ghostscript ---
  const rootURI = await (Zotero as any).Plugins.getRootURI(config.addonID);
  log("[1] rootURI =", rootURI);
  const gsRoot = await ensureGhostscript(rootURI);
  log("[1] Ghostscript 解包到 =", gsRoot);

  const PathUtils: any = (globalThis as any).PathUtils;
  const exe = PathUtils.join(gsRoot, "bin", "gswin64c.exe");
  const exeExists = await IOUtils.exists(exe);
  log("[1] gswin64c.exe 存在 =", exeExists, exe);
  assert.isTrue(exeExists, "解包后未找到 gswin64c.exe");

  // --- 2. 样本检查 ---
  const sampleExists = await IOUtils.exists(SAMPLE);
  log("[2] 样本存在 =", sampleExists, SAMPLE);
  assert.isTrue(sampleExists, "样本 PDF 不存在");

  // --- 3. 均衡档 ---
  const a1 = await Zotero.Attachments.importFromFile({
    file: SAMPLE,
    libraryID: Zotero.Libraries.userLibraryID,
  } as any);
  const pathBefore = await a1.getFilePathAsync();
  log("[3] 附件 id =", a1.id, "路径 =", pathBefore);

  const r1 = await compressAttachment(a1, "balanced", gsRoot);
  log("[3] 均衡结果 =", JSON.stringify(r1));
  assert.equal(r1.status, "ok", `均衡档失败: ${r1.reason} ${r1.message || ""}`);
  assert.isBelow(r1.outSize!, r1.inSize! * 0.98, "均衡档收益不足 2%");

  const pathAfter = await a1.getFilePathAsync();
  assert.equal(pathAfter, pathBefore, "原地覆盖后路径变了");
  const sizeNow = (await IOUtils.stat(pathAfter)).size;
  assert.equal(sizeNow, r1.outSize, "磁盘大小与报告不符");
  log(
    `[3] 均衡档：${r1.inSize} → ${r1.outSize}（省 ${((1 - r1.outSize! / r1.inSize!) * 100).toFixed(1)}%）`,
  );
  await Zotero.Items.trashTx([a1.id]);

  // --- 4. 激进档 ---
  const a2 = await Zotero.Attachments.importFromFile({
    file: SAMPLE,
    libraryID: Zotero.Libraries.userLibraryID,
  } as any);
  const r2 = await compressAttachment(a2, "aggressive", gsRoot);
  log("[4] 激进结果 =", JSON.stringify(r2));
  assert.equal(r2.status, "ok", `激进档失败: ${r2.reason} ${r2.message || ""}`);
  assert.isBelow(r2.outSize!, r2.inSize! * 0.98);
  log(
    `[4] 激进档：${r2.inSize} → ${r2.outSize}（省 ${((1 - r2.outSize! / r2.inSize!) * 100).toFixed(1)}%）`,
  );

  // --- 5. 二次压缩：应无收益或收益极小，且不留临时文件 ---
  const path2 = await a2.getFilePathAsync();
  const sizeAfterFirst = (await IOUtils.stat(path2)).size;
  const r3 = await compressAttachment(a2, "aggressive", gsRoot);
  log("[5] 二次压缩结果 =", JSON.stringify(r3));
  if (r3.status === "no-gain") {
    const sizeNow2 = (await IOUtils.stat(path2)).size;
    assert.equal(sizeNow2, sizeAfterFirst, "无收益时不应改动文件");
    log("[5] 正确判定无收益，原文件未动");
  } else {
    assert.equal(r3.status, "ok");
    log("[5] 二次压缩仍有收益，已替换");
  }
  assert.isFalse(
    await IOUtils.exists(path2 + ".compressing.pdf"),
    "残留临时文件",
  );
  await Zotero.Items.trashTx([a2.id]);

  // --- 6. 非 PDF 被拒 ---
  const r4 = await compressAttachment(
    {
      id: 999999,
      isFileAttachment: () => true,
      attachmentContentType: "text/plain",
      getField: () => "x",
    },
    "balanced",
    gsRoot,
  );
  assert.equal(r4.status, "failed");
  assert.equal(r4.reason, "not-pdf");
  log("[6] 非 PDF 正确被拒");

  log("全部通过");
}