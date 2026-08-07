// 场景剧本:请求记录 —— 弹窗放大查看一条请求 → Esc 退出。
// 自 full-tour 场景 3 拆出。前置自持:预热发一条消息保证请求记录有内容。
//
// 前置种子(record.mjs 自动):llm-recorder 插件。
const WARMUP = { "zh-CN": "回复一个词确认在线", en: "Reply with one word to confirm you're online" };

export default {
  name: "llm-recorder",
  steps: [
    { do: "hold", ms: 1400 },
    // 前置:预热建会话 + 产生一条请求记录(soft——失败继续,记录为空也能展示空态)
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: WARMUP },
    { do: "waitAgent", soft: true, hold: 1200 },

    // ── 请求记录:弹窗放大查看 ──
    { do: "click", target: { titleText: "工具" } },
    { do: "click", target: { titleText: "请求记录" }, hold: 1300 },
    { do: "click", target: { titleKey: "panel.expand" }, hold: 1700 },
    { do: "press", key: "Escape", hold: 700 },
  ],
};
