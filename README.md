# agent-bus

三个 agent（DSH / Hermes / OpenCode）的共享消息总线。

一个 append-only 的 JSONL 日志 + NTFS 独占锁。任何能跑 pwsh 的进程都能读写，不需要装任何东西。

## 文件

运行时目录 `D:\PNOS\agent-bus\`，代码仓库 `github.com/PandaNetOS/agent-bus`。

| 路径 | 作用 |
|---|---|
| `D:\PNOS\agent-bus\room.jsonl` | 消息日志，append-only，UTF-8 无 BOM |
| `D:\PNOS\agent-bus\bus.ps1` | 唯一入口 |
| `D:\PNOS\agent-bus\artifacts\` | 产出物（文件、报告等）放这里 |
| `D:\PNOS\agent-bus\.bus.lock` | 锁文件（运行时短暂存在，平时不存在） |

## 命令

```powershell
$BUS = 'D:\PNOS\agent-bus\bus.ps1'

# 发消息
pwsh -NoProfile -File $BUS post -From dsh -Text "开始干活"

# 点对点
pwsh -NoProfile -File $BUS post -From dsh -To opencode -Text "这个交给你"

# 建任务
pwsh -NoProfile -File $BUS task -From dsh -Text "修 Hindsight bank_id"

# 认领任务
pwsh -NoProfile -File $BUS claim -From opencode -Task 2

# 完成任务
pwsh -NoProfile -File $BUS done -From opencode -Task 2 -Text "改完了，commit abc123"

# 读新消息（只读 seq 大于 N 的）
pwsh -NoProfile -File $BUS read -Since 0 -Limit 20

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

## 三个 agent 怎么用

### DSH（大将军）

直接用 pwsh 调，或者在你的会话里说「往总线发一条消息」。

### Hermes

```powershell
D:\Hermes\bin\hermes.exe -z "用 pwsh 运行 D:\PNOS\agent-bus\bus.ps1 read 并把结果告诉我"
```

### OpenCode

```powershell
& "$env:APPDATA\ai.opencode.desktop\cli\2.1.4-x64\opencode-cli.exe" run --prompt "运行 D:\PNOS\agent-bus\bus.ps1 read 并把结果告诉我"
```

## 已验证

| 项 | 结果 |
|---|---|
| 建任务 / 认领 / 完成 全流程 | ✅ |
| 6 进程 × 5 条并发写入 | ✅ 30/30 无丢失、无坏行、seq 唯一 |
| 中文读写 | ✅ UTF-8 无 BOM，裸 `pwsh -File` 调用不乱码 |
| DSH / Hermes / OpenCode 三方实际读写 | ✅ 三方都成功写入过消息 |

## 已知坑

1. **反斜杠被吞**：OpenCode 第一次调用时把 `D:\PNOS\agent-bus\bus.ps1` 传成了 `D:agent-busbus.ps1`。**加单引号** `'D:\PNOS\agent-bus\bus.ps1'` 可避免。
2. **中文乱码**：早期版本在裸 `pwsh -File` 调用下中文显示乱码，已通过脚本开头强制 `[Console]::OutputEncoding = UTF8` 修复。
3. **锁超时**：单次写锁等待 10 秒，超时会报错。正常不会触发。

## 设计取舍

- **不用 HTTP 服务**：不需要常驻进程，不需要端口，不会因为服务挂了全线断掉
- **不用数据库**：JSONL 人类可读，`git` 可追，`grep` 可查
- **文件锁而非消息队列**：三个进程的写入频率远低于文件锁的开销，简单优先
- **append-only**：不删不改，出错可回溯
