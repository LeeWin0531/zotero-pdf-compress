declare const assert: any;
import { config } from "../package.json";

// 工单 03：验证调研给出的 Zotero 9 API 假设（轻量回归）。
// 压缩功能本身由 compress.test.ts 覆盖。

describe("工单03 API 基线", function () {
  this.timeout(60000);

  it("插件实例已加载", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("Zotero.MenuManager 存在且 registerMenu 可调用", function () {
    const mm = (Zotero as any).MenuManager;
    assert.isDefined(mm, "Zotero.MenuManager 不存在");
    assert.isFunction(mm.registerMenu, "registerMenu 不是函数");
  });

  it("插件已通过 MenuManager 注册菜单（无回退）", function () {
    const data = (Zotero as any)[config.addonInstance].data;
    console.log("[proto] 注册路径 =", data.protoMenuMode, "错误 =", data.protoError);
    assert.equal(
      data.protoMenuMode,
      "MenuManager",
      `未能走官方 MenuManager（err=${data.protoError}）`,
    );
  });

  it("附件 API 存在", function () {
    const itemProto = Zotero.Item.prototype as any;
    assert.isFunction(itemProto.getFilePathAsync);
    assert.isFunction(itemProto.isFileAttachment);
  });

  it("Subprocess 可加载", function () {
    const { Subprocess } = ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs",
    );
    assert.isFunction((Subprocess as any).call);
  });
});