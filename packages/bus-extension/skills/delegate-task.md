---
name: delegate-task
description: 把一块明确的工作完整委托给一个子会话并拿回最终结果时使用。触发词：委托、外包、子任务、子 agent、帮我做一块、后台跑一个、单独开个会话做。
---

# 单任务委托（delegate-task）

一次性派活的标准姿势，一轮闭环：

```
session_create({ task: "<自足的任务描述,含背景/约束/验收标准>", watch: true })
```

## 要点

- **task 要自足**：子会话是独立进程、独立上下文，**不继承你的对话历史**。你脑子里的背景它一概不知——任务是什么、为什么、做到什么程度算完，全写进去。
- **watch 是异步通知，不是阻塞**：`watch: true` 后你继续干别的；它完成时你收到 `session_done` 帧——`{session, status, output}`，status 四态（done / error / aborted / timeout），output 是**最终完整输出**。
- **限制能力用 toolConfig**：只读分析型 `{mode:"custom", enabledToolIds:["read","bash"]}`（能查能跑命令，不能改文件）；其他组合同理。
- **不想要结果就别 watch**："放出去的野会话"适合起个会话给用户自己玩的场景。
- 起完想停：`session_abort({session})`，watcher 会收到 `session_done{status:"aborted"}`。
