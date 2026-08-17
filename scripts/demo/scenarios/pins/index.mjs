// 场景剧本:图钉 —— 选色 → 点消息落钉 → 退模式。
// 种子:见 seed.json(主线会话;图钉从零开始加,ContentPin 存 session-colors 不走会话 JSONL)。
// 设计文档 §4.7。
export default {
  name: "pins",
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1500 },
    { do: "click", target: { titleText: "请求记录" } },
    { do: "click", target: { titleText: "图钉" } },
    { do: "click", target: { palettePin: "#89b4fa" }, hold: 600 },
    { do: "click", target: { css: "[data-message-id]:has(p)", nth: 0 }, hold: 1100 },
    { do: "click", target: { palettePin: "#89b4fa" }, hold: 700 },
  ],
};
