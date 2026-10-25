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
  [string]$Root = 'D:\PNOS\agent-bus'
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
$CeoFile = Join-Path $Root 'ceo.txt'

# $Members 是早期设计的遗留：当前未使用，成员活跃度从消息日志实时聚合。
# 保留变量以免有外部脚本引用，删掉更干净——但要先确认没人用。
$Members = Join-Path $Root 'members.json'

# 说明：下面这段「反斜杠被吞」的容错代码其实没有起作用——
# $self 算出来之后从未被使用。真正有效的规避手段是调用方给路径加单引号
# （见 README 已知坑 1）。此处保留原样并标注，避免误以为已有防护。
# if (-not (Test-Path $MyInvocation.MyCommand.Path)) { ... }

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
# 结果写到 $script:Messages 而不是用 return。
# 原因：PowerShell 会把函数返回的单个 List/数组再拆一层包，
# 调用方拿到的会是「装着数组的数组」，Count 永远为 1、Measure-Object
# 找不到 seq 属性。用脚本级变量传值最稳。
$script:Messages = @()
function Get-Messages {
  if (-not (Test-Path $Room)) { $script:Messages = @(); return }
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
  $script:Messages = $out.ToArray()
}

# ---------- 读 CEO ----------
# CEO 由用户指定：runtime 目录下 ceo.txt，一行一个 agent 名。
# 谁被指定为 CEO，谁才有派活（task）权限；dsh 也只是普通 agent。
function Get-Ceo {
  if (-not (Test-Path $CeoFile)) { return '' }
  $raw = [System.IO.File]::ReadAllText($CeoFile, $Utf8)
  return $raw.Trim()
}

# ---------- 追加一条 ----------
function Add-Message {
  param([hashtable]$Fields)
  Invoke-WithLock {
    Get-Messages
    $existing = @($script:Messages)
    $nextSeq = 1
    if ($existing.Count -gt 0) {
      $maxSeq = ($existing | Measure-Object -Property seq -Maximum).Maximum
      if ($null -ne $maxSeq) { $nextSeq = [int]$maxSeq + 1 }
    }

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
    # 派活权限只属于 CEO：CEO 由用户指定（ceo.txt 一行一个 agent 名）。
    # dsh 也只是普通 agent，不再默认拥有派活权。
    $ceo = Get-Ceo
    if ([string]::IsNullOrWhiteSpace($ceo)) {
      throw "task: 还没有指定 CEO。请用户在 $CeoFile 里写一行 CEO 的 agent 名（如 dsh）。"
    }
    if ($From -ne $ceo) { throw "只有 CEO（当前：$ceo）能建任务。其他成员请用 post / claim / done。" }
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
    # -To 必填：结果必须回到明确的收件人（约定 -To dsh 回调度者），否则悬空没人收。
    if ([string]::IsNullOrWhiteSpace($To)) { throw "done: 需要 -To <收件人>（回给派单人，通常就是 CEO）" }
    $body = if ([string]::IsNullOrWhiteSpace($Text)) { "完成任务 #$Task" } else { $Text }
    $m = Add-Message @{ from=$From; kind='done'; to=$To; task=$Task; text=$body }
    Write-Output ("[#{0}] {1} 完成 #{2} → {3}: {4}" -f $m.seq, $m.from, $Task, $m.to, $body)
  }

  'read' {
    Get-Messages
    $all = @($script:Messages)
    # 必须先筛 seq > Since 再取「前」Limit 条。-Since 的用途是增量轮询：
    # 每次从最旧的未读开始读，读完把 Since 推进到最后一条的 seq。
    # 用 -Last 会把最早的新消息挤掉，轮询时直接漏读。
    $sel = $all | Where-Object { $_.seq -gt $Since } | Select-Object -First $Limit
    if (-not $sel) { Write-Output "(无新消息，当前共 $($all.Count) 条)"; break }
    foreach ($m in $sel) {
      $t = ([datetime]$m.ts).ToLocalTime().ToString('HH:mm:ss')
      $tag = if ($m.kind -eq 'msg') { '' } else { "[$($m.kind)]" }
      $arrow = if ($m.to) { " → $($m.to)" } else { '' }
      Write-Output ("#{0,-4} {1}  {2,-10}{3}{4}  {5}" -f $m.seq, $t, $m.from, $arrow, $tag, $m.text)
    }
  }

  'tail' {
    Get-Messages
    $all = @($script:Messages)
    $sel = $all | Select-Object -Last $Limit
    foreach ($m in $sel) {
      $t = ([datetime]$m.ts).ToLocalTime().ToString('HH:mm:ss')
      Write-Output ("#{0,-4} {1}  {2,-10} [{3}]  {4}" -f $m.seq, $t, $m.from, $m.kind, $m.text)
    }
  }

  'who' {
    Get-Messages
    $all = @($script:Messages)
    $ceo = Get-Ceo
    if ([string]::IsNullOrWhiteSpace($ceo)) {
      Write-Output "=== CEO: 未指定（当前没人能建任务）==="
    } else {
      Write-Output "=== CEO: $ceo（由用户指定）==="
    }
    if (-not $all) { Write-Output "(还没有任何成员发言)"; break }
    Write-Output "=== 成员活跃度 ==="
    $all | Group-Object from | Sort-Object Count -Descending | ForEach-Object {
      $last = ($_.Group | Sort-Object seq | Select-Object -Last 1)
      $lt = ([datetime]$last.ts).ToLocalTime().ToString('MM-dd HH:mm:ss')
      Write-Output ("{0,-12} {1,4} 条   最后 {2}" -f $_.Name, $_.Count, $lt)
    }
  }

  'stats' {
    Get-Messages
    $all = @($script:Messages)
    $tasks = @($all | Where-Object { $_.kind -eq 'task' })
    $claims = @($all | Where-Object { $_.kind -eq 'claim' })
    $dones = @($all | Where-Object { $_.kind -eq 'done' })
    Write-Output ("总消息 {0} | 任务 {1} | 认领 {2} | 完成 {3}" -f $all.Count, $tasks.Count, $claims.Count, $dones.Count)
    Write-Output ("日志: {0}  ({1} B)" -f $Room, $(if(Test-Path $Room){ (Get-Item $Room).Length } else { 0 }))
  }
}
