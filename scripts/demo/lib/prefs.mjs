// 隔离执行环境 —— 每次录制在 /tmp/pi-demo-<rand>/ 现搭一次性 HOME,录完即弃。
//
// 为什么隔离:录制会捕获 UI 上的一切(会话标题、项目路径、扩展清单、skills 清单)。
// 跑在真实 profile 上会把这些个人/内部信息录进 GIF,且重复执行互相污染。
// 隔离 HOME 后:数据根(~/.pi-desktop-dev)与 ~/.pi/agent 全空,只种子演示所需的最小状态;
// 重的共享资产(pi 底座、models.json)用符号链接借真实 HOME 的,功能可用又不复制密钥。
//
// 环境内路径随 HOME 分流(client/paths 的 homedir() 吃 $HOME),应用代码零感知。
import {
  mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync, rmSync, readFileSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { platform, tmpdir } from "node:os";

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
export function setupIsolatedHome({ home, realHome, fixtureProject }) {
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

  mkdirSync(fixtureProject, { recursive: true });
  writeFileSync(join(fixtureProject, "README.md"), "# demo-project\n\nfixture for pi-desktop demo recording.\n");
  writeFileSync(join(fixtureProject, "main.py"), "def main():\n    return 'pong'\n");

  const prefsFile = join(dataRoot, "config", "config.json");
  writeJson(prefsFile, {
    currentThemeId: "chatgpt-dark",
    activeSidePanelTabs: [],
    lastCwd: fixtureProject,
    bundledSkillsEnabled: false,
  });
  writeJson(join(dataRoot, "config", "general.json"), {
    defaultThinkingLevel: "off",
    sidebarDefaultOpen: true,
    debugMode: true,
  });
  writeJson(join(dataRoot, "config", "notes.json"), {
    notes: [{
      id: "demo-ping", title: "ping", content: "ping", order: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    }],
  });
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
  for (const [name, desc] of [["demo-alpha", "first demo skill"], ["demo-beta", "second demo skill"]]) {
    const dir = join(agentDir, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n${desc}.\n`);
  }

  return {
    dataRoot,
    agentDir,
    prefsFile,
    fixtureProject,
    toolManagerProjectFile: join(fixtureProject, ".pi-desktop", "config", "tool-manager.json"),
  };
}

/** 每遍录制前按 locale 补 prefs(locale 因 i18n 竞态可能需 UI 兜底切换,见 record.mjs)。 */
export function patchLocale(prefsFile, locale) {
  const doc = existsSync(prefsFile) ? JSON.parse(readFileSyncSafe(prefsFile)) : {};
  writeJson(prefsFile, { ...doc, currentLocale: locale });
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

function readFileSyncSafe(p) {
  return readFileSync(p, "utf-8");
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}
