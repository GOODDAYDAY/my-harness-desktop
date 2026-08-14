// 隔离执行环境 —— 每次录制在 /tmp/pi-demo-<rand>/ 现搭一次性 HOME,录完即弃。
//
// 为什么隔离:录制会捕获 UI 上的一切(会话标题、项目路径、扩展清单、skills 清单)。
// 跑在真实 profile 上会把这些个人/内部信息录进 GIF,且重复执行互相污染。
// 隔离 HOME 后:数据根(~/.pi-desktop-dev)与 ~/.pi/agent 全空,只种子演示所需的最小状态;
// 重的共享资产(pi 底座、models.json)用符号链接借真实 HOME 的,功能可用又不复制密钥。
//
// 环境内路径随 HOME 分流(client/paths 的 homedir() 吃 $HOME),应用代码零感知。
//
// 本文件只管"底线基线"(任何板块都需要的东西):目录骨架、借资产、底座默认模型、
// 稳定性插件禁用、locale、prefs/general 默认值。板块各自的演示状态(会话/项目/
// 贴纸/工具组…)由场景 bundle 的 seed(ctx) 用 lib/seed/ 的预制件组装——
// 机制(common)与内容(场景)的分界即在此处。
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

/** 搭隔离 HOME 基线:目录骨架 + 符号链接借资产 + 底座/偏好默认状态。
 * 返回 ctx 供场景 seed 使用——场景只经 ctx 写状态,不自己拼隔离区路径。 */
export function setupBaseline({ home, realHome, locale = "zh-CN" }) {
  const dataRoot = join(home, ".pi-desktop-dev");
  const agentDir = join(home, ".pi", "agent");
  const configDir = join(dataRoot, "config");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const realBase = join(realHome, ".pi-desktop-dev", "pi");
  // Windows 目录链接用 junction(mklink /J):符号链接要管理员权限(EPERM),junction 免。
  // POSIX 平台 junction 类型不适用,走默认符号链接。
  if (existsSync(realBase)) symlinkSync(realBase, join(dataRoot, "pi"), platform() === "win32" ? "junction" : undefined);
  const realModels = join(realHome, ".pi", "agent", "models.json");
  if (existsSync(realModels)) sanitizeModels(realModels, join(agentDir, "models.json"));
  // 底座默认模型:演示用真实可用的 provider(脱敏键名 provider-1),apiKey 保留
  // 真实值——密码框掩码显示已防泄漏,且发送必须真实 key。默认模型指该 provider
  // 第一个模型 id,底座 spawn 后按默认模型发起调用,waitAgent 才能等到响应。
  writeJson(join(agentDir, "settings.json"), {
    defaultProvider: "provider-1",
    defaultModel: firstModelId(realModels),
    defaultThinkingLevel: "high",
  });

  // 稳定性决策(不因板块而变):goody-hao 注入工程原则 prompt 污染模型回复,
  // sub-agent 启动握手会建 $bus 会话干扰录制——演示环境两者恒禁用。
  writeJson(join(configDir, "plugin-manager.json"), {
    disabledPlugins: ["goody-hao", "sub-agent"],
  });

  // prefs 默认值(electron-store 的 config.json):板块经 ctx.setPrefs 局部覆盖。
  // locale 直接种入(i18n 竞态时 record.mjs 仍有语言页兜底)。
  const prefsFile = join(configDir, "config.json");
  writeJson(prefsFile, {
    currentThemeId: "chatgpt-dark",
    activeSidePanelTabs: [],
    rightPanelOpen: true,
    lastCwd: "",
    bundledSkillsEnabled: false,
    currentLocale: locale,
  });
  writeJson(join(configDir, "general.json"), {
    defaultThinkingLevel: "off",
    sidebarDefaultOpen: true,
    debugMode: true,
  });

  return {
    home, locale, dataRoot, agentDir, configDir,
    /** 全量写全局插件配置 config/<name>.json(统一配置通道的全局层)。 */
    writeConfig(name, obj) {
      writeJson(join(configDir, `${name}.json`), obj);
    },
    /** 浅合并 prefs(config/config.json)——板块覆盖 lastCwd/rightPanelOpen 等。 */
    setPrefs(partial) {
      writeJson(prefsFile, { ...JSON.parse(readFileSync(prefsFile, "utf-8")), ...partial });
    },
    /** 浅合并通用设置(config/general.json)。 */
    setGeneral(partial) {
      const p = join(configDir, "general.json");
      writeJson(p, { ...JSON.parse(readFileSync(p, "utf-8")), ...partial });
    },
    /** 全量写项目级插件配置 <cwd>/.pi-desktop/config/<name>.json(统一配置通道的项目层)。 */
    writeProjectConfig(cwd, name, obj) {
      writeJson(join(cwd, ".pi-desktop", "config", `${name}.json`), obj);
    },
  };
}

/** 脱敏复制 models.json:真实 provider 结构保留(功能可用、发送必须真实 apiKey),
 *  provider 键名与模型展示名换中性值——GIF 不携带真实供应商域名/命名。
 *  apiKey 保留真实值:模型页 apiKey 字段已改密码框(掩码显示),GIF 截不到明文;
 *  换占位符反而导致模型发送 401(演示默认模型必须真实可用)。 */
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

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}
