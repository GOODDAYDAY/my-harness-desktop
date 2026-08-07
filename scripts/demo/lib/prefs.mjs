// 隔离执行环境 —— 每次录制在 /tmp/pi-demo-<rand>/ 现搭一次性 HOME,录完即弃。
//
// 为什么隔离:录制会捕获 UI 上的一切(会话标题、项目路径、扩展清单、skills 清单)。
// 跑在真实 profile 上会把这些个人/内部信息录进 GIF,且重复执行互相污染。
// 隔离 HOME 后:数据根(~/.pi-desktop-dev)与 ~/.pi/agent 全空,只种子演示所需的最小状态;
// 重的共享资产(pi 底座、models.json)用符号链接借真实 HOME 的,功能可用又不复制密钥。
//
// 环境内路径随 HOME 分流(client/paths 的 homedir() 吃 $HOME),应用代码零感知。
//
// 种子内容设计见 docs/design/demo-redesign.md §3:两个 fixture 项目 + 三条种子会话
// (主线/旧会话/第二项目) + 3 笔记 + 2 技能 + 书签/图钉,全部按 locale 生成。
import {
  mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync, rmSync, readFileSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { platform, tmpdir } from "node:os";

import {
  buildMainSession, buildMainSessionLogs, buildOldSession, buildSiteSession, sessionFilePath,
} from "./seed-sessions.mjs";

export function makeRunRoot() {
  // 用 os.tmpdir()(POSIX 即 /tmp):Windows 上字面 "/tmp" 是当前盘根且无盘符,
  // Node 自身 API 能用但外部程序(ffmpeg 合成 GIF)解析不了。
  const base = tmpdir();
  // 只清过期残留(>1h):并发录制时各实例用自己唯一时间戳根,不能互删;
  // 崩溃残留由下次运行的过期清理兜底。
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of readdirSync(base)) {
    if (!name.startsWith("pi-demo-")) continue;
    try {
      if (statSync(join(base, name)).mtimeMs < cutoff) {
        rmSync(join(base, name), { recursive: true, force: true });
      }
    } catch {
      // 目录瞬时不可读(并发删除竞态)忽略,下次再清
    }
  }
  const root = join(base, `pi-demo-${Date.now().toString(36)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

/** 搭隔离 HOME:目录骨架 + 符号链接借资产 + 演示状态种子。返回关键路径供录制使用。 */
export function setupIsolatedHome({ home, realHome, fixtureProject, locale = "zh-CN" }) {
  const dataRoot = join(home, ".pi-desktop-dev");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(join(dataRoot, "config"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const realBase = join(realHome, ".pi-desktop-dev", "pi");
  // Windows 目录链接用 junction(mklink /J):符号链接要管理员权限(EPERM),junction 免。
  // POSIX 平台 junction 类型不适用,走默认符号链接。
  if (existsSync(realBase)) symlinkSync(realBase, join(dataRoot, "pi"), platform() === "win32" ? "junction" : undefined);
  const realModels = join(realHome, ".pi", "agent", "models.json");
  if (existsSync(realModels)) sanitizeModels(realModels, join(agentDir, "models.json"));
  // 底座默认模型:models.json 脱敏后 provider 键名/模型名全变,真实 settings.json 的
  // defaultProvider/defaultModel 指向旧名——不能直接复制(会把真实模型名泄漏进 GIF)。
  // 种一份脱敏 settings.json:defaultProvider 指脱敏后的 provider-1,模型指该 provider
  // 第一个模型 id(底座 spawn 后按默认模型发起调用,waitAgent 才能等到响应)。
  writeJson(join(agentDir, "settings.json"), {
    defaultProvider: "provider-1",
    defaultModel: firstModelId(realModels),
    defaultThinkingLevel: "high",
  });

  // ── 两个 fixture 项目:todo(主线)+ notes-site(第二项目,侧栏第二条来源)──
  const todoProject = fixtureProject;
  const siteProject = join(home, "notes-site");
  seedTodoProject(todoProject);
  seedSiteProject(siteProject);

  // ── 三条种子会话(JSONL 结构化生成,见 seed-sessions.mjs)──
  const mainSessionPath = sessionFilePath(agentDir, todoProject);
  writeFileSync(mainSessionPath, buildMainSession(locale, todoProject), "utf-8");
  writeFileSync(sessionFilePath(agentDir, todoProject, new Date(Date.now() - 3 * 24 * 3600_000)),
    buildOldSession(locale, todoProject), "utf-8");
  writeFileSync(sessionFilePath(agentDir, siteProject, new Date(Date.now() - 2 * 24 * 3600_000)),
    buildSiteSession(locale, siteProject), "utf-8");

  // 主线会话对应的请求记录(llm-recorder 种子):llm-logs/<会话文件名>.jsonl
  const logs = buildMainSessionLogs(locale, mainSessionPath);
  const logsDir = join(todoProject, ".pi-desktop", "llm-logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    join(logsDir, logs.fileName),
    logs.lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );

  // ── 配置种子 ──
  const prefsFile = join(dataRoot, "config", "config.json");
  writeJson(prefsFile, {
    currentThemeId: "chatgpt-dark",
    activeSidePanelTabs: [],
    rightPanelOpen: true,
    lastCwd: todoProject,
    bundledSkillsEnabled: false,
  });
  writeJson(join(dataRoot, "config", "general.json"), {
    defaultThinkingLevel: "off",
    sidebarDefaultOpen: true,
    debugMode: true,
  });
  writeJson(join(dataRoot, "config", "notes.json"), seedNotes(locale));
  // goody-hao:注入工程原则 prompt,模型回复会带"架构自检"等仓库内容;sub-agent:启动期
  // 握手会建 $bus 会话并引入第二进程,干扰录制——演示环境两者禁用。
  writeJson(join(dataRoot, "config", "plugin-manager.json"), {
    disabledPlugins: ["goody-hao", "sub-agent"],
  });
  writeJson(join(dataRoot, "config", "tool-manager.json"), {
    groups: [
      { id: "write", name: "write", description: "demo: write tools", toolIds: ["write", "edit", "bash"], defaultEnabled: true },
      { id: "read-only", name: "read-only", description: "demo: read-only tools", toolIds: ["read", "grep", "ls", "find"], defaultEnabled: true },
    ],
  });

  // ── 技能种子:像真的名字,替代 demo-alpha/beta ──
  const skills = locale === "zh-CN"
    ? [["git-release", "打 git tag 并推送 release 分支"], ["code-review", "审查一段代码改动并给出改进意见"]]
    : [["git-release", "Tag a release and push the release branch"], ["code-review", "Review a code change and suggest improvements"]];
  for (const [name, desc] of skills) {
    const dir = join(agentDir, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n${desc}.\n`);
  }

  return {
    dataRoot,
    agentDir,
    prefsFile,
    fixtureProject: todoProject,
    toolManagerProjectFile: join(todoProject, ".pi-desktop", "config", "tool-manager.json"),
  };
}

/** 每遍录制前按 locale 补 prefs(locale 因 i18n 竞态可能需 UI 兜底切换,见 record.mjs)。 */
export function patchLocale(prefsFile, locale) {
  const doc = existsSync(prefsFile) ? JSON.parse(readFileSyncSafe(prefsFile)) : {};
  writeJson(prefsFile, { ...doc, currentLocale: locale });
}

/** todo CLI 项目:主线会话的 cwd,工作台全景的项目列表/会话列表/会话流共用。 */
function seedTodoProject(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.py"), `# todo CLI — 演示项目\ndef load():\n    # 读本地 JSON 数据文件\n    with open("db.json") as f:\n        return json.load(f)\n\n\ndef main():\n    print("todo v0.1")\n\n\nif __name__ == "__main__":\n    main()\n`);
  writeFileSync(join(dir, "README.md"), `# todo\n\nA tiny CLI todo list.\n\n\`\`\`\n$ python main.py add "buy milk"\n$ python main.py list\n\`\`\`\n`);
  writeFileSync(join(dir, "db.json"), `[{"text": "buy milk", "due": "2026-07-20"}, {"text": "water plants", "due": "2026-07-25"}, {"text": "ship demo", "due": "2026-08-10"}]`);
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests", "test_main.py"), `def test_load():\n    assert True\n`);
}

/** notes-site 项目:第二项目,撑起"工作台有多个项目"的画面。 */
function seedSiteProject(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), `<h1>notes-site</h1>\n<input id="q" placeholder="search" />\n`);
  writeFileSync(join(dir, "search.ts"), `export function search(items, q) {\n  return items.filter((i) => i.title.includes(q));\n}\n`);
  writeFileSync(join(dir, "README.md"), `# notes-site\n\nStatic site for notes.\n`);
}

/** 笔记 3 条:发布前检查 / --due 实现要点 / 随手代码片段(有真实感)。 */
function seedNotes(locale) {
  const zh = locale === "zh-CN";
  const now = Date.now();
  return {
    notes: [
      {
        id: "demo-note-1", title: "发布前检查", order: 0, createdAt: now - 3 * 24 * 3600_000, updatedAt: now - 3 * 24 * 3600_000,
        content: zh
          ? "发布前检查清单：\n- 跑一遍全量测试\n- 确认 CHANGELOG 更新\n- 打 tag 并推送\n- 发 release 说明"
          : "Pre-release checklist:\n- Run full test suite\n- Update CHANGELOG\n- Tag and push\n- Write release notes",
      },
      {
        id: "demo-note-2", title: "--due 实现要点", order: 1, createdAt: now - 2 * 24 * 3600_000, updatedAt: now - 2 * 24 * 3600_000,
        content: zh
          ? "给 list 加 --due 的要点：\n1. argparse 里收一个可选日期\n2. list 时过滤 due 晚于该日期的项\n3. 过期项标 ⚠\n先过滤再排序，少一次遍历。"
          : "Notes on adding --due to list:\n1. Accept optional date in argparse\n2. Filter tasks whose due is after that date\n3. Mark overdue with ⚠\nFilter before sort — one less pass.",
      },
      {
        id: "demo-note-3", title: "随手", order: 2, createdAt: now - 24 * 3600_000, updatedAt: now - 24 * 3600_000,
        content: zh
          ? "```python\n# 分页工具\ndef paginate(items, page, size=10):\n    start = (page - 1) * size\n    return items[start:start + size]\n```"
          : "```python\n# pagination helper\ndef paginate(items, page, size=10):\n    start = (page - 1) * size\n    return items[start:start + size]\n```",
      },
    ],
  };
}

/** 脱敏复制 models.json:baseUrl/apiKey/headers/模型 id 保留(功能可用),
 *  provider 键名与模型展示名换中性值——GIF 不携带真实供应商域名/命名。 */
function sanitizeModels(realPath, targetPath) {
  const doc = JSON.parse(readFileSync(realPath, "utf-8"));
  const providers = {};
  let i = 0;
  for (const p of Object.values(doc.providers ?? {})) {
    i++;
    providers[`provider-${i}`] = {
      ...p,
      models: (p.models ?? []).map((m, j) => ({ ...m, name: `model-${i}.${j + 1}` })),
    };
  }
  writeJson(targetPath, { ...doc, providers });
}

/** 脱敏后 settings.json 的 defaultModel:取第一个 provider 的第一个模型 id。
 *  id 在 sanitizeModels 里保留(只有 name 换中性值),底座按 id 发起调用。 */
function firstModelId(realModelsPath) {
  if (!existsSync(realModelsPath)) return "";
  try {
    const doc = JSON.parse(readFileSync(realModelsPath, "utf-8"));
    for (const p of Object.values(doc.providers ?? {})) {
      const m = (p.models ?? [])[0];
      if (m && typeof m.id === "string") return m.id;
    }
  } catch {
    // 损坏忽略,底座会回落到空默认
  }
  return "";
}

function readFileSyncSafe(p) {
  return readFileSync(p, "utf-8");
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}
