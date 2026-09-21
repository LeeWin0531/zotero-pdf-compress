// ============================================================================
// 批处理编排（工单 07 / 08）
// 与 UI 解耦：进度上报和「关闭阅读器」都由调用方通过 BatchHooks 注入，
// 因此这一层可以在测试里直接断言（不依赖 ProgressWindow / 弹窗）。
// ============================================================================

import {
  compressAttachment,
  type CompressOptions,
  type CompressResult,
  type Preset,
} from "./compressor";

/** 从一组条目里挑出 PDF 附件（菜单层已置灰，这里是实现层的二次防御）。 */
export function pickPdfAttachments(items: any[]): any[] {
  return (items || []).filter(
    (it) =>
      it &&
      typeof it.isFileAttachment === "function" &&
      it.isFileAttachment() &&
      it.attachmentContentType === "application/pdf",
  );
}

/**
 * 关闭正在阅读器中打开这些附件的 reader。
 * Windows 下 PDF 被阅读器占用会导致替换失败（Q28）。
 */
export async function closeReadersFor(
  itemIDs: number[],
  log?: (msg: string, err?: unknown) => void,
): Promise<number> {
  const readers: any[] = (Zotero as any).Reader?._readers || [];
  let closed = 0;
  for (const reader of readers) {
    try {
      if (itemIDs.includes(reader.itemID)) {
        await reader.close();
        closed++;
      }
    } catch (e) {
      log?.("[compress] 关闭阅读器失败", e);
    }
  }
  return closed;
}

/** 人类可读的字节数。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 批次汇总（工单 08 的完成汇总数据源）。 */
export interface BatchSummary {
  total: number;
  ok: CompressResult[];
  noGain: CompressResult[];
  failed: CompressResult[];
  /** 成功压缩文件的原始总大小 */
  totalIn: number;
  /** 成功压缩文件的压缩后总大小 */
  totalOut: number;
  /** 节省的字节数 */
  saved: number;
  /** 中文汇总行（进度窗口直接消费） */
  lines: string[];
}

/** 汇总一批压缩结果，产出可读文本。成功/无收益/失败分别计数并合计节省空间。 */
export function summarize(results: CompressResult[]): BatchSummary {
  const ok = results.filter((r) => r.status === "ok");
  const noGain = results.filter((r) => r.status === "no-gain");
  const failed = results.filter((r) => r.status === "failed");

  let totalIn = 0;
  let totalOut = 0;
  for (const r of ok) {
    totalIn += r.inSize || 0;
    totalOut += r.outSize || 0;
  }

  const lines: string[] = [`成功压缩：${ok.length} 个`];
  if (ok.length) {
    lines.push(
      `节省：${formatBytes(totalIn - totalOut)}（${formatBytes(totalIn)} → ${formatBytes(totalOut)}）`,
    );
  }
  if (noGain.length) lines.push(`无收益（保留原文件）：${noGain.length} 个`);
  if (failed.length) lines.push(`失败：${failed.length} 个`);

  return {
    total: results.length,
    ok,
    noGain,
    failed,
    totalIn,
    totalOut,
    saved: totalIn - totalOut,
    lines,
  };
}

/** 失败原因 → 中文说明（工单 08 第 4 条）。 */
export function describeReason(reason?: CompressResult["reason"]): string {
  switch (reason) {
    case "encrypted":
      return "PDF 已加密（需要密码）";
    case "corrupt":
      return "PDF 已损坏或格式无效";
    case "locked":
      return "文件被占用（无法写入）";
    case "not-pdf":
      return "不是 PDF 附件";
    case "no-file":
      return "文件不存在";
    case "timeout":
      return "压缩超时";
    case "unverified":
      // 内容校验拦下的情况：压缩结果丢页/空白，已保留原文件。
      return "压缩结果不完整，已保留原文件";
    case "gs-error":
    default:
      return "Ghostscript 处理出错";
  }
}

/** 失败详情文本（弹窗内容）。 */
export function formatFailures(failed: CompressResult[]): string {
  return failed
    .map(
      (r) =>
        `• ${r.title}\n  ${describeReason(r.reason)}${r.message ? `: ${r.message}` : ""}`,
    )
    .join("\n\n");
}

/**
 * 批处理回调。全部可选，便于在测试里只断言关心的事件。
 */
export interface BatchHooks {
  /** 每个阶段开始前上报（用于进度窗口） */
  onStep?: (text: string, progress: number) => void;
  /** 关闭阅读器（默认用 closeReadersFor）；测试可注入 spy */
  closeReaders?: (itemIDs: number[]) => Promise<void>;
  /** 是否自动关闭阅读器 */
  autoCloseReader?: boolean;
  /** 串行处理每个附件（默认调 compressAttachment）；测试可注入 stub */
  compress?: (
    attachment: any,
    preset: Preset,
    options: CompressOptions,
  ) => Promise<CompressResult>;
  log?: (msg: string, err?: unknown) => void;
}

/**
 * 串行压缩一批条目（Q21：串行；一个失败不中断其余）。
 * 返回汇总结果，UI 由调用方通过 BatchHooks 呈现。
 */
export async function runBatch(
  items: any[],
  preset: Preset,
  gsRoot: string,
  options: CompressOptions,
  hooks: BatchHooks = {},
): Promise<BatchSummary> {
  const pdfs = pickPdfAttachments(items);
  if (!pdfs.length) {
    return summarize([]);
  }

  const compress =
    hooks.compress ??
    ((attachment: any, p: Preset, o: CompressOptions) =>
      compressAttachment(attachment, p, gsRoot, o));

  if (hooks.autoCloseReader !== false) {
    hooks.onStep?.("正在关闭已打开的阅读器…", 0);
    const close =
      hooks.closeReaders ??
      ((ids: number[]) => closeReadersFor(ids, hooks.log));
    await close(pdfs.map((p) => p.id));
  }

  const results: CompressResult[] = [];
  for (let i = 0; i < pdfs.length; i++) {
    const item = pdfs[i];
    const title = item.getField?.("title") || `#${item.id}`;
    hooks.onStep?.(
      `[${i + 1}/${pdfs.length}] ${title}`,
      Math.round((i / pdfs.length) * 100),
    );

    // 单个失败不抛出，转成 failed 结果继续
    let r: CompressResult;
    try {
      r = await compress(item, preset, options);
    } catch (e: any) {
      r = {
        itemID: item.id,
        title,
        status: "failed",
        reason: "gs-error",
        message: e?.message || String(e),
      };
    }
    results.push(r);
  }

  hooks.onStep?.("完成", 100);
  return summarize(results);
}
