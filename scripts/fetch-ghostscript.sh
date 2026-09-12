#!/usr/bin/env bash
# 下载并解包便携版 Ghostscript 到 addon/gs/。
#
# 为什么需要这个脚本：便携版 Ghostscript 约 42 MB（含 531 个文件），不宜提交进 git。
# 新克隆的仓库跑一次本脚本即可重建资源；addon/gs/manifest.json（文件清单，已入库）
# 由脚本一并生成，压缩核心靠它定位内置资源。
#
# 用法：bash scripts/fetch-ghostscript.sh
#
# 注意：下载源是 Artifex 官方 GitHub release。若直连 github.com 失败，
# 脚本会自动尝试镜像（GH_PROXY 环境变量可覆盖）。

set -euo pipefail

GS_VERSION="10.08.0"
GS_TAG="gs10080"
GS_FILE="gs10080w64.exe"
GS_SHA512="cb3ecc798508851ba28b05e3fb914ddefe78168190726376d8581546ce61d5b216ffa3359e6f829072786bc12350501c7b6f99110d578696b87213d157774269"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GS_DIR="$REPO_ROOT/addon/gs"
MANIFEST="$REPO_ROOT/addon/gs-manifest.json"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [ -f "$GS_DIR/bin/gswin64c.exe" ]; then
  echo "addon/gs/ 已存在，跳过下载。"
  echo "（如需强制重建，先删除 addon/gs/ 再运行）"
  exit 0
fi

BASE_URL="https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/${GS_TAG}"
URLS=("${BASE_URL}/${GS_FILE}")
if [ -n "${GH_PROXY:-}" ]; then
  URLS=("${GH_PROXY}/${BASE_URL}/${GS_FILE}")
else
  URLS+=("https://ghproxy.net/${BASE_URL}/${GS_FILE}")
  URLS+=("https://gh-proxy.com/${BASE_URL}/${GS_FILE}")
fi

echo "下载 Ghostscript ${GS_VERSION}（约 62 MB）…"
DOWNLOADED=""
for url in "${URLS[@]}"; do
  echo "  尝试 $url"
  if curl -fL --retry 3 --retry-delay 2 -o "$TMP_DIR/$GS_FILE" "$url"; then
    DOWNLOADED="$TMP_DIR/$GS_FILE"
    break
  fi
done
if [ -z "$DOWNLOADED" ]; then
  echo "错误：所有下载源均失败。可设置 GH_PROXY 指向可用镜像后重试。" >&2
  exit 1
fi

echo "校验 SHA512…"
ACTUAL="$(sha512sum "$DOWNLOADED" | awk '{print $1}')"
if [ "$ACTUAL" != "$GS_SHA512" ]; then
  echo "错误：SHA512 校验失败。" >&2
  echo "  期望 $GS_SHA512" >&2
  echo "  实际 $ACTUAL" >&2
  exit 1
fi
echo "  校验通过。"

echo "解包…"
SEVEN_ZIP="${SEVEN_ZIP:-}"
if [ -z "$SEVEN_ZIP" ]; then
  for c in 7z 7za 7zr "/c/Program Files/7-Zip/7z.exe" "/c/Program Files (x86)/7-Zip/7z.exe"; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then SEVEN_ZIP="$c"; break; fi
  done
fi
if [ -z "$SEVEN_ZIP" ]; then
  echo "错误：未找到 7-Zip。请安装后重试，或用 SEVEN_ZIP 指定路径。" >&2
  echo "  Windows: https://www.7-zip.org/ ；Debian/Ubuntu: sudo apt-get install p7zip-full" >&2
  exit 1
fi
"$SEVEN_ZIP" x -y -o"$TMP_DIR/extract" "$DOWNLOADED" >/dev/null

echo "组装便携版（剥离 doc/examples）…"
mkdir -p "$GS_DIR"
for d in bin Resource lib iccprofiles; do
  cp -r "$TMP_DIR/extract/$d" "$GS_DIR/"
done

echo "生成文件清单 $MANIFEST …"
# 兼容 Windows Git Bash / Linux（ubuntu 上只有 python3）
PYTHON=""
for p in python python3 py; do
  if command -v "$p" >/dev/null 2>&1; then PYTHON="$p"; break; fi
done
if [ -z "$PYTHON" ]; then
  echo "错误：未找到 Python（用于生成文件清单）。" >&2
  exit 1
fi
"$PYTHON" - "$GS_DIR" "$MANIFEST" <<'PYEOF'
import os, sys, json
gs_dir, manifest = sys.argv[1], sys.argv[2]
files = []
for root, _, fs in os.walk(gs_dir):
    for f in fs:
        p = os.path.relpath(os.path.join(root, f), gs_dir).replace(os.sep, "/")
        files.append(p)
files.sort()
# 显式 UTF-8：Windows CI 上 Python 默认 cp1252，写含非 ASCII 的文件名或
# 向终端输出中文都会抛 UnicodeEncodeError（GitHub Actions 实测踩到）。
with open(manifest, "w", encoding="utf-8") as fp:
    json.dump({"files": files}, fp, ensure_ascii=False, indent=0)
print("  %d files" % len(files))
PYEOF

SIZE="$(du -sh "$GS_DIR" | cut -f1)"
echo "完成：$GS_DIR（$SIZE）"
echo "提示：addon/gs/ 已被 .gitignore 忽略，不会进入版本控制。"