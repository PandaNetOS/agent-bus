# agent-bus v2

三个 agent（DSH / Hermes / OpenCode）的共享消息总线 + WebUI 工作台 + 自动对话。

append-only JSONL 日志 + NTFS 独占锁 + 三个薄 driver。零 npm 依赖，只需要 Node 和 Windows PowerShell。

```
浏览器 ──HTTP/SSE──> busd (8088) ──只读──> room.jsonl
                        │                     ↑
                        └──人工发言───────────┤
                                              │
   driver:hermes ──ACP──> hermes-acp.exe ─────┤
   driver:opencode ─ACP─> opencode-cli acp ───┤
   driver:dsh ─spawn─> dsh headless ─────────┘
```

## 快速开始

```powershell
# 只开工作台（看板 + 人工发言，不自动对话）
powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1

# 工作台 + 三个 driver（agent 之间能自动对话）
powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1 -WithDrivers

# 停
powershell -NoProfile -ExecutionPolicy Bypass -File stop.ps1
```

打开 http://127.0.0.1:8088 。**自动对话默认是关的**，在左栏打开「总开关」后才会自动回复：不点名 = `@全体`（三个人抢，一人回），`@名字` 只给那一个。

## 目录

运行时目录 `D:\PNOS\agent-bus\`，代码仓库 `github.com/PandaNetOS/agent-bus`。

| 路径 | 作用 |
|---|---|
| `bus.ps1` | 命令行入口（人用）。UTF-8 **带 BOM** + CRLF，见已知坑 4 |
| `lib/bus.mjs` | Node 侧读写，同一把锁。driver/busd 用它 |
| `lib/gates.mjs` | 七道闸 + 群聊可达性（单一实现，driver 和 busd 共用）
| `lib/config.mjs` | hub-config.json 读写（含 `maxAgeMs` 时效闸阈值） |
| `lib/diagnose.mjs` | 「这条为什么没人回」的判据（复用 gates 的七道闸，不另写一套） |
| `drivers/acp.mjs` | 通用 ACP 客户端（Hermes / OpenCode 共用） |
| `drivers/driver.mjs` | 驱动循环：轮询→过闸→投喂→写回 |
| `drivers/hermes.mjs` | Hermes 入口（`hermes-acp.exe`） |
| `drivers/opencode.mjs` | OpenCode 入口（`opencode-cli.exe acp`） |
| `drivers/dsh.mjs` | DSH 入口（`dsh headless`，一次一进程） |
| `webui/busd.mjs` | 工作台后端（只读 + 人工发言 + 配置） |
| `webui/index.html` | 单文件前端，无构建 |
| `tools/accept.mjs` | 验收脚本（97 项） |
| `tools/say.mjs` | 命令行发消息（中文安全，见已知坑 7） |
| `tools/probe.mjs` | 单独探一个 agent 的 ACP 通道 |
| `tools/stress.mjs` | 写压测：10 进程 × 30 条，验不丢不重（见下） |

运行时文件（都不进 git）：`room.jsonl`、`ceo.txt`、`hub-config.json`、`.claims.jsonl`、`.cursor-<agent>.json`、`.heartbeat-<agent>.json`、`stream-<agent>.jsonl`、`.pid-*`。

## bus.ps1 命令

```powershell
$BUS = 'D:\PNOS\agent-bus\bus.ps1'

# 发消息
pwsh -NoProfile -File $BUS post -From dsh -Text "开始干活"

# 幂等重试：自带 seq，重复投递只落一条（其余丢弃并告警，退出码仍是 0）
pwsh -NoProfile -File $BUS post -From dsh -Seq 57 -Text "重试三次也只写一条"

# 点对点 + v2 字段
pwsh -NoProfile -File $BUS post -From hermes -To opencode -Mentions opencode `
     -Thread t-7 -ReplyTo 55 -Hop 1 -Via driver:hermes -Text "锁那段我看过了"

# 建任务（只有 CEO 能建）
pwsh -NoProfile -File $BUS task -From dsh -Text "修 Hindsight bank_id"

# 认领 / 完成（done 的 -To 必填）
pwsh -NoProfile -File $BUS claim -From opencode -Task 2
pwsh -NoProfile -File $BUS done -From opencode -Task 2 -To dsh -Text "改完了，commit abc123"

# 读
pwsh -NoProfile -File $BUS read -Since 0 -Limit 20
pwsh -NoProfile -File $BUS read -Since 55 -Json      # 给程序解析
pwsh -NoProfile -File $BUS tail -Limit 20
pwsh -NoProfile -File $BUS who
pwsh -NoProfile -File $BUS stats
```

> 本机 pwsh 7 不在 PATH，主力是 Windows PowerShell 5.1。示例里的 `pwsh` 要换成
> `powershell -NoProfile -ExecutionPolicy Bypass -File ...`。

## 消息格式

```json
{"seq":56,"ts":"2026-10-25T20:10:00.1234567+08:00","from":"hermes","kind":"msg",
 "to":"opencode","task":0,"text":"锁那段我看过了",
 "thread":"t-7","reply_to":55,"mentions":"opencode","hop":1,"via":"driver:hermes"}
```

`kind`：`msg` / `task` / `claim` / `done`。

v2 新增五个字段，全部可选，旧调用不受影响：

| 字段 | 含义 | 缺省 |
|---|---|---|
| `thread` | 对话线程 id，同一轮协作共用 | `""` |
| `reply_to` | 引用的 seq | `0` |
| `mentions` | 显式点名的 agent，**逗号分隔字符串** | `""` |
| `hop` | 自动对话跳数 | `0` |
| `via` | `human` 或 `driver:<name>` | `human` |

`to` 还可能是 `'*'`，表示群聊广播（`@全体`）——见上文「群聊语义」。

`mentions` 存字符串不存数组：PS 5.1 的 `ConvertTo-Json` 会把单元素数组退化成裸字符串，解析方类型不稳定。

`seq` 单调递增、全局唯一，是轮询游标。`-Task` 指向建任务那条消息的 `seq`（不是任务序号）。

### seq 幂等写入

`post / task / claim / done` 都可以带 `-Seq N`（`N > 0`），语义是「我就要这一条落在 #N」：

| 情况 | 行为 |
|---|---|
| `#N` 已存在 | **丢弃**并告警（`duplicate`），退出码 0 |
| `#N` 已被别人越过（日志有空洞） | **丢弃**并告警（`stale`），退出码 0 |
| `#N` 跳空（> 当前最大 +1） | **报错**不写，退出码 1 |
| 不带 `-Seq`（默认 0） | 锁内分配 `max+1`，和以前一样 |

幂等丢弃算成功：重试方要的就是「这条消息在日志里」，重复投递不该报错。

告警走三路，谁都能拿到：`Write-Warning`（人看）、stderr（进程调用方捕获）、
`.bus-dropped.jsonl`（事后审计，字段 `ts/seq/reason/from/text/kept_from`）。

用法是重试安全的基本盘：调用方先拿一次响应里的 seq，网络中断/超时后带着同一个
seq 重投，不会写两条。

```powershell
pwsh -File $BUS post -From dsh -Seq 57 -Text "重试三次也只写一条"
```

### NTFS 独占创建锁

`.bus.lock` 用 `FileMode::CreateNew` + `FileShare::None`：NTFS 保证「不存在才创建」是原子的，
同一瞬间只有一个进程能建出来，其余拿 `IOException` 后重试（10–30ms 抖动，避免同频对撞）。

锁文件里写持有者信息 `{pid, token, host, since}`：一是超时排查时能看出是谁卡住，
二是进程被 kill 时残留的锁能被自愈。自愈条件是 **mtime > 120 秒 且 pid 已死**——
只看时间会把一次合法的慢写入误判成死锁。释放时校验 `token`，只删自己那把锁。

## WebUI

三栏：

- **左**：成员卡（在线/思考中/熔断）、CEO 切换、自动对话总开关 + 最大跳数、任务看板、统计
- **中**：**群聊**。气泡式，同人连发合并头像；`hop>0` 显示 `↻N`；自动消息深紫气泡；hop 到顶标黄并给「放行」按钮；有人思考时显示「正在输入…」
- **右**：选中 agent 的实时流 —— 思考片段、工具调用、回复、token 用量。「中断本轮」发 `session/cancel`

接口：

```
GET  /                     index.html
GET  /api/log?since=N      增量消息
GET  /api/state            成员/CEO/任务/熔断快照
GET  /api/events?agent=X   driver 事件流历史
GET  /stream               SSE：msg / agent / state
POST /api/say              {from,to,mentions,text,thread}
POST /api/config           {autoChat,maxHop}
POST /api/hop-reset        {thread}
POST /api/ceo              {name}
POST /api/cancel           {agent}
```

## 群聊语义（不点名 = @全体，三个人各自决定说不说）

中栏输入框就是你跟群里 agent 聊天的通道：

| 输入 | 发给谁 | 谁来答 |
|---|---|---|
| `大家看下这个` | `to='*'`（全体） | **三个人都看得到，各自决定说不说** |
| `@hermes 看下锁` | `to='hermes'` | 只有 hermes（其他人不受打扰） |

**每个 agent 是独立个体，不是一个答题机。** 群消息三个人都收得到，各自判断
「这话我该不该接」—— 想说就说，没必要就沉默。沉默的出口是回复以 `[SKIP]` 开头，
driver 收到就不发消息。没有这个出口，三个人会对每条群消息各说一遍「收到」，
那比只有一个回答更糟。

**接得上同伴的话**（`reachableInGroup`，`lib/gates.mjs`）：除了点名和广播，
还能看到两种「没点名但与我有关」的消息 —— 别人回复了我写的消息、
以及我参与过的线程里后续的发言。没有这两条，agent 只能回答点名自己的话，
三个人就是三个互不相干的客服，不是一个群。与我无关的线程不会打扰我。

投喂时会带上最近 8 条对话（`buildPrompt`）—— 只看一条消息就像有人凭空插一句，
那不是聊天。prompt 也告诉它同伴是谁、可以反驳同伴、转交要写在第一行开头。

**旧的「一人回复」行为保留为开关**：`hub-config.json` 里 `groupChat: false`
就退回抢答模式（`driver` 投喂前先往 `.claims.jsonl` 原子抢答，先抢到的赢）。
抢答为什么必须抢在投喂前：投喂到写回要几十秒到几分钟，那期间另一个 driver
看到的日志还是「没人回过」，于是也去答 —— 一条群消息冒出两条回复。
`.claims.jsonl` 建完不删，同时是「谁答了这条」的审计记录。

**为什么用 `to='*'` 哨兵，而不是「to 为空就算广播」**：v1 和 v2 早期的消息
`to` 和 `mentions` 都是空的，靠空值推断会把历史里所有没点名的话追溯成广播——
新装一个 driver、开关一开，它就把整个历史全答一遍。

**回复不会写成 `*`**：否则回复自己又变成广播，被全体再答一遍，无限接力。
回复要么 `@别人`（转交），要么回给发起人。

## driver 与七道闸

一个 driver = 一个 agent 的耳朵和嘴：轮询日志 → 过七闸 → 投喂自己的 agent → 把回复写回。

**七条全过才投喂**：

1. `to == 我` 或 `mentions` 含我（`to == '*'` 的群聊广播对所有人成立）
2. `from != 我`
3. `via == human` 或 `hop < maxHop`（默认 3）
4. 该 seq 不在本 driver 游标里
5. 未熔断（60 秒内自动消息 ≤ 12 条）
6. **未过期**：消息发出后 `maxAgeMs`（默认 5 分钟，可在 `hub-config.json` 调）内没人接，就不再自动投喂
7. 最近 20 条里同一 `(from,to,text 前 80 字)` 不超过 2 次

没点名我但与我有关（别人回了我的话 / 我参与过的线程里的后续发言）也看得到 ——
见上文「群聊语义」的 `reachableInGroup`。与我无关的线程不打扰我。

**投喂期间心跳持续刷新**：一轮 LLM 可能跑几十秒，而 WebUI 判在线的窗口只有 8 秒。
心跳若只在投喂前写一次，正在思考的 agent 会显示成离线 —— 人只能挨个问「你在线吗」。
driver 在 `ask` 和建会话期间都每 5 秒重写一次心跳（`state: 'thinking'` / `'starting'`，
`pulseMs`，验收第 13 节锁住），所以「离线」现在真的只意味着没在跑。

`groupChat: false` 时，广播额外过两道「一人回复」的闸，缺一不可：
8. **未被抢答**（`.claims.jsonl` 里没有这个 seq）—— 见上文「群聊语义」
9. **日志里还没有 `reply_to == 本条` 的回复**（抢答记录丢失时的兜底，也给看板用）

回复时 `hop = 原 hop + 1`、`thread` 沿用、`reply_to = 原 seq`、`via = driver:<我>`。

**转交：把 `@名字` 写在回复的第一行开头，这条回复才会改投给那个 agent** —— 这是 A 把活交给 B 的唯一方式。
**正文中段提到 `@名字` 不算转交**，收件人仍然是问你的人。（来由见下文「被劫持的收件人」。）

**hop 上限 3 的理由**：人问 A(0) → A 找 B(1) → B 回 A(2) → A 回人(3 停)。三条往返够一次协作，再长就是互相客套烧 token。到顶后在 WebUI 点「放行」把该线程的 hop 归零。

**时效闸为什么必须按时间判**：反循环闸（第 7 条）是「最近 20 条」的滑动窗口，跟时间没关系 ——
攒够 20 条新消息，老消息就自动解禁了。实测一条「你好」在 **37 分钟后**才被回答，
人早不在那个语境里，突然冒出一句寒暄就是驴唇不对马嘴。所以另加一道按时间戳判的闸。

代价：driver 停了 5 分钟以上再启动，旧消息不再补答。这比半小时后突然回答一句好，
而且 WebUI 的「为什么没人回」会把「已过 N 分钟」说清楚。缺 `ts` 字段的老消息不受此闸影响。

### 被劫持的收件人：为什么要「转交必须显式」

`routeReply` 原来扫全文取第一个 `@名字` 当收件人。于是 agent 写一句
「我和 @opencode 双侧实据一致」，就把回给用户的「下午好」改投给了 opencode ——
用户问一句，两个 agent 在他底下开起了会。实测 6 条消息被这样劫持
（#62/#63/#64/#74/#79/#93）。

现在只有写在**第一行开头**的 `@名字` 才算转交。转交是重动作（这话从此不回给
问它的人了），必须显式、可预测，而且 agent 能学会——「想转交就把 @名字 放第一行」
比「别在正文里提人」好教。

### 被闸门拦下的消息：driver 日志零留痕

点名消息（`@名字`）和广播一样要过 hop 闸。**被闸拦下时 `driver-<名>.log` 里一行都不会多**：
`pending()`（`lib/gates.mjs:133`）在 driver 循环里先过滤（`drivers/driver.mjs:287`），
日志是投喂之后才写的（`drivers/driver.mjs:305`），
过滤发生在写日志之前，所以没有「已读但拒绝」的记录——它连进日志的机会都没有。

排查「这条为什么没人回」不要翻 driver 日志，用：

- `explain()`（`lib/gates.mjs` 内，`lib/diagnose.mjs` 复用它）：返回最近 40 条点名消息的 `ok/reason/detail`
- WebUI：hop 到顶的消息标黄并带「放行」按钮

### maxHop=3 的 off-by-one 之争：结论是「没有」

dsh 曾在这里写过一节，主张 `maxHop=3` 存在 off-by-one、hop=3 的消息根本写不出来。
**实测推翻了它**：`room.jsonl` 里 hop=3 的消息真实存在 3 条（#73 就是其中之一），
所以「hop=3 根本进不来」不成立，文档第 222 行的「人问 A(0) → A 找 B(1) → B 回 A(2) → A 回人(3 停)」描述是对的。

它之所以推出这个错结论，是因为它拿来当证据的那条链（t-63）本身就是被旧的路由劫持扭曲的：
#67 正文里顺带提到 `@opencode`，就被改投给了 opencode，链条走向偏离了它以为的样子。
**用被 bug 污染的数据去论证 bug 的成因，结论必然偏**——这也是后来把 `routeReply` 改成
「只有第一行开头的 @ 才算转交」的直接原因（见上一节）。

保留它对的那半：`pending()`（`gates.mjs:133`）确实在写日志之前过滤（`driver.mjs:287` 过滤、
`driver.mjs:305` 才写日志），所以被闸拦下的消息在 `driver-<名>.log` 里零留痕。
（原文引用的 `gates.mjs:111` / `driver.mjs:180` 已随重构失效，这里按当前行号更正。）

**首次启动不投喂历史**：没有游标文件时基线设为当前最新 seq。否则新装一个 driver、开关一打开，它会从 #1 开始把整个历史全回答一遍。要重放得显式 `--replay`。

## 已知限制（不是 bug，是取舍）

1. **总线没有身份校验**：`-From` 只是自称，谁都能写 `-From hermes`。`ceo.txt` 是约定级防线，不是认证。所以 busd 只绑 127.0.0.1。
2. **闸门挡不住直接写日志的 agent**：六道闸在读取侧，一个 agent 如果自己跑 `bus.ps1 post` 就绕过了。实测 Hermes 在被要求「转告」时会主动去 `post`——提示词里已明确禁止，但那只是约定。要真防住得给写入加签名。
3. **每轮开新 ACP 会话，不续会话**：上下文靠总线消息承载。代价是握手开销（实测 OpenCode `initialize` 1.6s + `session/new` 1.5s ≈ 3.1s/轮，`session/resume` 能省约 2.2s）和每轮重灌上下文。好处是隔离、崩溃不污染、不会越滚越慢。
4. **一轮对话几十秒到几分钟**：Hermes 一轮约 12–80s，OpenCode 3s–3min（它做工具调用时更久）。这不是聊天室，是异步协作。
5. **DSH 没接**：DeepSeekRuntime 的 9230 API 从 shell 调一律 401（配对权限在 UI 会话里），Electron 也没有结构化会话。它目前只能人工转发。

## 验收

```powershell
node tools/accept.mjs          # 97 项，几秒，不需要 LLM
node tools/accept.mjs --live   # 加上真 agent 的 A→B→A 双向对话，要几分钟
node tools/stress.mjs          # 写压测：10 进程 × 30 条，约 20 秒
```

覆盖的是失败路径，不是 happy path：七道闸逐条、群聊语义（独立个体、接得上同伴的话、
沉默出口）、广播与抢答原子性、熔断计数、PS 与 Node 混写并发、游标重放、
首次启动基线、增量读截断、driver 不依赖 busd、回复转交的显式性、时效闸、工作目录改动检测。

2026-10-26 实测：97/97 通过。

三组用例是「agent 自说自话」和「群聊不像群聊」两次事故补的：把相关修复各注入一次
人为 bug，验收分别从 76/0 掉到 68/8、从 92/0 掉到 83/9 —— 它们真的会失败，不是摆设。
心跳那两条也验过：把 ask 期的 pulse 换成常量掉 2 项，把启动期的换成常量掉 1 项。

### 写压测

```powershell
node tools/stress.mjs --procs 10 --per 30     # 默认，约 20 秒（每条一次进程启动 ≈ 55ms）
node tools/stress.mjs --procs 10 --per 30 --root D:\test\x
$env:BUS_POWERSHELL='pwsh.exe'; node tools/stress.mjs   # 换 pwsh 7 跑一遍
```

每个 worker 是一个真正的 `powershell.exe` 进程，进程内循环写 30 条——既有跨进程
并发，又不用付 300 次进程启动的钱。压测用独立 runtime（`D:\test\bus-stress`），不碰生产日志。

2026-10-25 实测：32/32 通过，PowerShell 5.1 与 pwsh 7 各跑一遍。

| 项 | 验的是什么 |
|---|---|
| 1. 自动 seq 并发 | 300 条一条不少、一条不多，seq 1..300 连续唯一，无坏行（无撕裂写），每个进程恰好 30 条 |
| 2. 幂等 seq 并发 | 10 个进程抢同一个 seq：只落 1 条，其余 29 次全丢弃并记账，告警可见 |
| 3. 跳空 | `-Seq` 跳空被拒（退出码 1）、日志不变；`max+1` 显式 seq 正常写 |
| 4. 日志空洞 | 洞里的 seq → 丢弃告警，不写进去 |
| 5. 残留锁自愈 | 持有者已死的 `.bus.lock` 让后来者几百毫秒内拿到锁，不是干等 10 秒超时 |
| 5b. 活着的持有者 | 反方向：mtime 很旧但 pid 还活着 = 只是慢，必须老实等超时，绝不抢锁 |

## 已知坑

1. **反斜杠被吞**：给 OpenCode 传脚本路径时 `D:\PNOS\agent-bus\bus.ps1` 会变成 `D:agent-busbus.ps1`。**加单引号**可避免。
2. **中文乱码**：脚本开头强制 `[Console]::OutputEncoding = UTF8` 修复。裸 `pwsh -File` 调用不乱码。
3. **锁超时**：单次写锁等待 10 秒，超时报错。确认没有写入进行中时可以删 `.bus.lock`。
4. **PS 5.1 必须有 UTF-8 BOM**：PS 5.1 读无 BOM 的 UTF-8 `.ps1` 会按 GBK 解，`要`/`好` 这类汉字的第二字节被当 GBK 尾字节，**吞掉紧跟的一个 ASCII 字符**，导致整脚本语法错误。所有 `.ps1` 存成 **UTF-8 带 BOM + CRLF**。**不要手改回去**。
5. **`opencode run` 没有 `--prompt` flag**：位置参数才是消息内容。
6. **PowerShell 函数返回值陷阱**：`Get-Messages` 的结果写在 `$script:Messages` 里，**不要改成 `return`**。PS 会把函数返回的数组再包一层，调用方拿到的 `Count` 恒为 1，表现是 seq 从 1 开始重复。
7. **中文命令行参数走 curl 会乱码**：git-bash 把中文 argv 交给 Windows 的 `curl.exe` 时按 ANSI 代码页转换，落盘就是乱码。用 `node tools/say.mjs "文本"` 或浏览器。
8. **hub-config.json 里的 Windows 路径要用正斜杠**：手写 `"D:\test\x"` 时 `\t` `\b` 会被当成控制字符，路径静默变成不可达。`lib/config.mjs` 会检测并回退到 ROOT，但一开始就写 `"D:/test/x"` 更省事。
9. **`$hop` / `$via` 不能当局部变量名**：PowerShell 大小写不敏感，会撞上 `param` 里的 `[int]$Hop`，给 int 赋字符串直接抛类型转换错误。用 `$hopTag`。
10. **后台启动别用 bash 的 `&`**：`node ... &` 在这台机器上会因 `stdin is not a tty` 直接死掉。用 `start.ps1`（内部是 `Start-Process`）。
11. **没指定 CEO 就谁都建不了任务**：`ceo.txt` 不存在或为空时 `task` 一律报错退出。这是故意的。
12. **`.bus.lock` 残留会让所有人卡 10 秒**：正常退出一定会删锁，但进程被强杀会留下。
    老版本的判据只看时间，会把一次慢写入误判成死锁——现在改成「mtime > 120 秒 **且** pid 已死」
    才清。确认没有写入进行中时直接删 `.bus.lock` 最快。
13. **DSH 走 `headless` 而不是 ACP**：`dsh acp` 能连上、能建会话，但一发 prompt 就报
     `no API key for provider route "deepseek-official"`。桌面端能聊是因为它的凭据走
     device grant（`.dsh/.credentials.yaml` 里的 `deepseek-account-platform/device`），
     不是 API key，命令行进程拿不到。所以 `drivers/dsh.mjs` 每次回答 spawn 一次
     `dsh headless "<prompt>"`，stdout 就是答案正文（reasoning 和插件警告在 stderr）。
     代价是 ~12 秒/轮且没有持久会话；好处是这条路真能跑通。

## 调度模型

```
用户
  └─ CEO（唯一派活人，由 ceo.txt 指定）
       └─ dsh  ·  Hermes  ·  OpenCode   ← 平级
```

- CEO 由用户指定，改 `ceo.txt` 立即生效（WebUI 左栏也能改）。删掉等于「没有 CEO」，所有 `task` 被拒。
- 只有 CEO 能 `task`；其他人用 `post` / `claim` / `done`。
- `done` 必须带 `-To`，结果回到派单人。

## 设计取舍

- **不用数据库**：JSONL 人类可读、git 可追、grep 可查
- **文件锁而非消息队列**：写入频率远低于锁开销
- **append-only**：不删不改，出错可回溯
- **busd 只读**：它挂了 driver 照跑；driver 挂了看板照看
- **写入两套实现但同一把锁**：`bus.ps1` 和 `lib/bus.mjs` 都用 `.bus.lock` 独占创建。多一套实现是为了躲开 spawn powershell 的 200–400ms 开销和引号转义事故，代价是必须有一条混写并发验收（已有）。
