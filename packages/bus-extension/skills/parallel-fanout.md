---
name: parallel-fanout
description: 把任务拆成多块并行派给多个子会话、需要它们互通进展或各自汇报结果时使用。触发词：并行、同时跑、fan-out、分头、多路、批量派工、拆成几路。
---

# 并行 fan-out（parallel-fanout）

一轮并行分发 + 结果汇总：

```
# 同一轮回复里并行调用(不等第一个回来):
session_create({ task: "子任务 A(自足描述)", watch: true, channels: ["squad"] })
session_create({ task: "子任务 B(自足描述)", watch: true, channels: ["squad"] })
```

## 要点

- **一轮并行**：同一轮里发多个 create 调用就是并行 fan-out——别串行等第一个回来再发第二个，那是在浪费并行度。
- **channels 让工人互通**：同房间的工人说话互相听得见（说话即传输）——A 改了接口签名，B 立刻知道，不用你中转。不需要互通就省略 channels。
- **全部到齐再汇总**：每个工人完成各回一个 `session_done`，各带完整输出。别看到一个就先下结论——慢的那个往往才是瓶颈所在。
- **拆分原则**：边界清晰、接口先行。在每个 task 里写明"你只改 X，不许动公共接口"——并行翻车的根因几乎都是边界没钉死。
- **防失控**：工人起了就跑，必要时 `session_abort` 单个点杀；你在房间里喊话全员都听得见。
