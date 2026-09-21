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
  reason?:
    | "gs-error"
    | "encrypted"
    | "corrupt"
    | "locked"
    | "not-pdf"
    | "no-file"
    | "timeout"
    /** 输出内容校验未通过（内容缺失/空白），已放弃替换 */
    | "unverified";
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
  // 这里**不能**加 -dPDFSTOPONERROR。
  //
  // 它的本意是防止「加密/损坏输入返回退出码 0 并产出空白 PDF」，
  // 但它把 Ghostscript 所有可恢复的小毛病都升级成致命错误：只要论文里有一处
  // 轻微瑕疵（最常见的是目录书签目标页码越界，报
  // "A pdfmark destination page N points beyond the last page M"），
  // 整个转换就在第一页崩掉，输出一个残缺文件、退出码 1。
  // 实测在 419 篇真实论文里，这一个开关就误杀 83 篇（19.8%），
  // 而去掉它之后这 83 篇全部忠实压缩（页数一致、文本保留 99.5%+）。
  //
  // 「空白输出」改由 verifyOutput() 按**内容**拦截——它直接检查页数、
  // 空白页比例与每页墨迹面积，比依赖 Ghostscript 的错误报告可靠得多，
  // 且能同时覆盖加密、损坏与资源缺失三种情形。
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
 * 解包目录必须存在的关键文件。
 *
 * 只检查 gswin64c.exe 是不够的：临时目录可能被清理工具删掉大半而只留可执行文件，
 * 此时 exe 存在、检查通过、永不重新解包，但 Resource/Font 与 ColorSpace 已缺失，
 * Ghostscript 会把每页都渲染成空白**且退出码为 0**，于是「变小才替换」用空白
 * PDF 覆盖原论文（实测：53/531 文件的残缺目录下，419 篇论文里 25 篇被静默覆盖）。
 * 这些文件横跨 bin/Resource/lib/iccprofiles，任一缺失都说明目录不完整。
 */
const GS_CRITICAL_FILES = [
  "bin/gswin64c.exe",
  "bin/gsdll64.dll",
  "lib/gsbj",
  "Resource/Init/gs_init.ps",
  "Resource/Init/pdf_main.ps",
  "Resource/Init/Fontmap",
  "Resource/Font/NimbusRoman-Regular",
  "Resource/CMap/Identity-H",
  "Resource/ColorSpace/DefaultRGB",
  "iccprofiles/default_rgb.icc",
];

/**
 * 关键文件是否齐备（廉价检查，不读清单）。
 *
 * 用于「已解包」这条常见路径的快速判定：只要关键文件在就复用，完全不碰
 * XPI 内部，因此不依赖 jar: 读取能力。
 */
async function hasCriticalGhostscriptFiles(target: string): Promise<boolean> {
  const IOUtils = getIOUtils();
  const PathUtils = getPathUtils();
  for (const rel of GS_CRITICAL_FILES) {
    const p = PathUtils.join(target, ...rel.split("/"));
    if (!(await IOUtils.exists(p))) return false;
  }
  return true;
}

/**
 * 解包目录是否完整可用。
 *
 * 判定标准（任一不满足即视为不完整，需要重新解包）：
 *  1. 关键文件全部存在；
 *  2. 文件总数达到清单的 99%（清单里没有的关键文件不算数，但少量缺失可容忍）。
 *
 * 与 hasCriticalGhostscriptFiles 的分工：后者是「能用就行」的快速判定，
 * 用于已解包时直接复用；本函数是「逐项核对」，只在需要判断是否重解时调用。
 *
 * 导出仅为回归测试可断言（见 test/regression.test.ts R-B1）。
 */
export async function isGhostscriptComplete(
  target: string,
  manifest: { files: string[] },
): Promise<boolean> {
  const IOUtils = getIOUtils();
  const PathUtils = getPathUtils();

  if (!(await hasCriticalGhostscriptFiles(target))) return false;

  // 目录里有没有清单之外的垃圾不重要，缺文件才是问题。
  // 逐个 stat 531 个文件在慢盘上要几秒，但只在首次启动时执行一次。
  let present = 0;
  for (const rel of manifest.files) {
    const p = PathUtils.join(target, ...rel.split("/"));
    if (await IOUtils.exists(p)) present++;
  }
  return present >= manifest.files.length * 0.99;
}

/**
 * 读入内置的 gs-manifest.json（解包与完整性校验共用）。
 *
 * 必须用 Zotero.File.getResourceAsync：**生产态下 rootURI 是 jar: URI**。
 * 插件 ID 含 '@'，Zotero 因此把 XPI 以 jar: 装载（见 Zotero 源码 file.js 的
 * getResourceAsync 注释：「Goes through an nsIChannel to handle jar: URLs
 * containing '@'」）。而 IOUtils.read 只认原生路径，jar: 上做
 * QueryInterface(nsIFileURL) 会抛 NS_NOINTERFACE。
 *
 * 开发态（zotero-plugin serve/test）rootURI 是 file://，两种写法都能过——
 * 这正是该 bug 只在生产安装后才暴露的原因。
 */
export async function readGsManifest(
  rootURI: string,
): Promise<{ files: string[] }> {
  const srcRoot = rootURI.endsWith("/") ? rootURI : rootURI + "/";
  const text = await (Zotero as any).File.getResourceAsync(
    srcRoot + "gs-manifest.json",
  );
  return JSON.parse(text) as { files: string[] };
}

/**
 * 读入 XPI 内的一个二进制资源，返回字节。
 *
 * 同样不能用 IOUtils.read（见 readGsManifest 的说明）。这里用**异步** XHR 的
 * arraybuffer 模式：同步 XHR 不允许设置 responseType（实测报
 * "synchronous XMLHttpRequests do not support timeout and responseType"）。
 *
 * 也不能用 Zotero.File.getResourceAsync：它走文本通道，会把二进制按 UTF-8
 * 解码而损坏内容，对 exe/dll 绝对不行。
 *
 * 导出仅为回归测试可断言（见 test/regression.test.ts R-B4）。
 */
export async function readResourceBytes(uri: string): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", uri, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => {
      if (xhr.status && xhr.status !== 200) {
        reject(new Error(`读取资源失败（HTTP ${xhr.status}）：${uri}`));
        return;
      }
      const buf = xhr.response;
      if (!buf) {
        reject(new Error(`读取资源失败（无内容）：${uri}`));
        return;
      }
      resolve(new Uint8Array(buf as ArrayBuffer));
    };
    xhr.onerror = () => reject(new Error(`读取资源失败（网络错误）：${uri}`));
    xhr.send(null);
  });
}

/**
 * 清空解包目录缓存，让下一次 ensureGhostscript 重新做完整性判定。
 * 仅供测试使用（生产代码里缓存生命周期与进程一致，无需重置）。
 */
export function resetGhostscriptCache(): void {
  gsDirCache = null;
}

/**
 * 把内置的便携版 Ghostscript 解包到临时目录，返回其根目录。
 *
 * XPI 内的二进制不能就地执行，必须先复制出来（工单 01 结论）。
 * 读取走 readResourceBytes（XHR arraybuffer），因为生产态下 rootURI 是
 * jar: URI，IOUtils 与 getResourceAsync 都不适合二进制（见其注释）。
 */
export async function ensureGhostscript(rootURI: string): Promise<string> {
  if (gsDirCache) return gsDirCache;

  const IOUtils = getIOUtils();
  const PathUtils = getPathUtils();
  const target = PathUtils.join(PathUtils.tempDir, "pdf-compress-gs");

  const srcRoot = rootURI.endsWith("/") ? rootURI : rootURI + "/";

  // 已解包且关键文件齐 → 直接复用。
  // 这一步刻意放在读 manifest 之前：manifest 在 XPI 内部（生产态是 jar:），
  // 能省掉一次跨 XPI 的读取，也让「已解包」这条常见路径完全不依赖 jar: 支持。
  if (await hasCriticalGhostscriptFiles(target)) {
    gsDirCache = target;
    return target;
  }

  // 需要解包（或判定是否要重解）时才读清单
  const manifest = await readGsManifest(srcRoot);

  if (await isGhostscriptComplete(target, manifest)) {
    gsDirCache = target;
    return target;
  }
  if (await IOUtils.exists(target)) {
    await IOUtils.remove(target, { recursive: true, ignoreAbsent: true });
  }

  await IOUtils.makeDirectory(target, { ignoreExisting: true });

  for (const rel of manifest.files) {
    const bytes = await readResourceBytes(srcRoot + "gs/" + rel);
    const dest = PathUtils.join(target, ...rel.split("/"));
    await IOUtils.makeDirectory(PathUtils.parent(dest), {
      ignoreExisting: true,
    });
    await IOUtils.write(dest, bytes);
  }

  if (!(await isGhostscriptComplete(target, manifest))) {
    throw new Error(`Ghostscript 解包不完整：${target}`);
  }
  gsDirCache = target;
  return target;
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
    stdout: "pipe",
    stderr: "pipe",
  });

  // 两个流都读：Ghostscript 的诊断信息会在 stdout 和 stderr 间分配，
  // 只读 stderr 会丢掉关键错误（实测只剩最后一行）。
  let stderr = "";
  let chunk: string | null;
  while ((chunk = await proc.stderr.readString())) stderr += chunk;
  let stdout = "";
  while ((chunk = await proc.stdout.readString())) stdout += chunk;

  const { exitCode } = await proc.wait();
  return { exitCode, stderr: stderr + "\n" + stdout };
}

/** 分类 Ghostscript 的失败原因。 */
function classifyError(
  stderr: string,
  exitCode: number,
): CompressResult["reason"] {
  const s = stderr.toLowerCase();
  // 加密优先判：stderr 里有明确的密码提示
  if (s.includes("password") || s.includes("encrypted")) return "encrypted";
  if (s.includes("permission") || s.includes("locked")) return "locked";
  // 结构损坏：解析阶段就失败
  if (
    s.includes("/undefined") ||
    s.includes("unknownerror") ||
    s.includes("couldn't initialise file") ||
    s.includes("no pages will be processed") ||
    s.includes("catalog dictionary not located") ||
    s.includes("syntaxerror in --runpdf--")
  ) {
    return "corrupt";
  }
  if (exitCode !== 0) return "gs-error";
  return "gs-error";
}

// ---------------------------------------------------------------------------
// PDF 预检（页数 + 可读性）
// ---------------------------------------------------------------------------
//
// 为什么需要它：Windows 上 Ghostscript 的 stderr 会被截断，实测只能拿到
// 最后一行「Unrecoverable error, exit code 1」，拿不到前面的
// 「This file requires a password」或「/undefined in --runpdf--」，
// 因此无法仅凭 stderr 区分「加密」与「损坏」。
// 预检用 pdfpagecount 直接问文件本身，既能区分原因，又能拿到页数。

export interface PdfProbe {
  ok: boolean;
  pageCount: number;
  reason?: "encrypted" | "corrupt";
  message?: string;
}

/** 探测 PDF 的页数与可读性。加密/损坏都会得到 ok:false。 */
async function probePdf(gsRoot: string, inputPath: string): Promise<PdfProbe> {
  const PathUtils = getPathUtils();
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  );

  const exe = PathUtils.join(gsRoot, "bin", "gswin64c.exe");
  const lib = PathUtils.join(gsRoot, "lib");
  const init = PathUtils.join(gsRoot, "Resource", "Init");

  // PostScript 字符串里反斜杠是转义字符，Windows 路径 C:\a\b 会被解析坏，
  // 导致正常文件「打不开」而被误判为损坏（实测踩到）。统一转正斜杠。
  const psPath = inputPath.replace(/\\/g, "/");

  const args = [
    `-I${lib}`,
    `-I${init}`,
    "-q",
    "-dNOPAUSE",
    "-dBATCH",
    "-dNODISPLAY",
    "-dNOSAFER",
    "-c",
    `(${psPath}) (r) file runpdfbegin pdfpagecount = quit`,
  ];

  let out = "";
  let err = "";
  try {
    const proc = await (Subprocess as any).call({
      command: exe,
      arguments: args,
      environmentAppend: true,
      stdout: "pipe",
      stderr: "pipe",
    });
    // 关键：页数走 stdout，报错走 stderr，两个流都要读。
    // 只读 stderr 会拿到空结果并把正常文件误判为损坏（实测踩到）。
    let chunk: string | null;
    while ((chunk = await proc.stdout.readString())) out += chunk;
    while ((chunk = await proc.stderr.readString())) err += chunk;
    await proc.wait();
  } catch (e: any) {
    return { ok: false, pageCount: 0, reason: "corrupt", message: e?.message };
  }

  const combined = (out + "\n" + err).toLowerCase();
  if (combined.includes("password") || combined.includes("encrypted")) {
    return {
      ok: false,
      pageCount: 0,
      reason: "encrypted",
      message: "PDF 已加密，需要密码",
    };
  }

  // 页数是 stdout 里最后的纯数字行
  const nums = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l));
  const pageCount = nums.length
    ? Number.parseInt(nums[nums.length - 1], 10)
    : 0;

  if (
    pageCount <= 0 ||
    combined.includes("couldn't initialise") ||
    combined.includes("no pages will be processed")
  ) {
    return {
      ok: false,
      pageCount: 0,
      reason: "corrupt",
      message: "PDF 结构损坏，无法解析",
    };
  }

  return { ok: true, pageCount };
}

// ---------------------------------------------------------------------------
// 输出内容校验（防空白覆盖）
// ---------------------------------------------------------------------------
//
// 为什么需要它：去掉 -dPDFSTOPONERROR 后，Ghostscript 对加密/损坏输入会返回
// 退出码 0 并产出一个空白 PDF。若该空白文件更小，「变小才替换」就会用它覆盖
// 原论文——不可逆的数据丢失。
//
// 只比对页数不够：残缺的解包目录（缺 Resource/Font、ColorSpace）会让每页都
// 渲染成空白，**页数却完全正确**，页数校验会放行（实测 419 篇里 25 篇）。
//
// 因此改为按「内容」判定：用 bbox 设备取每页的墨迹外接框，逐页比对面积。
// bbox 只做解析与路径追踪、不做光栅化，比渲染整页便宜得多。

/** 每页的墨迹外接框（[x0,y0,x1,y1]；整页空白为 [0,0,0,0]）。 */
async function pageInkBoxes(
  gsRoot: string,
  pdfPath: string,
): Promise<number[][]> {
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
    "-q",
    "-dNOPAUSE",
    "-dBATCH",
    "-dSAFER",
    "-sDEVICE=bbox",
    pdfPath,
  ];

  const proc = await (Subprocess as any).call({
    command: exe,
    arguments: args,
    environmentAppend: true,
    stdout: "pipe",
    stderr: "pipe",
  });

  // bbox 把结果写在 stderr，诊断信息在 stdout，两个流都要读。
  let err = "";
  let out = "";
  let chunk: string | null;
  while ((chunk = await proc.stderr.readString())) err += chunk;
  while ((chunk = await proc.stdout.readString())) out += chunk;
  await proc.wait();

  const boxes: number[][] = [];
  for (const line of (err + "\n" + out).split("\n")) {
    if (!line.startsWith("%%BoundingBox:")) continue;
    const nums = line
      .slice("%%BoundingBox:".length)
      .trim()
      .split(/\s+/)
      .map((t) => Number.parseFloat(t));
    if (nums.length === 4 && nums.every((n) => Number.isFinite(n))) {
      boxes.push(nums);
    }
  }
  return boxes;
}

/** 单页墨迹面积。 */
function inkArea(box: number[]): number {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

/** 输出内容校验结果。 */
export interface OutputVerdict {
  ok: boolean;
  /**
   * 未通过时的原因分类建议。
   * - `corrupt`：输入解析不全（输出页数少于原件）——原件本身有问题；
   * - `unverified`：页数一致但内容缺失/空白——多半是运行环境问题（如解包残缺）。
   */
  reason?: "corrupt" | "unverified";
  message?: string;
}

/**
 * 校验压缩输出是否忠实于原文件。
 *
 * 拒绝条件（任一命中即判定输出不可用）：
 *  1. 页数与原件不一致；
 *  2. 空白页数量比原件显著增加（超过总页数的 20%）；
 *  3. 有页面的墨迹面积骤减到原件的一半以下（超过总页数的 20%）。
 *
 * 这些阈值留了充足余量：正常压缩只会让墨迹面积轻微变化（降采样不改版式），
 * 而资源缺失或加密失败会让整页归零，两者差距是数量级的。
 */
export async function verifyOutput(
  gsRoot: string,
  originalPath: string,
  outputPath: string,
  originalPageCount: number,
): Promise<OutputVerdict> {
  const outBoxes = await pageInkBoxes(gsRoot, outputPath);

  if (!outBoxes.length) {
    return {
      ok: false,
      reason: "unverified",
      message: "输出无法解析（未取到任何页面）",
    };
  }
  if (outBoxes.length !== originalPageCount) {
    return {
      ok: false,
      reason: "corrupt",
      message: `输出页数异常（原 ${originalPageCount} 页，结果 ${outBoxes.length} 页），已放弃替换`,
    };
  }

  const origBoxes = await pageInkBoxes(gsRoot, originalPath);
  if (origBoxes.length !== originalPageCount) {
    // 原件读不到外接框就退回保守判定：只查输出是否整篇空白。
    const blank = outBoxes.filter((b) => inkArea(b) === 0).length;
    if (blank > outBoxes.length * 0.2) {
      return {
        ok: false,
        reason: "unverified",
        message: `输出有 ${blank}/${outBoxes.length} 页为空白，已放弃替换`,
      };
    }
    return { ok: true };
  }

  const n = outBoxes.length;
  const blankOrig = origBoxes.filter((b) => inkArea(b) === 0).length;
  const blankOut = outBoxes.filter((b) => inkArea(b) === 0).length;
  if (blankOut - blankOrig > n * 0.2) {
    return {
      ok: false,
      reason: "unverified",
      message: `输出空白页异常增多（原 ${blankOrig} 页 → 结果 ${blankOut} 页），已放弃替换`,
    };
  }

  let shrunk = 0;
  for (let i = 0; i < n; i++) {
    const a = inkArea(origBoxes[i]);
    const b = inkArea(outBoxes[i]);
    if (a > 0 && b / a < 0.5) shrunk++;
    else if (a === 0 && b > 0) shrunk++;
  }
  if (shrunk > n * 0.2) {
    return {
      ok: false,
      reason: "unverified",
      message: `输出有 ${shrunk}/${n} 页内容明显缺失，已放弃替换`,
    };
  }

  return { ok: true };
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

  // 预检：加密/损坏的文件在这里就被拦下，绝不可能走到「替换」那一步。
  // 同时拿到页数，供压缩后校验（防空白输出）。
  const probe = await probePdf(gsRoot, inputPath);
  if (!probe.ok) {
    return {
      ...base,
      reason: probe.reason,
      message: probe.message,
      inSize,
    };
  }

  try {
    const { exitCode, stderr } = await runGhostscript(
      gsRoot,
      preset,
      inputPath,
      tmpPath,
    );

    if (exitCode !== 0) {
      // 失败时 Ghostscript 可能已留下半成品输出，务必清掉，
      // 避免残留文件被后续流程误当成结果（或占满目录）。
      await IOUtils.remove(tmpPath, { ignoreAbsent: true });
      return {
        ...base,
        reason: classifyError(stderr, exitCode),
        message:
          stderr
            .split("\n")
            .map((l) => l.trim())
            .filter(
              (l) => l && !l.startsWith("--dict:") && !l.includes("allocation"),
            )
            .slice(0, 2)
            .join(" ") || `退出码 ${exitCode}`,
        inSize,
      };
    }

    if (!(await IOUtils.exists(tmpPath))) {
      return { ...base, reason: "gs-error", message: "未生成输出文件", inSize };
    }

    // 内容校验：按每页墨迹面积比对输出与原件。
    // 这是防「空白 PDF 覆盖原论文」的最后一道防线，覆盖三种情形：
    // 加密/损坏输入产出空白文件（退出码 0）、解包残缺导致整篇空白
    // （页数却正确）、以及任何 Ghostscript 静默丢内容的路径。
    const verdict = await verifyOutput(
      gsRoot,
      inputPath,
      tmpPath,
      probe.pageCount,
    );
    if (!verdict.ok) {
      await IOUtils.remove(tmpPath, { ignoreAbsent: true });
      return {
        ...base,
        reason: verdict.reason ?? "unverified",
        message: verdict.message,
        inSize,
      };
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
    return {
      ...base,
      reason: "gs-error",
      message: e?.message || String(e),
      inSize,
    };
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
