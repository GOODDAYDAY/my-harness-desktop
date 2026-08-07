// 场景剧本:review —— 两条评论入篮 → Enter 发送。
// 种子:主线会话的「实现方案」段(够长、可选中,4.2/4.6 共用)。
// 设计文档 §4.6。
export default {
  name: "review-comments",
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1500 },
    // ── review:两条评论入篮 → 发送 ──
    { do: "select", target: { css: "[data-message-id] p", widest: true }, fromFx: 0.05, toFx: 0.6, hold: 700 },
    { do: "click", target: { i18nKey: "shell.comment" }, hold: 500 },
    {
      do: "type",
      target: { placeholderKey: "shell.placeholder" },
      submit: true,
      hold: 800,
      text: { "zh-CN": "这里语气可以更自然", en: "tone could be more natural" },
    },
    { do: "select", target: { css: "[data-message-id] p", nth: 0 }, fromFx: 0, toFx: 1, hold: 700 },
    { do: "click", target: { i18nKey: "shell.comment" }, hold: 500 },
    {
      do: "type",
      target: { placeholderKey: "shell.placeholder" },
      submit: true,
      hold: 1000,
      text: { "zh-CN": "这句保留", en: "keep this one" },
    },
    { do: "press", key: "Enter" },
  ],
};
