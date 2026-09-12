declare const assert: any;
import { config } from "../package.json";
import {
  runBatch,
  summarize,
  pickPdfAttachments,
  closeReadersFor,
  describeReason,
  formatFailures,
  formatBytes,
  type BatchSummary,
} from "../src/modules/batch";
import type { CompressResult, Preset } from "../src/modules/compressor";

// 工单 07（阅读器占用 + 多选串行批处理）与工单 08（进度上报 + 完成汇总）的验证。
// 编排逻辑已抽到 src/modules/batch.ts，这里注入 stub 断言行为，不依赖真实 UI。

const LOG = "C:\\Users\\lwh\\AppData\\Local\\Temp\\pdfcompress-batch.log";
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

/** 造一个假的附件条目。 */
function fakeAttachment(id: number, title: string, type = "application/pdf") {
  return {
    id,
    attachmentContentType: type,
    isFileAttachment: () => true,
    getField: (f: string) => (f === "title" ? title : ""),
  };
}

/** 造一个压缩结果。 */
function result(
  id: number,
  title: string,
  status: CompressResult["status"],
  inSize?: number,
  outSize?: number,
): CompressResult {
  return { itemID: id, title, status, inSize, outSize };
}

describe("工单07+08 批处理与进度上报", function () {
  this.timeout(60000);

  it("非 PDF 被过滤掉（实现层二次防御）", async function () {
    const items = [
      fakeAttachment(1, "论文A"),
      fakeAttachment(2, "图片", "image/png"),
      { id: 3, isFileAttachment: () => false, attachmentContentType: "" },
      null,
    ];
    const pdfs = pickPdfAttachments(items as any[]);
    log("过滤结果 ids = " + JSON.stringify(pdfs.map((p) => p.id)));
    assert.lengthOf(pdfs, 1);
    assert.equal(pdfs[0].id, 1);
  });

  it("串行处理：顺序正确、逐个上报进度", async function () {
    const items = [
      fakeAttachment(11, "论文1"),
      fakeAttachment(12, "论文2"),
      fakeAttachment(13, "论文3"),
    ];
    const order: number[] = [];
    const steps: string[] = [];

    const summary = await runBatch(
      items,
      "balanced",
      "unused",
      { mode: "overwrite", gainThreshold: 0.98 },
      {
        autoCloseReader: false,
        onStep: (t) => steps.push(t),
        compress: async (att) => {
          order.push(att.id);
          await Zotero.Promise.delay(1);
          return result(att.id, att.getField("title"), "ok", 1000, 400);
        },
      },
    );

    log("处理顺序 = " + JSON.stringify(order));
    log("进度上报 = " + JSON.stringify(steps));
    assert.deepEqual(order, [11, 12, 13], "未按串行顺序处理");
    assert.equal(summary.total, 3);
    assert.equal(summary.ok.length, 3);
    assert.isTrue(
      steps.some((s) => s.includes("[1/3]")),
      "缺少第 1/3 的进度上报",
    );
    assert.isTrue(
      steps.some((s) => s.includes("[3/3]")),
      "缺少第 3/3 的进度上报",
    );
  });

  it("一个失败不中断其余（异常也被转成 failed）", async function () {
    const items = [
      fakeAttachment(21, "好1"),
      fakeAttachment(22, "坏的"),
      fakeAttachment(23, "好2"),
    ];
    const seen: number[] = [];

    const summary = await runBatch(
      items,
      "aggressive",
      "unused",
      { mode: "overwrite", gainThreshold: 0.98 },
      {
        autoCloseReader: false,
        compress: async (att) => {
          seen.push(att.id);
          if (att.id === 22) throw new Error("模拟崩溃");
          return result(att.id, att.getField("title"), "ok", 1000, 300);
        },
      },
    );

    log("已处理的 ids = " + JSON.stringify(seen));
    assert.deepEqual(seen, [21, 22, 23], "失败后未继续处理后续文件");
    assert.equal(summary.ok.length, 2);
    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0].itemID, 22);
    log("失败条目 message = " + summary.failed[0].message);
    assert.isTrue(
      String(summary.failed[0].message).includes("模拟崩溃"),
      "异常未保留原始信息",
    );
  });

  it("阅读器关闭：只关匹配 itemID 的，且 autoCloseReader 可关", async function () {
    const items = [fakeAttachment(31, "A"), fakeAttachment(32, "B")];

    // 1) 默认（开）：应把本批 itemID 传给关闭函数
    let closedArg: number[] | null = null;
    await runBatch(
      items,
      "balanced",
      "unused",
      { mode: "overwrite", gainThreshold: 0.98 },
      {
        closeReaders: async (ids) => {
          closedArg = ids;
        },
        compress: async (att) => result(att.id, "t", "ok", 100, 50),
      },
    );
    log("关闭阅读器收到 ids = " + JSON.stringify(closedArg));
    assert.deepEqual(closedArg, [31, 32], "未按本批 itemID 关闭阅读器");

    // 2) 关闭开关：不应调用
    let called = false;
    await runBatch(
      items,
      "balanced",
      "unused",
      { mode: "overwrite", gainThreshold: 0.98 },
      {
        autoCloseReader: false,
        closeReaders: async () => {
          called = true;
        },
        compress: async (att) => result(att.id, "t", "ok", 100, 50),
      },
    );
    log("autoCloseReader=false 时是否调用关闭 = " + called);
    assert.isFalse(called, "关掉开关后仍尝试关闭阅读器");
  });

  it("closeReadersFor 会跳过无关 reader 并容忍单个失败", async function () {
    const original = (Zotero as any).Reader;
    const closed: number[] = [];
    const readers = [
      {
        itemID: 41,
        close: async () => {
          closed.push(41);
        },
      },
      {
        itemID: 99,
        close: async () => {
          closed.push(99);
        },
      },
      {
        itemID: 42,
        close: async () => {
          throw new Error("关不掉");
        },
      },
    ];
    try {
      (Zotero as any).Reader = { _readers: readers };
      const n = await closeReadersFor([41, 42]);
      log("实际关闭 = " + JSON.stringify(closed) + " 返回 " + n);
      assert.deepEqual(closed, [41], "应只关闭匹配且成功的 reader");
      assert.equal(n, 1);
    } finally {
      (Zotero as any).Reader = original;
    }
  });

  it("汇总：成功/无收益/失败分类 + 节省空间计算", function () {
    const results = [
      result(1, "A", "ok", 1000, 300),
      result(2, "B", "ok", 2000, 500),
      result(3, "C", "no-gain", 500, 495),
      result(4, "D", "failed"),
    ];
    const s: BatchSummary = summarize(results);
    log("汇总 = " + JSON.stringify(s.lines));
    log(`totalIn=${s.totalIn} totalOut=${s.totalOut} saved=${s.saved}`);
    assert.equal(s.total, 4);
    assert.equal(s.ok.length, 2);
    assert.equal(s.noGain.length, 1);
    assert.equal(s.failed.length, 1);
    // 无收益文件不计入节省统计
    assert.equal(s.totalIn, 3000);
    assert.equal(s.totalOut, 800);
    assert.equal(s.saved, 2200);
    assert.isTrue(s.lines[0].includes("成功压缩：2 个"));
    assert.isTrue(
      s.lines.some((l) => l.includes("节省")),
      "汇总缺少节省信息",
    );
    assert.isTrue(s.lines.some((l) => l.includes("无收益")));
    assert.isTrue(s.lines.some((l) => l.includes("失败：1 个")));
  });

  it("失败原因映射为可读中文，且详情文本正确", function () {
    assert.equal(describeReason("encrypted"), "PDF 已加密（需要密码）");
    assert.equal(describeReason("locked"), "文件被占用（无法写入）");
    assert.equal(describeReason("no-file"), "文件不存在");
    assert.equal(describeReason("timeout"), "压缩超时");
    assert.equal(describeReason("gs-error"), "Ghostscript 处理出错");
    assert.equal(describeReason(undefined), "Ghostscript 处理出错");

    const detail = formatFailures([
      {
        itemID: 1,
        title: "坏文件",
        status: "failed",
        reason: "encrypted",
        message: "需要密码",
      },
    ]);
    log("失败详情 = " + JSON.stringify(detail));
    assert.isTrue(detail.includes("坏文件"));
    assert.isTrue(detail.includes("已加密"));
  });

  it("formatBytes 输出可读单位", function () {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(3 * 1024 * 1024), "3.00 MB");
    log("formatBytes ok");
  });
});
