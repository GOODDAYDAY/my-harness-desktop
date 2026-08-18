// 隔离执行环境 —— 每次录制在 /tmp/pi-demo-<rand>/ 现搭一次性 HOME,录完即弃。
//
// 为什么隔离:录制会捕获 UI 上的一切(会话标题、项目路径、扩展清单、skills 清单)。
// 跑在真实 profile 上会把这些个人/内部信息录进 GIF,且重复执行互相污染。
// 隔离 HOME 后:数据根(~/.my-harness-desktop-dev)与 ~/.pi/agent 的演示内容全部种子化;
// pi 底座用符号链接借真实 HOME(功能可用),模型设置纯复用全局(原样拷贝,
// demo 不覆盖——见 setupBaseline 内注释)。
//
// 环境内路径随 HOME 分流(client/paths 的 homedir() 吃 $HOME),应用代码零感知。
//
// 本文件只管"底线基线"(任何板块都需要的东西):目录骨架、借资产、底座默认模型、
// 稳定性插件禁用、locale、prefs/general 默认值。板块各自的演示状态(会话/项目/
// 贴纸/工具组…)由场景 bundle 的 seed(ctx) 用 lib/seed/ 的预制件组装——
// 机制(common)与内容(场景)的分界即在此处。
import {
  mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync, rmSync, readFileSync, statSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { platform, tmpdir } from "node:os";

export function makeRunRoot() {
  // 用 os.tmpdir()(POSIX 即 /tmp):Windows 上字面 "/tmp" 是当前盘根且无盘符,
  // Node 自身 API 能用但外部程序(ffmpeg 合成 GIF)解析不了。
  const base = tmpdir();
  // 只清过期残留(>1h):并发录制时各实例用自己唯一根,不能互删;
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
  // 唯一根必须用 randomUUID:parallel-record 同步 spawn 多进程时 Date.now() 同毫秒
  // 撞名,多进程共享同一隔离 HOME(种子互覆 / config.json 并发写损坏 / 收尾 ENOTEMPTY)。
  const root = join(base, `pi-demo-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

/** 搭隔离 HOME 基线:目录骨架 + 符号链接借资产 + 底座/偏好默认状态。
 * 返回 ctx 供场景 seed 使用——场景只经 ctx 写状态,不自己拼隔离区路径。 */
export function setupBaseline({ home, realHome, locale = "zh-CN" }) {
  const dataRoot = join(home, ".my-harness-desktop-dev");
  const agentDir = join(home, ".pi", "agent");
  const configDir = join(dataRoot, "config");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const realBase = join(realHome, ".my-harness-desktop-dev", "pi");
  // Windows 目录链接用 junction(mklink /J):符号链接要管理员权限(EPERM),junction 免。
  // POSIX 平台 junction 类型不适用,走默认符号链接。
  if (existsSync(realBase)) symlinkSync(realBase, join(dataRoot, "pi"), platform() === "win32" ? "junction" : undefined);
  const realModels = join(realHome, ".pi", "agent", "models.json");
  if (existsSync(realModels)) copyFileSync(realModels, join(agentDir, "models.json"));
  // 模型设置纯复用:全局 settings.json 原样拷贝,demo 不覆盖任何模型设置(也不做
  // 脱敏改名——defaultProvider 引用 models.json 的 provider 键名,改任何一边都破坏
  // 配对)。拷贝而非符号链接:底座运行中会回写 settings.json,副本保证写不回真实
  // profile。apiKey 真实可用:模型页 apiKey 字段是密码框(掩码显示),GIF 截不到
  // 明文,且发送必须真实 key。
  const realSettings = join(realHome, ".pi", "agent", "settings.json");
  if (existsSync(realSettings)) copyFileSync(realSettings, join(agentDir, "settings.json"));

  // 全局默认模型(models.json 声明序首个可用模型)——镜像 core/domain/sessions.ts 的
  // firstModelOf(脚本不 import TS,契约单源仅注释同步)。种子会话的 model_change 与
  // 消息 provider/model 都从这里取:不写死 provider-1/model-1.1 假名,也不把真实
  // provider/model 名提交进种子文件(录制时从机器全局配置读,敏感名不出库)。
  const modelsPath = join(agentDir, "models.json");
  let defaultModel = null;
  if (existsSync(modelsPath)) {
    try {
      const cfg = JSON.parse(readFileSync(modelsPath, "utf-8"));
      for (const [provider, pc] of Object.entries(cfg?.providers ?? {})) {
        const m = pc?.models?.[0];
        if (m?.id) { defaultModel = { provider, modelId: m.id }; break; }
      }
    } catch {
      // models.json 损坏:defaultModel 保持 null,种子会话不写模型分隔线
    }
  }

  // 稳定性决策(不因板块而变):goody-hao 注入工程原则 prompt 污染模型回复,
  // sub-agent 启动握手会建 $bus 会话干扰录制——两者恒禁用。禁用后的"组件未注册"
  // 孤儿项由内核修复(bootstrap 对 disabledPlugins 统一撤注册,槽位不再列出)。
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
    home, locale, dataRoot, agentDir, configDir, defaultModel,
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
    /** 全量写项目级插件配置 <cwd>/.my-harness-desktop/config/<name>.json(统一配置通道的项目层)。 */
    writeProjectConfig(cwd, name, obj) {
      writeJson(join(cwd, ".my-harness-desktop", "config", `${name}.json`), obj);
    },
  };
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}
