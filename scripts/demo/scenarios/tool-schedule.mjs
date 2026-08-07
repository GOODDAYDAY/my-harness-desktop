// 场景剧本:工具调度三态 —— 能写 → 只读(拦)→ 恢复能写。开关"下次发送生效",切换后先预热一轮。
// 全片唯一保留真实模型往返的板块:权限拦截必须真跑才有说服力。
// 种子:write + read-only 工具组、主线会话(打开即有消息流,不用预热建会话)。
// waitAgent 全部 soft:模型往返失败(如录制机无网络/模型慢)不致命,画面落到
// buildBlockedSession 预置的拦截红条(种子会话兜底),演示仍成立——设计文档 §4.4 / QA。
const WARMUP = { "zh-CN": "回复一个词确认在线", en: "Reply with one word to confirm you're online" };
const WRITE_REQ = {
  "zh-CN": "往 README.md 加一行用法说明",
  en: "Add a usage line to README.md",
};

export default {
  name: "tool-schedule",
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1200 },
    { do: "click", target: { titleText: "笔记" } },
    { do: "click", target: { titleText: "工具" }, hold: 1200 },

    // 能写:发写请求 → 成功(模型不通则 soft 跳过,画面停在种子会话)
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: WRITE_REQ },
    { do: "waitAgent", soft: true, opts: { appearMs: 20000 }, hold: 1500 },

    // 只读:关掉 write 组(精确开关,不误伤其他组) → 预热一轮(下次发送生效) → 再发写请求 → 被拦
    { do: "click", target: { groupToggle: "write" }, hold: 1200 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, hold: 600, text: WARMUP },
    { do: "waitAgent", soft: true, opts: { appearMs: 20000 }, hold: 700 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: WRITE_REQ },
    { do: "waitAgent", soft: true, opts: { appearMs: 20000 }, hold: 1600 },

    // 恢复:重开 write 组(与关闭对称) → 预热 → 再发 → 成功
    { do: "click", target: { groupToggle: "write" }, hold: 1000 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, hold: 600, text: WARMUP },
    { do: "waitAgent", soft: true, opts: { appearMs: 20000 }, hold: 700 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: WRITE_REQ },
    { do: "waitAgent", soft: true, opts: { appearMs: 20000 }, hold: 1500 },
  ],
};
