#!/usr/bin/env bash
# pi-desktop 开发环境引导（macOS / Linux）：确保 Node.js >= 18（没有就装），然后 npm install。
# Windows 用同目录的 setup.ps1。
set -euo pipefail

MIN_NODE_MAJOR=18
NVM_VERSION="v0.40.3"

log()  { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[setup]\033[0m %s\n' "$*" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) die "未支持的平台：${OS}。Windows 请用 PowerShell 跑 scripts\\setup.ps1。" ;;
esac

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

install_with_brew() {
  command -v brew >/dev/null 2>&1 || return 1
  log "检测到 Homebrew，安装 Node.js ..."
  brew install node
}

install_with_nvm() {
  command -v curl >/dev/null 2>&1 || return 1
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    log "安装 nvm ($NVM_VERSION) ..."
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  log "用 nvm 安装 Node.js LTS ..."
  nvm install --lts
}

# --- 1. Node.js -------------------------------------------------------------

if [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ]; then
  log "Node.js $(node -v) 已满足（>= ${MIN_NODE_MAJOR}），跳过安装。"
else
  log "未检测到可用的 Node.js（需要 >= ${MIN_NODE_MAJOR}），开始安装 ..."
  if [ "$OS" = "Darwin" ]; then
    install_with_brew || install_with_nvm \
      || die "自动安装失败。请手动安装 Node.js LTS：https://nodejs.org/ 装完重跑本脚本。"
  else
    install_with_nvm \
      || die "自动安装失败（需要 curl）。请手动安装 Node.js LTS：https://nodejs.org/ 装完重跑本脚本。"
  fi
  [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] \
    || die "装完当前 shell 仍识别不到 Node.js >= ${MIN_NODE_MAJOR}。请新开一个终端再跑本脚本。"
fi

command -v npm >/dev/null 2>&1 \
  || die "node 有了但找不到 npm——npm 应随 Node.js 一起装上，请新开终端再试。"

log "node $(node -v) / npm $(npm -v)"

# --- 2. Linux 上补 Electron 运行库（仅 Debian/Ubuntu 系，可跳过） --------------

if [ "$OS" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
  if [ -t 0 ]; then
    printf '\033[1;33m[setup]\033[0m %s' \
      "Debian/Ubuntu 系：Electron 起窗口需要一组系统库（libgtk-3、libnss3、libasound2 等）。现在用 sudo apt-get 安装？[Y/n] "
    read -r ans || ans="Y"
    case "${ans:-Y}" in
      [Nn]*)
        warn "跳过。之后 npm run dev 起不来窗口的话，记得回来补这些库。"
        ;;
      *)
        sudo apt-get update
        # Ubuntu 24.04 起 libasound2 改名 libasound2t64，两个名字都试一下
        sudo apt-get install -y libgtk-3-0 libnss3 libxss1 libgbm1 libasound2 \
          || sudo apt-get install -y libgtk-3-0 libnss3 libxss1 libgbm1 libasound2t64
        ;;
    esac
  else
    warn "非交互终端，跳过 Electron 系统库安装。Debian/Ubuntu 系如起不来窗口，手动执行："
    warn "  sudo apt-get install -y libgtk-3-0 libnss3 libxss1 libgbm1 libasound2"
  fi
fi

# --- 3. 依赖 -----------------------------------------------------------------

log "npm install ..."
cd "$REPO_ROOT"
npm install

cat <<EOF

$(printf '\033[1;32m[setup]\033[0m') 完成。下一步：

  npm run dev        # 起开发窗口

首次使用在应用内还有两步（设置页，左栏底部齿轮入口）：
  1. 第一个 tab（pi-manager）安装 pi 底座版本
  2. 「模型」tab（pi-model-manager）配 provider 和 API Key
EOF
