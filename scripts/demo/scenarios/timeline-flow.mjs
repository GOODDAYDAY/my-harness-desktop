// 场景剧本:会话流渲染 —— 一条完整的干活会话,消息全形态一次看全。
// 种子:todo 主线会话(thinking/toolCall/toolResult/文本/bash/divider/label 全覆盖)。
//
// 滚动不做连续动画(机制零改动):两次 scrollIntoView 定位制造"滚动感"。
// 定位锚:assistant 文本段。设计文档 §4.2。
export default {
  name: "timeline-flow",
  steps: [
    { do: "hold", ms: 1400 },
    // 打开主线会话(侧栏第一条)
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1500 },
    // 定位到 thinking 段:assistant 消息里的首个文本(计划),scrollIntoView 即滚动
    { do: "click", target: { css: "[data-message-id]:has(p)", nth: 1 }, hold: 1200 },
    // 停在「实现方案」文本段(plan3/done 之间),这条文案够长可选中,同时服务 review 板块
    { do: "click", target: { css: "[data-message-id]:has(p)", widest: true }, hold: 2500 },
  ],
};
