// 场景剧本:review —— 两条评论入篮 → Enter 发送。
// 种子:见 seed.json(主线会话,「实现方案」段够长、可选中,与 timeline-flow 共用同款文案)。
// 设计文档 §4.6。
export default {
  name: "review-comments",
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1500 },
    // ── review:两条评论入篮 → 发送 ──
    // 锚「实现方案」段(main.plan3):contains 前缀匹配对 markdown 内联码稳健
    // (plan3 含 `--due` 反引号,渲染后 textContent 无反引号,全串精确匹配会失配)。
    { do: "select", target: { text: { "$t": "planAnchor" }, contains: true }, fromFx: 0.05, toFx: 0.6, hold: 700 },
    { do: "click", target: { i18nKey: "shell.comment" }, hold: 500 },
    { do: "type", target: { placeholderKey: "shell.placeholder" }, submit: true, hold: 800, text: { "$t": "comment1" } },
    { do: "select", target: { css: "[data-message-id] p", nth: 0 }, fromFx: 0, toFx: 1, hold: 700 },
    { do: "click", target: { i18nKey: "shell.comment" }, hold: 500 },
    { do: "type", target: { placeholderKey: "shell.placeholder" }, submit: true, hold: 1000, text: { "$t": "comment2" } },
    { do: "press", key: "Enter" },
  ],
};
