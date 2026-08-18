# my-harness-desktop 开发环境引导（Windows）：确保 Node.js >= 18（没有就装），然后 npm install。
# macOS / Linux 用同目录的 setup.sh。
# 运行方式：powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

$ErrorActionPreference = 'Stop'
$MinNodeMajor = 18

function Write-Log([string]$Msg) { Write-Host "[setup] $Msg" -ForegroundColor Cyan }
function Stop-Setup([string]$Msg) { Write-Host "[setup] $Msg" -ForegroundColor Red; exit 1 }

function Get-NodeMajor {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
  try { return [int](& node -p "process.versions.node.split('.')[0]") } catch { return 0 }
}

function Update-SessionPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

$repoRoot = Split-Path $PSScriptRoot -Parent

if ((Get-NodeMajor) -ge $MinNodeMajor) {
  Write-Log "Node.js $(& node -v) 已满足（>= $MinNodeMajor），跳过安装。"
} else {
  Write-Log "未检测到可用的 Node.js（需要 >= $MinNodeMajor），开始安装 ..."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Log "用 winget 安装 Node.js LTS ..."
    & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
    Write-Log "用 Chocolatey 安装 Node.js LTS ..."
    & choco install nodejs-lts -y
  } else {
    Stop-Setup "找不到 winget / choco，无法自动安装。请去 https://nodejs.org/ 下载 LTS 安装包，装完重跑本脚本。"
  }
  Update-SessionPath
  if ((Get-NodeMajor) -lt $MinNodeMajor) {
    Stop-Setup "装完当前终端还识别不到 node。请关掉这个窗口、新开一个 PowerShell，再重跑本脚本。"
  }
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Stop-Setup "node 有了但找不到 npm——npm 应随 Node.js 一起装上，请新开终端再试。"
}

Write-Log "node $(& node -v) / npm $(& npm -v)"

Write-Log "npm install ..."
Push-Location $repoRoot
try {
  & npm install
  if ($LASTEXITCODE -ne 0) { Stop-Setup "npm install 失败（exit $LASTEXITCODE）。" }
} finally {
  Pop-Location
}

Write-Host ""
Write-Log "完成。下一步："
Write-Host ""
Write-Host "  npm run dev        # 起开发窗口"
Write-Host ""
Write-Host "  若提示 'env' 不是命令：npm 脚本里有 Unix 的 env 调用，改用 Git Bash 跑 npm run dev 即可。"
Write-Host ""
Write-Host "首次使用在应用内还有两步（设置页，左栏底部齿轮入口）："
Write-Host "  1. 第一个 tab（pi-manager）安装 pi 底座版本"
Write-Host "  2. 「模型」tab（pi-model-manager）配 provider 和 API Key"
