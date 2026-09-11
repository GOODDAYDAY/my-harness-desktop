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
import type { KernelId, KernelPlugin } from "@my-harness-desktop/shared";
import type { PluginLifecycleDeps } from "../application/lifecycle";
import { KERNEL_LOGOS } from "../kernel/factories/kernel-logos";
import { KernelRegistry } from "../kernel/core/kernel-registry";
import { loadKernelPlugin, scanKernelPlugins, defaultEnabledEntries } from "../kernel/core/kernel-plugin-loader";
import { mirrorBundledSkills } from "../application/skills/bundled-skills";
import { SkillAggregator } from "../application/skills/skill-aggregator";
import { mirrorManagedDir } from "../application/bundled/mirror";
import { buildKernelSurfaces, ensureBundledSkillsOnAll, makeExtensionDispatch, migrateSkillsOnAll, runKernelStartupMigrations } from "./kernel-surfaces";
import { initKernelRuntime } from "../kernel/core/kernel-manager";
import { reconcileMissingKernels } from "../kernel/core/kernel-reconcile";
import { importLegacySessions } from "../application/sessions/legacy-import";
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
const GENERAL_CONFIG_PATH = join(CONFIG_DIR, "general.json");
// pi 内核配置目录(~/.pi/agent,内核标准,非 ~/.my-harness-desktop)。pi-settings 插件读写它。
// 内置 skills:仓库顶级 .claude/skills/ 随壳分发(pkg 拷贝到 resources/my-harness-desktop-skills,
// 与 my-harness-desktop-builtin 同批),启动时镜像到 ~/.my-harness-desktop/skills(强制覆盖,受管目录)
const BUNDLED_SKILLS_DIR = join(MY_HARNESS_DESKTOP_DIR, "skills");
// 桌面偏好走 electron-store,显式 cwd 纳入数据根 config 树(跨重启持久,与插件配置同根)
const prefsStore = new JsonPrefsStore<Prefs>(join(CONFIG_DIR, "config.json"), DEFAULT_PREFS);

initKernelRuntime(createNpmKernelRuntime());


// dsh 首次运行准备(ensure* 写 cordis.yml/凭证插件/明文会话日志 + zstd 迁移 + 悬空默认清理 +
//  tool-skill 启用)已收进 dshKernelPlugin 工厂(§kernel-plugin),此处不再重复构造——加第四个内核零改动。
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
    // 一次性迁移要能"摘掉"旧键（不是留个空壳在盘上），所以 prefs 面除 get/set 还有 remove。
    remove: (key: string): void => { prefsStore.remove(key as keyof Prefs); },
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
// 内核工厂的**构建根**：rollup 把每个内核的 plugin.ts 独立打包成
// out/main/server/kernel/<id>/plugin.js（见 electron.vite.config.ts 的 rollup input）。
// assemble 可能被 rollup 拆进 chunks/(import.meta.url 是 chunk 路径),故用 process.cwd() 定位:
// dev/build(electron-vite 输出到 out/):process.cwd() = 项目根 → out/main/server/kernel/;
// packaged(electron-builder):asar 内 → process.resourcesPath/app.asar/out/main/server/kernel/。
const KERNEL_BUILD_ROOT = opts.isPackaged
  ? join(process.resourcesPath, "app.asar", "out", "main", "server", "kernel")
  : join(process.cwd(), "out", "main", "server", "kernel");

// ---- 加载器:发现 builtin/installed/user/project 四目录插件,按优先级注册(低到高) ----
// 开发期扫 src/plugins;打包后扫 process.resourcesPath/my-harness-desktop-builtin。
// 内置插件与第三方插件平等:同一 discoverPlugins,无 if(builtin) 分支(01-core:1447)。
// dev: __dirname=out/main,src/plugins 在 ../../src/plugins(项目根/src/plugins)
// pkg: __dirname=resources/app.asar/...,插件随壳分发在 resources/my-harness-desktop-builtin/
const builtinDir = opts.isPackaged
  ? join(process.resourcesPath, "my-harness-desktop-builtin")
  : resolve(process.cwd(), "src/plugins");
const userPluginsDir = join(MY_HARNESS_DESKTOP_DIR, "plugins");

// 内核插件注册(§kernel-plugin):**扫的就是壳插件根目录**——manifest 带 `kernel` 块者，
// 既是一个壳插件、也是一个内核插件(内核面与它的 desktop 对接面同属一个目录)。
// 必须先于 modelCatalog(modelSource 从 registry 遍历),也先于下面的壳插件注册。
// 默认装载过滤(§目标 16):kernel.enabled===false 的内核默认不装载(如 minimal=验证用内核,生产无意义)。
// MHD_ENABLE_KERNELS(逗号分隔内核 id)运行时强制启用被声明为 off 的内核(测试/演示);
// 扫描 = 存在性(卸载 = 删 plugin.json → 扫描不存在),装载 = 默认开关(enabled),两轴正交。
const forceEnableKernels = new Set(
  (process.env["MHD_ENABLE_KERNELS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);
// builtin 在前、user 在后:用户装的第三方内核插件可覆盖同名(registry 对重复 id 会 fail-fast)。
const kernelEntries = defaultEnabledEntries(
  [...scanKernelPlugins(builtinDir), ...scanKernelPlugins(userPluginsDir)],
  forceEnableKernels,
);
for (const entry of kernelEntries) {
  loadKernelPlugin(kernelRegistry, entry, KERNEL_BUILD_ROOT, {
    ...pluginCtx,
    testModel: (cwd, p, m) => sessionStore.test(cwd, p, m, entry.manifest.id),
  });
}
/** 未被装载的内核插件 id:它们的**对接面也不进壳插件清单**。 */
const unloadedKernelPluginIds = new Set(
  scanKernelPlugins(builtinDir)
    .filter((e) => !kernelEntries.some((k) => k.manifest.id === e.manifest.id))
    .map((e) => e.manifest.id),
);
// 内核的历史遗留状态一次性迁移 + **全部内核面**一次投影（见 bootstrap/kernel-surfaces.ts：
// 那一段单独成文件是为了让"加第四个内核零改动"这句可被测试直接证明，而不是靠读代码相信）。
runKernelStartupMigrations(kernelRegistry);
const surfaces = buildKernelSurfaces(kernelRegistry);
const { modelCatalog, ids: kernelIds, defaultId: defaultKernelId } = surfaces;
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
/** 过滤掉"内核面未装载"的内核插件:没有内核却显示它的设置页,只会得到一堆报错。 */
const withoutUnloadedKernels = (list: ReturnType<typeof discoverPlugins>): ReturnType<typeof discoverPlugins> =>
  list.filter((p) => !unloadedKernelPluginIds.has(p.manifest.id));
registry.registerAll(withoutUnloadedKernels(discoverPlugins(builtinDir, "builtin")));
registry.registerAll(withoutUnloadedKernels(discoverPlugins(installedDir, "installed")));
registry.registerAll(withoutUnloadedKernels(discoverPlugins(userPluginsDir, "user")));
registry.registerAll(withoutUnloadedKernels(discoverPlugins(projectPluginsDir, "project")));

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
  {
    // 注册表派生的内核事实（会话根 / 已注册清单 / 默认内核）——三面同源，打成一包。
    sessionRoots: surfaces.sessionRoots,
    ids: kernelIds,
    defaultId: defaultKernelId ?? undefined,
  },
  () => registry.systemPromptPaths(),
  new NeutralSessionStore(join(MY_HARNESS_DESKTOP_DIR, "sessions")),
  modelCatalog,
  // 收藏快照目录(项目级,跟随 cwd):快照是中立物化前缀,存 <cwd>/.my-harness-desktop/bookmarks/。
  (cwd) => join(cwd, ".my-harness-desktop", "bookmarks"),
  // 挂起提问请求单(ask-design §4.3):壳持有的持久存储,进程生死不影响其存续。
  new PendingQuestionStore(join(MY_HARNESS_DESKTOP_DIR, "pending-questions")),
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
const kernelModels: KernelModelsRegistry = surfaces.modelsApis;
// pi settings.json 中性面已由 pi 插件的 createConfigApi 提供(插件内部构造 PiSettingsApi),
// 壳不再单独构造 piSettings 注入 MainContext。
// 内核原生配置中性 API(配置 TAB 用):从 registry 遍历 createConfigApi(加第四个内核零改动)。
const kernelConfig: Record<KernelId, KernelConfigApi> = surfaces.configApis;
// 内核版本管理中性 API:从 registry 遍历 createVersionApi(加第四个内核零改动)。
const kernelVersionApis: Record<KernelId, KernelVersionApi> = surfaces.versionApis;
// 已注册内核 id 清单(运行时注册表顺序;替代 KERNEL_IDS 字面量数组,前端经 kernel.list IPC 拿)。
// 一次性问内核能力(从 registry 遍历 createOneshot;pi 有、dsh/minimal 无此面 → undefined)。
const kernelOneshots = surfaces.oneshots;
// 内置 skills 挂/摘 + 旧命名迁移：**逐个内核都要挂**（此前是 `skillsPlugins[0]`，取第一个支持该面的
// 内核——单实现时看不出问题，形状是"第一个赢、其余静默忽略"，与刚修掉的技能开关路由同一个坑）。
const ensureBundledSkills = (enabled: boolean): Promise<boolean> => ensureBundledSkillsOnAll(surfaces, enabled);
const migrateSkills = (): Promise<boolean> => migrateSkillsOnAll(surfaces);
// 壳插件生命周期钩子(从 registry 遍历 createLifecycle;pi 有 skillsEnsure/piExtensionEnsure,
// dsh/minimal 无)。onActivate/onDeactivate 返回 changed 供壳广播刷新。
const lifecycles = surfaces.lifecycles;
const pluginSkillsEnsure: NonNullable<PluginLifecycleDeps["skillsEnsure"]> = {
  async onActivate(pluginId, pluginPath, source) {
    for (const l of lifecycles) {
      const changed = await l.hook.skillsEnsure?.onActivate(pluginId, pluginPath, source);
      if (changed) broadcastSettingsChanged(gateway);
    }
  },
  async onDeactivate(pluginId, pluginPath, source) {
    for (const l of lifecycles) {
      const changed = await l.hook.skillsEnsure?.onDeactivate(pluginId, pluginPath, source);
      if (changed) broadcastSettingsChanged(gateway);
    }
  },
};
// 插件携带**内核扩展**的挂/摘（一个内核一份实现，壳按 manifest.extensions 的内核 id 派发）。
// 这里没有 `piExtensionEnsure` / `dshExtensionEnsure` 这种按内核命名的分支：加第四个内核 =
// 它自己的插件交一份 createPluginExtensionSync，本文件零改动（§1.3 契约单源 / §1.4 无特权差异）。
const pluginExtensionEnsure: NonNullable<PluginLifecycleDeps["pluginExtensionEnsure"]> = makeExtensionDispatch(surfaces);

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
const kernelExtensions: Record<KernelId, KernelExtensionSource> = surfaces.extensionSources;

// 技能聚合器:壳不读内核存储,只聚合各内核插件的 createSkillProvider(内核各自读自己的存储、回报)。
const skillAggregator = new SkillAggregator(
  surfaces.skillProviders,
);

const ctx: MainContext = {
  // 注册表派生的两条路径面（configFile 白名单前缀 / 技能清单监视文件）。
  kernelConfigRoots: surfaces.configRoots,
  kernelSkillWatchPaths: surfaces.skillWatchPaths,
  paths: {
    homeDir: HOME_DIR,
    myHarnessDesktopDir: MY_HARNESS_DESKTOP_DIR,
    configDir: CONFIG_DIR,
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
  ensureBundledSkills,
  pluginSkillsEnsure,
  pluginExtensionEnsure,
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
          const changed = await l.hook.skillsEnsure?.onActivate(id, plugin.path, plugin.source);
          if (changed) anyChanged = true;
        } catch (e) {
          // 点名到内核：钩子带内核归属后，失败源不再是一个匿名数组下标。
          console.error(`[plugin-skills] 内核 ${l.kernel} 的 ensure 失败 (${plugin.manifest.id}):`, e);
        }
      }
    }
    if (anyChanged) broadcastSettingsChanged(gateway);
  })().catch((e) => console.error("[plugin-skills] 启动同步失败:", e));

  // 插件携带**内核扩展**的启动同步：内核各自的适配扩展 + 非禁用壳插件的声明 + 摘除孤儿目录。
  // 放在任何内核 spawn 之前（内核的 loader 只在 spawn 时扫一次扩展目录；dsh 启动时读 cordis.yml 组合）。
  // 设计 docs/design/llm-recorder-design.md §5。**内核无关**：循环的是注册表，不是写死的 pi/dsh 两段。
  void (async () => {
    try {
      const disabled = (await configStore.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
      const active = new Set<string>();
      // ① 随壳分发的适配扩展：各内核自报（syncFit 自己解析资产路径，并回报它注册的 id）。
      for (const e of surfaces.extensionSyncs) {
        const fitId = e.sync.syncFit?.();
        if (fitId) active.add(fitId);
      }
      // ② 壳插件携带的扩展：读 manifest.extensions 的 {内核 id: 相对路径}，按 id 派发。
      //    传**原始插件目录 + 相对路径**（插件侧 onActivate 自会 join）——历史上误传
      //    resolve(plugin.path, rel) 再 join(rel) 造成路径双重拼接，扩展永远同步不上（勿回退）。
      for (const [id, plugin] of registry.allPlugins()) {
        const ext = plugin.manifest.extensions ?? {};
        if (disabled.includes(id) || Object.keys(ext).length === 0) continue;
        for (const [kernel, rel] of Object.entries(ext)) {
          pluginExtensionEnsure.onActivate(kernel, id, plugin.path, rel);
        }
        active.add(id);
      }
      // ③ 对账：各内核摘除自己目录下带 marker 但不在 active 的扩展（含历史遗留的几个）。
      for (const e of surfaces.extensionSyncs) e.sync.reconcile?.(active);
    } catch (e) {
      console.error("[plugin-extension] 启动同步失败:", e);
    }
  })().catch((e) => console.error("[dsh-extension] 启动同步失败:", e));

  // （随壳分发的适配扩展已由上面的「插件携带内核扩展的启动同步」统一装好：各内核自报 syncFit，
  //   壳不认内核名、不持内核专属资产路径。renderer 经 kernel.fitPiExtensionAvailable IPC 探测可用性。）
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
    surfaces.plugins.map((p) => ({ kernel: p.id, versionApi: p.createVersionApi() })),
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
      const r = importLegacySessions(surfaces.plugins, store);
      if (r.imported > 0) {
        console.log(`[legacy-import] 内核旧会话导入中立层: ${r.imported} 个(跳过 ${r.skipped},失败 ${r.failed}${r.failedKernels.length ? `,内核读取失败 ${r.failedKernels.join(",")}` : ""})`);
        broadcastRefreshRequested(gateway);
      }
    }
  } catch (e) {
    console.warn("[legacy-import] 启动导入失败(不阻断启动):", e);
  }

  return { ctx, sessionStore, gateway, localToken: auth.localToken, port: PORT };
}
