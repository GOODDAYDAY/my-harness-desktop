// 场景剧本:管理页巡礼 —— 模型/技能/工具/插件/扩展/通用 6 页 + 1 个过滤 + 重启按钮展示(不点)。
// 种子:2 技能(技能页过滤有内容)+ 工具组(工具页有组可看);模型配置是基线脱敏副本。
// 无会话依赖——纯设置页巡礼,开场即空桌面。
//
// 跨语言契约:i18n key / title 字面;过滤标签按 locale 给双语文本。
import * as seed from "../../lib/seed/presets.mjs";

export default {
  name: "manager-tour",
  seed(ctx) {
    seed.seedSkills(ctx);
    seed.seedToolGroups(ctx);
  },
  steps: [
    { do: "hold", ms: 1000 },
    { do: "click", target: { i18nKey: "shell.settings", within: "[data-sidebar-style]" } },
    { do: "click", target: { i18nKey: "settings.models", within: "[data-sidebar-style]" }, hold: 1000 },
    { do: "click", target: { i18nKey: "settings.skills", within: "[data-sidebar-style]" }, hold: 900 },
    { do: "click", target: { text: { "zh-CN": "启用", en: "Enabled" }, contains: true, within: ".settings-content" }, hold: 700 },
    { do: "click", target: { i18nKey: "settings.tools", within: "[data-sidebar-style]" }, hold: 900 },
    { do: "click", target: { i18nKey: "settings.plugins", within: "[data-sidebar-style]" }, hold: 900 },
    { do: "click", target: { i18nKey: "settings.extensions", within: "[data-sidebar-style]" }, hold: 900 },
    { do: "point", target: { i18nKey: "ext.reloadAll" }, hold: 1200 },
    { do: "click", target: { i18nKey: "settings.general", within: "[data-sidebar-style]" }, hold: 1000 },
  ],
};
