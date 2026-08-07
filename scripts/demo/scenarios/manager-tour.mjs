// 场景剧本:管理页巡礼 —— 模型/技能/工具/插件/扩展/通用 6 页 + 过滤标签 + 重启按钮展示(不点)。
// 自 full-tour 场景 7 拆出,无会话依赖,可独立录制。
//
// 跨语言契约:i18n key / title 字面;过滤标签按 locale 给双语文本。
export default {
  name: "manager-tour",
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { i18nKey: "shell.settings", within: "[data-sidebar-style]" } },
    { do: "click", target: { i18nKey: "settings.models", within: "[data-sidebar-style]" }, hold: 1200 },
    { do: "click", target: { i18nKey: "settings.skills", within: "[data-sidebar-style]" }, hold: 1100 },
    { do: "click", target: { text: { "zh-CN": "启用", en: "Enabled" }, contains: true, within: ".settings-content" }, hold: 900 },
    { do: "click", target: { text: { "zh-CN": "全部", en: "All" }, contains: true, within: ".settings-content" }, hold: 700 },
    { do: "click", target: { i18nKey: "settings.tools", within: "[data-sidebar-style]" }, hold: 1100 },
    { do: "click", target: { i18nKey: "settings.plugins", within: "[data-sidebar-style]" }, hold: 1100 },
    { do: "click", target: { text: "会话", contains: true, within: ".settings-content" }, hold: 900 },
    { do: "click", target: { i18nKey: "settings.extensions", within: "[data-sidebar-style]" }, hold: 1100 },
    { do: "point", target: { i18nKey: "ext.reloadAll" }, hold: 1500 },
    { do: "click", target: { text: { "zh-CN": "本地", en: "local" }, contains: true, within: ".settings-content" }, hold: 1000 },
    { do: "click", target: { i18nKey: "settings.general", within: "[data-sidebar-style]" }, hold: 1300 },
  ],
};
