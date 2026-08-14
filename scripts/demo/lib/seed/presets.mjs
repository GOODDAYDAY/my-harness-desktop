// 种子预制件 —— 场景 seed 的积木。每个预制件是一块自洽的演示内容
// (fixture 项目 / 会话 / 贴纸 / 技能 / 工具组 / 请求记录),场景 bundle 按需组合。
//
// 文案集中在预制件与 sessions.mjs,不散在剧本里——剧本 target 走 i18n key/
// 语义锚点(locate 既有契约),语言差异只在种子数据层(demo-redesign.md §8 QA)。
//
// 路径约定:todo 项目目录名必须是 "project"(workbench 剧本按文本 "project"
// contains 匹配项目行),notes-site 目录名必须是 "notes-site"。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildMainSession, buildOldSession, buildSiteSession, buildBlockedSession,
  buildMainSessionLogs, sessionFilePath,
} from "./sessions.mjs";

/** todo CLI 项目:主线会话的 cwd,多板块的项目列表/会话列表/会话流共用。
 *  返回项目绝对路径(供会话 cwd、lastCwd、llm-logs 落盘用)。 */
export function seedTodoProject(ctx) {
  const dir = join(ctx.home, "project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.py"), `# todo CLI — 演示项目\ndef load():\n    # 读本地 JSON 数据文件\n    with open("db.json") as f:\n        return json.load(f)\n\n\ndef main():\n    print("todo v0.1")\n\n\nif __name__ == "__main__":\n    main()\n`);
  writeFileSync(join(dir, "README.md"), `# todo\n\nA tiny CLI todo list.\n\n\`\`\`\n$ python main.py add "buy milk"\n$ python main.py list\n\`\`\`\n`);
  writeFileSync(join(dir, "db.json"), `[{"text": "buy milk", "due": "2026-07-20"}, {"text": "water plants", "due": "2026-07-25"}, {"text": "ship demo", "due": "2026-08-10"}]`);
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests", "test_main.py"), `def test_load():\n    assert True\n`);
  return dir;
}

/** notes-site 项目:第二项目,撑起"工作台有多个项目"的画面。 */
export function seedSiteProject(ctx) {
  const dir = join(ctx.home, "notes-site");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), `<h1>notes-site</h1>\n<input id="q" placeholder="search" />\n`);
  writeFileSync(join(dir, "search.ts"), `export function search(items, q) {\n  return items.filter((i) => i.title.includes(q));\n}\n`);
  writeFileSync(join(dir, "README.md"), `# notes-site\n\nStatic site for notes.\n`);
  return dir;
}

/** 主线会话:「加 --due 参数」完整干活过程(全渲染形态)。返回会话文件路径。 */
export function seedMainSession(ctx, cwd) {
  const path = sessionFilePath(ctx.agentDir, cwd);
  writeFileSync(path, buildMainSession(ctx.locale, cwd), "utf-8");
  return path;
}

/** 旧会话:「修复重复项 bug」,3 天前。 */
export function seedOldSession(ctx, cwd) {
  const path = sessionFilePath(ctx.agentDir, cwd, new Date(Date.now() - 3 * 24 * 3600_000));
  writeFileSync(path, buildOldSession(ctx.locale, cwd), "utf-8");
  return path;
}

/** 第二项目会话:notes-site 加搜索,2 天前。 */
export function seedSiteSession(ctx, cwd) {
  const path = sessionFilePath(ctx.agentDir, cwd, new Date(Date.now() - 2 * 24 * 3600_000));
  writeFileSync(path, buildSiteSession(ctx.locale, cwd), "utf-8");
  return path;
}

/** 拦截变体会话:「只读模式下被拦了一次」,1 小时前(toolResult isError 红条形态)。 */
export function seedBlockedSession(ctx, cwd) {
  const path = sessionFilePath(ctx.agentDir, cwd, new Date(Date.now() - 3600_000));
  writeFileSync(path, buildBlockedSession(ctx.locale, cwd), "utf-8");
  return path;
}

/** 主线会话对应的请求记录(llm-recorder 种子):<cwd>/.pi-desktop/llm-logs/<会话文件名>。 */
export function seedMainSessionLogs(ctx, cwd, sessionPath) {
  const logs = buildMainSessionLogs(ctx.locale, sessionPath);
  const logsDir = join(cwd, ".pi-desktop", "llm-logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    join(logsDir, logs.fileName),
    logs.lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

/** 项目列表种子:projects 插件读 recentCwds(全局 projects.json)。 */
export function seedRecentCwds(ctx, cwds) {
  ctx.writeConfig("projects", { recentCwds: cwds, sectionCollapsed: false });
}

/** 贴纸种子:单条 ping,落项目层(面板新建的默认语义)——stickers key 与
 *  stickers-store 读写同源(统一配置通道契约)。id 固定字面量,重录不漂移。 */
export function seedPingSticker(ctx, cwd) {
  const now = Date.now();
  ctx.writeProjectConfig(cwd, "stickers", {
    stickers: [
      { id: "demo-sticker-ping", title: "ping", content: "ping", order: 0, createdAt: now, updatedAt: now },
    ],
  });
}

/** 技能种子:像真的名字(替代早期 demo-alpha/beta 的敷衍感)。 */
export function seedSkills(ctx) {
  const skills = ctx.locale === "zh-CN"
    ? [["git-release", "打 git tag 并推送 release 分支"], ["code-review", "审查一段代码改动并给出改进意见"]]
    : [["git-release", "Tag a release and push the release branch"], ["code-review", "Review a code change and suggest improvements"]];
  for (const [name, desc] of skills) {
    const dir = join(ctx.agentDir, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n${desc}.\n`);
  }
}

/** 工具组种子:files(文件操作)/exec(命令执行)两组——工具调度板块的演示基础。
 *  组名是剧本 groupToggle 锚点(字面"文件操作"),不随 locale 变。 */
export function seedToolGroups(ctx) {
  ctx.writeConfig("tool-manager", {
    groups: [
      { id: "files", name: "文件操作", description: "demo: file tools", toolIds: ["read", "write", "edit", "find", "grep", "ls"], defaultEnabled: true },
      { id: "exec", name: "命令执行", description: "demo: exec tools", toolIds: ["bash"], defaultEnabled: true },
    ],
  });
}
