// 基础展示剧本 —— 主界面 → 设置 → 主题切换 → 语言页 → 返回对话。
//
// 跨语言契约:target 只写 i18n key / 主题专名 / role 锚点,不写任何随语言变化的文本。
// within 圈定搜索域消歧:设置页左列表([data-sidebar-style])与内容区 tablist([role=tablist])
// 都可能出现同文案(如"主题"),靠搜索域而不是 nth 定位。
//
// 自定义剧本:复制本文件,改 steps 即可。step 形状:
//   { do: "hold", ms }                                   定格
//   { do: "click", target, preHold?, hold? }             涟漪 + 点击 + 结果定格
//   target: { i18nKey | text | themeCard | css, within?, nth? }
export default {
  name: "basic-tour",
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { i18nKey: "shell.settings", within: "[data-sidebar-style]" } },
    { do: "click", target: { i18nKey: "settings.theme", within: "[data-sidebar-style]" } },
    { do: "click", target: { i18nKey: "settings.theme", within: '[role="tablist"]' } },
    { do: "click", target: { themeCard: "mocha-dark" }, hold: 1600 },
    { do: "click", target: { i18nKey: "settings.language", within: "[data-sidebar-style]" }, hold: 1500 },
    { do: "click", target: { i18nKey: "shell.backToChat", within: "[data-sidebar-style]" }, hold: 1400 },
  ],
};
