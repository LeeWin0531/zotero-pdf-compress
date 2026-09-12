# Zotero PDF 压缩

一个 Zotero 插件：**右键论文 PDF 附件就能压缩**，把动辄几十 MB 的论文压到原来的三分之一左右，打开和同步都更快。内置便携版 Ghostscript，装完即用，不需要另外安装任何东西。

**默认原地替换原文件，标注、高亮、笔记全部保留。**

- 平台：**Windows**
- 适用：**Zotero 9.0.x**
- 语言：中文

---

## 这个插件能帮你做什么

论文 PDF 里通常嵌着大量高分辨率的位图图表，一个文件几十 MB，Zotero 打开慢、同步也慢。这个插件用 Ghostscript 把内嵌图片按合适的 DPI 重新采样，**正文文字和矢量图形几乎无损**，但体积能降一大截。

压缩在你的电脑上离线完成，不联网、不上传任何东西。

## 实测效果

一篇真实论文（3.71 MB）：

| 档位 | 压缩后 | 压缩率 |
|---|---|---|
| **均衡**（150 DPI，画质优先） | 1.38 MB | **−62.8%** |
| **激进**（100 DPI，体积优先） | 0.94 MB | **−74.6%** |

已经高度优化过的 PDF 可能几乎没有收益——这种情况插件会**自动放弃**，保留原文件（见下文「无收益保护」）。

---

## 安装

### 第一步：下载插件文件

到本仓库的 [Releases](../../releases) 页面下载最新的 `pdf-压缩.xpi` 文件。

> 如果 Releases 里还没有，说明维护者尚未发布构建产物，需要自行构建（见文末「自行构建」）。

### 第二步：在 Zotero 中安装

1. 打开 Zotero
2. 菜单栏 **工具 → 插件**（Tools → Add-ons）
3. 点右上角的**齿轮图标 ⚙ → Install Add-on From File...**（从文件安装插件）
4. 选中刚下载的 `pdf-压缩.xpi`
5. 点 **Install Now**，然后**重启 Zotero**

### 第三步：确认安装成功

重启后，在文献列表中**右键点一个 PDF 附件**，菜单里应该出现：

```
压缩 PDF  ▸  均衡压缩
             激进压缩
```

看到这个子菜单就说明装好了。

> 如果菜单里没有，先确认右键的是**PDF 附件**（不是父条目，也不是别的类型附件）。本插件只对 PDF 附件生效，非 PDF 会被自动置灰。

---

## 怎么用

### 压缩单个 PDF

在文献列表中右键一个 PDF 附件 → **压缩 PDF → 均衡压缩**（或激进压缩）。

右下角会出现进度提示，完成后显示汇总，例如：

```
成功压缩：1 个　节省：2.3 MB（3.71 MB → 1.38 MB）
```

提示会在几秒后自动消失，不会挡住你阅读。

### 一次压缩多个

**按住 Ctrl（或 Shift）多选**几个 PDF 附件，再右键压缩。插件会**一个一个串行处理**，并在进度提示里显示 `[2/5] 论文标题` 这样的进度。个别文件失败不会影响其余的。

### 两个档位怎么选

| 档位 | 内嵌图片 DPI | 适合 |
|---|---|---|
| **均衡压缩** | 150 DPI | **默认推荐**。图表细节保留得好，日常阅读和打印都够用 |
| **激进压缩** | 100 DPI | 只在屏幕上读、想尽量省空间时用。图表放大后会略糊 |

**建议**：先拿一两篇不重要的论文试均衡档，翻到有图表的那页看看效果能不能接受，再决定要不要批量用。

### 关于标注（重要）

插件默认**原地替换原文件**——附件条目和文件路径都不变，所以**你在 PDF 上做的所有标注、高亮、笔记都会完整保留**，压缩后重新打开位置依然对得上。

代价是：**压缩不可撤销，默认不保留原件备份**。所以强烈建议先试一两篇确认画质。

如果你不想动原文件，可以在设置里改成「新增副本」模式（见下）。

---

## 设置

**编辑 → 设置 → PDF 压缩**（Edit → Preferences → PDF 压缩）

| 设置项 | 默认 | 说明 |
|---|---|---|
| **附件处理方式** | 原地覆盖 | **原地覆盖**：替换原文件，标注保留（推荐）<br>**新增副本**：保留原文件，另存一个「原名（已压缩）.pdf」。⚠️ 新副本**不含**原有标注 |
| **默认预设** | 均衡 | 右键菜单里的默认档位 |
| **无收益阈值** | 缩小不到 2% 就放弃 | 压缩后如果没比原来小够这个幅度，就视为无收益、保留原文件 |
| **压缩前自动关闭阅读器** | 开 | Windows 下 PDF 被阅读器打开时文件是锁住的，必须先关闭才能替换。压缩完重新打开即可看到压缩后的版本 |
| **压缩完成后显示结果提示** | 开 | 关掉后不再弹右下角汇总（失败提示仍会弹出） |

---

## 安全机制

插件在「替换原文件」这件事上做了多重保护，避免把你的论文弄坏：

1. **变小才替换**：压缩结果必须比原文件小够一定幅度（默认 2%），否则保留原文件并提示「无收益」。绝不会出现「压完反而变大」。
2. **原子替换**：先写到同目录的临时文件，确认无误后才替换，中途失败原文件不受影响。
3. **加密 PDF 会被识别并跳过**：不会尝试压缩，原文件保持原样。
4. **损坏 PDF 会被识别并跳过**：同样保持原样。
5. **页数校验**：压缩结果的页数必须与原文件一致，否则一律放弃替换。
6. **失败自动清理**：任何环节失败都会清掉临时文件，不留垃圾。

> 第 3–5 条不是多余的：Ghostscript 遇到无法解密的文件时，会「成功」输出一个**空白 PDF**。如果不做这些检查，一个加密论文就会被空白文件悄悄替换掉。这个坑在开发时实际踩到过，所以专门做了防护。

---

## 常见问题

**Q：右键菜单里没有「压缩 PDF」？**
确认你右键的是 PDF **附件**而不是父条目。另外本插件要求 Zotero 9.0.x，其他大版本不支持。

**Q：压缩完标注会丢吗？**
不会。默认的「原地覆盖」模式只替换文件的字节内容，附件条目本身不变，标注/高亮/笔记都存在 Zotero 数据库里、与条目关联，因此完整保留。

**Q：能撤销吗？**
不能。默认不保留备份。这就是为什么建议先拿不重要的论文试。

**Q：压缩后画质变差了吗？**
正文文字和矢量线条是无损的，变化只发生在大尺寸位图图表上（被重新采样到 150/100 DPI）。正常阅读尺寸下通常看不出差别，放大图表才会。

**Q：压缩要多久？**
首次使用需要解包内置的 Ghostscript（约 2–3 秒，只发生一次）。之后每个文件通常几秒，取决于文件大小。

**Q：会联网吗？**
不会。压缩完全在本机离线完成。插件不收集、不上传任何数据。

**Q：压缩后 Zotero 同步会怎样？**
文件变小了，下次同步会重新上传压缩后的版本（这对你有利——上传更快、占用更少）。

**Q：支持 Mac / Linux 吗？**
目前只支持 Windows。内置的是 Windows 版 Ghostscript。

---

## 卸载

**工具 → 插件 → 找到「PDF 压缩」→ 移除**，然后重启 Zotero。

右键菜单和所有监听器都会被干净移除。已被压缩的文件**不会**被还原（压缩是永久性的）。

---

## 授权与第三方组件

本插件采用 **AGPL-3.0-or-later** 授权。

插件内置了 **GPL Ghostscript 10.08.0**（Artifex Software），同样以 AGPL-3.0 授权。插件以**独立进程**方式调用未经修改的 Ghostscript，属于聚合分发。Ghostscript 的许可证原文随插件一同分发，见 [`addon/gs-license/GHOSTSCRIPT-LICENSE.txt`](addon/gs-license/GHOSTSCRIPT-LICENSE.txt)。

Ghostscript 源码获取：<https://github.com/ArtifexSoftware/ghostpdl>

---
---

# 开发者文档

以下内容面向想自行构建、修改或二次开发的人。普通用户不需要看。

## 自行构建

需要 Node.js 18+ 和 [7-Zip](https://www.7-zip.org/)（用于解包 Ghostscript）。

```bash
npm install
npm run fetch-gs     # 下载并解包 Ghostscript 到 addon/gs/（约 42 MB，不入库）
npm run build        # 产出 .scaffold/build/pdf-压缩.xpi 并做类型检查
```

`fetch-gs` 会从 Artifex 官方 release 下载 `gs10080w64.exe`，校验 SHA512 后解包，只保留 `bin/ Resource/ lib/ iccprofiles/`，并重新生成 `addon/gs-manifest.json`。若直连 GitHub 失败，脚本会自动尝试镜像（可用 `GH_PROXY` 环境变量覆盖）。

> **注意**：`addon/gs/` 有 42 MB、531 个文件，已被 `.gitignore` 忽略，不入库。但 `addon/gs-manifest.json`（文件清单）**必须入库**——压缩核心靠它定位内置资源。

## 开发与测试

```bash
# 交互式调试（启动独立的 Zotero 实例，带热重载）
ZOTERO_PLUGIN_ZOTERO_BIN_PATH="F:\\zotero7\\zotero.exe" npm start

# 自动化测试（用独立 profile / 数据目录，不会碰到你的主库）
ZOTERO_PLUGIN_ZOTERO_BIN_PATH="F:\\zotero7\\zotero.exe" npm test -- --exit-on-finish
```

测试共 26 项，覆盖压缩核心、批处理编排、设置面板、菜单注册/卸载、以及端到端验收（真实论文压缩、标注保留、加密/损坏归类、阅读器占用）。端到端测试需要临时素材，见 `test/e2e.test.ts` 顶部的路径说明。

## 项目结构

```
addon/                        插件静态资源
  bootstrap.js                  Zotero bootstrap 生命周期
  manifest.json
  prefs.js                      首选项默认值
  locale/{zh-CN,en-US}/         Fluent 本地化
  content/preferences.xhtml     设置面板
  gs-license/                   Ghostscript 许可证（随包分发）
  gs/                           便携版 Ghostscript（fetch-gs 生成，不入库）
  gs-manifest.json              内置资源清单（入库）
src/
  hooks.ts                      生命周期、菜单、设置面板注册、UI 装配
  modules/compressor.ts         压缩核心（Ghostscript 调用、预检、变小才替换、原子替换）
  modules/batch.ts              批处理编排与汇总（与 UI 解耦，可测试）
test/                           自动化测试
scripts/fetch-ghostscript.sh    下载并解包 Ghostscript
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
12. **设置面板的 XHTML 不能有 `<?xml ... ?>` 声明**——面板是当 fragment 解析的，声明会让解析报 `not well-formed XML`，表现为「侧栏有标签、点了不切换」。
13. **Ghostscript 对加密/损坏 PDF 返回退出码 0 并产出空白 PDF**。不加 `-dPDFSTOPONERROR` 时，「变小才替换」会把原论文替换成空白文件（**数据丢失**）。现用三重防护：`-dPDFSTOPONERROR` + 压缩前预检 + 压缩后页数校验。
14. **Windows 上 Ghostscript 的 stderr 会被截断**（只剩最后一行），无法据以区分加密与损坏；且**页数走 stdout、报错走 stderr**，两个流都要读。改用 `pdfpagecount` 预检。
15. **PostScript 字符串里反斜杠是转义字符**：Windows 路径 `C:\a\b` 直接拼进 `(...)` 会解析坏，必须转正斜杠。
16. **`unregisterMenu` 的 key 是 `CSS.escape(\`${pluginID}-${menuID}\`)`**（`@` 被转义成 `\@`），手写拼接必然对不上、卸载后菜单残留。须捕获 `registerMenu` 的返回值原样传回。

## 公开发布注意事项

如果要正式对外发布，还需要处理：

- **Ghostscript 合规**：目前已在 `addon/gs-license/` 附带许可证原文。公开发布时建议同时提供源码获取链接（AGPL 要求）。
- **打包体积**：XPI 约 23 MB（其中 Ghostscript 占绝大部分）。若嫌大，可改为「首次使用时下载」或「引导用户自行安装 Ghostscript」。
- **更新机制**：`manifest.json` 的 `update_url` 指向 GitHub Releases 的 `update.json`，需要相应发布流程配合。
- **Zotero 10 前瞻**：Zotero 10（2026-09）有破坏性变更，届时需同步升级 `strict_max_version` 与相关 API。