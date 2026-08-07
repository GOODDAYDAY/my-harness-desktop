// 场景剧本:工作台巡览 —— 观众第一眼:桌面是满的、活的。
// 种子(record.mjs 自动):会话列表 3 条(todo 主线/旧会话/notes-site)、主区主线会话流、
// 笔记 3 条、右侧面板开(rightPanelOpen: true)。
//
// 跨语言契约:i18n key / title 字面 / css 锚点。侧栏会话条目锚 data-session-path。
export default {
  name: "workbench",
  steps: [
    { do: "hold", ms: 2500 },
    // 悬停侧栏会话列表第一条(主线会话在最上,按 modified 降序)
    { do: "hover", target: { css: "[data-session-path]", nth: 0 } },
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 2000 },
  ],
};
