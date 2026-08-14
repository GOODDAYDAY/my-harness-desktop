// 场景剧本:管理页巡礼 —— 模型/技能/工具/插件/扩展/通用 6 页 + 1 个过滤 + 重启按钮展示(不点)。
// 种子:见 seed.json(2 技能 + 工具组 preset;模型配置是基线脱敏副本)。
// 无会话依赖——纯设置页巡礼,开场即空桌面。
//
// 跨语言契约:i18n key / title 字面;过滤标签文案走场景 locales。
export default {
  name: "manager-tour",
  steps: [
    { do: "hold", ms: 1000 },
    { do: "click", target: { i18nKey: "shell.settings", within: "[data-sidebar-style]" } },
    { do: "click", target: { i18nKey: "settings.models", within: "[data-sidebar-style]" }, hold: 1000 },
    { do: "click", target: { i18nKey: "settings.skills", within: "[data-sidebar-style]" }, hold: 900 },
    { do: "click", target: { text: { "$t": "filterEnabled" }, contains: true, within: ".settings-content" }, hold: 700 },
    { do: "click", target: { i18nKey: "settings.tools", within: "[data-sidebar-style]" }, hold: 900 },
    { do: "click", target: { i18nKey: "settings.plugins", within: "[data-sidebar-style]" }, hold: 900 },
    { do: "click", target: { i18nKey: "settings.extensions", within: "[data-sidebar-style]" }, hold: 900 },
    { do: "point", target: { i18nKey: "ext.reloadAll" }, hold: 1200 },
    { do: "click", target: { i18nKey: "settings.general", within: "[data-sidebar-style]" }, hold: 1000 },
  ],
};
