// 场景剧本:请求记录 —— 打开会话 → 切请求记录 tab → 拖动列表 → 弹窗放大 → 拖动弹窗 → Esc。
// 种子:见 seed.json(主线会话 + llmLogs 按 preset 展开成 12 轮 request/response,
// 按会话文件名对齐)。设计文档 §4.9。
//
// 拖动不新增原语(设计 §2「定位即滚动」):point 一个 off-screen 元素,locate 命中后
// scrollIntoView 即滚动——两次 point(最旧→最新)制造列表滚动感,一次 point(响应段)
// 制造弹窗滚动感。
export default {
  name: "llm-recorder",
  steps: [
    { do: "hold", ms: 1800 },
    // 打开主线会话:面板靠 currentSessionPath 定位日志文件名,不开会是「先打开一个会话」空态
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1800 },
    // 表情包 tab 开右面板(tab 字面量跨语言不变;与 notes/stickers/tool-schedule 同款)
    { do: "click", target: { titleText: "表情包" }, hold: 600 },
    // 切请求记录 tab:读 <cwd>/.my-harness-desktop/llm-logs/<会话文件名>.jsonl,按 seq 倒序渲染
    { do: "click", target: { titleText: "请求记录" }, hold: 1500 },
    // 拖动列表:point 最旧记录(seq 1,倒序在最底)→ scrollIntoView 滚到底
    { do: "point", target: { text: "#1" }, hold: 1200 },
    // 滚回最新记录(seq 12,最顶)——两次 point 制造滚动感,也让下步 expand 命中最新(最重)一条
    { do: "point", target: { text: "#12" }, hold: 800 },
    // 弹窗查看:第一个展开钮 = seq 12(请求 payload 最长,弹窗内滚动素材最足)
    { do: "click", target: { titleKey: "panel.expand" }, hold: 3000 },
    // 拖动弹窗:point 响应段标签(长请求历史在折叠线之下)→ scrollIntoView 滚动弹窗内容
    { do: "point", target: { i18nKey: "panel.response" }, hold: 1500 },
    { do: "press", key: "Escape", hold: 1000 },
  ],
};
