// 场景剧本:主题设置 —— 切 Mocha Dark + 字体/侧栏/右面板/会话流 4 个大小条拖拽 → 返回对话。
// 自 full-tour 场景 0 拆出,无会话依赖,可独立录制。
//
// 跨语言契约:i18n key / 主题专名 / role 锚点,不写随语言变化的文本。
export default {
  name: "theme-settings",
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { i18nKey: "shell.settings", within: "[data-sidebar-style]" } },
    { do: "click", target: { i18nKey: "settings.theme", within: "[data-sidebar-style]" } },
    { do: "click", target: { i18nKey: "settings.theme", within: '[role="tablist"]' } },
    { do: "click", target: { themeCard: "mocha-dark" }, hold: 1300 },
    { do: "click", target: { i18nKey: "settings.font", within: '[role="tablist"]' } },
    { do: "drag", target: { css: "input[type=range]" }, dx: 80, back: true, hold: 600 },
    { do: "click", target: { i18nKey: "settings.sidebarStyle", within: '[role="tablist"]' } },
    { do: "drag", target: { css: "input[type=range]" }, dx: 80, back: true, hold: 600 },
    { do: "click", target: { i18nKey: "settings.sidepanelStyle", within: '[role="tablist"]' } },
    { do: "drag", target: { css: "input[type=range]" }, dx: 80, back: true, hold: 600 },
    { do: "click", target: { i18nKey: "settings.timelineTheme", within: '[role="tablist"]' } },
    { do: "drag", target: { css: "input[type=range]" }, dx: 80, back: true, hold: 600 },
    { do: "click", target: { i18nKey: "shell.backToChat", within: "[data-sidebar-style]" } },
    { do: "hold", ms: 700 },
  ],
};
