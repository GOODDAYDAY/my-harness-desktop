---
name: supervise-worker
description: 让一个会话旁听或审查另一个会话的工作、而自己不亲自盯时使用——监督者模式、第三方牵线。触发词：监督、审查、review、盯着、把关、牵线、旁听。
---

# 监督者（supervise-worker）

A 派工，S 审查，A 不亲自盯——`deliverTo` 第三方牵线：

```
session_create({ task: "干活内容(自足)", watch: true, channels: ["review-board"] })
session_create({ task: "待命:审查转给你的进展,给出意见", channels: ["review-board"] })
tap_start({ session: "session:<工人key>", filter: "done", deliverTo: "session:<监督者key>" })
```

## 要点

- **deliverTo 是牵线的关键**：工人 w 的事件流送给监督者 s 而不是你——你（A）不在回路里，这就是"替别人搭桥"。
- **filter 用 done（默认）**：s 拿到 w 的最终完整输出再审查，不看中间过程——审查要的是结果，不是直播。
- **结论回传靠房间**：s 和你在同一房间（上面的 channels 参数已经安排），s 把审查意见在房间里说出来你就收到——说话即传输，没有专门回传动作。
- **收线**：审查完成后 `tap_stop({tapId})`，工人和监督者可 `session_abort` 回收。
- tap 是**只读**的：s 无法经 tap 干扰 w 的执行，审查意见要生效得由你或 w 自己采纳。
