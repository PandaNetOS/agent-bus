<#
.SYNOPSIS
  agent-bus — 三个 agent（DSH / Hermes / OpenCode）的共享消息总线

.DESCRIPTION
  一个 append-only 的 JSONL 日志 + 文件锁。任何能跑 pwsh 的进程都能读写。

.EXAMPLE
  pwsh -File bus.ps1 post -From dsh -Text "开始修 Hindsight bank_id"
  pwsh -File bus.ps1 read -Since 0 -Limit 20
  pwsh -File bus.ps1 who
  pwsh -File bus.ps1 claim -From opencode -Task 3
  pwsh -File bus.ps1 done -From opencode -Task 3 -Text "改完了"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true, Position=0)]
  [ValidateSet('post','read','who','claim','done','task','stats','tail')]
  [string]$Command,

  [string]$From = 'unknown',
  [string]$To = '',
  [string]$Text = '',
  [int]$Since = 0,
  [int]$Limit = 30,
  [int]$Task = 0,
  [string]$Kind = 'msg',      # msg | task | claim | done | note
  [string]$Root = 'D:\agent-bus'
)

$ErrorActionPreference = 'Stop'

# 强制控制台 UTF-8：Windows 上 pwsh 默认输出 GBK 代码页，中文会乱码。
# 必须在任何 Write-Output 之前设。
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$Utf8 = [System.Text.UTF8Encoding]::new($false)
$Room = Join-Path $Root 'room.jsonl'
$Lock = Join-Path $Root '.bus.lock'
$Members = Join-Path $Root 'members.json'

# 外部进程调用本脚本时，Windows 会吞掉 -File 后路径里的反斜杠
# （D:\agent-bus\bus.ps1 → D:agent-busbus.ps1）。此处容错，但不静默。
if (-not (Test-Path $MyInvocation.MyCommand.Path)) {
  $self = $PSCommandPath
  if (-not $self) { $self = $MyInvocation.MyCommand.Path }
} else {
  $self = $MyInvocation.MyCommand.Path
}

# ---------- 文件锁：NTFS 独占创建，带重试 ----------
function Invoke-WithLock {
  param([scriptblock]$Body, [int]$TimeoutMs = 10000)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $fs = $null
  while ($true) {
    try {
      $fs = [System.IO.File]::Open($Lock, [System.IO.FileMode]::CreateNew,
              [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      break
    } catch {
      if ($sw.ElapsedMilliseconds -gt $TimeoutMs) { throw "bus: 获取锁超时（${TimeoutMs}ms）" }
      Start-Sleep -Milliseconds 15
    }
  }
  try { & $Body } finally {
    if ($fs) { $fs.Dispose() }
    Remove-Item $Lock -Force -ErrorAction SilentlyContinue
  }
}

# ---------- 读全部消息 ----------
function Get-Messages {
  if (-not (Test-Path $Room)) { return @() }
  $out = [System.Collections.Generic.List[object]]::new()
  $raw = [System.IO.File]::ReadAllLines($Room, $Utf8)
  $n = 0
  foreach ($line in $raw) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
      $o = $line | ConvertFrom-Json
      $n++
      if (-not $o.PSObject.Properties['seq']) { $o | Add-Member -NotePropertyName seq -NotePropertyValue $n -Force }
      $out.Add($o)
    } catch {
      # 坏行跳过，不阻塞整体读取
    }
  }
  return $out
}

# ---------- 追加一条 ----------
function Add-Message {
  param([hashtable]$Fields)
  Invoke-WithLock {
    $existing = Get-Messages
    $nextSeq = 0
    if ($existing.Count -gt 0) {
      $maxSeq = ($existing | Measure-Object -Property seq -Maximum).Maximum
      $nextSeq = [int]$maxSeq
    }
    $nextSeq++

    $obj = [ordered]@{
      seq  = $nextSeq
      ts   = (Get-Date).ToString('o')
      from = $Fields.from
      kind = $Fields.kind
      to   = $Fields.to
      task = $Fields.task
      text = $Fields.text
    }
    $json = ($obj | ConvertTo-Json -Compress -Depth 5)
    [System.IO.File]::AppendAllText($Room, $json + "`n", $Utf8)
    return $obj
  }
}

# ---------- 主逻辑 ----------
switch ($Command) {

  'post' {
    if ([string]::IsNullOrWhiteSpace($Text)) { throw "post: 需要 -Text" }
    $m = Add-Message @{ from=$From; kind=$Kind; to=$To; task=0; text=$Text }
    Write-Output ("[#{0}] {1} → {2}" -f $m.seq, $m.from, $m.text)
  }

  'task' {
    if ([string]::IsNullOrWhiteSpace($Text)) { throw "task: 需要 -Text（任务标题）" }
    $m = Add-Message @{ from=$From; kind='task'; to=''; task=0; text=$Text }
    Write-Output ("[#{0}] {1} 建任务: {2}" -f $m.seq, $m.from, $m.text)
  }

  'claim' {
    if ($Task -le 0) { throw "claim: 需要 -Task <序号>" }
    $m = Add-Message @{ from=$From; kind='claim'; to=''; task=$Task; text="认领任务 #$Task" }
    Write-Output ("[#{0}] {1} 认领 #{2}" -f $m.seq, $m.from, $Task)
  }

  'done' {
    if ($Task -le 0) { throw "done: 需要 -Task <序号>" }
    $body = if ([string]::IsNullOrWhiteSpace($Text)) { "完成任务 #$Task" } else { $Text }
    $m = Add-Message @{ from=$From; kind='done'; to=''; task=$Task; text=$body }
    Write-Output ("[#{0}] {1} 完成 #{2}: {3}" -f $m.seq, $m.from, $Task, $body)
  }

  'read' {
    $all = Get-Messages
    $sel = $all | Where-Object { $_.seq -gt $Since } | Select-Object -Last $Limit
    if (-not $sel) { Write-Output "(无新消息，当前共 $($all.Count) 条)"; break }
    foreach ($m in $sel) {
      $t = ([datetime]$m.ts).ToLocalTime().ToString('HH:mm:ss')
      $tag = if ($m.kind -eq 'msg') { '' } else { "[$($m.kind)]" }
      $arrow = if ($m.to) { " → $($m.to)" } else { '' }
      Write-Output ("#{0,-4} {1}  {2,-10}{3}{4}  {5}" -f $m.seq, $t, $m.from, $arrow, $tag, $m.text)
    }
  }

  'tail' {
    $all = Get-Messages
    $sel = $all | Select-Object -Last $Limit
    foreach ($m in $sel) {
      $t = ([datetime]$m.ts).ToLocalTime().ToString('HH:mm:ss')
      Write-Output ("#{0,-4} {1}  {2,-10} [{3}]  {4}" -f $m.seq, $t, $m.from, $m.kind, $m.text)
    }
  }

  'who' {
    $all = Get-Messages
    if (-not $all) { Write-Output "(还没有任何成员发言)"; break }
    Write-Output "=== 成员活跃度 ==="
    $all | Group-Object from | Sort-Object Count -Descending | ForEach-Object {
      $last = ($_.Group | Sort-Object seq | Select-Object -Last 1)
      $lt = ([datetime]$last.ts).ToLocalTime().ToString('MM-dd HH:mm:ss')
      Write-Output ("{0,-12} {1,4} 条   最后 {2}" -f $_.Name, $_.Count, $lt)
    }
  }

  'stats' {
    $all = Get-Messages
    $tasks = @($all | Where-Object { $_.kind -eq 'task' })
    $claims = @($all | Where-Object { $_.kind -eq 'claim' })
    $dones = @($all | Where-Object { $_.kind -eq 'done' })
    Write-Output ("总消息 {0} | 任务 {1} | 认领 {2} | 完成 {3}" -f $all.Count, $tasks.Count, $claims.Count, $dones.Count)
    Write-Output ("日志: {0}  ({1} B)" -f $Room, $(if(Test-Path $Room){ (Get-Item $Room).Length } else { 0 }))
  }
}
