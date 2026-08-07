// 场景剧本:debug 巡检 —— 右上角 debug 巡检模式 → 右键退出。
// 自 full-tour 场景 8 拆出,无会话依赖,可独立录制。
//
// 前置种子(record.mjs 自动):debugMode: true。
export default {
  name: "debug-inspect",
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { titleKey: "debug.inspectTitle" }, hold: 1600 },
    { do: "clickRightAt", x: 640, y: 420, hold: 800 },
    { do: "hold", ms: 1200 },
  ],
};
