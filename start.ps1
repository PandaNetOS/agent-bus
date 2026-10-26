<#
.SYNOPSIS
  启动 agent-bus 工作台（busd），可选带 driver

.DESCRIPTION
  用 Start-Process 脱离当前 shell 启动，所以关掉终端不影响。
  pid 写到 runtime 目录的 .pid-<name>，stop.ps1 按它杀。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1 -WithDrivers
  powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1 -Port 8090 -WithDrivers
#>
param(
  [int]$Port = 8088,
  [switch]$WithDrivers,
  [string]$Root = 'D:\PNOS\agent-bus'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }

$env:AGENT_BUS_ROOT = $Root
$env:PORT = "$Port"

function Start-Bg {
  param([string]$Name, [string[]]$ArgList)
  $out = Join-Path $Root "$Name.log"
  $err = Join-Path $Root "$Name.err.log"
  $p = Start-Process -FilePath 'node' -ArgumentList $ArgList -WorkingDirectory $Repo `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  Set-Content -Path (Join-Path $Root ".pid-$Name") -Value $p.Id -Encoding ascii
  Write-Output ("  {0,-16} pid={1}  日志 {2}" -f $Name, $p.Id, $out)
}

Write-Output "agent-bus root: $Root"
Start-Bg -Name 'busd' -ArgList @('webui/busd.mjs')

if ($WithDrivers) {
  Start-Bg -Name 'driver-hermes' -ArgList @('drivers/hermes.mjs')
  Start-Bg -Name 'driver-opencode' -ArgList @('drivers/opencode.mjs')
  # dsh 走 `dsh headless`，一次一进程，比另外两个慢（~12s/轮），
  # 但它是 ACP 那条路唯一能跑通的：无头环境拿不到桌面端的 device grant，
  # ACP 会报 no API key for provider route "deepseek-official"。
  Start-Bg -Name 'driver-dsh' -ArgList @('drivers/dsh.mjs')
  # pi / prime 都是 `-p` 一次性模式（每轮 spawn 一个进程），没有会话可续
  Start-Bg -Name 'driver-pi' -ArgList @('drivers/pi.mjs')
  Start-Bg -Name 'driver-prime' -ArgList @('drivers/prime.mjs')
}

Write-Output ""
Write-Output "工作台: http://127.0.0.1:$Port"
if (-not $WithDrivers) {
  Write-Output "driver 没启动（只读看板 + 人工发言）。要自动对话加 -WithDrivers，"
  Write-Output "或者单独跑：node drivers/hermes.mjs / node drivers/opencode.mjs"
}
Write-Output "自动对话默认是关的，在左栏打开「总开关」。"
