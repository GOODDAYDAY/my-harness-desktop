// 共享组装(web-service §23.2)——stores + ctx + gateway + handlers + 起服务器,零 electron。
// electron.ts / server.ts 各注入一份 Host + isPackaged(§5.4),共用本组装。依赖只向内。
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { JsonPrefsStore } from "../core/application/config/json-prefs";
import { ConfigStore } from "../core/application/config/config-store";
import { PiSettingsStore, parseSettingsSchema } from "../client/pi/pi-settings-store";
import { ModelsStore } from "../client/pi/models-store";
import { ModelCatalog } from "../core/application/models/model-catalog";
import { PiModelSource } from "../client/pi/pi-model-source";
import { PiWarmup } from "../client/pi/pi-warmup";
import { DshWarmup } from "../client/dsh/dsh-warmup";
import { DshConfigSource, DSH_OFFICIAL_PROVIDER } from "../client/dsh/dsh-config-source";
import { createPiModelsApi } from "../client/pi/pi-kernel-api";
import { createDshModelsApi } from "../client/dsh/dsh-kernel-api";
import { createPiConfigApi } from "../client/pi/pi-kernel-config";
import { createDshConfigApi } from "../client/dsh/dsh-kernel-config";
import { runPiOneshot } from "../client/pi/pi-oneshot";
import { DshQuestionBridge } from "../client/dsh/dsh-question-bridge";
import { discoverPlugins } from "../core/application/loader/discover";
import { PluginRegistry } from "../core/application/loader/registry";
import {
  mergeLanguageContributions,
  collectNamespaces,
  collectSupportedLngs,
  collectLocaleList,
} from "../core/application/i18n/merge";
import { SessionStore } from "../core/application/sessions/session-store";
import { NeutralSessionStore } from "../core/application/sessions/neutral-session-store";
import type { BackendFactory, SessionCatalogFactory } from "../core/domain/backend";
import type { PiSettingsApi, KernelModelsRegistry, KernelConfigApi } from "../core/domain/context";
import type { KernelId } from "../core/domain/kernel";
import type { PluginLifecycleDeps } from "../core/application/lifecycle";
import { createPiBackend, createDshBackend, createPiCatalog, createDshCatalog, piSeedSession } from "./kernel/kernel-factories";
import { createPiKernelManager, createDshKernelManager } from "./kernel/kernel-managers";
import { KERNEL_LOGOS } from "./kernel/kernel-logos";
import { mirrorBundledSkills } from "../core/application/skills/bundled-skills";
import { ensureBundledSkillsEntry, ensurePluginSkillsEntry, migrateLegacySkillPatterns } from "../client/pi/pi-bundled-skills";
import { SkillAggregator } from "../core/application/skills/skill-aggregator";
import { PiSkillProvider } from "../client/pi/pi-skill-provider";
import { DshSkillProvider } from "../client/dsh/dsh-skill-provider";
import { installFitPiExtension, fitPiExtensionAvailable } from "../client/pi/my-harness-fit-pi-extension-installer";
import { mirrorManagedDir } from "../core/application/bundled/mirror";
import { initKernelRuntime } from "../core/application/kernel/kernel-manager";
import { RestartCoordinatorImpl } from "../core/application/restart/restart-coordinator";
import { createNpmKernelRuntime } from "../client/npm/kernel-runtime";
import { PiExtensionManager } from "../client/pi/pi-extension-manager";
import { DshExtensionManager } from "../client/dsh/dsh-extension-manager";
import { DEFAULT_PREFS, type MainContext, type Prefs } from "../api/ipc/main-context";
import { broadcastSettingsChanged } from "../api/ipc/broadcast";
import { registerConfig } from "../api/http/handlers/config";
import { registerAppearance } from "../api/http/handlers/appearance";
import { registerSessions } from "../api/http/handlers/sessions";
import { registerFsGit } from "../api/http/handlers/fs-git";
import { registerSlotsDialog } from "../api/http/handlers/slots-dialog";
import { registerKernel } from "../api/http/handlers/kernel";
import { registerPlugins } from "../api/http/handlers/plugins";
import { registerSkills } from "../api/http/handlers/skills";
import { registerExtensions } from "../api/http/handlers/extensions";
import { registerBus } from "../api/http/handlers/bus";
import { registerWindow } from "../api/http/handlers/window";
import { registerAppInfo } from "../api/http/handlers/app-info";
import { registerNotification } from "../api/http/handlers/notification";
import { registerRemote } from "../api/http/handlers/remote";
import { reconcilePluginPiExtensions, syncPluginPiExtension, removePluginPiExtension } from "../client/pi/pi-extension-installer";
import { reconcilePluginDshExtensions, syncPluginDshExtension, removePluginDshExtension, syncFitDshExtension, FIT_DSEXTENSION_ID } from "../client/dsh/dsh-extension-installer";
import { SessionBus } from "../core/application/sessions/session-bus";
import { resolveMyHarnessDesktopDir } from "../client/paths";
import { createGateway } from "../core/application/remote/gateway";
import { RemoteAuth } from "../core/application/remote/auth";
import { RemoteConfigStore } from "../core/application/remote/remote-config";
import { createHttpServer } from "../api/http/http-server";
import { attachWsServer } from "../api/http/ws-server";
import { createElectronHost } from "./host/electron-host";

import type { Host } from "../core/domain/host";
import type { Gateway } from "../core/application/remote/gateway";

/** assemble 的产物:electron/server 各取所需。 */
export interface Assembled {
  ctx: MainContext;
  sessionStore: SessionStore;
  gateway: Gateway;
  localToken: string;
  port: number;
}

/** 共享组装:注入 Host + isPackaged(§5.4),建 stores/ctx/gateway/注册全部 handler/起服务器。 */
export function assemble(host: Host, opts: { isPackaged: boolean }): Assembled {
const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 路径:main 进程唯一读环境的点,经 MainContext 注入给 ipc 层 ----
// MY_HARNESS_DESKTOP_DIR 单源在 client/paths(打包态 ~/.my-harness-desktop,dev 态 ~/.my-harness-desktop-dev 分流)。
const HOME_DIR = homedir();
const MY_HARNESS_DESKTOP_DIR = resolveMyHarnessDesktopDir();
const CONFIG_DIR = join(MY_HARNESS_DESKTOP_DIR, "config");
// 远程鉴权(§8):本地 token + HMAC token(密码登录签发)复合校验;serverSecret 每次启动随机。
const PORT = 8420;
const remoteConfig = new RemoteConfigStore(join(CONFIG_DIR, "remote.json"));
const auth = new RemoteAuth(remoteConfig);
const gateway = createGateway(auth.createTokenVerifier());
const PI_INSTALL_DIR = join(MY_HARNESS_DESKTOP_DIR, "pi");
// dsh 内核 npm 安装目录(~/.my-harness-desktop/dsh);dsh 原生配置(cordis.yml/settings.yaml)在 ~/.dsh。
const DSH_INSTALL_DIR = join(MY_HARNESS_DESKTOP_DIR, "dsh");
// dsh 会话持久化根(稳定单源):活跃后端与目录 transport 必须共享同一根,目录才列得出会话。
// 不再用 cordis.yml 默认的 './.sessions'(相对进程 cwd)——后端 cwd=项目目录、目录 transport
// cwd=process.cwd(),两处根不同,目录永远列不到活跃后端的会话(根因)。
const DSH_SESSION_ROOT = join(MY_HARNESS_DESKTOP_DIR, "dsh", "sessions");
const GENERAL_CONFIG_PATH = join(CONFIG_DIR, "general.json");
// pi 内核配置目录(~/.pi/agent,内核标准,非 ~/.my-harness-desktop)。pi-settings 插件读写它。
const PI_AGENT_DIR = join(HOME_DIR, ".pi", "agent");

// 桌面偏好走 electron-store,显式 cwd 纳入数据根 config 树(跨重启持久,与插件配置同根)
const prefsStore = new JsonPrefsStore<Prefs>(join(CONFIG_DIR, "config.json"), DEFAULT_PREFS);

// 迁移旧单值 dshApiKey → dshApiKeys["deepseek-official"](一次,幂等)。旧字段已从 Prefs 类型删除,
// 但老用户磁盘上可能残留:读底层 raw 迁移后清除,避免「spawn 读新 map、旧值躺尸」的双份真相。
{
  const raw = prefsStore.store as unknown as Record<string, unknown>;
  const legacy = typeof raw.dshApiKey === "string" ? raw.dshApiKey : "";
  if (legacy) {
    const apiKeys = prefsStore.get("dshApiKeys");
    if (!apiKeys[DSH_OFFICIAL_PROVIDER]) {
      prefsStore.set("dshApiKeys", { ...apiKeys, [DSH_OFFICIAL_PROVIDER]: legacy });
    }
    delete raw.dshApiKey;
  }
}

initKernelRuntime(createNpmKernelRuntime());
// 内核版本管理组装:pi/dsh 各一个实例,spec 值 + postInstall 差异封装在各自实现
// (client/pi、client/dsh),此处只绑 installDir。注入 MainContext 供 kernel IPC 使用。
const piKernelManager = createPiKernelManager(PI_INSTALL_DIR);
const dshKernelManager = createDshKernelManager(DSH_INSTALL_DIR);

const piSettingsStore = new PiSettingsStore({ agentDir: PI_AGENT_DIR });
const modelsStore = new ModelsStore({ agentDir: PI_AGENT_DIR });
// 解析内核 settings-manager.d.ts 的全局回退路径(shell 注入,application 不读 process 环境)。
const PI_SETTINGS_RESOLVE_PATHS = [
  process.cwd(),
  join(HOME_DIR, ".npm-global"),
  "/usr/local/lib",
];
// dsh 原生配置:cordis.yml(插件组成 + base,路径取 DSH_CORDIS_CONFIG 或 ~/.dsh/cordis.yml)
// + settings.yaml(用户覆盖 namespace,~/.dsh/settings.yaml)。读不到 → 空,不炸应用(§6.2)。
// DSH_CORDIS_PATH 单源:配置读写(DshConfigSource)与 spawn(DSH_CORDIS_CONFIG env)共用同一路径。
const DSH_CORDIS_PATH = process.env.DSH_CORDIS_CONFIG ?? join(HOME_DIR, ".dsh", "cordis.yml");
const dshConfigSource = new DshConfigSource(
  DSH_CORDIS_PATH,
  join(HOME_DIR, ".dsh", "settings.yaml"),
  DSH_INSTALL_DIR,
);
// 首次运行:缺 cordis.yml 写默认 JSON-RPC 组合(否则 spawn dsh-jsonrpc-agent 报 usage 退出)。
dshConfigSource.ensureDefaultCordis();
// 内核形状:中立化 agent-core 自带的 skill-filesystem(改名 + 清空发现根),让统一适配插件的
// fork provider 独占 "filesystem" 名——duplicate provider 会让 dsh 启动即崩。
dshConfigSource.ensureAgentCoreSkillForkBase();
// 统一 dsh 适配插件源目录(合并 ask/goal/read-claude-md/skill-manager 四个随插件携带的
// dsh cordis 插件为一块 my-harness-fit-dsh-extension)。dev: __dirname=out/main →
// ../../src/client/dsh/dsh-extension;pkg: resources/my-harness-desktop-dsh-extension(extraResources 随壳分发)。
const DSH_FIT_EXTENSION_SOURCE = opts.isPackaged
  ? join(process.resourcesPath, "my-harness-desktop-dsh-extension")
  : resolve(__dirname, "../../src/client/dsh/dsh-extension");
// 启用 dsh 技能消费方(模型可调 skill);发现侧 fork 插件已并入统一适配插件(上方 syncFitDshExtension)。
// 幂等:addPlugin 见同名块跳过。写失败只 warn 不炸启动(技能是可选能力)。
try {
  dshConfigSource.addPlugin("@deepseek-ai/dsh-tool-skill");
} catch (err) {
  console.warn("[dsh-skill] 启用 tool-skill 失败:", err instanceof Error ? err.message : String(err));
}
const modelCatalog = new ModelCatalog([new PiModelSource(modelsStore), dshConfigSource]);

// ---- 加载器:发现 builtin/installed/user/project 四目录插件,按优先级注册(低到高) ----
// 开发期扫 src/plugins;打包后扫 process.resourcesPath/my-harness-desktop-builtin。
// 内置插件与第三方插件平等:同一 discoverPlugins,无 if(builtin) 分支(01-core:1447)。
// dev: __dirname=out/main,src/plugins 在 ../../src/plugins(项目根/src/plugins)
// pkg: __dirname=resources/app.asar/...,插件随壳分发在 resources/my-harness-desktop-builtin/
const builtinDir = opts.isPackaged
  ? join(process.resourcesPath, "my-harness-desktop-builtin")
  : resolve(__dirname, "../../src/plugins");
const userPluginsDir = join(MY_HARNESS_DESKTOP_DIR, "plugins");
// 内置 skills:仓库顶级 .claude/skills/ 随壳分发(pkg 拷贝到 resources/my-harness-desktop-skills,
// 与 my-harness-desktop-builtin 同批),启动时镜像到 ~/.my-harness-desktop/skills(强制覆盖,受管目录)
const BUNDLED_SKILLS_DIR = join(MY_HARNESS_DESKTOP_DIR, "skills");
const bundledSkillsSource = opts.isPackaged
  ? join(process.resourcesPath, "my-harness-desktop-skills")
  : resolve(__dirname, "../../.claude/skills");
// 内置表情包:assets/stickers/ 随壳分发(pkg 拷贝到 resources/my-harness-desktop-stickers),
// 启动时镜像到数据根 ~/.my-harness-desktop/stickers/bundled/(强制覆盖,受管目录)。
// stickers 插件按只读 builtin 层读它——纯 UI 内容,不进模型上下文,无 ensure* 开关。
const BUNDLED_STICKERS_DIR = join(MY_HARNESS_DESKTOP_DIR, "stickers", "bundled");
const bundledStickersSource = opts.isPackaged
  ? join(process.resourcesPath, "my-harness-desktop-stickers")
  : resolve(__dirname, "../../assets/stickers");
// ⚠ project 级 plugins 目录:桌面应用打包后 process.cwd() 通常是家目录,无"当前项目"
// 概念(M8)——此目录在打包态降级为"另一个用户级",留待"打开项目"功能接(演进)。
const projectPluginsDir = join(process.cwd(), ".my-harness-desktop", "plugins");
const installedDir = join(MY_HARNESS_DESKTOP_DIR, "installed");
const registry = new PluginRegistry();
registry.registerAll(discoverPlugins(builtinDir, "builtin"));
registry.registerAll(discoverPlugins(installedDir, "installed"));
registry.registerAll(discoverPlugins(userPluginsDir, "user"));
registry.registerAll(discoverPlugins(projectPluginsDir, "project"));

// ---- i18n:合并所有插件的 languages 贡献项成 i18next resources(05-plugin-i18n §6)----
// main 只合并 + 给 renderer;renderer 端 init i18next + react-i18next(跨堆,各持实例)。
const languageContributions = registry.languageContributions();
const i18nResources = mergeLanguageContributions(languageContributions);

// ---- 会话核心(SessionStore 单持;插件能力 sessions.* 的实现)----
// 依赖倒置:BackendFactory(圆心契约)由 shell 注入实现,SessionStore 不 new client 具体类、
// 不感知 spawn。内核专属 spawn 参数(cliPath/cordisConfig/apiKey)在此闭包捕获,不进契约。
// kernel 缺省 "pi"(迁移期兼容);"dsh" 走 createDshBackend(provider/model 有兜底默认)。
const baseBackendFactory: BackendFactory = {
  create: (opts) => {
    if (opts.kernel !== "dsh") return createPiBackend({ ...opts, cliPath: customCliPath() });
    // 注入密钥(按 provider 路由的 apiKeyEnv 名)+ cordis 路径 + CLI 入口。
    // 密钥字面值按 provider 存 prefs.dshApiKeys;env 名从 settings.yaml 读、非用户可编辑字段。
    // baseURL 已写 settings.yaml(用户覆盖层),不注入 env——dsh 官方解析链 config 优先于 env。
    // 兜底模型取 settings.yaml 的 agent-default-model(而非写死 deepseek-official):dsh 运行时
    // 无 session/setModel,模型只能在 initialize 握手时定,warmup 起进程未带显式模型时必须用
    // 用户配置的默认模型,否则发消息落到写死的 deepseek-official(其 baseURL 是占位符,必然失败)。
    const defaultModel = dshConfigSource.getDefaultModel();
    const provider = opts.provider ?? defaultModel?.provider ?? DSH_OFFICIAL_PROVIDER;
    const model = opts.model ?? defaultModel?.model ?? "deepseek-v4-pro";
    const apiKey = prefsStore.get("dshApiKeys")[provider];
    const apiKeyEnv = dshConfigSource.apiKeyEnvFor(provider);
    return createDshBackend({
      ...opts,
      provider,
      model,
      cliPath: dshCliPath(),
      cordisConfig: DSH_CORDIS_PATH,
      env: {
        ...(apiKey ? { [apiKeyEnv]: apiKey } : {}),
        DSH_SESSION_ROOT,
      },
    });
  },
  // 预 seed(§4.5 生命周期不对称):pi 的 seed 是纯文件写,先 seed 得路径、再以路径 spawn;
  // dsh 的 seed 是 RPC(需进程),返回 null,由 create → start → backend.seed 处理。
  seed: async (lineage, { kernel, cwd, agentDir, lineageId, header }) => {
    if (kernel === "pi") return piSeedSession(agentDir, cwd, lineage, { lineageId, header });
    return null;
  },
};
// 自定义内核指针(docs/design/custom-cli-path.md §2.4):读 prefs + resolveCustomCli 归一化,
// 组装一次单源——SessionStore(spawn 链)与 kernel IPC(oneshot)共用;未设置/失效返回
// undefined,spawn 回落数据根 > PATH(与 kernelStatus 状态标注同一判定函数,行为一致)。
const customCliPath = (): string | undefined => {
  const dir = prefsStore.get("customCliDir");
  if (!dir) return undefined;
  return piKernelManager.resolveCustomCli(dir)?.cliJs;
};
// dsh CLI 入口(与 customCliPath 同构):自定义 dsh 目录优先,否则回落数据根安装
// (~/.my-harness-desktop/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js)。dsh 装在独立目录,
// 不在 PATH 上,不注入 cliPath 则 spawn `dsh` 会 command-not-found 直接退出。
const dshCliPath = (): string | undefined => {
  const custom = prefsStore.get("dshCustomCliDir");
  if (custom) {
    const resolved = dshKernelManager.resolveCustomCli(custom);
    if (resolved) return resolved.cliJs;
  }
  return dshKernelManager.resolveCustomCli(DSH_INSTALL_DIR)?.cliJs;
};
// 目录/CRUD 工厂(依赖倒置):目录/CRUD 是内核专属存储操作,壳经 SessionCatalog 委托;
// dsh 目录:dsh 会话真相源在 dsh 进程内,目录/CRUD 经懒 spawn 的 dsh transport 走 JSON-RPC。
const sessionCatalogFactory: SessionCatalogFactory = {
  create: (kernel) => (kernel === "dsh"
    ? createDshCatalog({ cliPath: dshCliPath(), cordisConfig: DSH_CORDIS_PATH, env: { DSH_SESSION_ROOT } })
    : createPiCatalog(PI_AGENT_DIR)),
};
const sessionStore = new SessionStore(
  baseBackendFactory,
  sessionCatalogFactory,
  PI_AGENT_DIR,
  () => registry.systemPromptPaths(),
  new NeutralSessionStore(join(MY_HARNESS_DESKTOP_DIR, "sessions")),
    modelCatalog,
  // 内核 warmup 能力面:每个要预热的内核注册一个实现;未注册的内核不 warmup。
  [new PiWarmup(sessionCatalogFactory), new DshWarmup()],
);
sessionStore.onEvent((event) => {
  gateway.broadcast("session:event", event);
});
sessionStore.onKernelEvent((event) => {
  gateway.broadcast("session:kernelEvent", event);
});
sessionStore.onQuestion((req) => {
  gateway.broadcast("session:question", req);
});
sessionStore.onSnapshot((snapshot) => {
  gateway.broadcast("session:snapshot", snapshot);
});

// ---- 内核专属适配器组装(注入 MainContext,api/ipc 不直连 client/{kernel})----
// 模型配置中性 API:pi(models.json/settings.json)与 dsh(settings.yaml + prefs 密钥)各交一个适配器。
const kernelModels: KernelModelsRegistry = {
  pi: createPiModelsApi(modelsStore, piSettingsStore, sessionStore),
  dsh: createDshModelsApi(dshConfigSource, sessionStore, {
    getApiKeys: () => prefsStore.get("dshApiKeys"),
    setApiKeys: (m) => prefsStore.set("dshApiKeys", m),
  }),
};
// pi 内核 settings.json 中性面(get/set 委托 store,schema 解析 .d.ts 由 shell 绑定解析路径)。
const piSettings: PiSettingsApi = {
  get: () => piSettingsStore.get(),
  set: (patch) => piSettingsStore.set(patch),
  replace: (obj) => piSettingsStore.replace(obj),
  schema: async () => parseSettingsSchema(PI_INSTALL_DIR, PI_SETTINGS_RESOLVE_PATHS),
};
// 内核原生配置中性 API(配置 TAB 用):pi(settings.json 表单)+ dsh(settings.yaml 非模型段)。
const kernelConfig: Record<KernelId, KernelConfigApi> = {
  pi: createPiConfigApi(piSettings, { installDir: PI_INSTALL_DIR, homeDir: HOME_DIR }),
  dsh: createDshConfigApi(dshConfigSource),
};
// 一次性问内核(cwd 取激活项目根,cliPath 与会话进程同源——自定义内核生效时 oneshot 不分裂)。
const llmOneshot = (prompt: string): Promise<string> =>
  runPiOneshot(prompt, {
    cwd: sessionStore.getActiveCwd() ?? undefined,
    cliPath: customCliPath(),
  });
// 内置 skills 挂/摘(pi settings.json skills[];shell 不碰 pi 存储格式,经适配器函数)。
const ensureBundledSkills = (enabled: boolean): Promise<boolean> =>
  ensureBundledSkillsEntry({
    settingsPath: join(PI_AGENT_DIR, "settings.json"),
    targetDir: BUNDLED_SKILLS_DIR,
    enabled,
    homeDir: HOME_DIR,
  });
// 插件携带 skills 目录的挂/摘 hooks(生命周期 activate/deactivate 触发)。
const pluginSkillsEnsure: NonNullable<PluginLifecycleDeps["skillsEnsure"]> = {
  async onActivate(pluginId, pluginPath, source) {
    const skillsDir = join(pluginPath, "skills");
    if (!existsSync(skillsDir) || readdirSync(skillsDir).length === 0) return;
    const settingsPath = source === "project"
      ? join(process.cwd(), ".pi", "settings.json")
      : join(PI_AGENT_DIR, "settings.json");
    const changed = await ensurePluginSkillsEntry({
      settingsPath, skillsDir, active: true, homeDir: HOME_DIR,
    });
    if (changed) broadcastSettingsChanged();
  },
  async onDeactivate(pluginId, pluginPath, source) {
    const skillsDir = join(pluginPath, "skills");
    if (!existsSync(skillsDir)) return;
    const settingsPath = source === "project"
      ? join(process.cwd(), ".pi", "settings.json")
      : join(PI_AGENT_DIR, "settings.json");
    const changed = await ensurePluginSkillsEntry({
      settingsPath, skillsDir, active: false, homeDir: HOME_DIR,
    });
    if (changed) broadcastSettingsChanged();
  },
};
// 插件携带 pi 内核扩展的挂/摘 hooks(写 ~/.pi/agent/extensions 是流出适配)。
const pluginPiExtensionEnsure: NonNullable<PluginLifecycleDeps["piExtensionEnsure"]> = {
  onActivate(pluginId, pluginPath, piExtension) {
    syncPluginPiExtension(pluginId, join(pluginPath, piExtension));
  },
  onDeactivate(pluginId) {
    removePluginPiExtension(pluginId);
  },
};
// 插件携带 dsh cordis 扩展的挂/摘 hooks(同步目录 + 挂 cordis.yml 块)。
const pluginDshExtensionEnsure: NonNullable<PluginLifecycleDeps["dshExtensionEnsure"]> = {
  onActivate(pluginId, pluginPath, dshExtension) {
    syncPluginDshExtension(pluginId, join(pluginPath, dshExtension), dshConfigSource);
  },
  onDeactivate(pluginId) {
    removePluginDshExtension(pluginId, dshConfigSource);
  },
};

// dsh 提问桥(文件侧车桥在适配器层的收编):监听问句目录 → 投中性提问事件 → 汇入统一通道。
// 全局单例,经 sessionStore.injectQuestion 与 pi 的 onQuestion 汇聚到同一批监听器。
const dshQuestionBridge = new DshQuestionBridge();
dshQuestionBridge.start();
dshQuestionBridge.onQuestion((req) => {
  sessionStore.injectQuestion({
    kind: "question",
    requestId: req.requestId,
    sessionKey: req.sessionId,
    questions: req.questions,
  });
});

// 统一项目级配置通道(unified-project-config.md):全局层 ~/.my-harness-desktop/config/,
// 项目级经 getProjectDir 动态解析当前项目(sessionStore.getActiveCwd 是 main 侧 cwd 事实源)。
const configStore = new ConfigStore({
  userDir: CONFIG_DIR,
  getProjectDir: () => {
    const cwd = sessionStore.getActiveCwd();
    return cwd ? join(cwd, ".my-harness-desktop", "config") : null;
  },
});

// 禁用插件 = 从注册表撤贡献(§1.4 无特权差异:禁用后各槽位不列出、spawn 不注入其
// systemPrompts,无"组件未注册"孤儿)。disabledPlugins 由 demo/用户直接写 config
// (不经 disablePlugin/deactivate 的撤注册),故启动时在此统一撤——plugins:list 仍经
// rediscover 兜底列出它们供管理页展示(state 为 inactive)。i18n 合并(languageContributions)
// 已在此前完成,禁用插件的语言包多合并几串文案无害;槽位查询/ systemPromptPaths 是
// 懒求值,此处撤注册后自然不再包含它们。
const disabledPlugins = configStore.get<string[]>("plugin-manager", "disabledPlugins") ?? [];
for (const id of disabledPlugins) registry.unregister(id);

// ---- Session Bus 路由器:进线三路(上行帧/事件流/进程退出),出线两条(会话 stdin/renderer 广播)----
const sessionBus = new SessionBus(sessionStore, {
  broadcast: (message) => {
    gateway.broadcast("bus:event", message);
  },
});
sessionStore.onAnySessionEvent((event, sessionKey) => sessionBus.onSessionEvent(event, sessionKey));
sessionStore.onBusFrame((frame, sessionKey) => {
  void sessionBus.handleFrame(sessionKey, frame).catch((err) => console.error("[session-bus] 上行帧处理失败:", err));
});
sessionStore.onKernelEvent((event) => {
  if (event.kind === "processExit") sessionBus.onProcessExit(event.sessionKey, event.expected);
});

// ---- restart-coordinator + extension-store(§6.4/§6.7) ----
const restartCoordinator = new RestartCoordinatorImpl(sessionStore);
restartCoordinator.onStateChange((sessionKey, state) => {
  gateway.broadcast("restart:state", sessionKey, state);
});
// 内核拓展源(中性契约 KernelExtensionSource):pi/dsh 各一个,基类管排序/标签/受保护,
// 子类填数据源 + 落盘机制;onConfigChanged 统一接线 restartCoordinator(§extension-management §0)。
const markPendingAll = (reason: string): void => {
  const keys = sessionStore.getRunningSessionKeys();
  restartCoordinator.markPendingAll(keys, reason);
};
const piExtensionManager = new PiExtensionManager({
  agentDir: PI_AGENT_DIR,
  piSettings: piSettingsStore,
  onConfigChanged: markPendingAll,
});
const dshExtensionManager = new DshExtensionManager({
  dshConfigSource,
  dshKernelManager,
  installDir: DSH_INSTALL_DIR,
  onConfigChanged: markPendingAll,
});
const kernelExtensions = {
  pi: piExtensionManager,
  dsh: dshExtensionManager,
};

// 技能聚合器:壳不读内核存储,只聚合 pi/dsh 的 SkillProvider(内核各自读自己的存储、回报)。
// pi 扩展(读 settings.json + 扫目录 + 播报)、dsh 适配器(读 dsh fork 插件播报 + 写 disabled 名单)。
const skillAggregator = new SkillAggregator([
  new PiSkillProvider({
    agentDir: PI_AGENT_DIR,
    homeDir: HOME_DIR,
    builtinSkillsDir: BUNDLED_SKILLS_DIR,
    getCwd: () => sessionStore.getActiveCwd(),
  }),
  new DshSkillProvider({ dshHome: join(HOME_DIR, ".dsh") }),
]);

const ctx: MainContext = {
  paths: {
    homeDir: HOME_DIR,
    myHarnessDesktopDir: MY_HARNESS_DESKTOP_DIR,
    configDir: CONFIG_DIR,
    piInstallDir: PI_INSTALL_DIR,
    dshInstallDir: DSH_INSTALL_DIR,
    piAgentDir: PI_AGENT_DIR,
    generalConfigPath: GENERAL_CONFIG_PATH,
    bundledSkillsDir: BUNDLED_SKILLS_DIR,
    bundledSkillsSource,
    builtinDir,
    userPluginsDir,
    projectPluginsDir,
    installedDir,
  },
  prefsStore,
  customCliPath,
  configStore,
  piSettings,
  modelsConfig: modelsStore,
  modelCatalog,
  dshConfigSource,
  kernelModels,
  kernelConfig,
  piKernelManager,
  dshKernelManager,
  registry,
  skillAggregator,
  sessionStore,
  sessionBus,
  restartCoordinator,
  kernelExtensions,
  kernelLogos: KERNEL_LOGOS,
  fitPiExtensionAvailable,
  llmOneshot,
  ensureBundledSkills,
  pluginSkillsEnsure,
  pluginPiExtensionEnsure,
  pluginDshExtensionEnsure,
  i18n: {
    resources: i18nResources,
    namespaces: collectNamespaces(i18nResources),
    supportedLngs: collectSupportedLngs(languageContributions),
    localeList: collectLocaleList(collectSupportedLngs(languageContributions), i18nResources),
  },
};

registerConfig(gateway, ctx);
registerAppearance(gateway, ctx);
registerSessions(gateway, ctx);
registerBus(gateway, ctx);
registerFsGit(gateway, ctx);
registerSlotsDialog(gateway, ctx);
registerKernel(gateway, ctx);
registerPlugins(gateway, ctx);
registerSkills(gateway, ctx);
registerExtensions(gateway, ctx);
registerWindow(gateway);
registerAppInfo(gateway);
registerNotification(gateway);
registerRemote(gateway, auth);

  if (!existsSync(GENERAL_CONFIG_PATH)) {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(GENERAL_CONFIG_PATH, JSON.stringify({ defaultThinkingLevel: "high", sidebarDefaultOpen: true }, null, 2), "utf-8");
  } else {
    // 一次性迁移:旧种子写的是 sidebarDefaultOpen:false(非用户显式选择),按新默认翻 true。
    // 迁移标记保证只翻一次——用户此后手动关掉写显式 false,不再被回翻。
    try {
      const cfg = JSON.parse(readFileSync(GENERAL_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
      if (cfg["sidebarDefaultOpen"] === false && cfg["sidebarDefaultOpenMigrated"] !== true) {
        cfg["sidebarDefaultOpen"] = true;
        cfg["sidebarDefaultOpenMigrated"] = true;
        writeFileSync(GENERAL_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
      }
    } catch { /* 种子迁移失败不阻塞启动 */ }
  }

  // 内置 skills 启动同步:镜像文件(强制覆盖)+ 按偏好挂/摘 settings 条目。
  // 放在启动序列而非等 IPC:"用 my-harness-desktop 就有"不依赖用户先打开设置页。
  mirrorBundledSkills(bundledSkillsSource, BUNDLED_SKILLS_DIR);
  // 改名迁移:旧数据根 ~/.pi-desktop* 的 +/- 条目重写到新数据根,先迁移后注入、串行。
  void migrateLegacySkillPatterns(join(PI_AGENT_DIR, "settings.json"))
    .then((changed) => { if (changed) broadcastSettingsChanged(); })
    .catch((e) => console.error("[bundled-skills] 改名迁移失败:", e));
  // 内置表情包启动同步:镜像到数据根受管目录,stickers 插件按只读 builtin 层读它。
  mirrorManagedDir(bundledStickersSource, BUNDLED_STICKERS_DIR);
  void ensureBundledSkillsEntry({
    settingsPath: join(PI_AGENT_DIR, "settings.json"),
    targetDir: BUNDLED_SKILLS_DIR,
    enabled: prefsStore.get("bundledSkillsEnabled"),
    homeDir: HOME_DIR,
  }).then((changed) => { if (changed) broadcastSettingsChanged(); })
    .catch((e) => console.error("[bundled-skills] 启动同步失败:", e));

  void (async () => {
    let anyChanged = false;
    for (const [, plugin] of registry.allPlugins()) {
      const skillsDir = join(plugin.path, "skills");
      if (!existsSync(skillsDir)) continue;
      try {
        if (readdirSync(skillsDir).length === 0) continue;
      } catch { continue; }
      const settingsPath = plugin.source === "project"
        ? join(process.cwd(), ".pi", "settings.json")
        : join(PI_AGENT_DIR, "settings.json");
      try {
        const changed = await ensurePluginSkillsEntry({
          settingsPath,
          skillsDir,
          active: true,
          homeDir: HOME_DIR,
        });
        if (changed) anyChanged = true;
      } catch (e) {
        console.error(`[plugin-skills] ensure 失败 (${plugin.manifest.id}):`, e);
      }
    }
    if (anyChanged) broadcastSettingsChanged();
  })().catch((e) => console.error("[plugin-skills] 启动同步失败:", e));

  // 插件携带内核扩展(piExtension)的启动同步:同步非禁用插件的声明 + 摘除孤儿目录。
  // 放在任何 pi spawn 之前(toolgate 同约束:内核 loader 只在 spawn 时扫一次扩展目录)。
  // 设计 docs/design/llm-recorder-design.md §5。
  void (async () => {
    try {
      const disabled = (await configStore.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
      const active = new Set<string>();
      for (const [id, plugin] of registry.allPlugins()) {
        const rel = plugin.manifest.piExtension;
        if (!rel || disabled.includes(id)) continue;
        syncPluginPiExtension(id, resolve(plugin.path, rel));
        active.add(id);
      }
      reconcilePluginPiExtensions(active);
    } catch (e) {
      console.error("[pi-extension] 启动同步失败:", e);
    }
  })().catch((e) => console.error("[pi-extension] 启动同步失败:", e));

  // 插件携带 dsh cordis 插件的启动同步:同步非禁用插件的声明 + 摘除孤儿。与 piExtension 对账对称;
  // 放在任何 dsh spawn 之前(dsh 内核启动时读 cordis.yml 组合,须先挂好块)。
  void (async () => {
    try {
      const disabled = (await configStore.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
      // 统一适配插件:bootstrap 常驻,先于任何 dsh spawn(合并后的单一块)。
      syncFitDshExtension(DSH_FIT_EXTENSION_SOURCE, dshConfigSource);
      const active = new Set<string>([FIT_DSEXTENSION_ID]);
      // 第三方插件仍可经 manifest.dshExtension 携带 dsh cordis 插件(通用通道,随插件启停)。
      for (const [id, plugin] of registry.allPlugins()) {
        const rel = plugin.manifest.dshExtension;
        if (!rel || disabled.includes(id)) continue;
        syncPluginDshExtension(id, resolve(plugin.path, rel), dshConfigSource);
        active.add(id);
      }
      // 对账:PLUGINS_ROOT 下带 marker 但不在 active 的目录(含旧 ask/goal/read-claude-md/skill-manager)摘除。
      reconcilePluginDshExtensions(active, dshConfigSource);
    } catch (e) {
      console.error("[dsh-extension] 启动同步失败:", e);
    }
  })().catch((e) => console.error("[dsh-extension] 启动同步失败:", e));

  // my-harness-fit-pi-extension 内核扩展同步:统一了原 tool-gate/context-probe/bus/subagent/skills
  // 五个扩展,任何 pi 会话进程 spawn 之前装好,renderer 经 kernel.fitPiExtensionAvailable IPC 探测可用性。
  installFitPiExtension();
  // 起 HTTP+WS 服务器(§6/§7.3):静态 + /rpc。
  const httpServer = createHttpServer({ staticDir: resolve(__dirname, "../renderer"), gateway, auth });
  attachWsServer(httpServer, gateway, host, auth.createTokenVerifier());
  // 网络绑定(§8.6):loopback=127.0.0.1、lan=0.0.0.0(远程访问开启时)。
  const bindAddr = remoteConfig.get().bind === "lan" ? "0.0.0.0" : "127.0.0.1";
  httpServer.listen(PORT, bindAddr);

  return { ctx, sessionStore, gateway, localToken: auth.localToken, port: PORT };
}
