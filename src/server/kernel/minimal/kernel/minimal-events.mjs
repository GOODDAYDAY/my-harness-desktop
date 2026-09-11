// minimal 事件常量 —— 十种事件，一份常量，单一来源（§4.2.3）。
//
// 为什么单独成文件而不是在各处写字符串：
//   · 事件名是**内核与插件的对齐面**。§6.2.3 的「插件可订阅清单」要从这里取，
//     插件的 `on(event, handler)` 也要拿它做校验——两处若各写一份字符串，
//     改一处忘一处就是"订阅了一个永不触发的事件"（静默失效，最难查）。
//   · §4.2.3 明确说这十种「没有省略号」：清单本身就是规格。落成常量后可以用一条守卫
//     断言"实际发出的事件集合 === 这份清单"，防的正是"文档写了十种、实现只发七种"
//     这种漂移（实测发生过：sessionStart / toolCallUpdate / entryAppended 三种从没发过，
//     而壳侧的透传白名单里一直列着它们）。
//
// 依赖方向：本文件零依赖（内核本体与插件系统共同依赖它，谁都不依赖谁的内部，§6.1.2）。

/** 十种协议事件（§4.2.3）。键与值同名：用 `EVENTS.agentStart` 引用，避免手拼字符串。 */
export const EVENTS = Object.freeze({
  /** 会话换绑/水合：进程起来读到（或建好）会话文件的那一刻。 */
  sessionStart: "sessionStart",
  /** 回合边界：一条回合开始。 */
  agentStart: "agentStart",
  /** 回合边界：一条回合收敛结束（带 reason）。 */
  agentSettled: "agentSettled",
  /** 消息流式三态之一：开占位。 */
  messageStart: "messageStart",
  /** 消息流式三态之一：增量。 */
  messageUpdate: "messageUpdate",
  /** 消息流式三态之一：收口（带完整消息）。 */
  messageEnd: "messageEnd",
  /** 工具调用三态之一：模型决定调工具（带 toolCallId/toolName/args）。 */
  toolCallStart: "toolCallStart",
  /** 工具调用三态之一：参数分片流式到达（增量，§4.8.2）。 */
  toolCallUpdate: "toolCallUpdate",
  /** 工具调用三态之一：执行完（带 result/isError）。 */
  toolCallEnd: "toolCallEnd",
  /** 条目落盘：一条条目已经写穿会话文件。 */
  entryAppended: "entryAppended",
});

/** 全部事件名（守卫与协议文档共用一份清单）。 */
export const EVENT_NAMES = Object.freeze(Object.values(EVENTS));

/**
 * 插件**可订阅**的事件（§6.2.3）：生命周期"结果/边界"事件，五个。
 * 不可订阅的是流式"过程/增量"事件（messageStart / messageUpdate / toolCallStart /
 * toolCallUpdate / entryAppended）——它们挂在高频路径上，插件回调会把流式主路径拖慢。
 * 这不是"还没实现"，是**能力边界**：`on()` 必须显式拒绝，而不是让它静默订阅一个永不触发的名字。
 */
export const SUBSCRIBABLE_EVENTS = Object.freeze([
  EVENTS.sessionStart,
  EVENTS.agentStart,
  EVENTS.agentSettled,
  EVENTS.messageEnd,
  EVENTS.toolCallEnd,
]);

/** 协议里除事件外的**命令应答**类型（不是事件：一问一答，不参与订阅，也不进 §4.2.3 清单）。 */
export const REPLY_TYPES = Object.freeze(["pong", "tools", "tree", "entries", "seeded", "stopped", "error"]);

/** 这个类型是不是十种事件之一。 */
export function isEvent(type) {
  return EVENT_NAMES.includes(type);
}

/** 这个事件能不能被插件订阅。 */
export function isSubscribable(type) {
  return SUBSCRIBABLE_EVENTS.includes(type);
}
