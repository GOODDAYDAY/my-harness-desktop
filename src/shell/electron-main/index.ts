// Electron main 进程入口 —— 四根支柱的 shell 侧挂载点。
//
// 本次接入:
// - 支柱② 配置操作(application/config/config-store):插件配置 ~/.pi-desktop/plugins-data/
// - 桌面偏好(electron-store):currentThemeId/fontScale/fontMono/fontSans 等持久化
// - 支柱③ 加载器(application/loader):发现内置插件、填注册表
// - IPC 通道:config/prefs/themes/settings,经 preload 暴露受控 pi.* API
// 支柱①(RPC 适配)留后续。
import { app, BrowserWindow, ipcMain, shell, dialog } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname, sep } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import Store from "electron-store";
import { ConfigStore } from "../../application/config/config-store";
import { scanSkills, getSkillSourcePaths } from "../../application/skills/skill-scanner";
import { toggleSkill, addSkillPath, removeSkillPath } from "../../application/skills/skill-toggle";
import { readJsonFile, writeJsonFile } from "../../application/config/config-file";
import { PiSettingsStore, parseSettingsSchema } from "../../application/pi-settings/pi-settings-store";
import { ModelsStore } from "../../application/models/models-store";
import { discoverPlugins } from "../../application/loader/discover";
import { PluginRegistry } from "../../application/loader/registry";
import { buildCurrentTheme } from "../../application/theme/merge";
import {
  mergeLanguageContributions,
  collectNamespaces,
  collectSupportedLngs,
  collectLocaleList,
  type I18nResource,
} from "../../application/i18n/merge";
import { detectLocale } from "../../application/i18n/translator";
import { SessionStore, type RpcAdapterFactory } from "../../application/sessions/session-store";
import { listSessions, readSession, renameSession, updateSessionHeader, recentSessionSettings, copySession, removePath } from "../../application/sessions/session-scanner";
import { RpcAdapter } from "../../gateway/rpc-adapter";
import { createPiSubprocess } from "./subprocess-lifecycle";
import { listChangedFiles, fileDiff, fileContent } from "../../application/git/git-status";
import type { ImageInput } from "../../domain/sessions";
import {
  currentVersion,
  listRegistryVersions,
  installPi,
} from "../../application/kernel/kernel-manager";
import {
  activate, deactivate, disablePlugin, enablePlugin, uninstallPlugin, reloadPlugin,
  canDeactivate, getPluginState,
  type PluginLifecycleDeps,
} from "../../application/lifecycle";
import { install as installPlugin, UrlSource, LocalFileSource } from "../../application/installer";
import type { PluginListItem, PluginManifest } from "../../domain/contributions";
import { ExtensionStore } from "../../application/extensions/extension-store";
import { RestartCoordinatorImpl } from "../../application/restart/restart-coordinator";
import type { ExtensionInfo } from "../../domain/extensions";
import type { RestartState } from "../../domain/restart";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 桌面偏好(electron-store):shell/store 管的偏好持久化 ----
// 主题 id/字号/字体是桌面偏好(06 §7:不进 pi settings、不进 plugins-data)。
interface Prefs {
  currentThemeId: string;
  fontScale: number;
  fontMonoChoice: string;
  fontSansTone: string;
  sidebarWidth: number;
  rightPanelOpen: boolean;
  lastCwd: string;
  currentLocale: string;
  currentModelId: string | null;
}
const DEFAULT_PREFS: Prefs = {
  currentThemeId: "chatgpt-dark",
  fontScale: 1.0,
  fontMonoChoice: "jetbrains",
  fontSansTone: "sans",
  sidebarWidth: 240,
  rightPanelOpen: false,
  lastCwd: "",
  currentLocale: "zh-CN",
  currentModelId: null,
};
// 桌面偏好走 electron-store,显式 cwd 纳入 ~/.pi-desktop/config 树(跨重启持久,与插件配置同根)
const prefsStore = new Store<Prefs>({ defaults: DEFAULT_PREFS, cwd: join(homedir(), ".pi-desktop", "config") });

// ---- 插件配置(application/config/config-store)----
// 路径由 shell 注入(守"application 不依赖 shell")。
// 路径树 ~/.pi-desktop/{config/{prefs,plugins-data}, pi}(用户决策,已同步文档)。
const PI_DESKTOP_DIR = join(homedir(), ".pi-desktop");
const CONFIG_DIR = join(PI_DESKTOP_DIR, "config");
const PLUGINS_DATA_DIR = join(CONFIG_DIR, "plugins-data");
const PI_INSTALL_DIR = join(PI_DESKTOP_DIR, "pi"); // 阶段 E:下载的 pi 独立环境
const GENERAL_CONFIG_PATH = join(CONFIG_DIR, "general.json");
// pi 底座配置目录(~/.pi/agent,底座标准,非 ~/.pi-desktop)。pi-settings 插件读写它。
const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
const piSettingsStore = new PiSettingsStore({ agentDir: PI_AGENT_DIR });
const modelsStore = new ModelsStore({ agentDir: PI_AGENT_DIR });
const configStore = new ConfigStore({
  userDir: PLUGINS_DATA_DIR,
  // 项目级 config 本次不接(M7):桌面应用无"当前项目"概念,project 级 config
  // 路径待"打开项目"功能落地后按真实项目 cwd 注入(同 projectPluginsDir 的演进)。
  projectDir: null,
});

// ---- 加载器:发现内置插件 + 填注册表 ----
// 开发期扫 src/plugins;打包后扫 process.resourcesPath/pi-desktop-builtin。
// 加载器:发现 builtin/user/project/installed 四目录插件(H3 多目录)。
// 内置插件与第三方插件平等:同一 discoverPlugins,无 if(builtin) 分支(01-core:1447)。
// builtin:dev 扫 src/plugins、pkg 扫 resources/pi-desktop-builtin
// user:~/.pi-desktop/plugins(用户级,新建)
// project:<cwd>/.pi-desktop/plugins(项目级,按 cwd 注入)
// installed:~/.pi-desktop/installed/{id}/{version}/(外部安装,目录预留,本次 discover 不递归多版本层)
// dev: __dirname=out/main,src/plugins 在 ../../src/plugins(项目根/src/plugins)
// pkg: __dirname=resources/app.asar/...,插件随壳分发在 resources/pi-desktop-builtin/
const builtinDir = app.isPackaged
  ? join(process.resourcesPath, "pi-desktop-builtin")
  : resolve(__dirname, "../../src/plugins");
const userPluginsDir = join(PI_DESKTOP_DIR, "plugins");
// ⚠ project 级 plugins 目录:桌面应用打包后 process.cwd() 通常是家目录,无"当前项目"
// 概念(M8)——此目录在打包态降级为"另一个用户级",留待"打开项目"功能接(演进)。
const projectPluginsDir = join(process.cwd(), ".pi-desktop", "plugins");
const installedDir = join(PI_DESKTOP_DIR, "installed");
// 按优先级从低到高注册(后注册覆盖先注册,同 id 高优先级胜):
// builtin(最低)→ installed → user → project(最高)
const registry = new PluginRegistry();
registry.registerAll(discoverPlugins(builtinDir, "builtin"));
registry.registerAll(discoverPlugins(installedDir, "installed"));
registry.registerAll(discoverPlugins(userPluginsDir, "user"));
registry.registerAll(discoverPlugins(projectPluginsDir, "project"));

// ---- i18n:合并所有插件的 languages 贡献项成 i18next resources(05-plugin-i18n §6)----
// main 只合并 + 给 renderer;renderer 端 init i18next + react-i18next(跨堆,各持实例)。
const languageContributions = registry.languageContributions();
const i18nResources: I18nResource = mergeLanguageContributions(languageContributions);
const i18nNamespaces = collectNamespaces(i18nResources);
const i18nSupportedLngs = collectSupportedLngs(languageContributions);
const i18nLocaleList = collectLocaleList();

// ---- IPC:插件配置(config:走 ConfigStore)----
ipcMain.handle("config:get", (_e, pluginId: string, key: string) =>
  configStore.get<unknown>(pluginId, key),
);
ipcMain.handle(
  "config:set",
  async (_e, pluginId: string, key: string, value: unknown) => {
    await configStore.set(pluginId, key, value);
  },
);
ipcMain.handle("config:all", (_e, pluginId: string) => configStore.all(pluginId));

// ---- IPC:桌面偏好(prefs:走 electron-store)----
ipcMain.handle("prefs:get", (_e, key: keyof Prefs) => prefsStore.get(key));
ipcMain.handle("prefs:set", (_e, key: keyof Prefs, value: unknown) => {
  prefsStore.set(key, value as never);
});

// ---- IPC:i18n(语言槽合并后给 renderer init + locale 列表供设置页)----
// renderer 端 init i18next + react-i18next(跨堆各持实例);main 只提供合并好的 resources。
ipcMain.handle("i18n:resources", () => ({
  resources: i18nResources,
  ns: i18nNamespaces,
  supportedLngs: i18nSupportedLngs,
}));
ipcMain.handle("i18n:list", () => i18nLocaleList);
ipcMain.handle("i18n:detect", (_e, navigatorLanguage: string) =>
  detectLocale(navigatorLanguage, i18nSupportedLngs),
);

// ---- IPC:主题(读注册表 + 合并,供 renderer 注入 CSS 变量)----
ipcMain.handle("themes:list", () => registry.themeOptions());
ipcMain.handle(
  "themes:build",
  (_e, themeId: string, fontScale: number, fontMono: string, fontSans: string) =>
    buildCurrentTheme(
      themeId,
      registry.themesRegistry(),
      fontScale,
      fontMono,
      fontSans,
    ),
);

// ---- IPC:设置页(读 settings 槽贡献项)----
ipcMain.handle("settings:list", () => registry.settingsItems());

// ---- IPC:用系统默认编辑器打开文件(框架"打开配置"按钮用)----
ipcMain.handle("open-file", async (_e, path: string) => {
  // 展开 ~ 为家目录(shell.openPath 要绝对路径)
  const abs = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const r = await shell.openPath(abs);
  if (r) console.warn("[main] openPath failed:", abs, r);
  return r;
});

// ---- IPC:通用 JSON 配置文件读写(框架级配置管理,路径白名单 + ~ 展开)----
// 安全门控(§4.6/§8.1):configFile 是框架级通道,限定在 ~/.pi-desktop/(桌面配置区)
// 和 ~/.pi/agent/(底座配置区)前缀内,杜绝任意路径读写(评估 P1-D1:此前无门控,
// 被 session-bookmarks 用来读写项目内 <cwd>/.pi-desktop/bookmarks/,绕过 fs:project 只读沙箱)。
// 插件的私有数据应走 ctx.config(~/.pi-desktop/plugins-data/<id>/),项目级数据走声明能力。
function resolveConfigFilePath(path: string): string {
  const abs = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const allowed = [PI_DESKTOP_DIR, PI_AGENT_DIR];
  const ok = allowed.some((root) => abs === root || abs.startsWith(root + sep));
  if (!ok) throw new Error(`configFile 路径越界:仅允许 ~/.pi-desktop/ 或 ~/.pi/agent/ 前缀,收到 ${path}`);
  return abs;
}
ipcMain.handle("config-file:get", (_e, path: string) => {
  return readJsonFile(resolveConfigFilePath(path));
});
ipcMain.handle("config-file:set", async (_e, path: string, data: Record<string, unknown>, mergeMode: "deep" | "replace") => {
  const abs = resolveConfigFilePath(path);
  await writeJsonFile(abs, data, mergeMode);
  return readJsonFile(abs);
});

// ---- 会话核心(SessionStore 单持;插件能力 sessions.* 的实现)----
// 依赖倒置:RpcAdapterFactory 由 shell 实现(createPiSubprocess spawn → 绑 RpcAdapter),
// 注入给 application 的 SessionStore;application 不 new gateway 具体类、不感知 spawn。
const rpcAdapterFactory: RpcAdapterFactory = {
  create: (opts) => new RpcAdapter(createPiSubprocess(opts)),
};
const sessionStore = new SessionStore(rpcAdapterFactory, PI_AGENT_DIR);
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

ipcMain.handle("session:start", async (_e, cwd: string, sessionPath?: string) => {
  await sessionStore.start(cwd, sessionPath);
  return { ok: true };
});
ipcMain.handle("session:stop", async (_e, sessionPath?: string | null) => {
  await sessionStore.stop(sessionPath ?? null);
  return { ok: true };
});
ipcMain.handle("session:setContext", (_e, cwd: string, sessionPath: string | null) => {
  sessionStore.setContext(cwd, sessionPath);
});
ipcMain.handle("session:replyExtensionUI",
  (_e, requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: true }) =>
    sessionStore.replyExtensionUI(requestId, response));
ipcMain.handle("session:getSnapshot", () => sessionStore.getSnapshot());
ipcMain.handle("session:sync", () => sessionStore.sync());
ipcMain.handle("session:open", (_e, sessionPath: string) => readSession(sessionPath));
ipcMain.handle("session:readToolConfig", (_e, sessionPath: string) => {
  try {
    const content = readFileSync(sessionPath, "utf-8");
    const nl = content.indexOf("\n");
    if (nl <= 0) return null;
    const header = JSON.parse(content.slice(0, nl)) as Record<string, unknown>;
    return (header.toolConfig as { mode?: string; enabledGroupIds?: string[] } | undefined) ?? null;
  } catch {
    return null;
  }
});
ipcMain.handle("session:copySession", (_e, srcPath: string, targetPath: string) => {
  const expandHome = (p: string): string =>
    p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  copySession(expandHome(srcPath), expandHome(targetPath));
});
ipcMain.handle("session:rename", async (_e, sessionPath: string, name: string) => {
  await renameSession(sessionPath, name);
  return { ok: true };
});
ipcMain.handle(
  "session:updateHeader",
  async (_e, sessionPath: string, patch: { name?: string; pinned?: boolean; archived?: boolean }) => {
    await updateSessionHeader(sessionPath, patch);
    return { ok: true };
  },
);
ipcMain.handle("session:prompt", (_e, text: string, images?: ImageInput[]) =>
  sessionStore.prompt(text, images),
);
ipcMain.handle("session:abort", () => sessionStore.abort());
ipcMain.handle("session:getModels", () => sessionStore.getModels());
ipcMain.handle("session:setModel", (_e, provider: string, modelId: string) =>
  sessionStore.setModel(provider, modelId),
);
ipcMain.handle("session:getThinkingLevels", () => sessionStore.getThinkingLevels());
ipcMain.handle("session:setThinkingLevel", (_e, level: string) =>
  sessionStore.setThinkingLevel(level),
);
ipcMain.handle("session:getStats", () => sessionStore.getStats());
ipcMain.handle("sessions:list", (_e, cwd: string) => listSessions(PI_AGENT_DIR, cwd));
ipcMain.handle("sessions:recentSettings", (_e, cwd: string) => recentSessionSettings(PI_AGENT_DIR, cwd));

// ---- IPC: MessagingApi(消息发送变体)----
ipcMain.handle("session:steer", (_e, text: string, images?: ImageInput[]) => sessionStore.steer(text, images));
ipcMain.handle("session:followUp", (_e, text: string, images?: ImageInput[]) => sessionStore.followUp(text, images));
ipcMain.handle("session:abortRetry", () => sessionStore.abortRetry());

// ---- IPC: ModelApi(模型快捷切换)----
ipcMain.handle("session:cycleModel", () => sessionStore.cycleModel());
ipcMain.handle("session:cycleThinkingLevel", () => sessionStore.cycleThinkingLevel());

// ---- IPC: SessionTreeApi(会话树操作)----
ipcMain.handle("session:fork", (_e, entryId: string) => sessionStore.fork(entryId));
ipcMain.handle("session:clone", () => sessionStore.clone());
ipcMain.handle("session:getForkMessages", (_e, entryId: string) => sessionStore.getForkMessages(entryId));

// ---- IPC: SessionMaintenanceApi(会话维护)----
ipcMain.handle("session:compact", (_e, customInstructions?: string) => sessionStore.compact(customInstructions));
ipcMain.handle("session:setAutoCompaction", (_e, enabled: boolean) => sessionStore.setAutoCompaction(enabled));
ipcMain.handle("session:setAutoRetry", (_e, enabled: boolean) => sessionStore.setAutoRetry(enabled));
ipcMain.handle("session:exportHtml", async (_e, outputPath?: string) => {
  const result = await sessionStore.exportHtml(outputPath);
  return result;
});
ipcMain.handle("session:getLastAssistantText", () => sessionStore.getLastAssistantText());

// ---- IPC: QueueModeApi(队列模式)----
ipcMain.handle("session:setSteeringMode", (_e, mode: "all" | "one-at-a-time") => sessionStore.setSteeringMode(mode));
ipcMain.handle("session:setFollowUpMode", (_e, mode: "all" | "one-at-a-time") => sessionStore.setFollowUpMode(mode));

// ---- IPC: BashApi(需声明 rpc:bash 权限,高危 RCE 门控)----
ipcMain.handle("session:runBash", (_e, command: string, excludeFromContext?: boolean) =>
  sessionStore.run(command, { excludeFromContext }),
);
ipcMain.handle("session:abortBash", () => sessionStore.abortBash());

// ---- 声明能力门控:未在 manifest permissions 声明的插件调用即抛错 ----
function assertPermission(pluginId: string, permission: string): void {
  if (!registry.manifestOf(pluginId)) throw new Error(`未知插件: ${pluginId}`);
  if (!registry.hasPermission(pluginId, permission)) {
    throw new Error(`插件 ${pluginId} 未声明权限 ${permission}`);
  }
}

// ---- IPC:fs:project 能力(扫目录一层)----
ipcMain.handle("fs:listDir", (_e, pluginId: string, cwd: string) => {
  assertPermission(pluginId, "fs:project");
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => ({ name: e.name, isDir: true }));
    const files = entries.filter((e) => e.isFile()).map((e) => ({ name: e.name, isDir: false }));
    const sortFn = (a: { name: string }, b: { name: string }) =>
      a.name.startsWith(".") === b.name.startsWith(".") ? a.name.localeCompare(b.name) : a.name.startsWith(".") ? 1 : -1;
    dirs.sort(sortFn);
    files.sort(sortFn);
    return [...dirs, ...files];
  } catch {
    return [];
  }
});
ipcMain.handle("fs:removePath", (_e, pluginId: string, path: string) => {
  assertPermission(pluginId, "fs:project");
  const abs = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  removePath(abs);
});

// ---- IPC:git:read 能力(右面板 Review 页签数据源;只读)----
ipcMain.handle("git:status", async (_e, pluginId: string, cwd: string) => {
  assertPermission(pluginId, "git:read");
  try {
    return { isRepo: true, files: await listChangedFiles(cwd) };
  } catch {
    return { isRepo: false, files: [] };
  }
});
ipcMain.handle("git:fileDiff", async (_e, pluginId: string, cwd: string, path: string) => {
  assertPermission(pluginId, "git:read");
  try {
    return await fileDiff(cwd, path);
  } catch {
    return "";
  }
});
ipcMain.handle("git:fileContent", async (_e, pluginId: string, cwd: string, path: string) => {
  assertPermission(pluginId, "git:read");
  try {
    return await fileContent(cwd, path);
  } catch (err) {
    return `读取失败: ${(err as Error).message}`;
  }
});

// ---- IPC:槽位清单(sidePanel/sidebar 壳渲染用)----
ipcMain.handle("slots:sidePanel", () => registry.sidePanelItems());
ipcMain.handle("slots:sidebar", () => registry.sidebarItems());

// ---- IPC:对话框 ----
ipcMain.handle("dialog:openDirectory", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = win
    ? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
    : await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};
ipcMain.handle("dialog:openImages", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const opts = {
    properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[],
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
  };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (result.canceled) return [];
  const out: { name: string; data: string; mimeType: string }[] = [];
  for (const p of result.filePaths) {
    const mimeType = IMAGE_MIME[extname(p).toLowerCase()];
    if (!mimeType) continue;
    if (statSync(p).size > 10 * 1024 * 1024) continue; // 单张 10MB 上限
    out.push({ name: p.split("/").pop() ?? p, data: readFileSync(p).toString("base64"), mimeType });
  }
  return out;
});

// ---- IPC:pi 内核管理(application/kernel,只维护 ~/.pi-desktop/pi 一份)----
// 用户决策:不掺和 PATH 里的 pi、不走 pi update,桌面端只管 ~/.pi-desktop/pi 这一份(装/升/降级)。
ipcMain.handle("kernel:status", () => currentVersion(PI_INSTALL_DIR));
ipcMain.handle("kernel:listVersions", async (_e, forceRefresh: boolean) =>
  listRegistryVersions(forceRefresh),
);
// kernel:install npm install 指定版本到 ~/.pi-desktop/pi(覆盖式,装新=更新、装旧=降级)
ipcMain.handle("kernel:install", async (e, version: string) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const send = (line: string) => win?.webContents.send("kernel:install-progress", line);
  const result = await installPi(version, PI_INSTALL_DIR, send);
  if (win) win.webContents.send("kernel:install-done", result);
  return result;
});

// ---- IPC:pi 底座 settings(pi-settings 插件,读写 ~/.pi/agent/settings.json)----
// ⚠ 偏离文档(标注):文档说壳不替底座管配置,但 settings.json 是底座标准契约,
// 写标准字段不算重复领域知识。用户明确要在桌面端编辑 pi 所有配置。
ipcMain.handle("pi-settings:get", () => piSettingsStore.get());
ipcMain.handle("pi-settings:set", async (_e, patch: Record<string, unknown>) => {
  await piSettingsStore.set(patch);
  return piSettingsStore.get();
});
// 解析底座 .d.ts 拿当前版本所有字段(方案 D:.d.ts 有但描述表没有的兜底展示)
// globalResolvePaths 由 shell 注入(application 不读 process 环境):进程 cwd + npm 全局目录。
const PI_SETTINGS_RESOLVE_PATHS = [
  process.cwd(),
  join(homedir(), ".npm-global"),
  "/usr/local/lib",
];
ipcMain.handle("pi-settings:schema", () => parseSettingsSchema(PI_INSTALL_DIR, PI_SETTINGS_RESOLVE_PATHS));

// ---- IPC:pi 底座 models(models.json,pi-model-manager 插件用)----
ipcMain.handle("models:get", () => modelsStore.get());
ipcMain.handle("models:set", async (_e, config: unknown) => {
  await modelsStore.set(config as Record<string, unknown> as never);
  return modelsStore.get();
});

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    // 无边框窗口:红绿灯内嵌自定义标题栏(renderer 顶栏 -webkit-app-region: drag)
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 15 },
    backgroundColor: "#0b0b0c",
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

app.whenReady().then(() => {
  if (!existsSync(GENERAL_CONFIG_PATH)) {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(GENERAL_CONFIG_PATH, JSON.stringify({ defaultThinkingLevel: "high" }, null, 2), "utf-8");
  }

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
// ---- 插件管理 IPC ----
let pluginsNonceCounter = 0;
function notifyPluginsChanged(): void {
  pluginsNonceCounter++;
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send("plugins:changed", pluginsNonceCounter);
  }
}
function notifyPluginUnloaded(pluginId: string, components: string[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send("plugin:unloaded", { pluginId, components });
  }
}

const builtinGlobModules = import.meta.glob("../../plugins/*/renderer/index.{ts,tsx}");

const pluginLoader = {
  async load(manifest: PluginManifest, _pluginPath: string): Promise<void> {
    const source = manifest.source ?? "builtin";
    if (source === "builtin") {
      const globKeys = Object.keys(builtinGlobModules);
      const key = globKeys.find((k) => k.includes(`/plugins/${manifest.id}/renderer/index.`));
      if (key) {
        await (builtinGlobModules[key] as () => Promise<unknown>)();
      } else {
        const available = globKeys.filter((k) => k.includes("/renderer/index.")).join(", ");
        throw new Error(
          `builtin 插件 ${manifest.id} 的 renderer chunk 未找到。可用的 renderer 路径: ${available || "(无)"}`,
        );
      }
    } else {
      const rendererEntry = manifest.renderer ?? "./renderer/index.js";
      const fullPath = join(_pluginPath, rendererEntry);
      await import(/* @vite-ignore */ `file://${fullPath}?t=${Date.now()}`);
    }
  },
  unload(_pluginId: string): void {},
};

const lifecycleDeps: PluginLifecycleDeps = {
  registry,
  configStore,
  loader: pluginLoader,
  notifyPluginsChanged,
  notifyPluginUnloaded,
};

function rediscoverPlugin(pluginId: string): { manifest: PluginManifest; path: string; source: "builtin" | "user" | "installed" | "project" } | undefined {
  const dirs: [string, "builtin" | "user" | "installed" | "project"][] = [
    [projectPluginsDir, "project"],
    [userPluginsDir, "user"],
    [installedDir, "installed"],
    [builtinDir, "builtin"],
  ];
  for (const [dir, src] of dirs) {
    const pluginDir = join(dir, pluginId);
    const manifestFile = join(pluginDir, "plugin.json");
    if (existsSync(manifestFile)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestFile, "utf-8")) as PluginManifest;
        return { manifest, path: pluginDir, source: src };
      } catch { /* skip */ }
    }
  }
  return undefined;
}

function inferTier(manifest: PluginManifest, _source: string): "official" | "verified" | "community" {
  // 无特权差异(§1.4):tier 由 manifest 声明,不按 source 自动赋级(避免"内置=official"特权)。
  // 未声明 tier 的插件统一 community(中性兜底),需特权的插件在 plugin.json 声明 "tier"。
  return manifest.tier ?? "community";
}

ipcMain.handle("plugins:list", async () => {
  const disabled = (await configStore.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
  const list: PluginListItem[] = [];
  for (const [id, plugin] of registry.allPlugins()) {
    list.push({
      id,
      displayName: plugin.manifest.displayName ?? id,
      description: plugin.manifest.description,
      version: plugin.manifest.version,
      source: plugin.source,
      tier: inferTier(plugin.manifest, plugin.source),
      state: getPluginState(id, disabled),
      protected: !!plugin.manifest.protected,
    });
  }
  for (const id of disabled) {
    if (!registry.manifestOf(id)) {
      const discovered = rediscoverPlugin(id);
      if (discovered) {
        list.push({
          id,
          displayName: discovered.manifest.displayName ?? id,
          description: discovered.manifest.description,
          version: discovered.manifest.version,
          source: discovered.source,
          tier: inferTier(discovered.manifest, discovered.source),
          state: "inactive",
          protected: !!discovered.manifest.protected,
        });
      }
    }
  }
  return list;
});

ipcMain.handle("plugins:enable", async (_e, pluginId: string) => {
  return enablePlugin(lifecycleDeps, pluginId, () => rediscoverPlugin(pluginId));
});

ipcMain.handle("plugins:disable", async (_e, pluginId: string) => {
  return disablePlugin(lifecycleDeps, pluginId);
});

ipcMain.handle("plugins:uninstall", async (_e, pluginId: string) => {
  return uninstallPlugin(lifecycleDeps, pluginId);
});

ipcMain.handle("plugins:reload", async (_e, pluginId: string) => {
  return reloadPlugin(lifecycleDeps, pluginId, () => rediscoverPlugin(pluginId));
});

ipcMain.handle("plugins:install", async (_e, source: { type: "url" | "local"; location: string }) => {
  const installSource = source.type === "url"
    ? new UrlSource(source.location)
    : new LocalFileSource(source.location);
  const result = await installPlugin(installSource, installedDir);
  if (!result.ok || !result.manifest || !result.pluginPath) return result;
  return activate(lifecycleDeps, result.manifest, result.pluginPath, "installed");
});

// ---- IPC: Skills 管理 ----
const skillWatchers = new Map<string, { close: () => void }>();

ipcMain.handle("skills:list", (_e, cwd: string) => {
  return scanSkills({ agentDir: PI_AGENT_DIR, cwd: cwd || process.cwd() });
});

ipcMain.handle("skills:toggle", async (_e, opts: {
  filePath: string; sourcePath: string; enabled: boolean; scope: "user" | "project"; cwd: string;
}) => {
  await toggleSkill({ ...opts, agentDir: PI_AGENT_DIR });
});

ipcMain.handle("skills:addPath", async (_e, opts: { path: string; scope: "user" | "project"; cwd: string }) => {
  await addSkillPath({ ...opts, agentDir: PI_AGENT_DIR });
});

ipcMain.handle("skills:removePath", async (_e, opts: { path: string; scope: "user" | "project"; cwd: string }) => {
  await removeSkillPath({ ...opts, agentDir: PI_AGENT_DIR });
});

ipcMain.handle("skills:getSourcePaths", (_e, cwd: string) => {
  return getSkillSourcePaths(PI_AGENT_DIR, cwd || process.cwd());
});

ipcMain.handle("skills:watch", async (_e, cwd: string) => {
  const key = cwd || process.cwd();
  if (skillWatchers.has(key)) return;
  const { watch } = await import("chokidar");
  const skills = scanSkills({ agentDir: PI_AGENT_DIR, cwd: key });
  const pathsToWatch = new Set<string>();
  pathsToWatch.add(join(PI_AGENT_DIR, "settings.json"));
  for (const s of skills) pathsToWatch.add(s.sourcePath);
  pathsToWatch.add(join(key, ".pi", "skills"));
  pathsToWatch.add(join(key, ".agents", "skills"));
  pathsToWatch.add(join(PI_AGENT_DIR, "skills"));
  pathsToWatch.add(join(homedir(), ".agents", "skills"));
  const watchPaths = [...pathsToWatch].filter((p) => existsSync(p));
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(watchPaths, {
    ignored: /(^|[/\\])\./,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  const debouncedRescan = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("skills:changed");
      }
    }, 300);
  };
  watcher.on("add", debouncedRescan);
  watcher.on("unlink", debouncedRescan);
  watcher.on("change", debouncedRescan);
  watcher.on("addDir", debouncedRescan);
  watcher.on("unlinkDir", debouncedRescan);
  skillWatchers.set(key, { close: () => { watcher.close(); if (debounceTimer) clearTimeout(debounceTimer); } });
});

ipcMain.handle("skills:unwatch", (_e, cwd: string) => {
  const key = cwd || process.cwd();
  const w = skillWatchers.get(key);
  if (w) { w.close(); skillWatchers.delete(key); }
});

// ---- IPC: extension 管理(§6.4) ----
ipcMain.handle("extension:list", () => extensionStore.scanExtensions());
ipcMain.handle("extension:enable", (_e, source: string) => extensionStore.enable(source));
ipcMain.handle("extension:disable", (_e, source: string) => extensionStore.disable(source));
ipcMain.handle("extension:reorder", (_e, sources: string[]) => extensionStore.reorder(sources));

ipcMain.handle("extension:install", async (e, source: string) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const child = spawn("pi", ["install", source], { shell: true });
  child.stdout?.on("data", (d) => win?.webContents.send("extension:install-progress", d.toString()));
  child.stderr?.on("data", (d) => win?.webContents.send("extension:install-progress", d.toString()));
  return new Promise<{ ok: boolean; error: string | null }>((resolve) => {
    child.on("exit", (code) => {
      if (code === 0) resolve({ ok: true, error: null });
      else resolve({ ok: false, error: `pi install 退出码 ${code}` });
    });
  });
});
ipcMain.handle("extension:update", async (e, source: string) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const child = spawn("pi", ["update", source], { shell: true });
  child.stdout?.on("data", (d) => win?.webContents.send("extension:install-progress", d.toString()));
  child.stderr?.on("data", (d) => win?.webContents.send("extension:install-progress", d.toString()));
  return new Promise<{ ok: boolean; error: string | null }>((resolve) => {
    child.on("exit", (code) => {
      if (code === 0) resolve({ ok: true, error: null });
      else resolve({ ok: false, error: `pi update 退出码 ${code}` });
    });
  });
});
ipcMain.handle("extension:remove", async (e, source: string) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const child = spawn("pi", ["remove", source], { shell: true });
  child.stdout?.on("data", (d) => win?.webContents.send("extension:install-progress", d.toString()));
  child.stderr?.on("data", (d) => win?.webContents.send("extension:install-progress", d.toString()));
  return new Promise<{ ok: boolean; error: string | null }>((resolve) => {
    child.on("exit", (code) => {
      if (code === 0) resolve({ ok: true, error: null });
      else resolve({ ok: false, error: `pi remove 退出码 ${code}` });
    });
  });
});

// ---- IPC: restart 协调(§6.4) ----
ipcMain.handle("restart:pendingSessions", () => {
  const keys = sessionStore.getRunningSessionKeys();
  return keys.map((k) => ({ sessionKey: k, state: restartCoordinator.getState(k) }));
});
ipcMain.handle("restart:restart", (_e, sessionKey: string) => restartCoordinator.restart(sessionKey));
ipcMain.handle("restart:restartAllIdle", () => restartCoordinator.restartIdlePending());

app.on("before-quit", (event) => {
  event.preventDefault();
  void sessionStore.stopAll().finally(() => app.exit());
});
