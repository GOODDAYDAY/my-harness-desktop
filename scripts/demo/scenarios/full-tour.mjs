// 完整展示剧本 v2 —— 主题(切换+四档大小条拖拽) / 笔记 ping / 只读工具调度拦截 /
// 请求记录(弹窗放大) / review(两条评论并发送) / 图钉 / 收藏一击 / 管理页巡礼
// (含过滤与通用页、重启按钮展示) / 右上角 debug 巡检。
//
// 跨语言契约:i18n key / title 字面(manifest label 不翻译)/ role 锚点;
// 键入文本与过滤标签按 locale 给双语文本。
//
// 前置种子(record.mjs 自动):ping 笔记(全局层)+ read-only 工具组(项目层)+
// debugMode + 全局工具组默认关。活会话依赖:4~5 次真实模型往返(waitAgent 事件驱动)。
export default {
  name: "full-tour",
  steps: [
    { do: "hold", ms: 1400 },

    // ── 0 主题:切换 + 每个大小条都拖 ──
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

    // ── 2 笔记:关掉默认收藏页签 → 开笔记 → 点 ping 卡直发 ──
    { do: "click", target: { titleText: "收藏" } },
    { do: "click", target: { titleText: "笔记" } },
    { do: "click", target: { text: "ping", within: "[data-sidepanel-style]" }, hold: 700 },
    { do: "waitAgent", hold: 1500 },

    // ── 1 工具调度:除 read-only 外全关 → 预热一轮落配置 → 写请求看拦截 ──
    { do: "click", target: { titleText: "笔记" } },
    { do: "click", target: { titleText: "工具" }, hold: 1200 },
    { do: "toolsOnlyReadOnly", hold: 1400 },
    {
      do: "type",
      target: { css: "[data-timeline-composer]" },
      submit: true,
      hold: 700,
      text: { "zh-CN": "回复一个词确认在线", en: "Reply with one word to confirm you're online" },
    },
    { do: "waitAgent", hold: 900 },
    {
      do: "type",
      target: { css: "[data-timeline-composer]" },
      submit: true,
      text: {
        "zh-CN": "往 /tmp/demo-write.txt 写入内容 hello",
        en: "Write hello into /tmp/demo-write.txt",
      },
    },
    { do: "waitAgent", hold: 1600 },

    // ── 3 请求记录:弹窗放大查看 ──
    { do: "click", target: { titleText: "工具" } },
    { do: "click", target: { titleText: "请求记录" }, hold: 1300 },
    { do: "click", target: { titleKey: "panel.expand" }, hold: 1700 },
    { do: "press", key: "Escape", hold: 700 },

    // ── 5 review:两条评论入篮 → 发送 ──
    { do: "select", target: { css: "[data-message-id] p", widest: true }, fromFx: 0.05, toFx: 0.6, hold: 700 },
    { do: "click", target: { i18nKey: "shell.comment" }, hold: 500 },
    {
      do: "type",
      target: { placeholderKey: "shell.placeholder" },
      submit: true,
      hold: 800,
      text: { "zh-CN": "这里语气可以更自然", en: "tone could be more natural" },
    },
    { do: "select", target: { css: "[data-message-id] p", nth: 0 }, fromFx: 0, toFx: 1, hold: 700 },
    { do: "click", target: { i18nKey: "shell.comment" }, hold: 500 },
    {
      do: "type",
      target: { placeholderKey: "shell.placeholder" },
      submit: true,
      hold: 1000,
      text: { "zh-CN": "这句保留", en: "keep this one" },
    },
    { do: "press", key: "Enter" },
    { do: "waitAgent", hold: 1500 },

    // ── 4 图钉:选色 → 点消息落钉 → 退模式 ──
    { do: "click", target: { titleText: "请求记录" } },
    { do: "click", target: { titleText: "图钉" } },
    { do: "click", target: { palettePin: "#89b4fa" }, hold: 600 },
    { do: "click", target: { css: "[data-message-id]:has(p)", nth: 0 }, hold: 1100 },
    { do: "click", target: { palettePin: "#89b4fa" }, hold: 700 },

    // ── 收藏:悬停消息 → 一击收藏 → 揭示收藏页签 ──
    { do: "hover", target: { css: "[data-message-id]:has(p)", widest: true } },
    { do: "click", target: { i18nKey: "shell.bookmark" }, hold: 1600 },

    // ── 8 管理页巡礼(含过滤与通用)+ 6 重启按钮(展示不点)──
    { do: "click", target: { i18nKey: "shell.settings", within: "[data-sidebar-style]" } },
    { do: "click", target: { i18nKey: "settings.models", within: "[data-sidebar-style]" }, hold: 1200 },
    { do: "click", target: { i18nKey: "settings.skills", within: "[data-sidebar-style]" }, hold: 1100 },
    { do: "click", target: { text: { "zh-CN": "启用", en: "Enabled" }, contains: true, within: ".settings-content" }, hold: 900 },
    { do: "click", target: { text: { "zh-CN": "全部", en: "All" }, contains: true, within: ".settings-content" }, hold: 700 },
    { do: "click", target: { i18nKey: "settings.tools", within: "[data-sidebar-style]" }, hold: 1100 },
    { do: "click", target: { i18nKey: "settings.plugins", within: "[data-sidebar-style]" }, hold: 1100 },
    { do: "click", target: { text: "会话", contains: true, within: ".settings-content" }, hold: 900 },
    { do: "click", target: { i18nKey: "settings.extensions", within: "[data-sidebar-style]" }, hold: 1100 },
    { do: "click", target: { text: "ON", within: ".settings-content" } },
    { do: "click", target: { text: "OFF", within: ".settings-content" }, hold: 800 },
    { do: "point", target: { i18nKey: "ext.reloadAll" }, hold: 1500 },
    { do: "click", target: { text: { "zh-CN": "本地", en: "local" }, contains: true, within: ".settings-content" }, hold: 1000 },
    { do: "click", target: { i18nKey: "settings.general", within: "[data-sidebar-style]" }, hold: 1300 },

    // ── 7 右上角 debug:巡检模式 → 右键退出 ──
    { do: "click", target: { i18nKey: "shell.backToChat", within: "[data-sidebar-style]" } },
    { do: "hold", ms: 600 },
    { do: "click", target: { titleKey: "debug.inspectTitle" }, hold: 1600 },
    { do: "clickRightAt", x: 640, y: 420, hold: 800 },

    { do: "hold", ms: 1200 },
  ],
};
