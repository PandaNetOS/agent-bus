<#
.SYNOPSIS
  agent-bus — 三个 agent（DSH / Hermes / OpenCode）的共享消息总线

.DESCRIPTION
  一个 append-only 的 JSONL 日志 + 文件锁。任何能跑 pwsh 的进程都能读写。

  v2 新增五个字段（全部可选，旧调用不受影响）：
    -Thread    对话线程 id（同一轮协作的多条消息共用）
    -ReplyTo   引用的 seq
    -Mentions  显式点名的 agent，逗号分隔（如 "opencode,hermes"）
    -Hop       自动对话跳数，driver 用它防死循环
    -Via       谁投喂的：human（人说的）或 driver:<name>（agent 自动说的）

.EXAMPLE
  pwsh -File bus.ps1 post -From dsh -Text "开始修 Hindsight bank_id"
  pwsh -File bus.ps1 post -From hermes -To opencode -Mentions opencode -Thread t-7 -ReplyTo 55 -Hop 1 -Via driver:hermes -Text "锁那段我看过了"
  # 幂等重试：调用方自带 seq，重复投递只落一条，其余丢弃并告警
  pwsh -File bus.ps1 post -From dsh -Seq 57 -Text "这条重试也只写一次"
  pwsh -File bus.ps1 read -Since 0 -Limit 20
  pwsh -File bus.ps1 read -Since 55 -Json
  pwsh -File bus.ps1 who
  pwsh -File bus.ps1 claim -From opencode -Task 3
  pwsh -File bus.ps1 done -From opencode -Task 3 -To dsh -Text "改完了"
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
  [string]$Root = 'D:\PNOS\agent-bus',

  # 幂等写入：>0 表示调用方自带 seq（重试安全）。0 = 由锁内重新计算（老行为）。
  # 同一个 seq 第二次写入会被丢弃并告警，见 Add-Message。
  [int]$Seq = 0,

  # ---------- v2 ----------
  [string]$Thread = '',
  [int]$ReplyTo = 0,
  # 逗号分隔，存成字符串而不是数组：PS 5.1 的 ConvertTo-Json 会把单元素数组
  # 退化成裸字符串，调用方解析时类型不稳定。字符串 split(',') 两边都干净。
  [string]$Mentions = '',
  [int]$Hop = 0,
  [string]$Via = 'human',
  [switch]$Json              # read/tail 输出原始 JSON，给 driver 和 webui 解析
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
$DroppedLog = Join-Path $Root '.bus-dropped.jsonl'
$CeoFile = Join-Path $Root 'ceo.txt'

# $Members 是早期设计的遗留：当前未使用，成员活跃度从消息日志实时聚合。
# 保留变量以免有外部脚本引用，删掉更干净——但要先确认没人用。
$Members = Join-Path $Root 'members.json'

# 说明：下面这段「反斜杠被吞」的容错代码其实没有起作用——
# $self 算出来之后从未被使用。真正有效的规避手段是调用方给路径加单引号
# （见 README 已知坑 1）。此处保留原样并标注，避免误以为已有防护。
# if (-not (Test-Path $MyInvocation.MyCommand.Path)) { ... }

# ---------- 文件锁：NTFS 独占创建，带重试 + 死锁自愈 ----------
# FileMode::CreateNew 在 NTFS 上是原子的「不存在才创建」，FileShare::None 让
# 拿到句柄的进程独占这个文件。两者合起来就是跨进程互斥：同一瞬间只有一个
# 进程能建出 .bus.lock，其余进程拿 IOException 后重试。
#
# 锁文件里写持有者信息（pid / token / since），用途有两个：
#   1. 超时排查时能直接看出是谁卡住了；
#   2. 进程被 kill 时锁文件会残留，靠 pid 是否还活着判断能不能清掉。
# 注意：只按「mtime 超过 120 秒 且 pid 已死」判陈旧，绝不按时间单独判，
# 否则一次慢写入（大日志）会被别的进程误判成死锁并抢锁。
$LockStaleSeconds = 120

function Read-LockOwner {
  try {
    $txt = [System.IO.File]::ReadAllText($Lock, $Utf8)
    if ([string]::IsNullOrWhiteSpace($txt)) { return $null }
    return ($txt | ConvertFrom-Json)
  } catch { return $null }
}

function Test-StaleLock {
  try {
    $fi = [System.IO.FileInfo]::new($Lock)
    if (-not $fi.Exists) { return $false }
    if (((Get-Date).ToUniversalTime() - $fi.LastWriteTimeUtc).TotalSeconds -lt $LockStaleSeconds) { return $false }
    $owner = Read-LockOwner
    if ($owner -and $owner.pid) {
      $proc = Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue
      if ($proc) { return $false }   # 持有者还活着 → 慢，但不是死锁
    }
    return $true
  } catch { return $false }
}

function Invoke-WithLock {
  param([scriptblock]$Body, [int]$TimeoutMs = 10000)
  if (-not (Test-Path $Root)) { [void](New-Item -ItemType Directory -Path $Root -Force) }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $fs = $null
  $token = [guid]::NewGuid().ToString('N')
  while ($true) {
    try {
      $fs = [System.IO.File]::Open($Lock, [System.IO.FileMode]::CreateNew,
              [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      break
    } catch {
      if ($sw.ElapsedMilliseconds -gt $TimeoutMs) {
        throw "bus: 获取锁超时（${TimeoutMs}ms）。若确认没有写入进行中，删掉 $Lock 重试。"
      }
      if (Test-StaleLock) {
        # 持有者已死：清掉残留锁立刻重试，不用干等超时。
        try { [System.IO.File]::Delete($Lock) } catch { }
        continue
      }
      # 抖动重试：10 个进程同频重试容易一直撞在一起。
      Start-Sleep -Milliseconds (Get-Random -Minimum 10 -Maximum 31)
    }
  }
  try {
    $owner = [ordered]@{ pid = $PID; token = $token; host = $env:COMPUTERNAME
                         since = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
    $bytes = $Utf8.GetBytes($owner)
    $fs.Write($bytes, 0, $bytes.Length)
    $fs.Flush()
  } catch { }
  try { & $Body } finally {
    if ($fs) { try { $fs.Dispose() } catch { } }
    # 只删自己建的那把锁：万一被判陈旧并被别人重建，token 对不上就别动，
    # 否则会把别人的临界区打开。
    $cur = Read-LockOwner
    if ($cur -and $cur.token -eq $token) {
      Remove-Item $Lock -Force -ErrorAction SilentlyContinue
    }
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
      # v2 字段补默认值：老消息没有这些属性，读取方不必为缺字段写分支。
      foreach ($p in @('thread','reply_to','mentions','hop','via')) {
        if (-not $o.PSObject.Properties[$p]) {
          $dflt = if ($p -eq 'via') { 'human' } elseif ($p -eq 'thread' -or $p -eq 'mentions') { '' } else { 0 }
          $o | Add-Member -NotePropertyName $p -NotePropertyValue $dflt -Force
        }
      }
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

# ---------- 重复 seq：丢弃 + 告警 ----------
# 三路告警：Write-Warning（人看）、stderr（进程调用方能稳定捕获）、
# .bus-dropped.jsonl（事后审计：谁在什么时间重试了哪个 seq）。
function New-Dropped {
  param([int]$Seq, [string]$Reason, [hashtable]$Fields, $Existing)

  $what = if ($Reason -eq 'duplicate') { '重复 seq' } else { 'seq 已被越过' }
  $old = ''
  if ($Existing) {
    $t = [string]$Existing.text
    if ($t.Length -gt 60) { $t = $t.Substring(0, 60) + '…' }
    $old = "；已存在 from=$($Existing.from) text=$t"
  }
  $line = "bus: $what #$Seq，丢弃本次写入（幂等）$old"

  Write-Warning $line
  try { [Console]::Error.WriteLine($line) } catch { }
  try {
    $rec = [ordered]@{ ts = (Get-Date).ToString('o'); seq = $Seq; reason = $Reason
                       from = $Fields.from; text = $Fields.text
                       kept_from = $(if ($Existing) { $Existing.from } else { '' }) }
    [System.IO.File]::AppendAllText($DroppedLog, (($rec | ConvertTo-Json -Compress -Depth 3) + "`n"), $Utf8)
  } catch { }

  return [pscustomobject]@{ dropped = $true; seq = $Seq; reason = $Reason; existing = $Existing }
}

# ---------- 追加一条 ----------
# seq 幂等：-Seq > 0 时调用方自带 seq，重试同一 seq 只落一条。
#   * seq 已存在           → 丢弃，告警（duplicate）
#   * seq 已被别人越过     → 丢弃，告警（stale：这个位置已经被占了）
#   * seq 跳空（> max+1）  → 报错不写（append-only 日志不接受无法解释的空洞）
# -Seq = 0 时仍在锁内重新计算，和老行为完全一致。
function Add-Message {
  param([hashtable]$Fields)
  Invoke-WithLock {
    Get-Messages
    $existing = @($script:Messages)
    $used = [System.Collections.Generic.HashSet[int]]::new()
    $maxSeq = 0
    foreach ($m in $existing) {
      $s = [int]$m.seq
      [void]$used.Add($s)
      if ($s -gt $maxSeq) { $maxSeq = $s }
    }

    $nextSeq = $maxSeq + 1
    $want = [int]$Fields.seq
    if ($want -gt 0) {
      if ($used.Contains($want)) {
        $old = @($existing | Where-Object { [int]$_.seq -eq $want })[0]
        return (New-Dropped -Seq $want -Reason 'duplicate' -Fields $Fields -Existing $old)
      }
      if ($want -le $maxSeq) {
        return (New-Dropped -Seq $want -Reason 'stale' -Fields $Fields -Existing $null)
      }
      if ($want -gt $maxSeq + 1) {
        throw "bus: -Seq $want 跳空（当前最大 #$maxSeq，只能写 #$($maxSeq + 1)，或去掉 -Seq 让总线分配）"
      }
      $nextSeq = $want
    }

    $obj = [ordered]@{
      seq      = $nextSeq
      ts       = (Get-Date).ToString('o')
      from     = $Fields.from
      kind     = $Fields.kind
      to       = $Fields.to
      task     = $Fields.task
      text     = $Fields.text
      thread   = $Fields.thread
      reply_to = $Fields.reply_to
      mentions = $Fields.mentions
      hop      = $Fields.hop
      via      = $Fields.via
    }
    $json = ($obj | ConvertTo-Json -Compress -Depth 5)
    [System.IO.File]::AppendAllText($Room, $json + "`n", $Utf8)
    return $obj
  }
}

# 写命令统一出口：正常写入回显 seq，幂等丢弃也回显（退出码仍是 0，
# 因为「这条消息已经在日志里」对重试方就是成功）。
function Write-Result {
  param($Msg, [string]$Ok)
  if ($Msg.dropped) {
    Write-Output (("[#{0}] 已存在，丢弃（幂等 {1}）" -f $Msg.seq, $Msg.reason))
  } else {
    Write-Output $Ok
  }
}

# ---------- 主逻辑 ----------
switch ($Command) {

  'post' {
    if ([string]::IsNullOrWhiteSpace($Text)) { throw "post: 需要 -Text" }
    $m = Add-Message @{ from=$From; kind=$Kind; to=$To; task=0; text=$Text; seq=$Seq
                        thread=$Thread; reply_to=$ReplyTo; mentions=$Mentions
                        hop=$Hop; via=$Via }
    Write-Result $m (("[#{0}] {1} → {2}" -f $m.seq, $m.from, $m.text))
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
    $m = Add-Message @{ from=$From; kind='task'; to=$To; task=0; text=$Text; seq=$Seq
                        thread=$Thread; reply_to=$ReplyTo; mentions=$Mentions
                        hop=$Hop; via=$Via }
    Write-Result $m (("[#{0}] {1} 建任务: {2}" -f $m.seq, $m.from, $m.text))
  }

  'claim' {
    if ($Task -le 0) { throw "claim: 需要 -Task <序号>" }
    $m = Add-Message @{ from=$From; kind='claim'; to=''; task=$Task; text="认领任务 #$Task"; seq=$Seq
                        thread=$Thread; reply_to=$Task; mentions=$Mentions
                        hop=$Hop; via=$Via }
    Write-Result $m (("[#{0}] {1} 认领 #{2}" -f $m.seq, $m.from, $Task))
  }

  'done' {
    if ($Task -le 0) { throw "done: 需要 -Task <序号>" }
    # -To 必填：结果必须回到明确的收件人（约定 -To <派单人>），否则悬空没人收。
    if ([string]::IsNullOrWhiteSpace($To)) { throw "done: 需要 -To <收件人>（回给派单人，通常就是 CEO）" }
    $body = if ([string]::IsNullOrWhiteSpace($Text)) { "完成任务 #$Task" } else { $Text }
    $m = Add-Message @{ from=$From; kind='done'; to=$To; task=$Task; text=$body; seq=$Seq
                        thread=$Thread; reply_to=$Task; mentions=$Mentions
                        hop=$Hop; via=$Via }
    Write-Result $m (("[#{0}] {1} 完成 #{2} → {3}: {4}" -f $m.seq, $m.from, $Task, $m.to, $body))
  }

  'read' {
    Get-Messages
    $all = @($script:Messages)
    # 必须先筛 seq > Since 再取「前」Limit 条。-Since 的用途是增量轮询：
    # 每次从最旧的未读开始读，读完把 Since 推进到最后一条的 seq。
    # 用 -Last 会把最早的新消息挤掉，轮询时直接漏读。
    $unread = @($all | Where-Object { $_.seq -gt $Since })
    $sel = @($unread | Select-Object -First $Limit)
    # 增量读的可见性：积压超过 Limit 必须告诉调用方窗口被截断，
    # 否则 poller 会以为已经看全了（验收项之一）。
    $truncated = ($unread.Count -gt $sel.Count)

    if ($Json) {
      $payload = [ordered]@{ messages = $sel; count = $all.Count; truncated = $truncated; remaining = ($unread.Count - $sel.Count) }
      Write-Output ($payload | ConvertTo-Json -Depth 6 -Compress)
      break
    }
    if ($sel.Count -eq 0) { Write-Output "(无新消息，当前共 $($all.Count) 条)"; break }
    foreach ($m in $sel) {
      $t = ([datetime]$m.ts).ToLocalTime().ToString('HH:mm:ss')
      $tag = if ($m.kind -eq 'msg') { '' } else { "[$($m.kind)]" }
      $arrow = if ($m.to) { " → $($m.to)" } else { '' }
      # 变量名不能叫 $hop/$via：PowerShell 大小写不敏感，会撞上 param 里的
      # [int]$Hop 和 [string]$Via，给 int 赋字符串直接抛类型转换错误。
      $hopTag = if ($m.hop -gt 0) { " ↻$($m.hop)" } else { '' }
      $viaTag = if ($m.via -and $m.via -ne 'human') { " <$($m.via)>" } else { '' }
      Write-Output (("#{0,-4} {1}  {2,-10}{3}{4}{5}{6}  {7}" -f $m.seq, $t, $m.from, $arrow, $tag, $hopTag, $viaTag, $m.text))
    }
    if ($truncated) { Write-Output "(还有 $($unread.Count - $sel.Count) 条未读，把 -Since 推进到最后一条 seq 再读)" }
  }

  'tail' {
    Get-Messages
    $all = @($script:Messages)
    $sel = @($all | Select-Object -Last $Limit)
    if ($Json) {
      $payload = [ordered]@{ messages = $sel; count = $all.Count; truncated = ($all.Count -gt $sel.Count) }
      Write-Output ($payload | ConvertTo-Json -Depth 6 -Compress)
      break
    }
    foreach ($m in $sel) {
      $t = ([datetime]$m.ts).ToLocalTime().ToString('HH:mm:ss')
      $hopTag = if ($m.hop -gt 0) { " ↻$($m.hop)" } else { '' }
      Write-Output (("#{0,-4} {1}  {2,-10} [{3}]{4}  {5}" -f $m.seq, $t, $m.from, $m.kind, $hopTag, $m.text))
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
      $auto = @($_.Group | Where-Object { $_.via -and $_.via -ne 'human' }).Count
      Write-Output (("{0,-12} {1,4} 条（自动 {2}）  最后 {3}" -f $_.Name, $_.Count, $auto, $lt))
    }
  }

  'stats' {
    Get-Messages
    $all = @($script:Messages)
    $tasks = @($all | Where-Object { $_.kind -eq 'task' })
    $claims = @($all | Where-Object { $_.kind -eq 'claim' })
    $dones = @($all | Where-Object { $_.kind -eq 'done' })
    $auto = @($all | Where-Object { $_.via -and $_.via -ne 'human' })
    Write-Output (("总消息 {0} | 任务 {1} | 认领 {2} | 完成 {3} | 自动 {4}" -f $all.Count, $tasks.Count, $claims.Count, $dones.Count, $auto.Count))
    Write-Output (("日志: {0}  ({1} B)" -f $Room, $(if(Test-Path $Room){ (Get-Item $Room).Length } else { 0 })))
  }
}
