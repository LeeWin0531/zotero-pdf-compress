# Zotero PDF 压缩

一个 Zotero 9 插件：右键论文 PDF 附件即可压缩，内置便携版 Ghostscript，**默认原地覆盖、保留标注**。

## 功能

- 右键一个或多个 PDF 附件 → **压缩 PDF ▸ 均衡压缩 / 激进压缩**
- 内置 Ghostscript 10.08.0，无需自行安装，离线可用
- **默认原地覆盖**：附件条目与路径不变，因此标注、高亮、笔记全部保留
- 可切换「新增副本」模式：保留原附件，另存一个压缩后的副本
- 仅当压缩后明显变小才替换，否则保留原文件（避免「压完反而变大」）
- 压缩前自动关闭该 PDF 的阅读器（Windows 下文件被锁定时必需）
- 完整中文设置面板

> **注意**：原地覆盖**不可撤销**，且默认不保留原件备份。建议先拿一两个不重要的 PDF 试用，确认画质可接受后再批量使用。

## 实测效果

真实论文 PDF（3.71 MB）：

| 档位 | 输出 | 压缩率 |
|---|---|---|
| 均衡（150 DPI） | 1.38 MB | −62.8% |
| 激进（100 DPI） | 0.94 MB | −74.6% |

矢量文字几乎无损，收益主要来自嵌入的位图图表降采样。已经高度优化过的 PDF 可能几乎没有收益。

## 安装

1. 构建（见下）或用现成的 `.scaffold/build/pdf-压缩-*.xpi`
2. Zotero → 工具 → 插件 → 齿轮 → 从文件安装插件
3. 重启 Zotero

要求在 **Zotero 9.0.\***，Windows。

## 开发

```bash
npm install
npm run fetch-gs     # 下载并解包 Ghostscript 到 addon/gs/（约 42 MB，不入库）
npm run build        # 产出 .scaffold/build/*.xpi 并做类型检查
```

调试与测试（用独立 profile / 数据目录，不会碰到主库）：

```bash
# 交互式调试（启动一个独立的 Zotero 实例）
ZOTERO_PLUGIN_ZOTERO_BIN_PATH="F:\\zotero7\\zotero.exe" npm start

# 自动化测试
ZOTERO_PLUGIN_ZOTERO_BIN_PATH="F:\\zotero7\\zotero.exe" npm test -- --exit-on-finish
```

### 项目结构

```
addon/                 插件静态资源
  bootstrap.js           Zotero bootstrap 生命周期
  manifest.json
  prefs.js               首选项默认值
  locale/                Fluent 本地化（zh-CN / en-US）
  content/preferences.xhtml   设置面板
  gs/                    便携版 Ghostscript（由 fetch-gs 生成，不入库）
  gs-manifest.json       内置资源清单（入库；压缩核心靠它定位文件）
src/
  hooks.ts               生命周期、菜单、设置面板注册
  modules/compressor.ts  压缩核心（Ghostscript 调用、变小才替换、原子替换）
test/                    自动化测试
scripts/fetch-ghostscript.sh  下载并解包 Ghostscript
```

## 实现要点（踩过的坑）

开发时踩到不少 Zotero 9 的隐蔽陷阱，记录在此以免重蹈：

1. `Zotero.Plugins.getRootURI()` 是 **async**，必须 await。
2. `onMainWindowLoad` **不会对已存在的主窗口触发**；须在 `onStartup` 里遍历 `Zotero.getMainWindows()`。
3. `IOUtils` 只接受**原生路径**，不认 `file://` URI（需经 `nsIFileURL.file.path` 转换）。
4. `fetch()` 读不了 `file://`（改用 `IOUtils.read`）。
5. Zotero 9 没有 `resource://gre/modules/IOUtils.sys.mjs`（用全局）；但 `Subprocess.sys.mjs` 的这个路径**是**有效的。
6. 构建 glob `addon/**/*.*` 会漏掉**无扩展名**文件，须写 `addon/**/*`。
7. 真实安装的 XPI 里 `rootURI` 是 `jar:`，目录枚举无效 → 用构建期生成的文件清单。
8. **Fluent 的菜单/控件标签必须写成 `.label = ...` attributes 形式**，`key = 值` 不生效。
9. XHTML 的 `data-l10n-id` 用**带前缀**的全名，FTL 文件里写**不带前缀**的 key（构建器自动加）。
10. `server.devtools` 默认为 `true` 会加 `--jsdebugger` 使测试挂起，须设 `false`。
11. 测试须用页面提供的**全局 `assert`**，不能 `import ... from "chai"`（打包冲突会让整个套件静默消失）。

## 授权

AGPL-3.0-or-later。内置的 Ghostscript 为 Artifex 的 AGPL-3.0 授权软件，以独立进程调用、未做修改。

> **公开发布前必办**：随包附上 Ghostscript 的 LICENSE/COPYING 与源码获取说明；或改为要求用户自行安装 Ghostscript。
