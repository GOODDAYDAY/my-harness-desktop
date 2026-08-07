// 场景剧本:review —— 两条评论入篮 → Enter 发送。
// 自 full-tour 场景 5 拆出。前置自持:预热发一条消息保证消息流有可评论内容。
//
// 前置种子(record.mjs 自动):review 插件。
const WARMUP = { "zh-CN": "回复一个词确认在线", en: "Reply with one word to confirm you're online" };

export default {
  name: "review-comments",
  steps: [
    { do: "hold", ms: 1400 },
    // 前置:预热建会话,消息流有内容(review 锚 user 消息,soft——失败继续)
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: WARMUP },
    { do: "waitAgent", soft: true, hold: 1200 },

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
    { do: "waitAgent", hold: 1500 },
  ],
};
