// Electron main 进程入口 —— 组装根:读环境、建依赖、注入 MainContext、注册全部 IPC、管窗口生命周期。
// 机制只组装不实现:IPC handler 在 api/ipc/*,外部资源驱动在 client/*,用例编排在 core/application。
import { app, BrowserWindow, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import Store from "electron-store";
import { ConfigStore } from "../core/application/config/config-store";
import { PiSettingsStore } from "../core/application/pi-settings/pi-settings-store";
import { ModelsStore } from "../core/application/models/models-store";
import { ModelCatalog } from "../core/application/models/model-catalog";
import { DshModelSource } from "../client/dsh/dsh-model-source";
import { discoverPlugins } from "../core/application/loader/discover";
import { PluginRegistry } from "../core/application/loader/registry";
import {
  mergeLanguageContributions,
  collectNamespaces,
  collectSupportedLngs,
  collectLocaleList,
} from "../core/application/i18n/merge";
import { SessionStore, type BaseBackendFactory } from "../core/application/sessions/session-store";
import { createPiBackend, createDshBackend } from "../core/application/sessions/backend-factories";
import { ensureBundledSkillsEntry, mirrorBundledSkills, ensurePluginSkillsEntry } from "../core/application/skills/bundled-skills";
import { mirrorManagedDir } from "../core/application/bundled/mirror";
import { initKernelRuntime, resolveCustomCli } from "../core/application/kernel/kernel-manager";
import { ExtensionStore } from "../core/application/extensions/extension-store";
import { RestartCoordinatorImpl } from "../core/application/restart/restart-coordinator";
import { createNpmKernelRuntime } from "../client/npm/kernel-runtime";
import { DEFAULT_PREFS, type MainContext, type Prefs } from "../api/ipc/main-context";
import { broadcastSettingsChanged } from "../api/ipc/broadcast";
import { registerConfigIpc } from "../api/ipc/config";
import { registerAppearanceIpc } from "../api/ipc/appearance";
import { registerSessionsIpc } from "../api/ipc/sessions";
import { registerFsGitIpc } from "../api/ipc/fs-git";
import { registerSlotsDialogIpc } from "../api/ipc/slots-dialog";
import { registerKernelIpc } from "../api/ipc/kernel";
import { registerPluginsIpc } from "../api/ipc/plugins";
import { registerSkillsIpc } from "../api/ipc/skills";
import { registerExtensionsIpc } from "../api/ipc/extensions";
import { registerBusIpc } from "../api/ipc/bus";
import { registerWindowIpc, attachWindowStateSync } from "../api/ipc/window";
import { registerAppInfoIpc } from "../api/ipc/app-info";
import { installToolGate } from "../client/pi/toolgate-installer";
import { installContextProbe } from "../client/pi/context-probe-installer";
import { installBusExtension } from "../client/pi/bus-extension-installer";
import { installSubagentExtension } from "../client/pi/subagent-extension-installer";
import { reconcilePluginPiExtensions, syncPluginPiExtension } from "../client/pi/pi-extension-installer";
import { SessionBus } from "../core/application/sessions/session-bus";
import { resolvePiDesktopDir } from "../client/paths";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 路径:main 进程唯一读环境的点,经 MainContext 注入给 ipc 层 ----
// PI_DESKTOP_DIR 单源在 client/paths(打包态 ~/.pi-desktop,dev 态 ~/.pi-desktop-dev 分流)。
const HOME_DIR = homedir();
const PI_DESKTOP_DIR = resolvePiDesktopDir();
const CONFIG_DIR = join(PI_DESKTOP_DIR, "config");
const PI_INSTALL_DIR = join(PI_DESKTOP_DIR, "pi");
// dsh 内核 npm 安装目录(~/.pi-desktop/dsh);dsh 原生配置(cordis.yml/settings.yaml)在 ~/.dsh。
const DSH_INSTALL_DIR = join(PI_DESKTOP_DIR, "dsh");
const GENERAL_CONFIG_PATH = join(CONFIG_DIR, "general.json");
// pi 底座配置目录(~/.pi/agent,底座标准,非 ~/.pi-desktop)。pi-settings 插件读写它。
const PI_AGENT_DIR = join(HOME_DIR, ".pi", "agent");

// 桌面偏好走 electron-store,显式 cwd 纳入数据根 config 树(跨重启持久,与插件配置同根)
const prefsStore = new Store<Prefs>({ defaults: DEFAULT_PREFS, cwd: CONFIG_DIR });

initKernelRuntime(createNpmKernelRuntime());

const piSettingsStore = new PiSettingsStore({ agentDir: PI_AGENT_DIR });
const modelsStore = new ModelsStore({ agentDir: PI_AGENT_DIR });
// dsh 原生模型配置(cordis.yml):路径取 DSH_CORDIS_CONFIG(harness 约定),未设回落 ~/.dsh/cordis.yml。
// 读不到 → 空清单(dsh 未配置是显式态,§6.2),不炸应用。
const dshModelSource = new DshModelSource(process.env.DSH_CORDIS_CONFIG ?? join(HOME_DIR, ".dsh", "cordis.yml"));
const modelCatalog = new ModelCatalog(modelsStore, dshModelSource);

// ---- 加载器:发现 builtin/installed/user/project 四目录插件,按优先级注册(低到高) ----
// 开发期扫 src/plugins;打包后扫 process.resourcesPath/pi-desktop-builtin。
// 内置插件与第三方插件平等:同一 discoverPlugins,无 if(builtin) 分支(01-core:1447)。
// dev: __dirname=out/main,src/plugins 在 ../../src/plugins(项目根/src/plugins)
// pkg: __dirname=resources/app.asar/...,插件随壳分发在 resources/pi-desktop-builtin/
const builtinDir = app.isPackaged
  ? join(process.resourcesPath, "pi-desktop-builtin")
  : resolve(__dirname, "../../src/plugins");
const userPluginsDir = join(PI_DESKTOP_DIR, "plugins");
// 内置 skills:仓库顶级 .claude/skills/ 随壳分发(pkg 拷贝到 resources/pi-desktop-skills,
// 与 pi-desktop-builtin 同批),启动时镜像到 ~/.pi-desktop/skills(强制覆盖,受管目录)
const BUNDLED_SKILLS_DIR = join(PI_DESKTOP_DIR, "skills");
const bundledSkillsSource = app.isPackaged
  ? join(process.resourcesPath, "pi-desktop-skills")
  : resolve(__dirname, "../../.claude/skills");
// 内置表情包:assets/stickers/ 随壳分发(pkg 拷贝到 resources/pi-desktop-stickers),
// 启动时镜像到数据根 ~/.pi-desktop/stickers/bundled/(强制覆盖,受管目录)。
// stickers 插件按只读 builtin 层读它——纯 UI 内容,不进模型上下文,无 ensure* 开关。
const BUNDLED_STICKERS_DIR = join(PI_DESKTOP_DIR, "stickers", "bundled");
const bundledStickersSource = app.isPackaged
  ? join(process.resourcesPath, "pi-desktop-stickers")
  : resolve(__dirname, "../../assets/stickers");
// ⚠ project 级 plugins 目录:桌面应用打包后 process.cwd() 通常是家目录,无"当前项目"
// 概念(M8)——此目录在打包态降级为"另一个用户级",留待"打开项目"功能接(演进)。
const projectPluginsDir = join(process.cwd(), ".pi-desktop", "plugins");
const installedDir = join(PI_DESKTOP_DIR, "installed");
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
// 依赖倒置:BaseBackendFactory 由 application 拥有、shell 注入(createPiBackend 产 pi 后端,
// createDshBackend 产 dsh 后端),SessionStore 不 new client 具体类、不感知 spawn。
// kernel 缺省 "pi"(迁移期兼容);"dsh" 走 createDshBackend(provider/model 有兜底默认)。
const baseBackendFactory: BaseBackendFactory = {
  create: (opts) => opts.kernel === "dsh" ? createDshBackend(opts) : createPiBackend(opts),
};
// 自定义底座指针(docs/design/custom-cli-path.md §2.4):读 prefs + resolveCustomCli 归一化,
// 组装一次单源——SessionStore(spawn 链)与 kernel IPC(oneshot)共用;未设置/失效返回
// undefined,spawn 回落数据根 > PATH(与 kernelStatus 状态标注同一判定函数,行为一致)。
const customCliPath = (): string | undefined => {
  const dir = prefsStore.get("customCliDir");
  if (!dir) return undefined;
  return resolveCustomCli(dir)?.cliJs;
};
const sessionStore = new SessionStore(
  baseBackendFactory,
  PI_AGENT_DIR,
  () => registry.systemPromptPaths(),
  customCliPath,
);
sessionStore.onEvent((event) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("session:event", event);
});
sessionStore.onKernelEvent((event) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("session:kernelEvent", event);
});
sessionStore.onExtensionUI((req) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("session:extensionUI", req);
});
sessionStore.onSnapshot((snapshot) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("session:snapshot", snapshot);
});

// 统一项目级配置通道(unified-project-config.md):全局层 ~/.pi-desktop/config/,
// 项目级经 getProjectDir 动态解析当前项目(sessionStore.getActiveCwd 是 main 侧 cwd 事实源)。
const configStore = new ConfigStore({
  userDir: CONFIG_DIR,
  getProjectDir: () => {
    const cwd = sessionStore.getActiveCwd();
    return cwd ? join(cwd, ".pi-desktop", "config") : null;
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
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("bus:event", message);
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
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("restart:state", sessionKey, state);
});
const extensionStore = new ExtensionStore({
  agentDir: PI_AGENT_DIR,
  piSettings: piSettingsStore,
  onConfigChanged: (reason) => {
    const keys = sessionStore.getRunningSessionKeys();
    restartCoordinator.markPendingAll(keys, reason);
  },
});

const ctx: MainContext = {
  paths: {
    homeDir: HOME_DIR,
    piDesktopDir: PI_DESKTOP_DIR,
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
  piSettingsStore,
  modelsStore,
  modelCatalog,
  dshModelSource,
  registry,
  sessionStore,
  sessionBus,
  restartCoordinator,
  extensionStore,
  i18n: {
    resources: i18nResources,
    namespaces: collectNamespaces(i18nResources),
    supportedLngs: collectSupportedLngs(languageContributions),
    localeList: collectLocaleList(collectSupportedLngs(languageContributions), i18nResources),
  },
};

registerConfigIpc(ctx);
registerAppearanceIpc(ctx);
registerSessionsIpc(ctx);
registerBusIpc(ctx);
registerFsGitIpc(ctx);
registerSlotsDialogIpc(ctx);
registerKernelIpc(ctx);
registerPluginsIpc(ctx);
registerSkillsIpc(ctx);
registerExtensionsIpc(ctx);
registerWindowIpc();
registerAppInfoIpc();

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    // 无边框窗口(renderer 顶栏 -webkit-app-region: drag):mac 红绿灯内嵌自定义标题栏;
    // win/linux 无原生按钮,标题栏自绘 min/max/close(经 window:* IPC,见 api/ipc/window)。
    ...(process.platform === "darwin"
      // trafficLightPosition 定位的是按钮容器原点,容器带 2px 内衬,实测圆心 = y + 8;
      // 垂直居中:y = 标题栏 40px / 2 − 8 = 12(像素截图实测验证,勿按 y+6 目测微调)
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 12 } }
      : { frame: false as const, autoHideMenuBar: true }),
    backgroundColor: "#0b0b0c",
    icon: resolve(__dirname, "../../assets/icons/icon.png"),
    webPreferences: {
      preload: resolve(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachWindowStateSync(win);

  // 外部链接一律交给系统,不在应用内开新窗口/导航(桌面壳标准做法):
  // window.open / target=_blank 经 setWindowOpenHandler 拦截——http(s) 用默认浏览器,
  // file: 本地文件用系统关联程序;renderer 内跨源导航(链接点击)经 will-navigate 拦截,
  // 防应用自身页面被替换成外部页面。markdown 等渲染的 <a target="_blank"> 由此统一生效。
  win.webContents.setWindowOpenHandler(({ url }) => {
    void (url.startsWith("file:") ? shell.openPath(url) : shell.openExternal(url));
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const current = win.webContents.getURL();
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === new URL(current).origin;
    } catch { /* 解析失败的导航一律视为外部 */ }
    if (sameOrigin) return; // 应用自身页面内导航(hash/刷新)放行
    event.preventDefault();
    void (url.startsWith("file:") ? shell.openPath(url) : shell.openExternal(url));
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(resolve(__dirname, "../renderer/index.html"));
  }

  win.on("ready-to-show", () => win.show());
}

app.setName("π Desktop");

app.whenReady().then(() => {
  // dock 图标尽早设置:createWindow 使进程进入 dock,若 bundle 图标未生效
  // (LaunchServices 缓存陈旧),此处晚于 createWindow 会闪现默认图标。
  // bundle 修复见 assets/scripts/patch-electron.cjs(改 icns 后 touch + lsregister)。
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(resolve(__dirname, "../../assets/icons/icon.png"));
  }

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
  // 放在启动序列而非等 IPC:"用 pi-desktop 就有"不依赖用户先打开设置页。
  mirrorBundledSkills(bundledSkillsSource, BUNDLED_SKILLS_DIR);
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

  // 插件携带底座扩展(piExtension)的启动同步:同步非禁用插件的声明 + 摘除孤儿目录。
  // 放在任何 pi spawn 之前(toolgate 同约束:底座 loader 只在 spawn 时扫一次扩展目录)。
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

  // tool-gate 底座扩展同步:任何 pi 会话进程 spawn 之前装好,renderer 经 kernel.toolgateAvailable IPC 探测可用性。
  installToolGate();
  // context-probe 底座扩展同步:同一交付通道;请求侧实测上下文用量,先于任何 pi spawn。
  installContextProbe();
  // bus-extension 底座扩展同步:与 tool-gate 同一交付通道,先于任何 pi spawn。
  installBusExtension();
  // subagent-extension 底座扩展同步:同一交付通道(agent 侧 spawn 系 tool 的注册源)。
  installSubagentExtension();

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 应用退出:停所有会话的 pi 进程(多会话多进程,兜底清理)。
// before-quit 是同步事件:preventDefault 阻断退出,等 stopAll(含 kill 链 stdin→SIGTERM→SIGKILL)
// 真正完成再 exit——否则子进程变孤儿(主进程已死,pi 被 init 收养不退出)。
app.on("before-quit", (event) => {
  event.preventDefault();
  void sessionStore.stopAll().finally(() => app.exit());
});
