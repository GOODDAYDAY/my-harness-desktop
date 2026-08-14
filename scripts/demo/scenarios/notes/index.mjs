// 场景剧本:表情包(原笔记板块)—— 点 ping 贴纸直发进对话。
// 种子:单条 ping 贴纸(项目层 stickers.json,stickers key 与 stickers-store 同源)
// + 主线会话(发送目标)。
// 点贴纸会真实调 sendMessage 起 pi 进程(stickers 插件既有行为);waitAgent soft——
// 模型不通时画面停在消息已发送(乐观注入),模型可达时展示直发效果。
// 注:notes 插件已升级为 stickers(表情包)——tab 锚点用 manifest label 字面量
// 「表情包」(跨语言不变),原「笔记」tab 已不存在。
import * as seed from "../../lib/seed/presets.mjs";

export default {
  name: "notes",
  seed(ctx) {
    const todo = seed.seedTodoProject(ctx);
    seed.seedMainSession(ctx, todo);
    seed.seedPingSticker(ctx, todo);
    seed.seedRecentCwds(ctx, [todo]);
    ctx.setPrefs({ lastCwd: todo });
  },
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { titleText: "收藏" } },
    { do: "click", target: { titleText: "表情包" }, hold: 1200 },
    { do: "click", target: { text: "ping", within: "[data-sidepanel-style]" }, hold: 800 },
    { do: "waitAgent", soft: true, opts: { appearMs: 20000 }, hold: 1800 },
  ],
};
