// 场景剧本:工具调度三态 —— 能写 → 只读(拦)→ 恢复能写。开关"下次发送生效",切换后先预热一轮。
// 全片唯一保留真实模型往返的板块:权限拦截必须真跑才有说服力。
// 种子:见 seed.json(工具组走 common preset,组名文案与剧本 groupToggle 共用 $t key)。
// waitAgent 全部 soft:模型往返失败(如录制机无网络/模型慢)不致命,画面停在种子会话,
// 演示仍成立——设计文档 demo-redesign.md §4.4 / QA。
// 注:中间过渡点击的右面板 tab 是「表情包」(stickers 插件的 manifest label 字面量,
// 跨语言不变)——原「笔记」tab 随 notes→stickers 升级已不存在。
export default {
  name: "tool-schedule",
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1200 },
    { do: "click", target: { titleText: "表情包" } },
    { do: "click", target: { titleText: "工具" }, hold: 1200 },

    // 能写:发写请求 → 成功(模型不通则 soft 跳过,画面停在种子会话)
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: { "$t": "writeReq" } },
    { do: "waitAgent", soft: true, opts: { appearMs: 8000 }, hold: 1500 },

    // 只读:关掉 write 组(精确开关,不误伤其他组) → 预热一轮(下次发送生效) → 再发写请求 → 被拦
    { do: "click", target: { groupToggle: { "$t": "toolGroup.files" } }, hold: 1200 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, hold: 600, text: { "$t": "warmup" } },
    { do: "waitAgent", soft: true, opts: { appearMs: 8000 }, hold: 700 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: { "$t": "writeReq" } },
    { do: "waitAgent", soft: true, opts: { appearMs: 8000 }, hold: 1600 },

    // 恢复:重开 write 组(与关闭对称) → 预热 → 再发 → 成功
    { do: "click", target: { groupToggle: { "$t": "toolGroup.files" } }, hold: 1000 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, hold: 600, text: { "$t": "warmup" } },
    { do: "waitAgent", soft: true, opts: { appearMs: 8000 }, hold: 700 },
    { do: "type", target: { css: "[data-timeline-composer]" }, submit: true, text: { "$t": "writeReq" } },
    { do: "waitAgent", soft: true, opts: { appearMs: 8000 }, hold: 1500 },
  ],
};
