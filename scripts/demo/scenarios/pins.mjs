// 场景剧本:图钉 —— 选色 → 点消息落钉 → 退模式。
// 自 full-tour 场景 4 拆出。前置自持:预热发一条消息保证消息流有可落钉内容。
//
// 前置种子(record.mjs 自动):session-colors 插件。
const WARMUP = { "zh-CN": "回复一个词确认在线", en: "Reply with one word to confirm you're online" };

export default {
  name: "pins",
  steps: [
    { do: "hold", ms: 1400 },
    // 前置:预热建会话,消息流有内容(soft——失败继续)
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: WARMUP },
    { do: "waitAgent", soft: true, hold: 1200 },

    // ── 图钉:选色 → 点消息落钉 → 退模式 ──
    { do: "click", target: { titleText: "请求记录" } },
    { do: "click", target: { titleText: "图钉" } },
    { do: "click", target: { palettePin: "#89b4fa" }, hold: 600 },
    { do: "click", target: { css: "[data-message-id]:has(p)", nth: 0 }, hold: 1100 },
    { do: "click", target: { palettePin: "#89b4fa" }, hold: 700 },
  ],
};
