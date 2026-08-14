// 场景剧本:工作台巡览 —— 观众第一眼。分两段:
//   空态:启动即"未打开任何项目"(lastCwd 空),定格空桌面——
//   观众看到新装软件的样子:无会话、无模型选中,只有"从左栏打开文件夹开始"的提示。
//   变满:点项目列表里的 todo(project),再点侧栏会话第一条(主线会话),桌面变满。
// 种子:数据全在(recentCwds 种了 todo/notes-site,会话 3 条)但 lastCwd 空、右面板关。
// 跨语言契约:css 锚点。项目行文本 = 目录 basename("project"),会话行锚 data-session-path。
import * as seed from "../../lib/seed/presets.mjs";

export default {
  name: "workbench",
  seed(ctx) {
    const todo = seed.seedTodoProject(ctx);
    const site = seed.seedSiteProject(ctx);
    seed.seedMainSession(ctx, todo);
    seed.seedOldSession(ctx, todo);
    seed.seedSiteSession(ctx, site);
    seed.seedRecentCwds(ctx, [todo, site]);
    ctx.setPrefs({ lastCwd: "", rightPanelOpen: false });
  },
  steps: [
    // 空态:定格 3s——空桌面(无项目打开/无会话/无模型)
    { do: "hold", ms: 3000 },
    // 点项目列表里的 todo(项目行文本 = 完整路径,contains 匹配尾部 project)→ 打开项目
    { do: "click", target: { text: "project", contains: true, within: "[data-sidebar-style]" }, hold: 1500 },
    // 点侧栏会话第一条(主线会话在最上)→ 满桌面
    { do: "hover", target: { css: "[data-session-path]", nth: 0 } },
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 2500 },
  ],
};
