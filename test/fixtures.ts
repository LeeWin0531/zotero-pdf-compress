// 测试素材生成器（回归测试专用）。
//
// 为什么在测试里现造 PDF：这些用例需要特定形态的素材——页数正确但整篇空白的
// PDF、带越界书签的 PDF——在用户库里找不到，也不该依赖用户本地文件。
// 用 Ghostscript 自己的 pdfwrite 生成，保证是真实可解析的 PDF。

declare const assert: any;

import { config } from "../package.json";
import { ensureGhostscript } from "../src/modules/compressor";

const IOUtils: any = (globalThis as any).IOUtils;
const PathUtils: any = (globalThis as any).PathUtils;

/** 解包 Ghostscript 的根目录（供生成素材用）。 */
async function gsRootForFixtures(): Promise<string> {
  const rootURI = await (Zotero as any).Plugins.getRootURI(config.addonID);
  return ensureGhostscript(rootURI);
}

/** 用 PostScript 生成一个 n 页、每页有文字的 PDF。 */
async function makePdf(path: string, pages: number): Promise<void> {
  const ps = [
    "%!PS-Adobe-3.0",
    "<< /PageSize [612 792] >> setpagedevice",
    "/Times-Roman findfont 18 scalefont setfont",
    ...Array.from({ length: pages }, (_, i) => [
      `72 720 moveto (Fixture page ${i + 1} of ${pages}) show`,
      "72 690 moveto (Lorem ipsum dolor sit amet, consectetur adipiscing elit.) show",
      "72 660 moveto (Sed do eiusmod tempor incididunt ut labore et dolore.) show",
      "showpage",
    ]).flat(),
  ].join("\n");

  await runGsPs(path, ps);
}

/** 生成 n 页全空白的 PDF（页数正确，但没有任何墨迹）。 */
async function makeBlankPdf(path: string, pages: number): Promise<void> {
  const ps = [
    "%!PS-Adobe-3.0",
    "<< /PageSize [612 792] >> setpagedevice",
    ...Array.from({ length: pages }, () => "showpage"),
  ].join("\n");

  await runGsPs(path, ps);
}

/**
 * 生成一个带「越界书签」的 PDF。
 *
 * 这是真实论文里最常见的瑕疵：目录（outline）指向的页码超出实际页数，
 * Ghostscript 会报 "A pdfmark destination page N points beyond the last
 * page M"。旧版的 -dPDFSTOPONERROR 会因此让整个转换在第一页崩掉。
 */
async function makePdfWithBrokenToc(
  path: string,
  pages: number,
): Promise<void> {
  const ps = [
    "%!PS-Adobe-3.0",
    "<< /PageSize [612 792] >> setpagedevice",
    "/Times-Roman findfont 18 scalefont setfont",
    // 先写一页正文
    ...Array.from({ length: pages }, (_, i) => [
      `72 720 moveto (Page ${i + 1}) show`,
      "showpage",
    ]).flat(),
    // 再声明一个指向第 999 页的书签 —— 远超实际页数。
    // 用 pdfmark 的 /Page 形式制造越界目标。
    "[/Title (Broken bookmark) /Page 999 /OUT pdfmark",
  ].join("\n");

  await runGsPs(path, ps);
}

/** 用 Ghostscript 把 PostScript 转成 PDF。 */
async function runGsPs(outPath: string, ps: string): Promise<void> {
  const gsRoot = await gsRootForFixtures();
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  );

  const tmpPs = outPath + ".ps";
  await IOUtils.writeUTF8(tmpPs, ps);

  const proc = await (Subprocess as any).call({
    command: PathUtils.join(gsRoot, "bin", "gswin64c.exe"),
    arguments: [
      `-I${PathUtils.join(gsRoot, "lib")}`,
      `-I${PathUtils.join(gsRoot, "Resource", "Init")}`,
      "-dNOPAUSE",
      "-dQUIET",
      "-dBATCH",
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.7",
      `-sOutputFile=${outPath}`,
      tmpPs,
    ],
    environmentAppend: true,
    stdout: "pipe",
    stderr: "pipe",
  });

  let err = "";
  let c: string | null;
  while ((c = await proc.stderr.readString())) err += c;
  while ((c = await proc.stdout.readString())) {
    /* drain */
  }
  const { exitCode } = await proc.wait();
  await IOUtils.remove(tmpPs, { ignoreAbsent: true });

  if (exitCode !== 0) {
    throw new Error(`生成测试素材失败（exit ${exitCode}）: ${err}`);
  }
}

/**
 * 生成一个「图形状态不平衡」的 PDF —— 复现 Bug A 的最小素材。
 *
 * 每页引用一个 Form XObject，其内容流多了一个 `Q`（多余的 restore）。
 * 这是真实 PDF 里常见的瑕疵（PDF 生成器 bug、拼接工具留下的残渣），
 * Ghostscript 不带 -dPDFSTOPONERROR 时能正常恢复并把所有页画出来；
 * 带上该开关则把每页的 .PDFDrawPage 都升级为致命错误，
 * 在第一页就崩掉，只产出 1 页残缺文件（实测 6 页 → 1 页）。
 *
 * 页面里同时嵌入一张噪声图，确保降采样后有足够收益，
 * 否则会被「无收益阈值」拦下而测不到压缩路径。
 */
async function makePdfWithUnbalancedForm(
  path: string,
  pages: number,
): Promise<void> {
  const width = 700;
  const height = 700;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = (x * 3 + y * 5) % 251;
      const i = (y * width + x) * 3;
      rgb[i] = v;
      rgb[i + 1] = (v * 7) % 251;
      rgb[i + 2] = (v * 13) % 251;
    }
  }

  // 全部用未压缩流（不带 /Filter）。PDF 允许裸流，Ghostscript 能正常读；
  // 而未压缩的噪声图正好让 pdfwrite 有充足压缩空间，
  // 确保能通过「变小才替换」阈值，从而真正走到内容校验那一步。
  const objs: Record<number, Uint8Array> = {};
  const enc = (s: string) => new TextEncoder().encode(s);
  const stream = (dict: string, body: Uint8Array) =>
    concat([
      enc(`${dict}/Length ${body.length}>>stream\n`),
      body,
      enc("\nendstream"),
    ]);

  objs[10] = stream(
    `<</Type/XObject/Subtype/Image/Width ${width}/Height ${height}` +
      `/ColorSpace/DeviceRGB/BitsPerComponent 8`,
    rgb,
  );

  // 关键：内容流末尾多一个 Q，制造图形状态不平衡。
  objs[11] = stream(
    "<</Type/XObject/Subtype/Form/BBox[0 0 612 792]/Resources" +
      "<</Font<</F1 20 0 R>>/XObject<</Im 10 0 R>>>>",
    enc("q 1 0 0 1 40 40 cm BT /F1 12 Tf 0 0 Td (form text) Tj ET Q\nQ\n"),
  );

  const kids: number[] = [];
  for (let i = 0; i < pages; i++) {
    const n = 100 + i;
    objs[n] = enc(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ` +
        `${n + 1000} 0 R/Resources<</Font<</F1 20 0 R>>` +
        `/XObject<</Fm 11 0 R/Im 10 0 R>>>>>>`,
    );
    objs[n + 1000] = stream(
      "<</",
      enc(
        "q 1 0 0 1 0 0 cm /Im Do Q\n" +
          "q 1 0 0 1 0 0 cm /Fm Do Q\n" +
          `BT /F1 14 Tf 72 750 Td (Page ${i + 1} of ${pages}) Tj ET\n`,
      ),
    );
    kids.push(n);
  }

  objs[1] = enc("<</Type/Catalog/Pages 2 0 R>>");
  objs[2] = enc(
    `<</Type/Pages/Kids[${kids.map((k) => `${k} 0 R`).join(" ")}]` +
      `/Count ${pages}>>`,
  );
  objs[20] = enc("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");

  const maxObj = Math.max(...Object.keys(objs).map(Number));
  const parts: Uint8Array[] = [enc("%PDF-1.4\n")];
  let offset = parts[0].length;
  const offsets: Record<number, number> = {};
  for (const n of Object.keys(objs)
    .map(Number)
    .sort((a, b) => a - b)) {
    offsets[n] = offset;
    const chunk = concat([enc(`${n} 0 obj`), objs[n], enc("endobj\n")]);
    parts.push(chunk);
    offset += chunk.length;
  }
  const xrefOffset = offset;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) {
    xref +=
      offsets[n] !== undefined
        ? `${String(offsets[n]).padStart(10, "0")} 00000 n \n`
        : "0000000000 65535 f \n";
  }
  parts.push(
    enc(
      xref +
        `trailer<</Size ${maxObj + 1}/Root 1 0 R>>\nstartxref\n` +
        `${xrefOffset}\n%%EOF\n`,
    ),
  );

  await IOUtils.write(path, concat(parts));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export {
  makePdf,
  makeBlankPdf,
  makePdfWithBrokenToc,
  makePdfWithUnbalancedForm,
};
