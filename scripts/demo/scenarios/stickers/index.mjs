// 场景剧本:表情包 —— 从零到发送的完整闭环。
//   空面板开场(啥都不种)→ ＋ 新建 ping(标题+内容)→ 保存出卡 →
//   点卡直发 ×2(乐观注入,模型回复 soft)→ hover「加入输入框」→ 输入框续写发送 →
//   点左侧旧会话再点回主线(触发从盘重载),证明刷新后发送内容展示正常。
// 种子:见 seed.json(只种项目与会话,贴纸零预置——本板块演示的就是"从无到有")。
// 活体语义同 notes 板块:点卡直发天性是 live,waitAgent 全 soft,模型不通画面停在已发送。
// 跨语言契约:面板按钮 title(新建贴纸/加入输入框…)是组件字面量,不随语言变;
// 编辑器 placeholder 与保存钮走 stickers.* i18n key。
export default {
  name: "stickers",
  steps: [
    { do: "hold", ms: 1400 },
    // 打开主线会话(发送目标)
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1200 },
    // 空面板:暂无贴纸
    { do: "click", target: { titleText: "表情包" }, hold: 1500 },
    // 新建 ping:＋ → 编辑器 → 标题/内容 → 保存
    { do: "click", target: { titleText: "新建贴纸" }, hold: 800 },
    { do: "type", target: { placeholderKey: "stickers.titlePlaceholder" }, text: "ping" },
    { do: "type", target: { placeholderKey: "stickers.contentPlaceholder" }, text: "ping" },
    { do: "click", target: { i18nKey: "stickers.save", within: "[data-sidepanel-style]" }, hold: 1200 },
    // 点卡直发 ×2(doneMs 给足:流式落定后再动下一步——streaming 期间卡面重排
    // (sending 指示出现/消失)会让 hover 浮钮在 locate→click 窗口里移位)
    { do: "click", target: { text: "ping", within: "[data-sidepanel-style]" }, hold: 800 },
    { do: "waitAgent", soft: true, opts: { appearMs: 15000, doneMs: 40000 }, hold: 1500 },
    { do: "click", target: { text: "ping", within: "[data-sidepanel-style]" }, hold: 800 },
    { do: "waitAgent", soft: true, opts: { appearMs: 15000, doneMs: 40000 }, hold: 1500 },
    // 加入输入框:hover 浮钮 → composer 得 "ping" → 续写发送
    { do: "hover", target: { text: "ping", within: "[data-sidepanel-style]" } },
    { do: "click", target: { titleText: "加入输入框（不发送，可改后再发）" }, hold: 1000 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: { "$t": "append" } },
    { do: "waitAgent", soft: true, opts: { appearMs: 15000, doneMs: 40000 }, hold: 1500 },
    // 左侧切走再切回:触发会话从盘重载,定格证明刷新后展示正常。
    // 切前留 settle 定格:后台 pi 进程落盘收尾,避开"刚流式完就重开"的快照竞态。
    { do: "hold", ms: 3000 },
    { do: "click", target: { css: "[data-session-path]", nth: 1 }, hold: 1200 },
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1200 },
    // 重开后视口可能在顶部:点「回到底部」把 ping/pong 消息拉进画面(按钮只在滚离
    // 底部时存在,soft 跳过兜底)——刷新后展示正常的证明帧
    { do: "click", target: { text: "回到底部" }, soft: true, hold: 1200 },
    { do: "hold", ms: 2500 },
  ],
};
