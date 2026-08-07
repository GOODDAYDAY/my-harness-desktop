// 场景剧本:笔记 ping 直发 —— 关默认收藏页签 → 开笔记 → 点 ping 卡直发一条消息。
// 自 full-tour 场景 2 拆出,自带起会话(点 ping 直发即起),可独立录制。
//
// 前置种子(record.mjs 自动):ping 笔记 / 空会话。
export default {
  name: "notes-ping",
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { titleText: "收藏" } },
    { do: "click", target: { titleText: "笔记" } },
    { do: "click", target: { text: "ping", within: "[data-sidepanel-style]" }, hold: 700 },
    { do: "waitAgent", soft: true, hold: 1500 },
  ],
};
