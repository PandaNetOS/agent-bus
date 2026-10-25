<#
.SYNOPSIS
  停止 agent-bus 的 busd 和 driver

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File stop.ps1
#>
param([string]$Root = 'D:\PNOS\agent-bus')

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$pids = Get-ChildItem -Path $Root -Filter '.pid-*' -Force
if (-not $pids) { Write-Output "没有找到 .pid-* 文件（$Root），可能本来就没在跑"; exit 0 }

foreach ($f in $pids) {
  $procId = (Get-Content $f.FullName -Raw).Trim()
  $name = $f.Name -replace '^\.pid-', ''
  if ($procId -match '^\d+$') {
    $p = Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
    if ($p) {
      Stop-Process -Id ([int]$procId) -Force
      Write-Output ("  已停止 {0,-16} pid={1}" -f $name, $procId)
    } else {
      Write-Output ("  {0,-16} pid={1} 已经不在了" -f $name, $procId)
    }
  }
  Remove-Item $f.FullName -Force
}
Write-Output "完成"
