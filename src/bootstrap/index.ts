// Electron main 进程入口 —— 组装根:读环境、建依赖、注入 MainContext、注册全部 IPC、管窗口生命周期。
// 机制只组装不实现:IPC handler 在 api/ipc/*,外部资源驱动在 client/*,用例编排在 core/application。
import { app, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import Store from "electron-store";
import { ConfigStore } from "../core/application/config/config-store";
import { PiSettingsStore } from "../core/application/pi-settings/pi-settings-store";
import { ModelsStore } from "../core/application/models/models-store";
import { discoverPlugins } from "../core/application/loader/discover";
import { PluginRegistry } from "../core/application/loader/registry";
import {
  mergeLanguageContributions,
  collectNamespaces,
  collectSupportedLngs,
  collectLocaleList,
} from "../core/application/i18n/merge";
import { SessionStore, type RpcAdapterFactory } from "../core/application/sessions/session-store";
import { ensureBundledSkillsEntry, mirrorBundledSkills } from "../core/application/skills/bundled-skills";
import { mirrorBundledClaude } from "../core/application/skills/bundled-claude";
import { initKernelRuntime } from "../core/application/kernel/kernel-manager";
import { ExtensionStore } from "../core/application/extensions/extension-store";
import { RestartCoordinatorImpl } from "../core/application/restart/restart-coordinator";
import { RpcAdapter } from "../client/pi/rpc-adapter";
import { createPiSubprocess } from "../client/pi/subprocess-lifecycle";
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
import { installToolGate } from "../client/pi/toolgate-installer";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 路径:main 进程唯一读环境的点,经 MainContext 注入给 ipc 层 ----
const HOME_DIR = homedir();
const PI_DESKTOP_DIR = join(HOME_DIR, ".pi-desktop");
const CONFIG_DIR = join(PI_DESKTOP_DIR, "config");
const PLUGINS_DATA_DIR = join(CONFIG_DIR, "plugins-data");
const PI_INSTALL_DIR = join(PI_DESKTOP_DIR, "pi");
const GENERAL_CONFIG_PATH = join(CONFIG_DIR, "general.json");
// pi 底座配置目录(~/.pi/agent,底座标准,非 ~/.pi-desktop)。pi-settings 插件读写它。
const PI_AGENT_DIR = join(HOME_DIR, ".pi", "agent");

// 桌面偏好走 electron-store,显式 cwd 纳入 ~/.pi-desktop/config 树(跨重启持久,与插件配置同根)
const prefsStore = new Store<Prefs>({ defaults: DEFAULT_PREFS, cwd: join(HOME_DIR, ".pi-desktop", "config") });

initKernelRuntime(createNpmKernelRuntime());

const piSettingsStore = new PiSettingsStore({ agentDir: PI_AGENT_DIR });
const modelsStore = new ModelsStore({ agentDir: PI_AGENT_DIR });
const configStore = new ConfigStore({
  userDir: PLUGINS_DATA_DIR,
  // 项目级 config 本次不接(M7):桌面应用无"当前项目"概念,project 级 config
  // 路径待"打开项目"功能落地后按真实项目 cwd 注入(同 projectPluginsDir 的演进)。
  projectDir: null,
});

// ---- 加载器:发现 builtin/installed/user/project 四目录插件,按优先级注册(低到高) ----
// 开发期扫 src/plugins;打包后扫 process.resourcesPath/pi-desktop-builtin。
// 内置插件与第三方插件平等:同一 discoverPlugins,无 if(builtin) 分支(01-core:1447)。
// dev: __dirname=out/main,src/plugins 在 ../../src/plugins(项目根/src/plugins)
// pkg: __dirname=resources/app.asar/...,插件随壳分发在 resources/pi-desktop-builtin/
const builtinDir = app.isPackaged
  ? join(process.resourcesPath, "pi-desktop-builtin")
  : resolve(__dirname, "../../src/plugins");
const userPluginsDir = join(PI_DESKTOP_DIR, "plugins");
// 内置 skills:assets/skills/ 随壳分发(pkg 拷贝到 resources/pi-desktop-skills,
// 与 pi-desktop-builtin 同批),启动时镜像到 ~/.pi-desktop/skills(强制覆盖,受管目录)
const BUNDLED_SKILLS_DIR = join(PI_DESKTOP_DIR, "skills");
const bundledSkillsSource = app.isPackaged
  ? join(process.resourcesPath, "pi-desktop-skills")
  : resolve(__dirname, "../../assets/skills");
// 内置工程原则 prompt:仓库顶级 assets/CLAUDE.md 随壳分发(pkg 拷贝路径待 extraResources
// 配置落地,与 skills 同一缺口),启动时镜像到 ~/.pi-desktop/claude.md(受管副本)。
const BUNDLED_CLAUDE_PATH = join(PI_DESKTOP_DIR, "claude.md");
const bundledClaudeSource = app.isPackaged
  ? join(process.resourcesPath, "pi-desktop-assets", "CLAUDE.md")
  : resolve(__dirname, "../../assets/CLAUDE.md");
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
// 依赖倒置:RpcAdapterFactory 由 client 实现(createPiSubprocess spawn → 绑 RpcAdapter),
// 注入给 application 的 SessionStore;application 不 new client 具体类、不感知 spawn。
const rpcAdapterFactory: RpcAdapterFactory = {
  create: (opts) => new RpcAdapter(createPiSubprocess(opts)),
};
const sessionStore = new SessionStore(
  rpcAdapterFactory,
  PI_AGENT_DIR,
  () => (prefsStore.get("bundledClaudePromptEnabled") ? BUNDLED_CLAUDE_PATH : null),
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
    pluginsDataDir: PLUGINS_DATA_DIR,
    piInstallDir: PI_INSTALL_DIR,
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
  piSettingsStore,
  modelsStore,
  registry,
  sessionStore,
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
registerFsGitIpc(ctx);
registerSlotsDialogIpc(ctx);
registerKernelIpc(ctx);
registerPluginsIpc(ctx);
registerSkillsIpc(ctx);
registerExtensionsIpc(ctx);

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    // 无边框窗口:红绿灯内嵌自定义标题栏(renderer 顶栏 -webkit-app-region: drag)
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 15 },
    backgroundColor: "#0b0b0c",
    icon: resolve(__dirname, "../../assets/icons/icon.png"),
    webPreferences: {
      preload: resolve(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
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
    writeFileSync(GENERAL_CONFIG_PATH, JSON.stringify({ defaultThinkingLevel: "high", sidebarDefaultOpen: false }, null, 2), "utf-8");
  }

  // 内置 skills 启动同步:镜像文件(强制覆盖)+ 按偏好挂/摘 settings 条目。
  // 放在启动序列而非等 IPC:"用 pi-desktop 就有"不依赖用户先打开设置页。
  mirrorBundledSkills(bundledSkillsSource, BUNDLED_SKILLS_DIR);
  // 内置工程原则 prompt 镜像:受管副本落盘,session spawn 时按 prefs 开关拼 argv 注入。
  mirrorBundledClaude(bundledClaudeSource, BUNDLED_CLAUDE_PATH);
  void ensureBundledSkillsEntry({
    settingsPath: join(PI_AGENT_DIR, "settings.json"),
    targetDir: BUNDLED_SKILLS_DIR,
    enabled: prefsStore.get("bundledSkillsEnabled"),
    homeDir: HOME_DIR,
  }).then((changed) => { if (changed) broadcastSettingsChanged(); })
    .catch((e) => console.error("[bundled-skills] 启动同步失败:", e));

  // tool-gate 底座扩展同步:任何 pi 会话进程 spawn 之前装好,renderer 经 kernel.toolgateAvailable IPC 探测可用性。
  installToolGate();

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
