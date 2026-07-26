// Electron main 进程入口 —— 四根支柱的 shell 侧挂载点。
//
// 本次接入:
// - 支柱② 配置操作(application/config/config-store):插件配置 ~/.pi-desktop/plugins-data/
// - 桌面偏好(electron-store):currentThemeId/fontScale/fontMono/fontSans 等持久化
// - 支柱③ 加载器(application/loader):发现内置插件、填注册表
// - IPC 通道:config/prefs/themes/settings,经 preload 暴露受控 pi.* API
// 支柱①(RPC 适配)留后续。
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import Store from "electron-store";
import { ConfigStore } from "../../application/config/config-store";
import { readJsonFile, writeJsonFile } from "../../application/config/config-file";
import { PiSettingsStore, parseSettingsSchema } from "../../application/pi-settings/pi-settings-store";
import { ModelsStore } from "../../application/models/models-store";
import { discoverPlugins } from "../../application/loader/discover";
import { PluginRegistry } from "../../application/loader/registry";
import { buildCurrentTheme } from "../../application/theme/merge";
import {
  currentVersion,
  listRegistryVersions,
  installPi,
} from "../../application/kernel/kernel-manager";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 桌面偏好(electron-store):shell/store 管的偏好持久化 ----
// 主题 id/字号/字体是桌面偏好(06 §7:不进 pi settings、不进 plugins-data)。
interface Prefs {
  currentThemeId: string;
  fontScale: number;
  fontMonoChoice: string;
  fontSansTone: string;
}
const DEFAULT_PREFS: Prefs = {
  currentThemeId: "new-york-dark",
  fontScale: 1.0,
  fontMonoChoice: "jetbrains",
  fontSansTone: "sans",
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

// ---- IPC:通用 JSON 配置文件读写(框架级配置管理,~ 展开)----
ipcMain.handle("config-file:get", (_e, path: string) => {
  const abs = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return readJsonFile(abs);
});
ipcMain.handle("config-file:set", async (_e, path: string, data: Record<string, unknown>, mergeMode: "deep" | "replace") => {
  const abs = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  await writeJsonFile(abs, data, mergeMode);
  return readJsonFile(abs);
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
ipcMain.handle("pi-settings:schema", () => parseSettingsSchema(PI_INSTALL_DIR));

// ---- IPC:pi 底座 models(models.json,pi-model-manager 插件用)----
ipcMain.handle("models:get", () => modelsStore.get());
ipcMain.handle("models:set", async (_e, config: unknown) => {
  await modelsStore.set(config as Record<string, unknown> as never);
  return modelsStore.get();
});

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
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
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
