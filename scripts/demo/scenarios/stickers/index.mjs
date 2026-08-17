// 场景剧本:表情包 —— 新建会话 → 内置贴纸(已自带 ping) + 展示可新建 → 点卡直发 → 续写发送 → 重载验证。
//   开场面板自带内置贴纸(assets/stickers 镜像,含 ping/worktree/commit…,零种子,见 seed.json)。
//   ＋ 新建会话作发送目标 → 表情包面板(内置 ping)→ 新建一张 toy 贴纸(只展示"能新建",不发)→
//   点 ping 卡直发 ×2(乐观注入,模型回复 soft)→ hover「加入输入框」→ 输入框续写发送 →
//   直接点第一条(当前会话)触发从盘重载,证明刷新后发送内容展示正常。
// 活体语义:点卡直发天性是 live,waitAgent 全 soft,模型不通画面停在已发送。
// 跨语言契约:面板按钮 title(新建贴纸/加入输入框…)是组件字面量,不随语言变;
// 编辑器 placeholder 与保存钮走 stickers.* i18n key;新建会话 ＋ 按钮 title 走 sessions.new。
export default {
  name: "stickers",
  steps: [
    { do: "hold", ms: 1400 },
    // 新建会话:＋ 按钮(title = i18n sessions.new)开一个全新空会话作发送目标
    { do: "click", target: { titleKey: "sessions.new", within: "[data-sidebar-style]" }, hold: 1500 },
    // 打开表情包面板(内置贴纸已自带 ping)
    { do: "click", target: { titleText: "表情包" }, hold: 1500 },
    // 新建贴纸:展示一下"能新建"即可(toy 只建不发,发送仍用默认 ping)
    { do: "click", target: { titleText: "新建贴纸" }, hold: 800 },
    { do: "type", target: { placeholderKey: "stickers.titlePlaceholder" }, text: "toy" },
    { do: "type", target: { placeholderKey: "stickers.contentPlaceholder" }, text: "toy" },
    { do: "click", target: { i18nKey: "stickers.save", within: "[data-sidepanel-style]" }, hold: 1200 },
    // 点默认 ping 卡直发 ×2(doneMs 给足:流式落定后再动下一步——streaming 期间卡面重排
    // (sending 指示出现/消失)会让 hover 浮钮在 locate→click 窗口里移位)
    { do: "click", target: { text: "ping", within: "[data-sidepanel-style]" }, hold: 800 },
    { do: "waitAgent", soft: true, opts: { appearMs: 15000, doneMs: 40000 }, hold: 1500 },
    { do: "click", target: { text: "ping", within: "[data-sidepanel-style]" }, hold: 800 },
    { do: "waitAgent", soft: true, opts: { appearMs: 15000, doneMs: 40000 }, hold: 1500 },
    // 加入输入框:hover 浮钮 → composer 得 "ping" → 续写发送。
    // 面板序:toy(项目层)在前、内置 ping 在后,「加入输入框」按钮每卡一个,故取 nth:1 命中 ping 卡。
    { do: "hover", target: { text: "ping", within: "[data-sidepanel-style]" } },
    { do: "click", target: { titleText: "加入输入框（不发送，可改后再发）", nth: 1 }, hold: 1000 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: { "$t": "append" } },
    { do: "waitAgent", soft: true, opts: { appearMs: 15000, doneMs: 40000 }, hold: 1500 },
    // 切前留 settle 定格:后台 pi 进程落盘收尾,避开"刚流式完就重开"的快照竞态。
    { do: "hold", ms: 3000 },
    // 直接点第一条(当前新建会话)→ openSession 从盘重读 + openNonce 重挂触发重载
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1500 },
    // 重开后视口可能在顶部:点「回到底部」把 ping/pong 消息拉进画面(按钮只在滚离
    // 底部时存在,soft 跳过兜底)——刷新后展示正常的证明帧
    { do: "click", target: { text: "回到底部" }, soft: true, hold: 1200 },
    { do: "hold", ms: 2500 },
  ],
};
