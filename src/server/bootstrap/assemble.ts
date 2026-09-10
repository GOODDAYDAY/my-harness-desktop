// 共享组装(web-service §23.2)——stores + ctx + gateway + handlers + 起服务器,零 electron。
// electron.ts / server.ts 各注入一份 Host + isPackaged(§5.4),共用本组装。依赖只向内。
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { JsonPrefsStore } from "../application/config/json-prefs";
import { ConfigStore } from "../application/config/config-store";
import { ModelCatalog } from "../application/models/model-catalog";
import { writeApiKey } from "../kernel/dsh/backend/dsh-credentials-store";
import { discoverPlugins } from "../application/loader/discover";
import { PluginRegistry } from "../application/loader/registry";
import {
  mergeLanguageContributions,
  collectNamespaces,
  collectSupportedLngs,
  collectLocaleList,
} from "../application/i18n/merge";
import { SessionStore } from "../application/sessions/session-store";

import { NeutralSessionStore } from "../application/sessions/neutral-session-store";
import { PendingQuestionStore } from "../application/sessions/pending-question-store";
import type { BackendFactory, SessionCatalogFactory } from "@my-harness-desktop/shared";
import type { KernelModelsRegistry, KernelConfigApi, KernelExtensionSource, KernelVersionApi, SkillProvider } from "@my-harness-desktop/shared";
import type { KernelId } from "@my-harness-desktop/shared";
import type { PluginLifecycleDeps } from "../application/lifecycle";
import { KERNEL_LOGOS } from "../kernel/factories/kernel-logos";
import { KernelRegistry } from "../kernel/core/kernel-registry";
import { loadKernelPlugin, scanKernelPlugins, defaultEnabledEntries } from "../kernel/core/kernel-plugin-loader";
import { mirrorBundledSkills } from "../application/skills/bundled-skills";
import { SkillAggregator } from "../application/skills/skill-aggregator";
import { installFitPiExtension, fitPiExtensionAvailable } from "../kernel/pi/extension/my-harness-fit-pi-extension-installer";
import { mirrorManagedDir } from "../application/bundled/mirror";
import { initKernelRuntime } from "../kernel/core/kernel-manager";
import { reconcileMissingKernels } from "../kernel/core/kernel-reconcile";
import { importLegacyPiSessions } from "../application/sessions/neutral-migration";
import { RestartCoordinatorImpl } from "../application/restart/restart-coordinator";
import { createNpmKernelRuntime } from "../client/npm/kernel-runtime";
import { DEFAULT_PREFS, type MainContext, type Prefs } from "../application/context/main-context";
import { broadcastSettingsChanged, broadcastRefreshRequested } from "../routing/broadcast";
import { registerConfig } from "../controllers/config";
import { registerAppearance } from "../controllers/appearance";
import { registerSessions } from "../controllers/sessions";
import { registerFsGit } from "../controllers/fs-git";
import { registerSlotsDialog } from "../controllers/slots-dialog";
import { registerKernel } from "../controllers/kernel";
import { registerPlugins } from "../controllers/plugins";
import { registerSkills } from "../controllers/skills";
import { registerExtensions } from "../controllers/extensions";
import { registerBus } from "../controllers/bus";
import { registerWindow } from "../controllers/window";
import { registerAppInfo } from "../controllers/app-info";
import { registerNotification } from "../controllers/notification";
import { registerRemote } from "../controllers/remote";
import { FIT_DSEXTENSION_ID } from "../kernel/dsh/extension/dsh-extension-installer";
import { SessionBus } from "../application/sessions/session-bus";
import { resolveMyHarnessDesktopDir } from "../application/config/paths";
import { createGateway } from "../routing/gateway";
import { RemoteAuth } from "../remote/auth";
import { RemoteConfigStore } from "../remote/remote-config";
import { createHttpServer } from "../transport/http/http-server";
import { attachWsServer } from "../transport/ws/ws-server";
import { createElectronHost } from "../host/electron-host";

import type { Host } from "@my-harness-desktop/shared";
import type { Gateway } from "../routing/gateway";

/** assemble 的产物:electron/server 各取所需。 */
export interface Assembled {
  ctx: MainContext;
  sessionStore: SessionStore;
  gateway: Gateway;
  localToken: string;
  port: number;
}

/** 共享组装:注入 Host + isPackaged + rendererDir(§5.4),建 stores/ctx/gateway/注册全部 handler/起服务器。
 *  rendererDir 由入口(electron.ts/server.ts)注入而非此处推断:本文件被 rollup 打进
 *  out/main/chunks/,__dirname 多一段 chunks/,process.cwd() 又在打包态指向家目录而非
 *  asar,两者都无法可靠定位 out/renderer。入口是 entry(__dirname 恒为 out/main),
 *  resolve(__dirname,"../renderer") 在 dev/server 宿主/打包态三种上下文都对。 */
export function assemble(host: Host, opts: { isPackaged: boolean; rendererDir: string }): Assembled {

// ---- 路径:main 进程唯一读环境的点,经 MainContext 注入给 ipc 层 ----
// MY_HARNESS_DESKTOP_DIR 单源在 client/paths(打包态 ~/.my-harness-desktop,dev 态 ~/.my-harness-desktop-dev 分流)。
const HOME_DIR = homedir();
const MY_HARNESS_DESKTOP_DIR = resolveMyHarnessDesktopDir(opts.isPackaged);
const CONFIG_DIR = join(MY_HARNESS_DESKTOP_DIR, "config");
// 远程鉴权(§8):本地 token + HMAC token(密码登录签发)复合校验;serverSecret 每次启动随机。
// 服务端口:默认 8420;MHD_PORT 环境变量可覆盖——e2e/演示场景与开发实例并存时各占各的
// 端口(此前写死 8420,dev 实例在跑时 e2e 实例绑定失败/连错服务端,启动即「Connection
// lost」的根因)。端口是部署参数不是业务内容,环境变量是合法配置面。
const PORT = Number(process.env["MHD_PORT"]) > 0 ? Number(process.env["MHD_PORT"]) : 8420;
const remoteConfig = new RemoteConfigStore(join(CONFIG_DIR, "remote.json"));
const auth = new RemoteAuth(remoteConfig);
const gateway = createGateway(auth.createTokenVerifier());
const PI_INSTALL_DIR = join(MY_HARNESS_DESKTOP_DIR, "pi");
// dsh 内核 npm 安装目录(~/.my-harness-desktop/dsh);dsh 原生配置(cordis.yml/settings.yaml)在 ~/.dsh。
const DSH_INSTALL_DIR = join(MY_HARNESS_DESKTOP_DIR, "dsh");
const GENERAL_CONFIG_PATH = join(CONFIG_DIR, "general.json");
// pi 内核配置目录(~/.pi/agent,内核标准,非 ~/.my-harness-desktop)。pi-settings 插件读写它。
const PI_AGENT_DIR = join(HOME_DIR, ".pi", "agent");
// 内置 skills:仓库顶级 .claude/skills/ 随壳分发(pkg 拷贝到 resources/my-harness-desktop-skills,
// 与 my-harness-desktop-builtin 同批),启动时镜像到 ~/.my-harness-desktop/skills(强制覆盖,受管目录)
const BUNDLED_SKILLS_DIR = join(MY_HARNESS_DESKTOP_DIR, "skills");
// 桌面偏好走 electron-store,显式 cwd 纳入数据根 config 树(跨重启持久,与插件配置同根)
const prefsStore = new JsonPrefsStore<Prefs>(join(CONFIG_DIR, "config.json"), DEFAULT_PREFS);

// 迁移旧 prefs.dshApiKeys(provider → 密钥字面值;旧机制 spawn 时注入进程 env)
// → dsh 凭证库(~/.dsh/.credentials.yaml refs;新机制 dsh 运行时直接读凭证库,不注入 env)。
// 一次幂等:迁移后清空旧 map,避免「凭证库 + prefs」双份真相。deepseek-official 官方路由已废弃,
// 旧单值 dshApiKey(指向它)随迁移一并清除,不再落凭证库。读 raw store:字段已从 Prefs 类型删除。
{
  const raw = prefsStore.store as unknown as Record<string, unknown>;
  const legacyKeys = (raw.dshApiKeys ?? {}) as Record<string, unknown>;
  for (const [provider, key] of Object.entries(legacyKeys)) {
    if (typeof key === "string" && key) {
      writeApiKey(join(HOME_DIR, ".dsh", ".credentials.yaml"), provider, key);
    }
  }
  if (Object.keys(legacyKeys).length > 0) delete raw.dshApiKeys;
  if (typeof raw.dshApiKey === "string") delete raw.dshApiKey;
}

initKernelRuntime(createNpmKernelRuntime());

// dsh 首次运行准备(ensure* 写 cordis.yml/凭证插件/明文会话日志 + zstd 迁移 + 悬空默认清理 +
//  tool-skill 启用)已收进 dshKernelPlugin 工厂(§kernel-plugin),此处不再重复构造——加第四个内核零改动。
// 统一 dsh 适配插件源目录(合并 ask/goal/read-claude-md/skill-manager 四个随插件携带的
// dsh cordis 插件为一块 my-harness-fit-dsh-extension)。dev: __dirname=out/main →
// ../../src/server/kernel/dsh/extension/dsh-extension;pkg: resources/my-harness-desktop-dsh-extension(extraResources 随壳分发)。
const DSH_FIT_EXTENSION_SOURCE = opts.isPackaged
  ? join(process.resourcesPath, "my-harness-desktop-dsh-extension")
  : resolve(process.cwd(), "src/server/kernel/dsh/extension/dsh-extension");
// 内核插件注册(§kernel-plugin):唯一 import 具体内核插件并注册的地方。加第四个内核 = 在此加一行。
// 提前到 modelCatalog 之前(modelSource 从 registry 遍历),testModel/markSessionsPendingRestart 用延迟
// 闭包引用后赋值的 sessionStore/restartCoordinator(运行时才求值,那时已赋值)。
const kernelRegistry = new KernelRegistry();
let sessionStore!: SessionStore;
let restartCoordinator!: RestartCoordinatorImpl;
const pluginCtx = {
  isPackaged: opts.isPackaged,
  homedir: HOME_DIR,
  dataRoot: MY_HARNESS_DESKTOP_DIR,
  prefs: {
    get: <T>(key: string): T | undefined => prefsStore.get(key as keyof Prefs) as T | undefined,
    set: <T>(key: string, value: T): void => { prefsStore.set(key as keyof Prefs, value as Prefs[keyof Prefs]); },
  },
  markSessionsPendingRestart: (reason: string) => {
    const keys = sessionStore.getRunningSessionKeys();
    restartCoordinator.markPendingAll(keys, reason);
  },
  broadcastRefresh: () => broadcastRefreshRequested(gateway),
  builtinSkillsDir: BUNDLED_SKILLS_DIR,
  getCwd: () => sessionStore.getActiveCwd(),
};
// 内核插件动态加载(§kernel-plugin 物理插件):扫描内核插件目录(有 plugin.json 的子目录),
// 读 manifest → 同步 require 工厂 → register。加第四个内核 = 加一个目录 + manifest;
// 卸载 = 删目录/禁 manifest,壳照常启动(modelCatalog 从 registry 遍历,未注册内核自动缺面)。
// 内核插件目录(物理插件:rollup 把 plugin.ts 独立打包到 out/main/server/kernel/*/plugin.js)。
// assemble 可能被 rollup 拆进 chunks/(import.meta.url 是 chunk 路径),故用 process.cwd() 定位:
// dev/build(electron-vite 输出到 out/):process.cwd() = 项目根 → out/main/server/kernel/;
// packaged(electron-builder):asar 内 → process.resourcesPath/app.asar/out/main/server/kernel/。
const KERNEL_PLUGINS_DIR = opts.isPackaged
  ? join(process.resourcesPath, "app.asar", "out", "main", "server", "kernel")
  : join(process.cwd(), "out", "main", "server", "kernel");
// 默认装载过滤(§目标 16):manifest.enabled===false 的内核默认不装载(如 minimal=验证用内核,生产无意义)。
// MHD_ENABLE_KERNELS(逗号分隔内核 id)运行时强制启用被声明为 off 的内核(测试/演示);
// 扫描 = 存在性(卸载 = 删 manifest → 扫描不存在),装载 = 默认开关(enabled),两轴正交。
const forceEnableKernels = new Set(
  (process.env["MHD_ENABLE_KERNELS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);
for (const { dir, manifest } of defaultEnabledEntries(scanKernelPlugins(KERNEL_PLUGINS_DIR), forceEnableKernels)) {
  loadKernelPlugin(kernelRegistry, dir, manifest, {
    ...pluginCtx,
    testModel: (cwd, p, m) => sessionStore.test(cwd, p, m, manifest.id),
  });
}
const modelCatalog = new ModelCatalog(kernelRegistry.all().map((p) => p.createModelSource()));

// ---- 加载器:发现 builtin/installed/user/project 四目录插件,按优先级注册(低到高) ----
// 开发期扫 src/plugins;打包后扫 process.resourcesPath/my-harness-desktop-builtin。
// 内置插件与第三方插件平等:同一 discoverPlugins,无 if(builtin) 分支(01-core:1447)。
// dev: __dirname=out/main,src/plugins 在 ../../src/plugins(项目根/src/plugins)
// pkg: __dirname=resources/app.asar/...,插件随壳分发在 resources/my-harness-desktop-builtin/
const builtinDir = opts.isPackaged
  ? join(process.resourcesPath, "my-harness-desktop-builtin")
  : resolve(process.cwd(), "src/plugins");
const userPluginsDir = join(MY_HARNESS_DESKTOP_DIR, "plugins");
const bundledSkillsSource = opts.isPackaged
  ? join(process.resourcesPath, "my-harness-desktop-skills")
  : resolve(process.cwd(), ".claude/skills");
// 内置表情包:assets/stickers/ 随壳分发(pkg 拷贝到 resources/my-harness-desktop-stickers),
// 启动时镜像到数据根 ~/.my-harness-desktop/stickers/bundled/(强制覆盖,受管目录)。
// stickers 插件按只读 builtin 层读它——纯 UI 内容,不进模型上下文,无 ensure* 开关。
const BUNDLED_STICKERS_DIR = join(MY_HARNESS_DESKTOP_DIR, "stickers", "bundled");
const bundledStickersSource = opts.isPackaged
  ? join(process.resourcesPath, "my-harness-desktop-stickers")
  : resolve(process.cwd(), "assets/stickers");
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
// 依赖倒置:BackendFactory(圆心契约)由 shell 注入实现,SessionStore 不 new 具体内核、
// 不感知 spawn。内核插件经 KernelRegistry 注册(见 modelCatalog 之前的 registerKernelPlugins),
// create/seed 按 opts.kernel 查插件、调其 createBackend/seed——加第四个内核 = 加插件 + 注册。
const baseBackendFactory: BackendFactory = {
  create: (opts) => {
    const plugin = kernelRegistry.get(opts.kernel);
    if (!plugin) throw new Error(`未注册的内核: ${opts.kernel}`);
    return plugin.createBackend(opts);
  },
  // 预 seed(§4.5 生命周期不对称):文件态内核(pi/minimal)= 纯文件写,先 seed 得路径再以该路径
  //  spawn;RPC 内核(dsh)= 返回 null,走 create → start → backend.seed。缺面(无 seed)同样返回 null。
  seed: async (lineage, opts) => {
    const plugin = kernelRegistry.get(opts.kernel);
    return plugin?.seed?.(lineage, opts) ?? null;
  },
};
// 目录/CRUD 工厂(依赖倒置):目录/CRUD 是内核专属存储操作,壳经 SessionCatalog 委托;
// 按 kernel 查插件、调其 createCatalog——加第四个内核 = 加插件 + 注册,此处零改动。
const sessionCatalogFactory: SessionCatalogFactory = {
  create: (kernel) => {
    const plugin = kernelRegistry.get(kernel);
    if (!plugin) throw new Error(`未注册的内核: ${kernel}`);
    return plugin.createCatalog();
  },
};
sessionStore = new SessionStore(
  baseBackendFactory,
  sessionCatalogFactory,
  PI_AGENT_DIR,
  () => registry.systemPromptPaths(),
  new NeutralSessionStore(join(MY_HARNESS_DESKTOP_DIR, "sessions")),
  modelCatalog,
  // 收藏快照目录(项目级,跟随 cwd):快照是中立物化前缀,存 <cwd>/.my-harness-desktop/bookmarks/。
  (cwd) => join(cwd, ".my-harness-desktop", "bookmarks"),
  // 挂起提问请求单(ask-design §4.3):壳持有的持久存储,进程生死不影响其存续。
  new PendingQuestionStore(join(MY_HARNESS_DESKTOP_DIR, "pending-questions")),
  // 默认内核 id:注册表首个内核(无模型/无会话头时兜底)。
  kernelRegistry.ids()[0] ?? "",
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
// 中立层变更通知 → WS 扇出(session-single-source §3.2:写穿回执,渲染层镜像的数据源)。
sessionStore.onNeutralChange((change) => {
  gateway.broadcast("session:neutralChange", change);
});

// ---- 内核专属适配器组装(注入 MainContext,api/ipc 不直连 client/{kernel})----
// 模型配置中性 API:从 registry 遍历 createModelsApi(加第四个内核 = 加插件 + 注册,此处零改动)。
const kernelModels: KernelModelsRegistry = Object.fromEntries(
  kernelRegistry.all().map((p) => [p.id, p.createModelsApi()]),
) as KernelModelsRegistry;
// pi settings.json 中性面已由 pi 插件的 createConfigApi 提供(插件内部构造 PiSettingsApi),
// 壳不再单独构造 piSettings 注入 MainContext。
// 内核原生配置中性 API(配置 TAB 用):从 registry 遍历 createConfigApi(加第四个内核零改动)。
const kernelConfig: Record<KernelId, KernelConfigApi> = Object.fromEntries(
  kernelRegistry.all().map((p) => [p.id, p.createConfigApi()]),
) as Record<KernelId, KernelConfigApi>;
// 内核版本管理中性 API:从 registry 遍历 createVersionApi(加第四个内核零改动)。
const kernelVersionApis: Record<KernelId, KernelVersionApi> = Object.fromEntries(
  kernelRegistry.all().map((p) => [p.id, p.createVersionApi()]),
) as Record<KernelId, KernelVersionApi>;
// 已注册内核 id 清单(运行时注册表顺序;替代 KERNEL_IDS 字面量数组,前端经 kernel.list IPC 拿)。
const kernelIds: KernelId[] = kernelRegistry.all().map((p) => p.id);
// 一次性问内核能力(从 registry 遍历 createOneshot;pi 有、dsh/minimal 无此面 → undefined)。
const kernelOneshots: Record<KernelId, ((prompt: string, cwd?: string) => Promise<string>) | undefined> = Object.fromEntries(
  kernelRegistry.all().map((p) => [p.id, p.createOneshot?.()]),
) as Record<KernelId, ((prompt: string, cwd?: string) => Promise<string>) | undefined>;
// 内置 skills 挂/摘 + 旧命名迁移(从 registry 遍历 ensureSkills/migrateSkills;pi 有、dsh/minimal 无)。
const skillsPlugins = kernelRegistry.all().filter((p) => p.ensureSkills);
const ensureBundledSkills = (enabled: boolean): Promise<boolean> =>
  skillsPlugins[0]?.ensureSkills?.(enabled) ?? Promise.resolve(false);
const migrateSkills = (): Promise<boolean> =>
  skillsPlugins[0]?.migrateSkills?.() ?? Promise.resolve(false);
// 壳插件生命周期钩子(从 registry 遍历 createLifecycle;pi 有 skillsEnsure/piExtensionEnsure,
// dsh/minimal 无)。onActivate/onDeactivate 返回 changed 供壳广播刷新。
const lifecycles = kernelRegistry.all().map((p) => p.createLifecycle?.()).filter((l) => !!l);
const pluginSkillsEnsure: NonNullable<PluginLifecycleDeps["skillsEnsure"]> = {
  async onActivate(pluginId, pluginPath, source) {
    for (const l of lifecycles) {
      const changed = await l.skillsEnsure?.onActivate(pluginId, pluginPath, source);
      if (changed) broadcastSettingsChanged(gateway);
    }
  },
  async onDeactivate(pluginId, pluginPath, source) {
    for (const l of lifecycles) {
      const changed = await l.skillsEnsure?.onDeactivate(pluginId, pluginPath, source);
      if (changed) broadcastSettingsChanged(gateway);
    }
  },
};
// 插件携带 pi 内核扩展的挂/摘 hooks(写 ~/.pi/agent/extensions 是流出适配)。
const pluginPiExtensionEnsure: NonNullable<PluginLifecycleDeps["piExtensionEnsure"]> = {
  onActivate(pluginId, pluginPath, piExtension) {
    for (const l of lifecycles) l.piExtensionEnsure?.onActivate(pluginId, pluginPath, piExtension);
  },
  onDeactivate(pluginId) {
    for (const l of lifecycles) l.piExtensionEnsure?.onDeactivate(pluginId);
  },
};
// 插件携带 dsh cordis 扩展的挂/摘 hooks(同步目录 + 挂 cordis.yml 块)。
// 从 registry 遍历 createExtensionSync(dsh 有、pi/minimal 无此面)。
const extensionSyncs = kernelRegistry.all().map((p) => p.createExtensionSync?.()).filter((s) => !!s);
const pluginDshExtensionEnsure: NonNullable<PluginLifecycleDeps["dshExtensionEnsure"]> = {
  onActivate(pluginId, pluginPath, dshExtension) {
    for (const s of extensionSyncs) s.onActivate?.(pluginId, pluginPath, dshExtension);
  },
  onDeactivate(pluginId) {
    for (const s of extensionSyncs) s.onDeactivate?.(pluginId);
  },
};

// 提问桥(从 registry 遍历 createQuestionBridge;dsh 有、pi/minimal 无此面)。
// 监听问句目录 → 投中性提问事件 → 经 sessionStore.injectQuestion 汇入统一通道。
for (const p of kernelRegistry.all()) {
  const bridge = p.createQuestionBridge?.();
  if (!bridge) continue;
  bridge.start();
  bridge.onQuestion((req) => {
    sessionStore.injectQuestion({
      kind: "question",
      requestId: req.requestId,
      sessionKey: req.sessionId,
      questions: req.questions,
    });
  });
}

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
restartCoordinator = new RestartCoordinatorImpl(sessionStore);
restartCoordinator.onStateChange((sessionKey, state) => {
  gateway.broadcast("restart:state", sessionKey, state);
});
// 内核拓展源(中性契约 KernelExtensionSource):pi/dsh 各一个,基类管排序/标签/受保护,
// 子类填数据源 + 落盘机制;onConfigChanged 统一接线 restartCoordinator(§extension-management §0)。
// 内核拓展源(中性契约 KernelExtensionSource):从 registry 遍历 createExtensionSource
// (加第四个内核 = 加插件 + 注册,此处零改动)。
const kernelExtensions = Object.fromEntries(
  kernelRegistry.all().map((p) => [p.id, p.createExtensionSource()]),
) as Record<KernelId, KernelExtensionSource>;

// 技能聚合器:壳不读内核存储,只聚合各内核插件的 createSkillProvider(内核各自读自己的存储、回报)。
const skillAggregator = new SkillAggregator(
  kernelRegistry.all().map((p) => p.createSkillProvider?.()).filter((s): s is SkillProvider => !!s),
);

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
  configStore,
  modelCatalog,
  kernelModels,
  kernelConfig,
  registry,
  skillAggregator,
  sessionStore,
  sessionBus,
  restartCoordinator,
  kernelExtensions,
  kernelLogos: KERNEL_LOGOS,
  kernelVersionApis,
  kernelIds,
  kernelOneshots,
  fitPiExtensionAvailable,
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
registerAppearance(gateway, ctx, host);
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
// 远程访问热重绑闭包(第 19 项):真实现在下方 httpServer 创建后赋值,
// 控制器开关经 opts.rebind 触发——绑定变更即时生效,不再等重启。
let rebindRemote: () => void = () => {};
// 设备管理句柄(第 23/24 项):真实现在下方 attachWsServer 后赋值。
let wsHandleRef: import("../transport/ws/ws-server").WsServerHandle | null = null;
registerRemote(gateway, auth, {
  port: PORT,
  rebind: () => rebindRemote(),
  deviceManager: {
    list: () => wsHandleRef?.listConnections() ?? [],
    kick: (id: string) => wsHandleRef?.kick(id) ?? false,
    kickAll: () => wsHandleRef?.kickAll() ?? 0,
  },
});

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
  void migrateSkills()
    .then((changed) => { if (changed) broadcastSettingsChanged(gateway); })
    .catch((e) => console.error("[bundled-skills] 改名迁移失败:", e));
  // 内置表情包启动同步:镜像到数据根受管目录,stickers 插件按只读 builtin 层读它。
  mirrorManagedDir(bundledStickersSource, BUNDLED_STICKERS_DIR);
  void ensureBundledSkills(prefsStore.get("bundledSkillsEnabled"))
    .then((changed) => { if (changed) broadcastSettingsChanged(gateway); })
    .catch((e) => console.error("[bundled-skills] 启动同步失败:", e));

  void (async () => {
    let anyChanged = false;
    for (const [id, plugin] of registry.allPlugins()) {
      for (const l of lifecycles) {
        try {
          const changed = await l.skillsEnsure?.onActivate(id, plugin.path, plugin.source);
          if (changed) anyChanged = true;
        } catch (e) {
          console.error(`[plugin-skills] ensure 失败 (${plugin.manifest.id}):`, e);
        }
      }
    }
    if (anyChanged) broadcastSettingsChanged(gateway);
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
        // 传原始插件目录 + 相对扩展路径(插件侧 onActivate 自会 join)——此前误传 resolve(plugin.path, rel)
        // 再在插件侧 join(rel) 导致路径双重拼接,扩展目录永远同步不上(§根因修复,勿回退)。
        for (const l of lifecycles) l.piExtensionEnsure?.onActivate(id, plugin.path, rel);
        active.add(id);
      }
      for (const l of lifecycles) l.piExtensionEnsure?.reconcile?.(active);
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
      for (const s of extensionSyncs) s.syncFit?.(DSH_FIT_EXTENSION_SOURCE);
      const active = new Set<string>([FIT_DSEXTENSION_ID]);
      // 第三方插件仍可经 manifest.dshExtension 携带 dsh cordis 插件(通用通道,随插件启停)。
      for (const [id, plugin] of registry.allPlugins()) {
        const rel = plugin.manifest.dshExtension;
        if (!rel || disabled.includes(id)) continue;
        // 同 piExtension:传原始插件目录 + 相对扩展路径,插件侧 onActivate 自会 join。
        // 此前误传 resolve(plugin.path, rel) 再 join(rel) → 路径双重拼接,dsh 扩展目录同步不上,
        // cordis.yml 里的相对块指向不存在的目录 → dsh 内核启动即崩(§根因修复,勿回退)。
        for (const s of extensionSyncs) s.onActivate?.(id, plugin.path, rel);
        active.add(id);
      }
      // 对账:PLUGINS_ROOT 下带 marker 但不在 active 的目录(含旧 ask/goal/read-claude-md/skill-manager)摘除。
      for (const s of extensionSyncs) s.reconcile?.(active);
    } catch (e) {
      console.error("[dsh-extension] 启动同步失败:", e);
    }
  })().catch((e) => console.error("[dsh-extension] 启动同步失败:", e));

  // my-harness-fit-pi-extension 内核扩展同步:统一了原 tool-gate/context-probe/bus/subagent/skills
  // 五个扩展,任何 pi 会话进程 spawn 之前装好,renderer 经 kernel.fitPiExtensionAvailable IPC 探测可用性。
  installFitPiExtension(opts.isPackaged);
  // 起 HTTP+WS 服务器(§6/§7.3):静态 + /rpc。
  const httpServer = createHttpServer({ staticDir: opts.rendererDir, gateway, auth });
  const wsHandle = attachWsServer(httpServer, gateway, host, auth.createTokenVerifier());
  wsHandleRef = wsHandle; // 设备管理面就绪(第 23/24 项)
  // 网络绑定(§8.6):默认关闭=仅 loopback;开启且 bind=lan 才 0.0.0.0(第 14/19 项)。
  const bindFor = (): string =>
    remoteConfig.get().enabled && remoteConfig.get().bind === "lan" ? "0.0.0.0" : "127.0.0.1";
  let currentBind = bindFor();
  httpServer.listen(PORT, currentBind);
  // 热重绑(第 19 项):开关远程访问立即重监听,不需重启。升级后的 WS socket 不计入
  // server.close 等待集合,须先经 wsHandle 显式终止,否则 close 回调不触发、端口悬空。
  // 既有连接被断开——客户端已有断连横幅引导刷新(第 17 项),重绑窗口极短。
  // 竞态收敛:重绑进行中的再次开关不重入,listen 完成后按最新配置自检补一轮。
  // 防御:全程 try/catch + 常驻 error 监听——重绑路径上任何未捕获异常都会杀掉主进程
  // (应用整体暴毙的根因排查结论,第 19 项)。
  httpServer.on("error", (e) => console.error("[remote] HTTP server error:", e));
  let rebinding = false;
  rebindRemote = () => {
    const next = bindFor();
    if (next === currentBind || rebinding) return;
    rebinding = true;
    currentBind = next;
    try { wsHandle.closeAllClients(); } catch (e) { console.error("[remote] closeAllClients 失败:", e); }
    try { httpServer.closeAllConnections?.(); } catch { /* 无此方法的老 Node 忽略 */ }
    httpServer.close(() => {
      try {
        httpServer.listen(PORT, next, () => {
          console.log(`[remote] 网络绑定已切换: ${next}:${PORT}`);
          rebinding = false;
          if (bindFor() !== currentBind) rebindRemote(); // 连点收敛
        });
      } catch (e) {
        console.error("[remote] 重监听抛出:", e);
        setTimeout(() => {
          try { httpServer.listen(PORT, next); } catch (e2) { console.error("[remote] 补救重监听失败:", e2); }
          rebinding = false;
        }, 500);
      }
    });
  };

  // 内核冷启动对账(design-principles「内核安装不该靠手动」):启动后异步扫已装状态,缺失则按
  // dist-tag 最新版自动补装。fire-and-forget,不阻断启动;失败只 warn 不崩。进度不进 UI(后台静默),
  // 装完广播 refresh 让「未安装」只读条消失;进度/结果回调为后续插件安装/更新扫描预留同一形状。
  void reconcileMissingKernels(
    kernelRegistry.all().map((p) => ({ kernel: p.id, versionApi: p.createVersionApi() })),
    (_kernel, _line) => { /* 后台静默,进度仅日志(不打扰用户) */ },
    (result) => {
      if (result.outcome === "installed") {
        console.log(`[kernel-reconcile] ${result.kernel} 内核已自动补装`);
        broadcastRefreshRequested(gateway);
      } else if (result.outcome === "failed") {
        console.warn(`[kernel-reconcile] ${result.kernel} 自动补装失败: ${result.error}`);
      }
    },
  ).catch((e) => console.error("[kernel-reconcile] 启动对账失败:", e));

  // pi 旧命名会话文件的一次性中立层导入(session-single-source §4.3;§2.1 的显式例外,
  // 离线迁移工具不是会话流读路径)。幂等,已有中立层的跳过;同步执行(文件量小、本地读),
  // 失败只告警不阻断启动;有导入则广播刷新,让列表出现迁移进来的旧会话。
  try {
    const store = sessionStore.neutralStoreRef;
    if (store) {
      const r = importLegacyPiSessions(PI_AGENT_DIR, store);
      if (r.imported > 0) {
        console.log(`[neutral-migration] 旧 pi 会话文件导入中立层: ${r.imported} 个(跳过 ${r.skipped},失败 ${r.failed})`);
        broadcastRefreshRequested(gateway);
      }
    }
  } catch (e) {
    console.warn("[neutral-migration] 启动导入失败(不阻断启动):", e);
  }

  return { ctx, sessionStore, gateway, localToken: auth.localToken, port: PORT };
}
