// 场景剧本:笔记 —— 点 ping 卡片直发进对话。
// 种子:单条 ping 笔记。
// 点卡会真实调 sendMessage 起 pi 进程(notes 插件既有行为);waitAgent soft——
// 模型不通时画面停在消息已发送,模型可达时展示直发效果。
// 设计文档 §4.5(用户要求"就记录 ping 就行")。
export default {
  name: "notes",
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { titleText: "收藏" } },
    { do: "click", target: { titleText: "笔记" }, hold: 1200 },
    { do: "click", target: { text: "ping", within: "[data-sidepanel-style]" }, hold: 800 },
    { do: "waitAgent", soft: true, opts: { appearMs: 20000 }, hold: 1800 },
  ],
};
