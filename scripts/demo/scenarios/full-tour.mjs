// 完整展示剧本 —— 主题 / 笔记 ping / 只读工具调度 / 请求记录 / review / 图钉 /
// 管理页巡礼(含重启按钮展示) / 右上角 debug。
//
// 跨语言契约同 basic-tour:i18n key / title 字面(manifest label 不翻译)/ role 锚点;
// 键入文本是内容层,按 locale 给双语文本。
//
// 前置种子(record.mjs 自动):ping 笔记(全局层)+ read-only 工具组(项目层)。
// 活会话依赖:笔记 ping 与写请求各一次真实模型往返(waitAgent 事件驱动等落定)。
export default {
  name: "full-tour",
  steps: [
    { do: "hold", ms: 1400 },

    // ── 0 主题 ──
    { do: "click", target: { i18nKey: "shell.settings", within: "[data-sidebar-style]" } },
    { do: "click", target: { i18nKey: "settings.theme", within: "[data-sidebar-style]" } },
    { do: "click", target: { i18nKey: "settings.theme", within: '[role="tablist"]' } },
    { do: "click", target: { themeCard: "mocha-dark" }, hold: 1500 },
    { do: "click", target: { i18nKey: "shell.backToChat", within: "[data-sidebar-style]" } },
    { do: "hold", ms: 700 },

    // ── 2 笔记:关掉默认收藏页签 → 开笔记 → 点 ping 卡直发 ──
    { do: "click", target: { titleText: "收藏" } },
    { do: "click", target: { titleText: "笔记" } },
    { do: "click", target: { text: "ping", within: "[data-sidepanel-style]" }, hold: 700 },
    { do: "waitAgent", hold: 1600 },

    // ── 1 工具调度:除 read-only 外全关(面板提示"下次发送生效")→ 预热一轮落配置 → 写请求看拦截 ──
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
    { do: "waitAgent", hold: 1800 },

    // ── 3 请求记录:看这两轮都记了啥 ──
    { do: "click", target: { titleText: "工具" } },
    { do: "click", target: { titleText: "请求记录" }, hold: 1800 },

    // ── 5 review:选中 pong 文本行 → 评论 → 入篮(选 <p> 保证活选区,浮钮才出现)──
    { do: "select", target: { css: "[data-message-id] p", widest: true }, fromFx: 0.05, toFx: 0.6, hold: 800 },
    { do: "click", target: { i18nKey: "shell.comment" }, hold: 600 },
    {
      do: "type",
      target: { placeholderKey: "shell.placeholder" },
      submit: true,
      hold: 1400,
      text: { "zh-CN": "这里语气可以更自然", en: "tone could be more natural" },
    },

    // ── 4 图钉:选色 → 点消息落钉 → 退模式 ──
    { do: "click", target: { titleText: "请求记录" } },
    { do: "click", target: { titleText: "图钉" } },
    { do: "click", target: { palettePin: "#89b4fa" }, hold: 600 },
    // 钉在含文本的消息上(:has(p) 排除分隔线/统计行)
    { do: "click", target: { css: "[data-message-id]:has(p)", nth: 0 }, hold: 1200 },
    { do: "click", target: { palettePin: "#89b4fa" }, hold: 800 },

    // ── 8 管理页巡礼 + 6 重启按钮(展示不点)──
    { do: "click", target: { i18nKey: "shell.settings", within: "[data-sidebar-style]" } },
    { do: "click", target: { i18nKey: "settings.models", within: "[data-sidebar-style]" }, hold: 1300 },
    { do: "click", target: { i18nKey: "settings.skills", within: "[data-sidebar-style]" }, hold: 1300 },
    { do: "click", target: { i18nKey: "settings.tools", within: "[data-sidebar-style]" }, hold: 1300 },
    { do: "click", target: { i18nKey: "settings.plugins", within: "[data-sidebar-style]" }, hold: 1300 },
    { do: "click", target: { i18nKey: "settings.extensions", within: "[data-sidebar-style]" }, hold: 1200 },
    // 制造 pending:关→开第一个可切换 extension,重启区出现
    { do: "click", target: { text: "ON", within: ".settings-content" } },
    { do: "click", target: { text: "OFF", within: ".settings-content" }, hold: 800 },
    { do: "point", target: { i18nKey: "ext.reloadAll" }, hold: 1600 },

    // ── 7 右上角 debug:巡检模式 → 右键退出 ──
    { do: "click", target: { i18nKey: "shell.backToChat", within: "[data-sidebar-style]" } },
    { do: "hold", ms: 600 },
    { do: "click", target: { titleKey: "debug.inspectTitle" }, hold: 1600 },
    { do: "clickRightAt", x: 640, y: 420, hold: 800 },

    { do: "hold", ms: 1200 },
  ],
};
