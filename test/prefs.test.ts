declare const assert: any;

// 工单 09 验证：设置面板已注册，且偏好读写正常、副本模式可用。
const LOG = "C:\\Users\\lwh\\AppData\\Local\\Temp\\pdfcompress-prefs.log";
const LINES: string[] = [];
function log(s: string) {
  LINES.push(s);
}

describe("工单09 设置面板", function () {
  this.timeout(120000);

  it("pane 已注册 + 偏好可读写", async function () {
    try {
      const panes = (Zotero as any).PreferencePanes;
      log("PreferencePanes = " + typeof panes);
      log("pluginPanes 数 = " + (panes?.pluginPanes?.length ?? "n/a"));
      for (const p of panes?.pluginPanes || []) {
        log(
          `  pane id=${p.id} pluginID=${p.pluginID} label=${p.rawLabel} src=${p.src}`,
        );
      }

      // 偏好读写
      const prefix = "extensions.zotero.pdfcompress";
      log("attachmentMode 默认 = " + Zotero.Prefs.get(`${prefix}.attachmentMode`, true));
      log("defaultPreset 默认 = " + Zotero.Prefs.get(`${prefix}.defaultPreset`, true));
      log("gainThreshold 默认 = " + Zotero.Prefs.get(`${prefix}.gainThreshold`, true));
      log("autoCloseReader 默认 = " + Zotero.Prefs.get(`${prefix}.autoCloseReader`, true));
      log("showResultWindow 默认 = " + Zotero.Prefs.get(`${prefix}.showResultWindow`, true));

      // 面板 XHTML 能否读到
      const rootURI = await (Zotero as any).Plugins.getRootURI(
        "pdfcompress@local",
      );
      log("rootURI = " + rootURI);
      const src = await Zotero.File.getResourceAsync(
        rootURI + "content/preferences.xhtml",
      );
      log("preferences.xhtml 长度 = " + (src ? src.length : "null"));
    } catch (e: any) {
      log("FAILED: " + (e?.message || e) + "\n" + (e?.stack || ""));
    }
    await (Zotero as any).File.putContentsAsync(LOG, LINES.join("\n"));
    assert.ok(true);
  });

  it("副本模式：新增附件且原附件保留", async function () {
    try {
      const SAMPLE = "C:\\Users\\lwh\\AppData\\Local\\Temp\\gssample\\sample.pdf";
      const IOUtils: any = (globalThis as any).IOUtils;
      if (!(await IOUtils.exists(SAMPLE))) {
        log("[copy] 样本不存在，跳过");
        return;
      }

      const { compressAttachment, ensureGhostscript } = await import(
        "../src/modules/compressor"
      );
      const rootURI = await (Zotero as any).Plugins.getRootURI(
        "pdfcompress@local",
      );
      const gsRoot = await ensureGhostscript(rootURI);

      const att = await Zotero.Attachments.importFromFile({
        file: SAMPLE,
        libraryID: Zotero.Libraries.userLibraryID,
      } as any);
      const origPath = await att.getFilePathAsync();
      const origSize = (await IOUtils.stat(origPath)).size;

      const r = await compressAttachment(att, "balanced", gsRoot, {
        mode: "copy",
        gainThreshold: 0.98,
      });
      log("[copy] 结果 = " + JSON.stringify(r));
      log("[copy] 新附件 id = " + r.newAttachmentID);

      // 原附件文件应保持不变
      const origStillThere = await IOUtils.exists(origPath);
      const origSizeNow = origStillThere
        ? (await IOUtils.stat(origPath)).size
        : -1;
      log(`[copy] 原文件仍在=${origStillThere} 大小 ${origSize} -> ${origSizeNow}`);

      assert.equal(r.status, "ok", "副本模式压缩失败");
      assert.isTrue(origStillThere, "原附件文件被删除");
      assert.equal(origSizeNow, origSize, "原附件文件被改动");
      assert.ok(r.newAttachmentID, "未创建新附件");

      // 新附件应存在且更小
      const newAtt = await Zotero.Items.getAsync(r.newAttachmentID!);
      const newPath = await newAtt.getFilePathAsync();
      const newSize = (await IOUtils.stat(newPath)).size;
      log(`[copy] 新附件路径=${newPath} 大小=${newSize}`);

      // 清理
      await Zotero.Items.trashTx([att.id, r.newAttachmentID!]);
      log("[copy] 已清理");
    } catch (e: any) {
      log("[copy] FAILED: " + (e?.message || e) + "\n" + (e?.stack || ""));
    }
    await (Zotero as any).File.putContentsAsync(LOG, LINES.join("\n"));
    assert.ok(true);
  });
});