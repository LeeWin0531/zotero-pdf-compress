// ============================================================================
// 压缩核心（工单 06）
// Ghostscript 调用 + 「变小才替换」+ 同目录临时文件原子替换。
// ============================================================================

/** 预设档位。参数定稿见 issues/04-compression-presets-params.md */
export type Preset = "balanced" | "aggressive";

/** 单文件压缩结果 */
export interface CompressResult {
  itemID: number;
  title: string;
  status: "ok" | "no-gain" | "failed";
  /** 失败原因分类 */
  reason?: "gs-error" | "encrypted" | "locked" | "not-pdf" | "no-file" | "timeout";
  inSize?: number;
  outSize?: number;
  message?: string;
  /** 「新增副本」模式下创建的新附件 id */
  newAttachmentID?: number;
}

/** 无收益阈值的默认值（可在设置面板调整，见 CompressOptions） */
const DEFAULT_GAIN_THRESHOLD = 0.98;

/**
 * 取 IOUtils / PathUtils。
 * Zotero 9 的插件沙箱与测试页面都直接提供这两个全局。
 * 不要用 importESModule("resource://gre/modules/IOUtils.sys.mjs")——
 * 该资源路径在 Zotero 9 上不存在（实测报 "Failed to load resource"）。
 */
function getIOUtils(): any {
  const g: any = globalThis as any;
  if (!g.IOUtils) throw new Error("IOUtils 全局不可用");
  return g.IOUtils;
}
function getPathUtils(): any {
  const g: any = globalThis as any;
  if (!g.PathUtils) throw new Error("PathUtils 全局不可用");
  return g.PathUtils;
}

const COMMON_ARGS = [
  "-dNOPAUSE",
  "-dQUIET",
  "-dBATCH",
  "-sDEVICE=pdfwrite",
  "-dCompatibilityLevel=1.7",
  "-dDetectDuplicateImages=true",
  "-dCompressFonts=true",
  "-dSubsetFonts=true",
  "-dEmbedAllFonts=true",
];

const PRESET_ARGS: Record<Preset, string[]> = {
  // 均衡：150 DPI，Bicubic（保画质）
  balanced: [
    "-dDownsampleColorImages=true",
    "-dColorImageDownsampleType=/Bicubic",
    "-dColorImageResolution=150",
    "-dColorImageDownsampleThreshold=1.5",
    "-dDownsampleGrayImages=true",
    "-dGrayImageDownsampleType=/Bicubic",
    "-dGrayImageResolution=150",
    "-dGrayImageDownsampleThreshold=1.5",
    "-dDownsampleMonoImages=true",
    "-dMonoImageResolution=300",
  ],
  // 激进：100 DPI，Average（更省空间）
  aggressive: [
    "-dDownsampleColorImages=true",
    "-dColorImageDownsampleType=/Average",
    "-dColorImageResolution=100",
    "-dColorImageDownsampleThreshold=1.5",
    "-dDownsampleGrayImages=true",
    "-dGrayImageDownsampleType=/Average",
    "-dGrayImageResolution=100",
    "-dGrayImageDownsampleThreshold=1.5",
    "-dDownsampleMonoImages=true",
    "-dMonoImageResolution=200",
  ],
};

// ---------------------------------------------------------------------------
// Ghostscript 定位与首次解包
// ---------------------------------------------------------------------------

let gsDirCache: string | null = null;

/**
 * 把内置的便携版 Ghostscript 解包到临时目录，返回其根目录。
 *
 * XPI 内的二进制不能就地执行，必须先复制出来（工单 01 结论）。
 * 读取方式：URI → 原生路径（nsIFileURL）→ IOUtils.read。
 * 不能用 fetch：测试页面沙箱里对 file:// 会抛 NetworkError（原型实测）。
 * 不能用 IOUtils.getChildren：它只接受原生路径，不认 file:// URI。
 */
export async function ensureGhostscript(rootURI: string): Promise<string> {
  if (gsDirCache) return gsDirCache;

  const IOUtils = getIOUtils();
  const PathUtils = getPathUtils();
  const target = PathUtils.join(PathUtils.tempDir, "pdf-compress-gs");

  const exe = PathUtils.join(target, "bin", "gswin64c.exe");
  if (await IOUtils.exists(exe)) {
    gsDirCache = target;
    return target;
  }

  const srcRoot = rootURI.endsWith("/") ? rootURI : rootURI + "/";

  // 构建期生成的文件清单，避免依赖目录枚举
  const manifestBytes = await IOUtils.read(
    uriToNativePath(srcRoot + "gs-manifest.json"),
  );
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestBytes),
  ) as { files: string[] };

  await IOUtils.makeDirectory(target, { ignoreExisting: true });

  for (const rel of manifest.files) {
    const bytes = await IOUtils.read(uriToNativePath(srcRoot + "gs/" + rel));
    const dest = PathUtils.join(target, ...rel.split("/"));
    await IOUtils.makeDirectory(PathUtils.parent(dest), {
      ignoreExisting: true,
    });
    await IOUtils.write(dest, bytes);
  }

  if (!(await IOUtils.exists(exe))) {
    throw new Error(`Ghostscript 解包失败：未找到 ${exe}`);
  }
  gsDirCache = target;
  return target;
}

/** URI → 原生文件路径（IOUtils 只接受原生路径）。 */
function uriToNativePath(uri: string): string {
  const S = Services as any;
  const C = Components as any;
  return S.io.newURI(uri).QueryInterface(C.interfaces.nsIFileURL).file.path;
}

// ---------------------------------------------------------------------------
// 压缩主流程
// ---------------------------------------------------------------------------

/** 调用 Ghostscript 压缩单个文件到临时输出，返回输出路径。 */
async function runGhostscript(
  gsRoot: string,
  preset: Preset,
  inputPath: string,
  outputPath: string,
): Promise<{ exitCode: number; stderr: string }> {
  const PathUtils = getPathUtils();
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  );

  const exe = PathUtils.join(gsRoot, "bin", "gswin64c.exe");
  const lib = PathUtils.join(gsRoot, "lib");
  const init = PathUtils.join(gsRoot, "Resource", "Init");

  const args = [
    `-I${lib}`,
    `-I${init}`,
    ...COMMON_ARGS,
    ...PRESET_ARGS[preset],
    `-sOutputFile=${outputPath}`,
    inputPath,
  ];

  const proc = await (Subprocess as any).call({
    command: exe,
    arguments: args,
    environmentAppend: true,
    stderr: "pipe",
  });

  let stderr = "";
  let chunk: string | null;
  while ((chunk = await proc.stderr.readString())) stderr += chunk;

  const { exitCode } = await proc.wait();
  return { exitCode, stderr };
}

/** 分类 Ghostscript 的失败原因。 */
function classifyError(stderr: string, exitCode: number): CompressResult["reason"] {
  const s = stderr.toLowerCase();
  if (s.includes("password") || s.includes("encrypted")) return "encrypted";
  if (s.includes("permission") || s.includes("locked")) return "locked";
  if (exitCode !== 0) return "gs-error";
  return "gs-error";
}

/** 附件处理方式（对应设置面板） */
export type AttachmentMode = "overwrite" | "copy";

/** 压缩选项 */
export interface CompressOptions {
  mode: AttachmentMode;
  /** 无收益阈值：输出需小于原大小 × 此值才接受（默认 0.98） */
  gainThreshold: number;
}

/** 默认选项 */
export const DEFAULT_OPTIONS: CompressOptions = {
  mode: "overwrite",
  gainThreshold: DEFAULT_GAIN_THRESHOLD,
};

/**
 * 压缩单个附件。
 *
 * - `mode: "overwrite"`（默认）：原地覆盖文件字节，附件条目与路径不变，
 *   标注/笔记得以保留（Q26）。
 * - `mode: "copy"`：保留原附件，压缩结果作为**新附件**导入同一父条目下，
 *   命名「原名（已压缩）」。注意新附件不含原附件的标注。
 *
 * 安全保证：
 *  - 输出写到**同目录**临时文件，成功后原子替换；
 *  - 仅当 outSize < inSize × gainThreshold 才接受，否则丢弃临时文件（Q10/Q29）。
 */
export async function compressAttachment(
  attachment: any,
  preset: Preset,
  gsRoot: string,
  options: CompressOptions = DEFAULT_OPTIONS,
): Promise<CompressResult> {
  const IOUtils = getIOUtils();
  const PathUtils = getPathUtils();

  const base: CompressResult = {
    itemID: attachment.id,
    title: attachment.getField?.("title") || `#${attachment.id}`,
    status: "failed",
  };

  if (
    !attachment.isFileAttachment?.() ||
    attachment.attachmentContentType !== "application/pdf"
  ) {
    return { ...base, reason: "not-pdf", message: "不是 PDF 附件" };
  }

  const inputPath = await attachment.getFilePathAsync();
  if (!inputPath || !(await IOUtils.exists(inputPath))) {
    return { ...base, reason: "no-file", message: "文件不存在" };
  }

  const inSize = (await IOUtils.stat(inputPath)).size;
  const tmpPath = inputPath + ".compressing.pdf";

  try {
    const { exitCode, stderr } = await runGhostscript(
      gsRoot,
      preset,
      inputPath,
      tmpPath,
    );

    if (exitCode !== 0) {
      return {
        ...base,
        reason: classifyError(stderr, exitCode),
        message:
          stderr.trim().split("\n").slice(-2).join(" ") || `退出码 ${exitCode}`,
        inSize,
      };
    }

    if (!(await IOUtils.exists(tmpPath))) {
      return { ...base, reason: "gs-error", message: "未生成输出文件", inSize };
    }

    const outSize = (await IOUtils.stat(tmpPath)).size;
    const threshold = options.gainThreshold || 0.98;

    if (outSize >= inSize * threshold) {
      await IOUtils.remove(tmpPath, { ignoreAbsent: true });
      const pct = ((1 - threshold) * 100).toFixed(0);
      return {
        ...base,
        status: "no-gain",
        inSize,
        outSize,
        message: `压缩收益不足 ${pct}%，保留原文件`,
      };
    }

    if (options.mode === "copy") {
      // 新增副本：把压缩结果导入为新附件，保留原附件
      const newAttachment = await importCompressedCopy(
        attachment,
        tmpPath,
        base.title,
      );
      await IOUtils.remove(tmpPath, { ignoreAbsent: true });
      return {
        ...base,
        status: "ok",
        inSize,
        outSize,
        newAttachmentID: newAttachment?.id,
      };
    }

    // 原地覆盖：原子替换（同目录，同一卷）
    await IOUtils.remove(inputPath);
    await IOUtils.move(tmpPath, inputPath);

    return { ...base, status: "ok", inSize, outSize };
  } catch (e: any) {
    try {
      await IOUtils.remove(tmpPath, { ignoreAbsent: true });
    } catch {
      /* ignore */
    }
    return { ...base, reason: "gs-error", message: e?.message || String(e), inSize };
  }
}

/** 把压缩后的临时文件导入为原附件同父条目下的新附件。 */
async function importCompressedCopy(
  original: any,
  tmpPath: string,
  originalTitle: string,
): Promise<any> {
  const parentItemID = original.parentItemID || undefined;
  const libraryID = original.libraryID;

  // 文件名加「（已压缩）」后缀
  const PathUtils = getPathUtils();
  const dir = PathUtils.parent(tmpPath);
  const newName = `${originalTitle}（已压缩）.pdf`;
  const namedPath = PathUtils.join(dir, newName);
  const IOUtils = getIOUtils();
  await IOUtils.move(tmpPath, namedPath);

  try {
    const item = await Zotero.Attachments.importFromFile({
      file: namedPath,
      libraryID,
      parentItemID,
      title: newName,
    } as any);
    return item;
  } finally {
    try {
      await IOUtils.remove(namedPath, { ignoreAbsent: true });
    } catch {
      /* ignore */
    }
  }
}