import { IPC } from "@my-harness-desktop/shared";
// 步骤 50：构造与接线 —— stores / gateway handler / SessionBus / restartCoordinator /
// PluginLifecycleDeps / KernelBootDeps / KernelRuntimeState / MainContext。
//
// 这一步**不映射 §1.1.2 的任何一个启动动作**：它收的是设计文档明确排除在"15 个动作"之外的
// "构造与接线"工作（今天的 `assemble.ts:221-336`、`358-427`、`429-455`）。
//
// **为什么 fatal**：它产出 `MainContext`——`assemble()` 的返回值来源。接线失败意味着壳没有
// 可用的运行期上下文，起不来是正确的。
//
// **一处有意的行为改善**（设计文档 §6.4.1 失败路径 ②）：`skillsEnsure` 的逐内核遍历补上了
// try/catch 与点名。今天冷启动那份循环有（`assemble.ts:492-496`：catch 里写
// `[plugin-skills] 内核 ${l.kernel} 的 ensure 失败 (${id})`），而暖启动走的闭包**没有**——
// 一个内核的技能钩子抛错会冒泡到 `lifecycle.activate` 的 catch，被记成"插件激活失败"并撤注册。
// 合一之后冷暖两侧共用这一份带隔离与点名的实现，那处漂移消失。
import type { BackendFactory, SessionCatalogFactory } from "@my-harness-desktop/shared";
import type { BootStep } from "../types";
import type { MainContext, Prefs } from "../../../application/context/main-context";
import type { PluginLifecycleDeps } from "../../../application/lifecycle";
import type { KernelBootDeps } from "../ops";
import { reconcileActiveSet } from "../ops";
import { reloadKernelPlugins } from "../kernel-reload";
import { reloadShellPlugins } from "../../../application/lifecycle/shell-reload";
import { SessionStore } from "../../../application/sessions/session-store";
import { NeutralSessionStore } from "../../../application/sessions/neutral-session-store";
import { PendingQuestionStore } from "../../../application/sessions/pending-question-store";
import { SessionBus } from "../../../application/sessions/session-bus";
import { RestartCoordinatorImpl } from "../../../application/restart/restart-coordinator";
import { SkillAggregator } from "../../../application/skills/skill-aggregator";
// i18n 派生的三个纯查询也从 merge 单源导入（不在步骤里重实现）。
import {
  collectNamespaces, collectSupportedLngs, collectLocaleList, mergeLanguageContributions,
} from "../../../application/i18n/merge";
import { initTranslator, DEFAULT_LOCALE } from "../../../application/i18n/translator";
import { ensureBundledSkillsOnAll, makeExtensionDispatch } from "../../kernel-surfaces";
import { broadcastSettingsChanged, broadcastRefreshRequested } from "../../../routing/broadcast";
import { notifyPluginsChanged, notifyPluginUnloaded } from "../../../routing/broadcast";
import { registerConfig } from "../../../controllers/config";
import { registerAppearance } from "../../../controllers/appearance";
import { registerSessions } from "../../../controllers/sessions";
import { registerFsGit } from "../../../controllers/fs-git";
import { registerSlotsDialog } from "../../../controllers/slots-dialog";
import { registerKernel } from "../../../controllers/kernel";
import { registerPlugins } from "../../../controllers/plugins";
import { registerSkills } from "../../../controllers/skills";
import { registerExtensions } from "../../../controllers/extensions";
import { registerBus } from "../../../controllers/bus";
import { registerWindow } from "../../../controllers/window";
import { registerAppInfo } from "../../../controllers/app-info";
import { registerNotification } from "../../../controllers/notification";
import { join } from "node:path";

const step: BootStep = {
  id: "50-wiring",
  scope: "global",
  failure: "fatal",
  requires: ["40-shell-plugins"],
  run(ctx) {
    const { paths, gateway, host, prefsStore, lateRefs } = ctx;
    const registry = ctx.registry!;
    const configStore = ctx.configStore!;
    const surfaces = ctx.surfaces!;
    const kernelRegistry = ctx.kernelRegistry!;
    const { modelCatalog, ids: kernelIds } = surfaces;

    // ---- 后端与目录工厂（依赖倒置：按 kernel 查插件，壳不 import 任何具体内核）----
    const baseBackendFactory: BackendFactory = {
      create: (opts) => {
        const plugin = kernelRegistry.get(opts.kernel);
        // 文案要**可行动**（勿退回成裸的「未注册的内核: X」）：这句话会经 RPC 冒到用户面前，
        // 而用户唯一能做的是"启用这个内核"。怎么启用是 bootstrap 自己知道的事
        // （§1.2 机制与内容分离：内核清单由插件声明决定，这里只解释"为什么不在清单里"），
        // 不推给 application 去猜。
        if (!plugin) throw new Error(
          `内核 "${opts.kernel}" 当前未装载,无法起会话进程(该内核可能默认关闭、未安装,或插件未启用;`
          + `临时启用可用 MHD_ENABLE_KERNELS=${opts.kernel} 启动)`,
        );
        return plugin.createBackend(opts);
      },
      // 预 seed（§4.5 生命周期不对称）：文件态内核 = 纯文件写，先 seed 得路径再以该路径 spawn；
      // RPC 内核返回 null，走 create → start → backend.seed。缺面（无 seed）同样返回 null。
      seed: async (lineage, opts) => kernelRegistry.get(opts.kernel)?.seed?.(lineage, opts) ?? null,
    };
    const sessionCatalogFactory: SessionCatalogFactory = {
      create: (kernel) => {
        const plugin = kernelRegistry.get(kernel);
        if (!plugin) throw new Error(`未注册的内核: ${kernel}`);
        return plugin.createCatalog();
      },
    };

    // ---- 会话核心 ----
    const sessionStore = new SessionStore(
      baseBackendFactory,
      sessionCatalogFactory,
      // 注册表派生的内核事实（会话根 / 已注册清单）——同源，打成**一个 getter**（§3.6.3）。
      // 与 ModelCatalog / SkillAggregator 同款理由：SessionStore 是长期持有的实例，
      // 构造期传数组/对象的话，重载替换 surfaces 之后它读到的仍是旧事实
      // （症状：新内核的会话根不进路径圈禁白名单、旧内核的 id 仍被当作"已知内核"）。
      // **没有"默认内核"**：内核是模型的派生量，缺内核处显式报错（设计原则 22）。
      () => ({
        sessionRoots: ctx.kernelState!.surfaces.sessionRoots,
        ids: ctx.kernelState!.accessors.kernelIds(),
      }),
      () => registry.systemPromptPaths(),
      new NeutralSessionStore(join(paths.dataRoot, "sessions")),
      modelCatalog,
      // 收藏快照目录（项目级，跟随 cwd）：快照是中立物化前缀，存 <cwd>/.my-harness-desktop/bookmarks/。
      (cwd) => join(cwd, ".my-harness-desktop", "bookmarks"),
      // 挂起提问请求单（ask-design §4.3）：壳持有的持久存储，进程生死不影响其存续。
      new PendingQuestionStore(join(paths.dataRoot, "pending-questions")),
    );
    sessionStore.onEvent((event) => { gateway.broadcast(IPC.session.event, event); });
    sessionStore.onKernelEvent((event) => { gateway.broadcast(IPC.session.kernelEvent, event); });
    sessionStore.onQuestion((req) => { gateway.broadcast(IPC.session.question, req); });
    sessionStore.onSnapshot((snapshot) => { gateway.broadcast(IPC.session.snapshot, snapshot); });
    // 中立层变更通知 → WS 扇出（session-single-source §3.2：写穿回执，渲染层镜像的数据源）。
    sessionStore.onNeutralChange((change) => { gateway.broadcast(IPC.session.neutralChange, change); });

    const restartCoordinator = new RestartCoordinatorImpl(sessionStore);
    restartCoordinator.onStateChange((sessionKey, state) => {
      gateway.broadcast(IPC.restart.state, sessionKey, state);
    });

    // ---- 延迟引用绑定（本步骤是**唯一**绑定点；见 ../late-refs.ts）----
    lateRefs.bind({ sessionStore, restartCoordinator });

    // ---- 内核侧操作的依赖 + 运行期可变状态 ----
    const extensionActiveIds = new Set<string>();
    const kernelBootDeps: KernelBootDeps = {
      // getter：暖重载会整体替换 surfaces，持值会 stale。
      surfaces: () => ctx.kernelState!.surfaces,
      bundledSkillsEnabled: () => prefsStore.get("bundledSkillsEnabled"),
      extensionActiveIds,
      reconcileActive: () => reconcileActiveSet(extensionActiveIds, registry),
      notifySettingsChanged: () => broadcastSettingsChanged(gateway),
      // 内核清单变了 → 广播中性刷新信号（renderer 据此重拉 kernelIds，§3.6.4）。
      // 同样走 broadcast 层的具名助手，不在这里拼 channel 字面量。
      notifyKernelsChanged: () => broadcastRefreshRequested(gateway),
      injectQuestion: (req) => sessionStore.injectQuestion(req),
    };
    // accessors：注册表派生面的活访问器（§3.6.3）。绑的是 **registry 本身**（不是 surfaces 快照），
    // 所以它天然随注册表变化而新鲜；重载时替换 surfaces 之后要调 `accessors.bump()` 作废实例缓存。
    ctx.kernelState = {
      registry: kernelRegistry,
      surfaces,
      bootDeps: kernelBootDeps,
      // accessors 与 loader 都由 10-kernel-plugins 创建（accessors 与注册表同批诞生是因为
      // memo 缓存只能有一份；loader 是暖重载要复用的扫描+装载能力）。这里只是挂进状态。
      accessors: ctx.kernelAccessors!,
      loader: ctx.kernelLoader!,
    };
    ctx.kernelBootDeps = kernelBootDeps;
    ctx.extensionActiveIds = extensionActiveIds;

    // ---- 内置技能：逐内核遍历 + 逐内核隔离与点名（冷暖共用这一份）----
    const skillsEnsure: NonNullable<PluginLifecycleDeps["skillsEnsure"]> = {
      async onActivate(pluginId, pluginPath, source) {
        for (const l of surfaces.lifecycles) {
          try {
            const changed = await l.hook.skillsEnsure?.onActivate(pluginId, pluginPath, source);
            if (changed) broadcastSettingsChanged(gateway);
          } catch (e) {
            // 点名到内核 + 插件：一个内核的钩子抛错不该连累其余内核，也不该被记成
            // "插件激活失败"（那会让整个插件被撤注册）。
            console.error(`[plugin-skills] 内核 ${l.kernel} 的 ensure 失败 (${pluginId}):`, e);
          }
        }
      },
      async onDeactivate(pluginId, pluginPath, source) {
        for (const l of surfaces.lifecycles) {
          try {
            const changed = await l.hook.skillsEnsure?.onDeactivate(pluginId, pluginPath, source);
            if (changed) broadcastSettingsChanged(gateway);
          } catch (e) {
            console.error(`[plugin-skills] 内核 ${l.kernel} 的 unensure 失败 (${pluginId}):`, e);
          }
        }
      },
    };
    // 插件携带**内核扩展**的挂摘（一个内核一份实现，按 manifest.extensions 的内核 id 派发）。
    // 没有 `piExtensionEnsure` / `dshExtensionEnsure` 这种按内核命名的分支：加第四个内核 =
    // 它自己的插件交一份 createPluginExtensionSync，本文件零改动。
    const pluginExtensionEnsure = makeExtensionDispatch(surfaces);

    // main 侧 pluginLoader 是 no-op：插件 renderer 由 renderer 侧 plugins-host 经 import.meta.glob
    // 统一加载（无 if-builtin 分支），main 只管注册 + 通知。main 是 CJS，import React ESM chunk
    // 会失败，所以这里绝不能"顺手"去 load renderer chunk。
    const lifecycleDeps: PluginLifecycleDeps = {
      registry,
      configStore,
      loader: {
        async load() { /* no-op，理由见上 */ },
        unload() { /* no-op */ },
      },
      notifyPluginsChanged: () => notifyPluginsChanged(gateway),
      notifyPluginUnloaded: (pluginId, components) => notifyPluginUnloaded(gateway, pluginId, components),
      skillsEnsure,
      pluginExtensionEnsure,
    };
    ctx.lifecycleDeps = lifecycleDeps;

    // ---- Session Bus 路由器：进线三路（上行帧/事件流/进程退出），出线两条（会话 stdin/renderer 广播）----
    const sessionBus = new SessionBus(sessionStore, {
      broadcast: (message) => { gateway.broadcast(IPC.bus.event, message); },
    });
    sessionStore.onAnySessionEvent((event, sessionKey) => sessionBus.onSessionEvent(event, sessionKey));
    sessionStore.onBusFrame((frame, sessionKey) => {
      void sessionBus.handleFrame(sessionKey, frame).catch((err) => console.error("[session-bus] 上行帧处理失败:", err));
    });
    sessionStore.onKernelEvent((event) => {
      if (event.kind === "processExit") sessionBus.onProcessExit(event.sessionKey, event.expected);
    });
    ctx.sessionBus = sessionBus;
    ctx.restartCoordinator = restartCoordinator;
    ctx.sessionStore = sessionStore;

    // ---- 技能聚合器：壳不读内核存储，只聚合各内核插件的 createSkillProvider ----
    // ⚠ getter 里读 `ctx.kernelState!.surfaces`（**当前**的 surfaces），不是本步骤局部捕获的
    //   `surfaces` 常量——后者是构造这一刻的快照，重载替换 state.surfaces 之后不会追溯更新，
    //   于是新内核的技能永远进不了聚合（延迟求值 ≠ 活，与 ModelCatalog 同款陷阱）。
    const skillAggregator = new SkillAggregator(() => ctx.kernelState!.surfaces.skillProviders);

    // ---- MainContext ----
    const i18nResources = ctx.i18nResources!;

    // ---- 服务端 i18n 单例接线（r78）----
    // `application/i18n/translator.ts` 按 docs/plugins/05-plugin-i18n §6.2「main 端持单例(init 一次)」
    // 实现好了 `initTranslator` / `t` / `changeLocale` / `currentLocale`，但 **initTranslator 此前
    // 零调用点** ⇒ 单例从未初始化 ⇒ `t()` 恒走 `if (!initialized) return key` 的退化路径，
    // 于是服务端所有面向用户的错误消息只能写死中文（英文界面里冒出中文）。
    // 这与 r72 删掉的死契约成员同类、方向相反：那次是"契约有面没人调"，这次是"机制齐全没人启动"。
    // 接线依据：§1.2 文案归语言插件——这里查的仍是**插件贡献的语言包**（i18nResources 来自
    // mergeLanguageContributions），服务端不持有文案，只按当前 locale 查表。
    void initTranslator({
      resources: i18nResources,
      lng: prefsStore.get("currentLocale") || DEFAULT_LOCALE,
      ns: collectNamespaces(i18nResources),
      supportedLngs: collectSupportedLngs(registry.languageContributions()),
    });
    const mainContext: MainContext = {
      // 注册表派生的两条路径面（configFile 白名单前缀 / 技能清单监视文件）。
      // 注册表派生面**全部委托给活访问器**（§3.6.3），不再喂构造期快照。
      // 惰性读 `ctx.kernelState!.accessors`（与下面 ensureBundledSkills 同款写法）：
      // 访问器绑的是 registry 本身，所以每次调用都新鲜；重载后调 bump() 作废实例缓存即可。
      kernelConfigRoots: () => ctx.kernelState!.accessors.kernelConfigRoots(),
      kernelSkillWatchPaths: surfaces.skillWatchPaths,
      paths: {
        homeDir: paths.homeDir,
        myHarnessDesktopDir: paths.dataRoot,
        configDir: paths.configDir,
        generalConfigPath: paths.generalConfigPath,
        bundledSkillsDir: paths.bundledSkillsDir,
        bundledSkillsSource: paths.bundledSkillsSource,
        builtinDir: paths.builtinPluginsDir,
        userPluginsDir: paths.userPluginsDir,
        projectPluginsDir: paths.projectPluginsDir,
        installedDir: paths.installedPluginsDir,
      },
      prefsStore,
      configStore,
      modelCatalog,
      kernelModels: (kernel) => ctx.kernelState!.accessors.kernelModels(kernel),
      kernelConfig: (kernel) => ctx.kernelState!.accessors.kernelConfig(kernel),
      registry,
      skillAggregator,
      sessionStore,
      sessionBus,
      restartCoordinator,
      kernelExtensionSource: (kernel) => ctx.kernelState!.accessors.kernelExtensionSource(kernel),
      kernelLogo: (kernel) => ctx.kernelState!.accessors.kernelLogo(kernel),
      kernelVersionApi: (kernel) => ctx.kernelState!.accessors.kernelVersionApi(kernel),
      kernelIds: () => ctx.kernelState!.accessors.kernelIds(),
      kernelOneshot: (kernel) => ctx.kernelState!.accessors.kernelOneshot(kernel),
      // 差量重载：绑到 kernelState（暖路径唯一能用的状态对象，BootContext 冷启动即弃）。
      // 「重载内核插件」= **两侧都要收敛**，顺序有依据：
      //   ① 先内核注册表（差量重载、重跑变动内核的工厂、重建投影面、bump 访问器缓存）；
      //   ② 再壳插件注册表（差量重扫四根目录）。
      // 顺序不能反：壳侧的过滤判据 `isKernelLoadable` 要查**内核注册表**
      // （与 `40-shell-plugins` 冷启动的同名判据同源——「内核面未装载的内核插件不注册，
      // 没有内核却显示它的设置页只会得到一堆报错」）。先扫壳侧就会按旧的内核清单过滤，
      // 于是"刚装上的内核"的设置页 TAB 仍然不出现、"刚删掉的内核"的 TAB 仍然留着。
      reloadKernelPlugins: async () => {
        const kernels = await reloadKernelPlugins(ctx.kernelState!);
        const kernelRegistry = ctx.kernelState!.registry;
        const shell = await reloadShellPlugins(
          lifecycleDeps,
          {
            builtin: paths.builtinPluginsDir,
            installed: paths.installedPluginsDir,
            user: paths.userPluginsDir,
            project: paths.projectPluginsDir,
          },
          // 判据从注册表现算（注册表是单源，重算比传状态更不容易漂）
          (id, hasKernelBlock) => !hasKernelBlock || kernelRegistry.has(id as never),
        );
        return { kernels, shell, changed: kernels.changed || shell.changed };
      },
      // 内置技能挂摘：经 kernelState 取**活** surfaces，暖重载后自动指向新投影面。
      ensureBundledSkills: (enabled: boolean) => ensureBundledSkillsOnAll(ctx.kernelState!.surfaces, enabled),
      lifecycleDeps,
      i18n: {
        resources: i18nResources,
        namespaces: collectNamespaces(i18nResources),
        supportedLngs: collectSupportedLngs(registry.languageContributions()),
        localeList: collectLocaleList(collectSupportedLngs(registry.languageContributions()), i18nResources),
      },
    };
    ctx.mainContext = mainContext;

    // ---- handler 域注册（14 个，与 src/server/controllers/ 下 14 个非测试文件一一对应）----
    // registerRemote **不在这里**：它的 rebind 与 deviceManager 依赖 transport 起来之后的句柄，
    // 归 90-transport（§4.1 第 12 行本就把"远程绑定与热重绑闭包"划给该步骤）。
    registerConfig(gateway, mainContext);
    registerAppearance(gateway, mainContext, host);
    registerSessions(gateway, mainContext);
    registerBus(gateway, mainContext);
    registerFsGit(gateway, mainContext);
    registerSlotsDialog(gateway, mainContext);
    registerKernel(gateway, mainContext);
    registerPlugins(gateway, mainContext);
    registerSkills(gateway, mainContext);
    registerExtensions(gateway, mainContext);
    registerWindow(gateway);
    registerAppInfo(gateway);
    registerNotification(gateway);
  },
};

export default step;
