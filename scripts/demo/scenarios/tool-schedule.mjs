// 场景剧本:工具调度三态 —— 能写 → 只读(拦)→ 恢复能写。开关"下次发送生效",切换后先预热一轮。
// 自 full-tour 场景 1 拆出。前置自持:开头预热一条消息建会话(soft,模型往返失败不致命)。
//
// 前置种子(record.mjs 自动):write + read-only 工具组(defaultEnabled)、空会话。
const WARMUP = { "zh-CN": "回复一个词确认在线", en: "Reply with one word to confirm you're online" };
const WRITE_REQ = {
  "zh-CN": "往 demo-write.txt 写入内容 hello",
  en: "Write hello into demo-write.txt",
};

export default {
  name: "tool-schedule",
  steps: [
    { do: "hold", ms: 1400 },
    // 前置:预热建会话(拆分后自持,不依赖前序场景;soft——失败则跳过 waitAgent 继续)
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: WARMUP },
    { do: "waitAgent", soft: true, hold: 1200 },

    // ── 工具调度三态:能写 → 只读(拦)→ 恢复能写 ──
    { do: "click", target: { titleText: "笔记" } },
    { do: "click", target: { titleText: "工具" }, hold: 1200 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: WRITE_REQ },
    { do: "waitAgent", hold: 1500 },
    { do: "toolsOnlyReadOnly", hold: 1200 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, hold: 600, text: WARMUP },
    { do: "waitAgent", hold: 700 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: WRITE_REQ },
    { do: "waitAgent", hold: 1600 },
    { do: "click", target: { groupToggle: "write" }, hold: 1000 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, hold: 600, text: WARMUP },
    { do: "waitAgent", hold: 700 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: WRITE_REQ },
    { do: "waitAgent", hold: 1500 },
  ],
};
