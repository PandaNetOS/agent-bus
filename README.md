# agent-bus

三个 agent（DSH / Hermes / OpenCode）的共享消息总线。

一个 append-only 的 JSONL 日志 + NTFS 独占锁。任何能跑 pwsh 的进程都能读写，不需要装任何东西。

## 文件

运行时目录 `D:\PNOS\agent-bus\`，代码仓库 `github.com/PandaNetOS/agent-bus`。

| 路径 | 作用 |
|---|---|
| `D:\PNOS\agent-bus\room.jsonl` | 消息日志，append-only，UTF-8 无 BOM |
| `D:\PNOS\agent-bus\bus.ps1` | 唯一入口。**UTF-8 带 BOM + CRLF**（PS 5.1 兼容，见已知坑 4） |
| `D:\PNOS\agent-bus\artifacts\` | 产出物（文件、报告等）放这里 |
| `D:\PNOS\agent-bus\.bus.lock` | 锁文件（运行时短暂存在，平时不存在） |

> 本机没装 pwsh 7，只有 Windows PowerShell 5.1。所以下面示例里的 `pwsh` 要换成：
> `powershell -NoProfile -ExecutionPolicy Bypass -File ...`（本机执行策略拦脚本，必须加 `-ExecutionPolicy Bypass`）。

## 命令

```powershell
$BUS = 'D:\PNOS\agent-bus\bus.ps1'

# 发消息
pwsh -NoProfile -File $BUS post -From dsh -Text "开始干活"

# 点对点
pwsh -NoProfile -File $BUS post -From dsh -To opencode -Text "这个交给你"

# 建任务（只有 dsh 能建，其他来源会报错退出）
pwsh -NoProfile -File $BUS task -From dsh -Text "修 Hindsight bank_id"

# 认领任务
pwsh -NoProfile -File $BUS claim -From opencode -Task 2

# 完成任务（-To 必填，-To dsh 表示回给调度者）
pwsh -NoProfile -File $BUS done -From opencode -Task 2 -To dsh -Text "改完了，commit abc123"

# 读新消息（只读 seq 大于 N 的）
pwsh -NoProfile -File $BUS read -Since 0 -Limit 20

# 增量轮询：每次把 Since 推进到上一条输出的 seq
pwsh -NoProfile -File $BUS read -Since 12 -Limit 20

# 看最近 N 条
pwsh -NoProfile -File $BUS tail -Limit 20

# 成员活跃度
pwsh -NoProfile -File $BUS who

# 统计
pwsh -NoProfile -File $BUS stats
```

## 消息格式

每行一个 JSON 对象：

```json
{"seq":4,"ts":"2026-10-25T12:41:00.123+08:00","from":"dsh","kind":"post","to":"","task":0,"text":"中文编码测试：消息总线已就绪 ✅"}
```

`kind` 取值：`msg`（普通消息）/ `task` / `claim` / `done`。

`seq` 单调递增、全局唯一，是轮询进度游标。`-Task` 指向任务的 `seq`（即建任务那条消息的 seq），**不是任务序号**——所以下面「认领任务 #9」里的 9 指的是第 9 条消息。

## 三个 agent 怎么用

### DSH（大将军）

直接用 pwsh 调，或者在你的会话里说「往总线发一条消息」。

### Hermes

```powershell
D:\Hermes\bin\hermes.exe -z "用 pwsh 运行 D:\PNOS\agent-bus\bus.ps1 read 并把结果告诉我"
```

### OpenCode

```powershell
& "$env:APPDATA\ai.opencode.desktop\cli\2.1.4-x64\opencode-cli.exe" run "运行 'D:\PNOS\agent-bus\bus.ps1' read 并把结果告诉我"

> `run` 的位置参数才是消息内容，**没有 `--prompt` 这个 flag**（`run --help` 里只有 `message...`）。写 `--prompt` 会被当成未知 flag 直接报错。
> 脚本路径务必用**单引号**包住，否则反斜杠会被吞（见「已知坑」第 1 条）。
```

## 调度模型

一级调度就三个 agent，平级：

```
dsh  ·  Hermes  ·  OpenCode
```

三者在总线里直接对话、互相派单和回报，中间没有别的层级。dsh 内部的调度（它自己下面的将军层、怎么分工）**不在总线这一层描述**，总线只认这三个成员。

三条规则：

1. **建任务统一由 dsh 签发**。`task` 内置白名单，其他来源直接报错并以非零退出码退出：`只有 dsh（大将军）能建任务。其他成员请用 post / claim / done。` Hermes / OpenCode 用 `post` 沟通、`claim` 认领、`done` 回报。
2. **派单必须用 `-To` 点名**，不让三方抢活。收件人明确，不靠「谁先看到谁抢」。
3. **结果必须 `done -To dsh` 回到调度者才算闭环**。`done` 缺 `-To` 直接报错退出；`-To dsh` 就是「回给调度者」。

### 改动留痕

谁改了什么，在总线发一条 `post` 说明，格式：

```powershell
pwsh -NoProfile -File $BUS post -From <自己> -Text "改动: <文件> — <做了什么>"
```

例：`改动: bus.ps1 — task 加 -From dsh 白名单，done 强制 -To`

## 已验证

| 项 | 结果 |
|---|---|
| 建任务 / 认领 / 完成 全流程 | ✅ |
| 10 进程 × 3 条并发写入 | ✅ 30/30 无丢失、无坏行、seq 唯一且连续 |
| 坏行容错 | ✅ 中间夹一行坏 JSON，不影响读写，seq 继续递增 |
| 中文读写 | ✅ UTF-8 无 BOM 输出，裸 `pwsh -File` 调用不乱码 |
| DSH / Hermes / OpenCode 三方实际读写 | ✅ 三方都成功写入过消息 |
| Windows PowerShell 5.1 | ✅ 需 UTF-8 **BOM**（见已知坑 4） |

## 已知坑

1. **反斜杠被吞**：OpenCode 第一次调用时把 `D:\PNOS\agent-bus\bus.ps1` 传成了 `D:agent-busbus.ps1`。**加单引号** `'D:\PNOS\agent-bus\bus.ps1'` 可避免。
2. **中文乱码**：早期版本在裸 `pwsh -File` 调用下中文显示乱码，已通过脚本开头强制 `[Console]::OutputEncoding = UTF8` 修复。
3. **锁超时**：单次写锁等待 10 秒，超时会报错。正常不会触发。
4. **PS 5.1 必须有 UTF-8 BOM**：本机没有装 pwsh，只有 Windows PowerShell 5.1。PS 5.1 读无 BOM 的 UTF-8 `.ps1` 会按 GBK 解，`要`/`好` 这类汉字的第二字节被当成 GBK 尾字节，**吞掉后面紧跟的一个 ASCII 字符**。文件里只要出现 `需要`、`强制` 这种词，就会吃掉后面的 `"` 或 `{`，导致整脚本语法错误、一行都跑不了。
   修复：脚本文件存成 **UTF-8 带 BOM + CRLF**。pwsh 两种都吃，所以这是安全的公共解。**不要手改回去**——无 BOM 版本在 PS 5.1 下直接全挂。
5. **`run` 没有 `--prompt` flag**：`opencode run` 的位置参数才是消息内容。写 `--prompt` 会被当未知 flag 报错。正确写法：`opencode run "运行 'D:\PNOS\agent-bus\bus.ps1' read"`。

## PowerShell 函数返回值陷阱（改代码前必读）

`Get-Messages` 的结果写在 `$script:Messages` 里，**不要改成 `return`**。

PowerShell 会把函数返回的单个数组/List 再拆一层包，调用方拿到的是「装着数组的数组」——`Count` 恒为 1，`Measure-Object -Property seq` 直接报「找不到属性 seq」。这个坑的表现是 **seq 从 1 开始重复**（`1,1,2,3,4...`），日志看起来只是「偶尔错号」，实际是每次写入都算错了基数。

## 设计取舍

- **不用 HTTP 服务**：不需要常驻进程，不需要端口，不会因为服务挂了全线断掉
- **不用数据库**：JSONL 人类可读，`git` 可追，`grep` 可查
- **文件锁而非消息队列**：三个进程的写入频率远低于文件锁的开销，简单优先
- **append-only**：不删不改，出错可回溯
