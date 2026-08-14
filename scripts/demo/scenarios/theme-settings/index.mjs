// 场景剧本:主题设置 —— 切 Everforest Dark + 字体/侧栏 2 个大小条拖拽 → 返回对话。
// 种子:见 seed.json(todo + 主线会话,结尾 backToChat 回到有会话的工作台;主题基线 chatgpt-dark)。
//
// 跨语言契约:i18n key / 主题专名 / role 锚点,不写随语言变化的文本。
export default {
  name: "theme-settings",
  steps: [
    { do: "hold", ms: 1200 },
    { do: "click", target: { i18nKey: "shell.settings", within: "[data-sidebar-style]" } },
    { do: "click", target: { i18nKey: "settings.theme", within: "[data-sidebar-style]" } },
    { do: "click", target: { i18nKey: "settings.theme", within: '[role="tablist"]' } },
    { do: "click", target: { themeCard: "everforest-dark" }, hold: 1600 },
    { do: "click", target: { i18nKey: "settings.font", within: '[role="tablist"]' } },
    { do: "drag", target: { css: "input[type=range]" }, dx: 80, back: true, hold: 700 },
    { do: "click", target: { i18nKey: "settings.sidebarStyle", within: '[role="tablist"]' } },
    { do: "drag", target: { css: "input[type=range]" }, dx: 80, back: true, hold: 700 },
    { do: "click", target: { i18nKey: "shell.backToChat", within: "[data-sidebar-style]" } },
    { do: "hold", ms: 800 },
  ],
};
