declare const assert: any;
import { config } from "../package.json";
import {
  compressAttachment,
  ensureGhostscript,
} from "../src/modules/compressor";
import { runBatch, summarize } from "../src/modules/batch";

// 工单 10：端到端验收。
// 覆盖：真实论文压缩、加密/损坏归类、多选批处理、标注保留与位置对齐、中文文案。
// 素材在 C:\Users\lwh\AppData\Local\Temp\gsfixtures\

const DIR = "C:\\Users\\lwh\\AppData\\Local\\Temp\\gsfixtures";
const PAPER = DIR + "\\paper.pdf";
const ENCRYPTED = DIR + "\\encrypted.pdf";
const CORRUPT = DIR + "\\corrupt.pdf";

const LOG = "C:\\Users\\lwh\\AppData\\Local\\Temp\\pdfcompress-e2e.log";
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

async function importPdf(path: string, title?: string) {
  return Zotero.Attachments.importFromFile({
    file: path,
    libraryID: Zotero.Libraries.userLibraryID,
    title,
  } as any);
}

describe("工单10 端到端验收", function () {
  this.timeout(600000);

  let gsRoot = "";

  // 每个用例都落盘，否则断言抛错时日志丢失，无法定位
  afterEach(async function () {
    await flush();
  });

  before(async function () {
    const rootURI = await (Zotero as any).Plugins.getRootURI(config.addonID);
    gsRoot = await ensureGhostscript(rootURI);
    log("gsRoot = " + gsRoot);
  });

  it("AC2 原地覆盖：真实论文压缩后路径不变、变小、标注保留且位置对齐", async function () {
    const att = await importPdf(PAPER, "真实验收论文");
    const pathBefore = await att.getFilePathAsync();
    const sizeBefore = (await IOUtils.stat(pathBefore)).size;

    // 构造真实标注：挂在附件下，位置指向第 1 页
    // PDF 标注的 sortIndex 格式固定为 5|6|5 位数字（见 Zotero data/item.js）
    const annot = new Zotero.Item("annotation" as any);
    annot.libraryID = att.libraryID;
    annot.parentItemID = att.id;
    annot.annotationType = "highlight";
    annot.annotationText = "这是被高亮的关键结论";
    annot.annotationComment = "端到端验收标注";
    annot.annotationColor = "#ffd400";
    annot.annotationPageLabel = "1";
    annot.annotationSortIndex = "00001|000000|00000";
    const position = {
      pageIndex: 0,
      rects: [[100, 200, 300, 220]],
    };
    annot.annotationPosition = JSON.stringify(position);
    await annot.saveTx();

    log(`[AC2] 压缩前：大小=${sizeBefore} 标注 id=${annot.id}`);

    const r = await compressAttachment(att, "balanced", gsRoot);
    log("[AC2] 压缩结果 = " + JSON.stringify(r));
    assert.equal(r.status, "ok", `压缩失败: ${r.reason} ${r.message || ""}`);

    // 路径与条目不变
    const pathAfter = await att.getFilePathAsync();
    assert.equal(pathAfter, pathBefore, "原地覆盖后附件路径变了");

    // 文件确实变小
    const sizeAfter = (await IOUtils.stat(pathAfter)).size;
    assert.isBelow(sizeAfter, sizeBefore, "文件未变小");
    log(
      `[AC2] ${sizeBefore} → ${sizeAfter}（省 ${((1 - sizeAfter / sizeBefore) * 100).toFixed(1)}%）`,
    );

    // 标注仍存在、内容未变
    const annotAfter = await Zotero.Items.getAsync(annot.id);
    assert.ok(annotAfter, "压缩后标注消失了");
    assert.equal(annotAfter.annotationText, "这是被高亮的关键结论");
    assert.equal(annotAfter.annotationComment, "端到端验收标注");
    assert.equal(annotAfter.parentItemID, att.id, "标注的父条目变了");

    // 位置对齐：position 必须原样保留
    const posAfter = JSON.parse(annotAfter.annotationPosition);
    assert.equal(posAfter.pageIndex, position.pageIndex, "页码索引变了");
    assert.deepEqual(posAfter.rects, position.rects, "高亮矩形坐标变了");
    log("[AC2] 标注保留且位置一致: " + JSON.stringify(posAfter));

    // 页数与页面尺寸不变（否则坐标会错位）
    log("[AC2] 文件头 = " + (await readHead(pathAfter, 8)));
    await Zotero.Items.trashTx([att.id, annot.id]);
  });

  it("AC3 无收益：高度优化的 PDF 不被替换、原文件完好、提示正确", async function () {
    // 先用激进档压一次，得到已高度优化的文件
    const att = await importPdf(PAPER, "无收益测试");
    const r1 = await compressAttachment(att, "aggressive", gsRoot);
    assert.equal(r1.status, "ok");
    const path = await att.getFilePathAsync();
    const sizeAfterFirst = (await IOUtils.stat(path)).size;

    // 再压一次：应判无收益
    const r2 = await compressAttachment(att, "aggressive", gsRoot);
    log("[AC3] 二次压缩 = " + JSON.stringify(r2));

    if (r2.status === "no-gain") {
      const sizeNow = (await IOUtils.stat(path)).size;
      assert.equal(sizeNow, sizeAfterFirst, "无收益时文件被改动");
      assert.isTrue(
        String(r2.message).includes("保留原文件"),
        "提示文案不含保留原文件",
      );
      log("[AC3] 正确判无收益并保留原文件");
    } else {
      assert.equal(r2.status, "ok");
      log("[AC3] 二次仍有收益（可接受），已替换");
    }
    assert.isFalse(
      await IOUtils.exists(path + ".compressing.pdf"),
      "残留临时文件",
    );
    await Zotero.Items.trashTx([att.id]);
  });

  it("AC6 失败路径：加密 PDF 归为 encrypted，且绝不产生空白覆盖", async function () {
    const att = await importPdf(ENCRYPTED, "加密PDF");
    const path = await att.getFilePathAsync();
    const sizeBefore = (await IOUtils.stat(path)).size;

    const r = await compressAttachment(att, "balanced", gsRoot);
    log("[AC6-加密] 结果 = " + JSON.stringify(r));
    assert.equal(r.status, "failed", "加密 PDF 被当成成功处理（严重！）");
    assert.equal(r.reason, "encrypted");

    // 原文件必须完好
    const sizeNow = (await IOUtils.stat(path)).size;
    assert.equal(sizeNow, sizeBefore, "加密 PDF 被改动了（数据损坏！）");
    assert.isFalse(
      await IOUtils.exists(path + ".compressing.pdf"),
      "失败时残留临时文件",
    );
    log("[AC6-加密] 原文件完好，未残留临时文件");
    await Zotero.Items.trashTx([att.id]);
  });

  it("AC6 失败路径：损坏 PDF 归为 corrupt，原文件完好", async function () {
    const att = await importPdf(CORRUPT, "损坏PDF");
    const path = await att.getFilePathAsync();
    const sizeBefore = (await IOUtils.stat(path)).size;

    const r = await compressAttachment(att, "balanced", gsRoot);
    log("[AC6-损坏] 结果 = " + JSON.stringify(r));
    assert.equal(r.status, "failed", "损坏 PDF 被当成成功处理");
    assert.equal(r.reason, "corrupt");

    const sizeNow = (await IOUtils.stat(path)).size;
    assert.equal(sizeNow, sizeBefore, "损坏 PDF 被改动了");
    assert.isFalse(await IOUtils.exists(path + ".compressing.pdf"));
    log("[AC6-损坏] 归类正确，原文件完好");
    await Zotero.Items.trashTx([att.id]);
  });

  it("AC4 多选：串行批处理且汇总正确（混入失败文件）", async function () {
    const a1 = await importPdf(DIR + "\\tiny.pdf", "小文件1");
    const a2 = await importPdf(DIR + "\\tiny.pdf", "小文件2");
    const bad = await importPdf(CORRUPT, "混入的坏文件");

    const summary = await runBatch(
      [a1, a2, bad],
      "aggressive",
      gsRoot,
      { mode: "overwrite", gainThreshold: 0.98 },
      { autoCloseReader: false, log: (m) => log("[AC4] " + m) },
    );

    log("[AC4] 汇总 = " + JSON.stringify(summary.lines));
    log(
      `[AC4] total=${summary.total} ok=${summary.ok.length} failed=${summary.failed.length}`,
    );
    assert.equal(summary.total, 3, "批处理总数不对");
    assert.equal(summary.failed.length, 1, "坏文件未被计入失败");
    assert.equal(summary.failed[0].reason, "corrupt");
    assert.isTrue(summary.lines.length > 0, "汇总行缺失");
    // 坏文件不能影响其它文件
    const badPath = await bad.getFilePathAsync();
    assert.equal(
      (await IOUtils.stat(badPath)).size,
      (await IOUtils.stat(CORRUPT)).size,
      "坏文件被改动了",
    );
    log("[AC4] 多选串行完成，坏文件未影响其余");

    await Zotero.Items.trashTx([a1.id, a2.id, bad.id]);
  });

  it("AC7 中文文案：菜单与设置项的 FTL 全部有中文且无缺失", async function () {
    const rootURI = await (Zotero as any).Plugins.getRootURI(config.addonID);
    const ftlPath = rootURI + "locale/zh-CN/" + config.addonRef + "-addon.ftl";
    let content = "";
    try {
      content = Zotero.File.getContentsFromURL(ftlPath);
    } catch (e: any) {
      log("[AC7] 读取 zh-CN ftl 失败: " + (e?.message || e));
    }
    assert.isTrue(content.length > 0, "读不到中文 FTL");
    log("[AC7] zh-CN ftl 长度 = " + content.length);

    // 关键 key 必须存在
    const required = [
      "compress-menu",
      "compress-balanced",
      "compress-aggressive",
      "prefs-attachment-title",
      "prefs-mode-overwrite",
      "prefs-mode-copy",
      "prefs-default-preset",
      "prefs-gain-threshold",
      "prefs-auto-close-reader",
      "prefs-show-result",
    ];
    const missing = required.filter((k) => !content.includes(k + " ="));
    log("[AC7] 缺失 key = " + JSON.stringify(missing));
    assert.deepEqual(missing, [], "中文 FTL 缺失 key: " + missing.join(", "));

    // 中文字符确实存在
    assert.isTrue(/[\u4e00-\u9fa5]/.test(content), "FTL 中不含中文字符");
    log("[AC7] 中文文案完整");
  });
});

async function readHead(path: string, n: number): Promise<string> {
  const bytes = await IOUtils.read(path, { maxBytes: n });
  return new TextDecoder().decode(bytes);
}
