// 场景剧本:收藏一击 —— 悬停消息 → 一击收藏 → 揭示收藏页签。
// 自 full-tour 场景 6 拆出。前置自持:预热发一条消息保证消息流有可收藏内容。
//
// 前置种子(record.mjs 自动):session-bookmarks 插件。
const WARMUP = { "zh-CN": "回复一个词确认在线", en: "Reply with one word to confirm you're online" };

export default {
  name: "bookmark",
  steps: [
    { do: "hold", ms: 1400 },
    // 前置:预热建会话,消息流有内容(soft——失败继续)
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: WARMUP },
    { do: "waitAgent", soft: true, hold: 1200 },

    // ── 收藏:悬停消息 → 一击收藏 → 揭示收藏页签 ──
    { do: "hover", target: { css: "[data-message-id]:has(p)", widest: true } },
    { do: "click", target: { i18nKey: "shell.bookmark" }, hold: 1600 },
  ],
};
