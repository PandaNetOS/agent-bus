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
   driver:dsh（未做）    outbox 文件 ─────────┘
```

## 快速开始

```powershell
# 只开工作台（看板 + 人工发言，不自动对话）
powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1

# 工作台 + 两个 driver（agent 之间能自动对话）
powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1 -WithDrivers

# 停
powershell -NoProfile -ExecutionPolicy Bypass -File stop.ps1
```

打开 http://127.0.0.1:8088 。**自动对话默认是关的**，在左栏打开「总开关」后，被 `@点名` 的 agent 才会自动回复。

## 目录

运行时目录 `D:\PNOS\agent-bus\`，代码仓库 `github.com/PandaNetOS/agent-bus`。

| 路径 | 作用 |
|---|---|
| `bus.ps1` | 命令行入口（人用）。UTF-8 **带 BOM** + CRLF，见已知坑 4 |
| `lib/bus.mjs` | Node 侧读写，同一把锁。driver/busd 用它 |
| `lib/gates.mjs` | 六道闸（单一实现，driver 和 busd 共用） |
| `lib/config.mjs` | hub-config.json 读写 |
| `drivers/acp.mjs` | 通用 ACP 客户端（Hermes / OpenCode 共用） |
| `drivers/driver.mjs` | 驱动循环：轮询→过闸→投喂→写回 |
| `drivers/hermes.mjs` | Hermes 入口（`hermes-acp.exe`） |
| `drivers/opencode.mjs` | OpenCode 入口（`opencode-cli.exe acp`） |
| `webui/busd.mjs` | 工作台后端（只读 + 人工发言 + 配置） |
| `webui/index.html` | 单文件前端，无构建 |
| `tools/accept.mjs` | 验收脚本（26 项） |
| `tools/say.mjs` | 命令行发消息（中文安全，见已知坑 7） |
| `tools/probe.mjs` | 单独探一个 agent 的 ACP 通道 |
| `tools/stress.mjs` | 写压测：10 进程 × 30 条，验不丢不重（见下） |

运行时文件（都不进 git）：`room.jsonl`、`ceo.txt`、`hub-config.json`、`.cursor-<agent>.json`、`.heartbeat-<agent>.json`、`stream-<agent>.jsonl`、`.pid-*`。

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
- **中**：消息流。`@名字` 定向点名；`hop>0` 显示 `↻N`；自动消息左侧紫条；hop 到顶的消息标黄并给「放行」按钮
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

## driver 与六道闸

一个 driver = 一个 agent 的耳朵和嘴：轮询日志 → 过六闸 → 投喂自己的 agent → 把回复写回。

**六条全过才投喂**：

1. `to == 我` 或 `mentions` 含我
2. `from != 我`
3. `via == human` 或 `hop < maxHop`（默认 3）
4. 该 seq 不在本 driver 游标里
5. 未熔断（60 秒内自动消息 ≤ 12 条）
6. 最近 20 条里同一 `(from,to,text 前 80 字)` 不超过 2 次

回复时 `hop = 原 hop + 1`、`thread` 沿用、`reply_to = 原 seq`、`via = driver:<我>`。

**回复里的 `@名字` 会改投给那个 agent** —— 这是 A 把活交给 B 的唯一方式。没有它 agent 只能回给发消息的人，那还是留言板。

**hop 上限 3 的理由**：人问 A(0) → A 找 B(1) → B 回 A(2) → A 回人(3 停)。三条往返够一次协作，再长就是互相客套烧 token。到顶后在 WebUI 点「放行」把该线程的 hop 归零。

**首次启动不投喂历史**：没有游标文件时基线设为当前最新 seq。否则新装一个 driver、开关一打开，它会从 #1 开始把整个历史全回答一遍。要重放得显式 `--replay`。

## 已知限制（不是 bug，是取舍）

1. **总线没有身份校验**：`-From` 只是自称，谁都能写 `-From hermes`。`ceo.txt` 是约定级防线，不是认证。所以 busd 只绑 127.0.0.1。
2. **闸门挡不住直接写日志的 agent**：六道闸在读取侧，一个 agent 如果自己跑 `bus.ps1 post` 就绕过了。实测 Hermes 在被要求「转告」时会主动去 `post`——提示词里已明确禁止，但那只是约定。要真防住得给写入加签名。
3. **每轮开新 ACP 会话，不续会话**：上下文靠总线消息承载。代价是握手开销（实测 OpenCode `initialize` 1.6s + `session/new` 1.5s ≈ 3.1s/轮，`session/resume` 能省约 2.2s）和每轮重灌上下文。好处是隔离、崩溃不污染、不会越滚越慢。
4. **一轮对话几十秒到几分钟**：Hermes 一轮约 12–80s，OpenCode 3s–3min（它做工具调用时更久）。这不是聊天室，是异步协作。
5. **DSH 没接**：DeepSeekRuntime 的 9230 API 从 shell 调一律 401（配对权限在 UI 会话里），Electron 也没有结构化会话。它目前只能人工转发。

## 验收

```powershell
node tools/accept.mjs          # 26 项，几秒，不需要 LLM
node tools/accept.mjs --live   # 加上真 agent 的 A→B→A 双向对话，要几分钟
node tools/stress.mjs          # 写压测：10 进程 × 30 条，约 20 秒
```

覆盖的是失败路径，不是 happy path：六道闸逐条、熔断计数、PS 与 Node 混写并发、游标重放、首次启动基线、增量读截断、driver 不依赖 busd。

2026-10-25 实测：26/26 通过。真链路实测链：`human→hermes(hop1)→opencode(hop2)→hermes(hop3)→opencode 被 hop-limit 拦住`。

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
