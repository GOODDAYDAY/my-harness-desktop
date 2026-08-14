// 场景剧本:请求记录 —— 弹窗放大查看一条请求 → Esc 退出。慢节奏展示明细。
// 种子:见 seed.json(主线会话 + llmLogs 从会话 rows 派生,按会话文件名对齐)。
// 设计文档 §4.9。
export default {
  name: "llm-recorder",
  steps: [
    { do: "hold", ms: 1800 },
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1800 },
    { do: "click", target: { titleText: "工具" }, hold: 600 },
    { do: "click", target: { titleText: "请求记录" }, hold: 1500 },
    { do: "click", target: { titleKey: "panel.expand" }, hold: 3000 },
    { do: "press", key: "Escape", hold: 1000 },
  ],
};
