declare const assert: any;
import { config } from "../package.json";
import {
  ensureGhostscript,
  isGhostscriptComplete,
  readGsManifest,
  resetGhostscriptCache,
  verifyOutput,
  compressAttachment,
} from "../src/modules/compressor";
import { makePdf, makeBlankPdf, makePdfWithUnbalancedForm } from "./fixtures";

// 回归测试：两个已诊断的真实 bug（2026-09-21）。
//
// Bug A（内容校验）：-dPDFSTOPONERROR 把 Ghostscript 可恢复的小毛病升级为致命
//   错误，419 篇真实论文里误杀 83 篇（19.8%）。去掉开关后，改由 verifyOutput()
//   按「每页墨迹面积」拦截空白/残缺输出。
//
// Bug B（解包完整性）：ensureGhostscript 只检查 bin/gswin64c.exe 是否存在。
//   临时目录被部分清理后（实测 53/531 文件，lib/、Resource/Font 全空），exe 仍在
//   → 判定「已就绪」→ 永不重解 → Ghostscript 把每页渲染成空白**且退出码为 0**
//   → 「变小才替换」用空白 PDF 覆盖原论文（实测 419 篇里 25 篇被静默覆盖）。
//
// 素材全部由 test/fixtures.ts 现造，不依赖用户本地库。

const IOUtils: any = (globalThis as any).IOUtils;
const PathUtils: any = (globalThis as any).PathUtils;

const LOG = "C:\\Users\\lwh\\AppData\\Local\\Temp\\pdfcompress-regression.log";
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

/** 每个用例独立的临时目录，避免互相干扰。 */
function scratchDir(name: string): string {
  return PathUtils.join(PathUtils.tempDir, "gs-regression", name);
}

async function freshDir(name: string): Promise<string> {
  const dir = scratchDir(name);
  await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  return dir;
}

describe("回归：两个已诊断的真实 bug", function () {
  this.timeout(600000);

  let gsRoot = "";

  before(async function () {
    const rootURI = await (Zotero as any).Plugins.getRootURI(config.addonID);
    gsRoot = await ensureGhostscript(rootURI);
    log("gsRoot = " + gsRoot);
  });

  afterEach(async function () {
    await flush();
  });

  describe("A. Ghostscript 输出内容校验", function () {
    it("R-A1 放行正常压缩输出", async function () {
      const dir = await freshDir("a1");
      const src = PathUtils.join(dir, "good.pdf");
      await makePdf(src, 5);

      const out = PathUtils.join(dir, "good-out.pdf");
      await compressWithGs(gsRoot, src, out);

      const v = await verifyOutput(gsRoot, src, out, 5);
      log("[R-A1] verdict = " + JSON.stringify(v));
      assert.isTrue(v.ok, `正常输出被误拒: ${v.message}`);
    });

    it("R-A2 拒绝「页数正确但整篇空白」的输出（Bug B 的数据丢失路径）", async function () {
      const dir = await freshDir("a2");
      const src = PathUtils.join(dir, "orig.pdf");
      const blank = PathUtils.join(dir, "blank.pdf");

      await makePdf(src, 6);
      // 页数相同、但每页空白 —— 这正是残缺解包目录造成的输出形态。
      // 旧版「页数一致就放行」的校验会接受它，导致空白覆盖原论文。
      await makeBlankPdf(blank, 6);

      const v = await verifyOutput(gsRoot, src, blank, 6);
      log("[R-A2] verdict = " + JSON.stringify(v));
      assert.isFalse(v.ok, "空白输出被放行（会导致数据丢失！）");
      assert.ok(
        String(v.message).includes("空白"),
        `拒绝原因未提到空白: ${v.message}`,
      );
    });

    it("R-A3 拒绝页数不符的输出", async function () {
      const dir = await freshDir("a3");
      const src = PathUtils.join(dir, "a.pdf");
      const fewer = PathUtils.join(dir, "b.pdf");

      await makePdf(src, 8);
      await makePdf(fewer, 3);

      const v = await verifyOutput(gsRoot, src, fewer, 8);
      log("[R-A3] verdict = " + JSON.stringify(v));
      assert.isFalse(v.ok, "页数不符被放行");
      assert.ok(
        String(v.message).includes("页数"),
        `原因不含页数: ${v.message}`,
      );
    });

    it("R-A4 含图形状态瑕疵的正常 PDF 能被压缩（旧版在此误杀）", async function () {
      const dir = await freshDir("a4");
      const src = PathUtils.join(dir, "unbalanced.pdf");

      // 每页引用一个内容流多了 `Q` 的 Form XObject —— 真实 PDF 里常见的瑕疵。
      // 旧版 -dPDFSTOPONERROR 会把每页的 .PDFDrawPage 都升级为致命错误，
      // 在第一页就崩掉，6 页只产出 1 页（实测）。这是 Bug A 的最小复现。
      await makePdfWithUnbalancedForm(src, 6);
      log(`[R-A4] 素材大小 = ${(await IOUtils.stat(src)).size}`);

      const att = await Zotero.Attachments.importFromFile({
        file: src,
        libraryID: Zotero.Libraries.userLibraryID,
        title: "回归：图形状态瑕疵 PDF",
      } as any);

      const r = await compressAttachment(att, "balanced", gsRoot);
      log("[R-A4] 压缩结果 = " + JSON.stringify(r));
      assert.equal(
        r.status,
        "ok",
        `含瑕疵的正常 PDF 被误杀: ${r.reason} ${r.message || ""}`,
      );
      assert.isBelow(r.outSize!, r.inSize!, "输出未变小");

      // 页数必须完整保留 —— 旧版在这里只剩 1 页。
      // 用 Ghostscript 自己数（与插件 probePdf 同一手段），
      // 因为 Zotero 没有公开的「取 PDF 页数」API。
      const pathAfter = await att.getFilePathAsync();
      const pages = await countPdfPages(gsRoot, pathAfter);
      log(`[R-A4] 压缩后页数 = ${pages}（应为 6）`);
      assert.equal(pages, 6, "压缩后页数丢失（旧版在此只剩 1 页）");

      log(`[R-A4] ${r.inSize} → ${r.outSize}，页数 6 完整保留`);
      await Zotero.Items.trashTx([att.id]);
    });
  });

  describe("B. Ghostscript 解包完整性", function () {
    it("R-B1 残缺目录被判为不完整（旧版因 exe 仍在而误判就绪）", async function () {
      const rootURI = await (Zotero as any).Plugins.getRootURI(config.addonID);
      const target = PathUtils.join(PathUtils.tempDir, "pdf-compress-gs");
      const manifest = await readGsManifest(rootURI);

      // 先确保有一份完整解包
      const gsRoot = await ensureGhostscript(rootURI);
      assert.equal(gsRoot, target, "解包目录不是预期路径");
      assert.isTrue(
        await isGhostscriptComplete(target, manifest),
        "初始解包不完整",
      );
      log(`[R-B1] 初始完整，清单 ${manifest.files.length} 项`);

      // 制造 Bug B 的现场：删掉 lib/ 与 Resource/Font，只留 exe。
      await IOUtils.remove(PathUtils.join(target, "lib"), {
        recursive: true,
        ignoreAbsent: true,
      });
      await IOUtils.remove(PathUtils.join(target, "Resource", "Font"), {
        recursive: true,
        ignoreAbsent: true,
      });

      const exe = PathUtils.join(target, "bin", "gswin64c.exe");
      assert.isTrue(await IOUtils.exists(exe), "exe 应仍在（这正是陷阱所在）");

      // 关键断言：必须判为不完整
      const complete = await isGhostscriptComplete(target, manifest);
      log(`[R-B1] 删掉 lib/ 与 Resource/Font 后，完整性判定 = ${complete}`);
      assert.isFalse(complete, "残缺目录被判为完整（Bug B 未修复）");
    });

    it("R-B2 残缺目录会被自动重建，且重建后能真正压缩", async function () {
      const rootURI = await (Zotero as any).Plugins.getRootURI(config.addonID);
      const target = PathUtils.join(PathUtils.tempDir, "pdf-compress-gs");
      const manifest = await readGsManifest(rootURI);

      // 清掉缓存，让 ensureGhostscript 重新走完整性判定 → 重建
      resetGhostscriptCache();
      const gsRoot = await ensureGhostscript(rootURI);
      assert.equal(gsRoot, target);

      assert.isTrue(
        await isGhostscriptComplete(target, manifest),
        "重建后仍不完整",
      );
      assert.isTrue(
        await IOUtils.exists(PathUtils.join(target, "Resource", "Font")),
        "Resource/Font 未恢复",
      );

      // 重建后必须能真正压缩（不是只有文件在、功能却坏）
      const dir = await freshDir("b2");
      const src = PathUtils.join(dir, "post-rebuild.pdf");
      await makePdf(src, 4);
      const out = PathUtils.join(dir, "post-rebuild-out.pdf");
      await compressWithGs(target, src, out);

      const v = await verifyOutput(target, src, out, 4);
      log("[R-B2] 重建后压缩校验 = " + JSON.stringify(v));
      assert.isTrue(v.ok, `重建后仍无法正常压缩: ${v.message}`);
    });
  });
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 用 Ghostscript 的 pdfpagecount 数页数（与插件 probePdf 同一手段）。 */
async function countPdfPages(gsRoot: string, pdfPath: string): Promise<number> {
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  );
  // PostScript 字符串里反斜杠是转义字符，路径必须转正斜杠。
  const psPath = pdfPath.replace(/\\/g, "/");
  const proc = await (Subprocess as any).call({
    command: PathUtils.join(gsRoot, "bin", "gswin64c.exe"),
    arguments: [
      `-I${PathUtils.join(gsRoot, "lib")}`,
      `-I${PathUtils.join(gsRoot, "Resource", "Init")}`,
      "-q",
      "-dNOPAUSE",
      "-dBATCH",
      "-dNODISPLAY",
      "-dNOSAFER",
      "-c",
      `(${psPath}) (r) file runpdfbegin pdfpagecount = quit`,
    ],
    environmentAppend: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  let c: string | null;
  while ((c = await proc.stdout.readString())) out += c;
  while ((c = await proc.stderr.readString())) {
    /* drain */
  }
  await proc.wait();
  const nums = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l));
  return nums.length ? Number.parseInt(nums[nums.length - 1], 10) : 0;
}

/**
 * 用与插件一致的参数压缩一次。
 *
 * 注意：**不含** -dPDFSTOPONERROR —— 这正是修复的一部分。
 * 若这条测试用的参数与产品代码漂移，Bug A 就锁不住了，
 * 所以参数与 compressor.ts 的 COMMON_ARGS / PRESET_ARGS 保持一致。
 */
async function compressWithGs(
  gsRoot: string,
  input: string,
  output: string,
): Promise<void> {
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  );
  const args = [
    `-I${PathUtils.join(gsRoot, "lib")}`,
    `-I${PathUtils.join(gsRoot, "Resource", "Init")}`,
    "-dNOPAUSE",
    "-dQUIET",
    "-dBATCH",
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.7",
    "-dDetectDuplicateImages=true",
    "-dCompressFonts=true",
    "-dSubsetFonts=true",
    "-dEmbedAllFonts=true",
    "-dDownsampleColorImages=true",
    "-dColorImageDownsampleType=/Bicubic",
    "-dColorImageResolution=150",
    "-dDownsampleGrayImages=true",
    "-dGrayImageDownsampleType=/Bicubic",
    "-dGrayImageResolution=150",
    "-dDownsampleMonoImages=true",
    "-dMonoImageResolution=300",
    `-sOutputFile=${output}`,
    input,
  ];
  const proc = await (Subprocess as any).call({
    command: PathUtils.join(gsRoot, "bin", "gswin64c.exe"),
    arguments: args,
    environmentAppend: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  let c: string | null;
  while ((c = await proc.stderr.readString())) {
    /* drain */
  }
  while ((c = await proc.stdout.readString())) {
    /* drain */
  }
  await proc.wait();
}
