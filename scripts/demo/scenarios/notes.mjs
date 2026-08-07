// 场景剧本:笔记 —— 随手记几条,看笔记面板长什么样。
// 种子:3 条笔记(发布前检查 / --due 实现要点 / 随手代码片段)。
//
// 不点卡片直发:点卡会真实调 sendMessage 起 pi 进程等模型回复(notes 插件既有行为),
// 等于第二个真实往返点——设计总纲"只有 tool-schedule 有真实往返",故只展示面板与内容浏览。
// 设计文档 §4.5。
export default {
  name: "notes",
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { titleText: "收藏" } },
    { do: "click", target: { titleText: "笔记" }, hold: 1200 },
    { do: "click", target: { text: "发布前检查", within: "[data-sidepanel-style]" }, hold: 1500 },
  ],
};
