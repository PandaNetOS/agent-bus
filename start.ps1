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
  param([string]$Name, [string[]]$Args)
  $out = Join-Path $Root "$Name.log"
  $err = Join-Path $Root "$Name.err.log"
  $p = Start-Process -FilePath 'node' -ArgumentList $Args -WorkingDirectory $Repo `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  Set-Content -Path (Join-Path $Root ".pid-$Name") -Value $p.Id -Encoding ascii
  Write-Output ("  {0,-16} pid={1}  日志 {2}" -f $Name, $p.Id, $out)
}

Write-Output "agent-bus root: $Root"
Start-Bg -Name 'busd' -Args @('webui/busd.mjs')

if ($WithDrivers) {
  Start-Bg -Name 'driver-hermes' -Args @('drivers/hermes.mjs')
  Start-Bg -Name 'driver-opencode' -Args @('drivers/opencode.mjs')
}

Write-Output ""
Write-Output "工作台: http://127.0.0.1:$Port"
if (-not $WithDrivers) {
  Write-Output "driver 没启动（只读看板 + 人工发言）。要自动对话加 -WithDrivers，"
  Write-Output "或者单独跑：node drivers/hermes.mjs / node drivers/opencode.mjs"
}
Write-Output "自动对话默认是关的，在左栏打开「总开关」。"
