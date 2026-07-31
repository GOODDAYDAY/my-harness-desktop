// Electron main 进程入口 —— 四根支柱的 shell 侧挂载点。
//
// 本次接入:
// - 支柱② 配置操作(application/config/config-store):插件配置 ~/.pi-desktop/plugins-data/
// - 桌面偏好(electron-store):currentThemeId/fontScale/fontMono/fontSans 等持久化
// - 支柱③ 加载器(application/loader):发现内置插件、填注册表
// - IPC 通道:config/prefs/themes/settings,经 preload 暴露受控 pi.* API
// 支柱①(RPC 适配)留后续。
import { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname, sep } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import Store from "electron-store";
import { ConfigStore } from "../../application/config/config-store";
import { scanSkills, getSkillSourcePaths } from "../../application/skills/skill-scanner";
import { toggleSkill, toggleForceInvocation, addSkillPath, removeSkillPath } from "../../application/skills/skill-toggle";
import { readJsonFile, writeJsonFile } from "../../application/config/config-file";
import { PiSettingsStore, parseSettingsSchema } from "../../application/pi-settings/pi-settings-store";
import { ModelsStore } from "../../application/models/models-store";
import { discoverPlugins } from "../../application/loader/discover";
import { PluginRegistry } from "../../application/loader/registry";
import { buildCurrentTheme } from "../../application/theme/merge";
import { auditThemeContrast } from "../../application/theme/contrast";
import {
  mergeLanguageContributions,
  collectNamespaces,
  collectSupportedLngs,
  collectLocaleList,
  type I18nResource,
} from "../../application/i18n/merge";
import { detectLocale } from "../../application/i18n/translator";
import { SessionStore, type RpcAdapterFactory } from "../../application/sessions/session-store";
import { removePath } from "../../application/sessions/session-scanner";
import { walkDirTree } from "./fs-tree";
import { RpcAdapter } from "../../gateway/rpc-adapter";
import { createPiSubprocess } from "./subprocess-lifecycle";
import { IPC } from "../ipc-channels";
import { listChangedFiles, fileDiff, fileContent } from "../../application/git/git-status";
import type { ImageInput } from "../../domain/sessions";
import {
  currentVersion,
  listRegistryVersions,
  installPi,
  initKernelRuntime,
} from "../../application/kernel/kernel-manager";
import type { KernelRuntime } from "../../application/kernel/kernel-runtime";
import {
  activate, deactivate, disablePlugin, enablePlugin, uninstallPlugin, reloadPlugin,
  canDeactivate, getPluginState, reportLoadFailure, erroredPlugins,
  type PluginLifecycleDeps,
} from "../../application/lifecycle";
import { install as installPlugin, UrlSource, LocalFileSource } from "../../application/installer";
import type { PluginListItem, PluginManifest } from "../../domain/contributions";
import { resolvePluginTags } from "../../domain/contributions";
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
  timelineThemeId: string;
  fontScale: number;
  fontMonoChoice: string;
  fontSansTone: string;
  sidebarStyle: string;
  sidepanelStyle: string;
  sidebarWidth: number;
  rightPanelOpen: boolean;
  activeSidePanelTabs: string[];
  lastCwd: string;
  currentLocale: string;
  currentModelId: string | null;
}
const DEFAULT_PREFS: Prefs = {
  currentThemeId: "chatgpt-dark",
  timelineThemeId: "__inherit__",
  fontScale: 1.0,
  fontMonoChoice: "jetbrains",
  fontSansTone: "sans",
  sidebarStyle: "default",
  sidepanelStyle: "default",
  sidebarWidth: 240,
  rightPanelOpen: false,
  activeSidePanelTabs: [],
  lastCwd: "",
  currentLocale: "zh-CN",
  currentModelId: null,
};
// 桌面偏好走 electron-store,显式 cwd 纳入 ~/.pi-desktop/config 树(跨重启持久,与插件配置同根)
const HOME_DIR = homedir();
const PI_DESKTOP_DIR = join(HOME_DIR, ".pi-desktop");
const CONFIG_DIR = join(PI_DESKTOP_DIR, "config");
const PLUGINS_DATA_DIR = join(CONFIG_DIR, "plugins-data");
const PI_INSTALL_DIR = join(PI_DESKTOP_DIR, "pi"); // 阶段 E:下载的 pi 独立环境
const GENERAL_CONFIG_PATH = join(CONFIG_DIR, "general.json");
// pi 底座配置目录(~/.pi/agent,底座标准,非 ~/.pi-desktop)。pi-settings 插件读写它。
const PI_AGENT_DIR = join(HOME_DIR, ".pi", "agent");
const prefsStore = new Store<Prefs>({ defaults: DEFAULT_PREFS, cwd: join(HOME_DIR, ".pi-desktop", "config") });

// KernelRuntime 实现:spawn npm install + fetch registry + env allowlist(评估 P2 依赖倒置,
// 进程管理/网络/环境是外层细节,推到 shell;application 的 kernel-manager 经接口调用)。
const REGISTRY_URL = "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent";
const kernelRuntime: KernelRuntime = {
  installNpm(pkgSpec, installDir, onProgress) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(
          "npm",
          ["install", pkgSpec, "--no-audit", "--no-fund", "--omit=dev", "--ignore-scripts"],
          { cwd: installDir, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" }, shell: false },
        );
      } catch (err) {
        resolve({ ok: false, error: `npm 启动失败: ${(err as Error).message}` });
        return;
      }
      const lineBuf: Buffer[] = [];
      child.on("error", (e) => resolve({ ok: false, error: `npm 启动失败: ${e.message}` }));
      child.stdout?.on("data", (d: Buffer) => {
        lineBuf.push(d);
        const text = Buffer.concat(lineBuf).toString();
        const lines = text.split("\n");
        lineBuf.length = 0;
        const rest = lines[lines.length - 1];
        if (rest) lineBuf.push(Buffer.from(rest));
        for (const line of lines.slice(0, -1)) onProgress(line);
      });
      child.stderr?.on("data", (d: Buffer) => onProgress(`[stderr] ${d.toString().trim()}`));
      child.on("close", (code) => {
        if (lineBuf.length > 0) {
          const rest = Buffer.concat(lineBuf).toString();
          if (rest.trim()) onProgress(rest.trim());
        }
        resolve({ ok: code === 0, error: code === 0 ? null : `npm install 退出码 ${code}` });
      });
    });
  },
  async fetchRegistryVersions() {
    const resp = await fetch(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(25_000),
    });
    if (!resp.ok) throw new Error(`registry ${resp.status}`);
    const data = (await resp.json()) as {
      versions?: Record<string, unknown>; "dist-tags"?: { latest?: string };
    };
    const semverMod = await import("semver");
    const versions = semverMod.default.sort(Object.keys(data.versions ?? {}).filter((v) => semverMod.default.valid(v)));
    return { versions, latest: data["dist-tags"]?.latest ?? null };
  },
};
initKernelRuntime(kernelRuntime);
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
const i18nLocaleList = collectLocaleList(i18nSupportedLngs, i18nResources);

// ---- IPC:插件配置(config:走 ConfigStore)----
ipcMain.handle(IPC.config.get, (_e, pluginId: string, key: string) =>
  configStore.get<unknown>(pluginId, key),
);
ipcMain.handle(
  IPC.config.set,
  async (_e, pluginId: string, key: string, value: unknown) => {
    await configStore.set(pluginId, key, value);
  },
);
ipcMain.handle(IPC.config.all, (_e, pluginId: string) => configStore.all(pluginId));

// ---- IPC:桌面偏好(prefs:走 electron-store)----
ipcMain.handle(IPC.prefs.get, (_e, key: keyof Prefs) => prefsStore.get(key));
ipcMain.handle(IPC.prefs.set, (_e, key: keyof Prefs, value: unknown) => {
  prefsStore.set(key, value as never);
});

// ---- IPC:i18n(语言槽合并后给 renderer init + locale 列表供设置页)----
// renderer 端 init i18next + react-i18next(跨堆各持实例);main 只提供合并好的 resources。
ipcMain.handle(IPC.i18n.resources, () => ({
  resources: i18nResources,
  ns: i18nNamespaces,
  supportedLngs: i18nSupportedLngs,
}));
ipcMain.handle(IPC.i18n.list, () => i18nLocaleList);
ipcMain.handle(IPC.i18n.detect, (_e, navigatorLanguage: string) =>
  detectLocale(navigatorLanguage, i18nSupportedLngs),
);

// ---- IPC:主题(读注册表 + 合并,供 renderer 注入 CSS 变量)----
ipcMain.handle(IPC.themes.list, () => registry.themeOptions());
ipcMain.handle(
  IPC.themes.build,
  (_e, themeId: string, fontScale: number, fontMono: string, fontSans: string) => {
    const theme = buildCurrentTheme(
      themeId,
      registry.themesRegistry(),
      fontScale,
      fontMono,
      fontSans,
      nativeTheme.shouldUseDarkColors,
    );
    // WCAG AA 对比度审计(06 §870):诊断不阻断,主进程日志上报告警,主题开发者可见。
    const audit = auditThemeContrast(theme);
    for (const d of audit.failed) {
      console.warn(
        `[theme] 对比度不足 ${themeId}: ${d.fg} on ${d.bg} = ${d.ratio.toFixed(2)}:1(需 ≥${d.required}:1)`,
      );
    }
    return theme;
  },
);
// 系统明暗变化 → 推 renderer 重 build(__auto__ 动态 base 的消费方在 renderer,事件驱动不轮询)。
nativeTheme.on("updated", () => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.themes.systemChanged);
});

// ---- IPC:设置页(读 settings 槽贡献项)----
ipcMain.handle(IPC.settings.list, () => registry.settingsItems());

// ---- IPC:用系统默认编辑器打开文件(框架"打开配置"按钮用)----
ipcMain.handle(IPC.misc.openFile, async (_e, path: string) => {
  // 展开 ~ 为家目录(shell.openPath 要绝对路径)
  const abs = path.startsWith("~/") ? join(HOME_DIR, path.slice(2)) : path;
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
  const abs = path.startsWith("~/") ? join(HOME_DIR, path.slice(2)) : path;
  const allowed = [PI_DESKTOP_DIR, PI_AGENT_DIR];
  const ok = allowed.some((root) => abs === root || abs.startsWith(root + sep));
  if (!ok) throw new Error(`configFile 路径越界:仅允许 ~/.pi-desktop/ 或 ~/.pi/agent/ 前缀,收到 ${path}`);
  return abs;
}
ipcMain.handle(IPC.configFile.get, (_e, path: string) => {
  return readJsonFile(resolveConfigFilePath(path));
});
// 配置写后广播(根因修复:此前仅 skills:* 广播,设置页保存后订阅方如 debug-bar 永远收不到)
function broadcastSettingsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("settings:changed");
}
ipcMain.handle(IPC.configFile.set, async (_e, path: string, data: Record<string, unknown>, mergeMode: "deep" | "replace") => {
  const abs = resolveConfigFilePath(path);
  await writeJsonFile(abs, data, mergeMode);
  broadcastSettingsChanged();
  return readJsonFile(abs);
});

// ---- IPC:分层配置(框架级项目配置 fallback;详见 docs/design/layered-config.md)----
// 路径由 main 构造(插件传 cwd + relPath),不走白名单——攻击面是 relPath 能否逃逸 .pi-desktop/。
function resolveRelPath(cwd: string, relPath: string): { project: string; global: string } {
  if (relPath.startsWith("/") || relPath.includes("~"))
    throw new Error("relPath 不能是绝对路径或含 ~");
  if (relPath.split(sep).includes(".."))
    throw new Error("relPath 不能含 ..");
  return {
    project: join(cwd, ".pi-desktop", relPath),
    global: join(PI_DESKTOP_DIR, relPath),
  };
}
ipcMain.handle(IPC.configFile.getLayered, (_e, cwd: string, relPath: string) => {
  const { project, global } = resolveRelPath(cwd, relPath);
  if (existsSync(project)) return readJsonFile(project);
  if (existsSync(global)) return readJsonFile(global);
  return null;
});
ipcMain.handle(IPC.configFile.getProject, (_e, cwd: string, relPath: string) => {
  const { project } = resolveRelPath(cwd, relPath);
  return existsSync(project) ? readJsonFile(project) : null;
});
ipcMain.handle(IPC.configFile.setProject, async (_e, cwd: string, relPath: string, data: Record<string, unknown>, mode: "deep" | "replace") => {
  const { project } = resolveRelPath(cwd, relPath);
  await writeJsonFile(project, data, mode);
  broadcastSettingsChanged();
  return readJsonFile(project);
});
ipcMain.handle(IPC.configFile.clearProject, (_e, cwd: string, relPath: string) => {
  const { project } = resolveRelPath(cwd, relPath);
  try { unlinkSync(project); } catch {}
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

ipcMain.handle(IPC.session.start, async (_e, cwd: string, sessionPath?: string) => {
  await sessionStore.start(cwd, sessionPath);
  return { ok: true };
});
ipcMain.handle(IPC.session.stop, async (_e, sessionPath?: string | null) => {
  await sessionStore.stop(sessionPath ?? null);
  return { ok: true };
});
ipcMain.handle(IPC.session.setContext, (_e, cwd: string, sessionPath: string | null) => {
  sessionStore.setContext(cwd, sessionPath);
});
ipcMain.handle(IPC.session.replyExtensionUI,
  (_e, requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: true }) =>
    sessionStore.replyExtensionUI(requestId, response));
ipcMain.handle(IPC.session.getSnapshot, () => sessionStore.getSnapshot());
ipcMain.handle(IPC.session.sync, () => sessionStore.sync());
ipcMain.handle(IPC.session.open, (_e, sessionPath: string) => sessionStore.openSession(sessionPath));
ipcMain.handle(IPC.session.readToolConfig, (_e, sessionPath: string) => sessionStore.readToolConfig(sessionPath));
ipcMain.handle(IPC.session.copySession, (_e, srcPath: string, targetPath: string) => {
  const expandHome = (p: string): string =>
    p.startsWith("~/") ? join(HOME_DIR, p.slice(2)) : p;
  void sessionStore.copySession(expandHome(srcPath), expandHome(targetPath));
});
ipcMain.handle(IPC.session.rename, async (_e, sessionPath: string, name: string) => {
  await sessionStore.renameSession(sessionPath, name);
  return { ok: true };
});
ipcMain.handle(
  IPC.session.updateHeader,
  async (_e, sessionPath: string, patch: { name?: string; pinned?: boolean; archived?: boolean }) => {
    await sessionStore.updateHeader(sessionPath, patch);
    return { ok: true };
  },
);
ipcMain.handle(IPC.session.delete, async (_e, paths: string[]) => {
  await sessionStore.deleteSessions(paths);
  return { ok: true };
});
ipcMain.handle(IPC.session.prompt, (_e, text: string, images?: ImageInput[]) =>
  sessionStore.prompt(text, images),
);
ipcMain.handle(IPC.session.abort, () => sessionStore.abort());
ipcMain.handle(IPC.session.getModels, () => sessionStore.getModels());
ipcMain.handle(IPC.session.setModel, (_e, provider: string, modelId: string) =>
  sessionStore.setModel(provider, modelId),
);
ipcMain.handle(IPC.session.getThinkingLevels, () => sessionStore.getThinkingLevels());
ipcMain.handle(IPC.session.setThinkingLevel, (_e, level: string) =>
  sessionStore.setThinkingLevel(level),
);
ipcMain.handle(IPC.session.getStats, () => sessionStore.getStats());
ipcMain.handle(IPC.sessions.list, (_e, cwd: string) => sessionStore.list(cwd));
ipcMain.handle(IPC.sessions.recentSettings, (_e, cwd: string) => sessionStore.recentSettings(cwd));

// ---- IPC: MessagingApi(消息发送变体)----
ipcMain.handle(IPC.session.steer, (_e, text: string, images?: ImageInput[]) => sessionStore.steer(text, images));
ipcMain.handle(IPC.session.followUp, (_e, text: string, images?: ImageInput[]) => sessionStore.followUp(text, images));
ipcMain.handle(IPC.session.abortRetry, () => sessionStore.abortRetry());

// ---- IPC: ModelApi(模型快捷切换)----
ipcMain.handle(IPC.session.cycleModel, () => sessionStore.cycleModel());
ipcMain.handle(IPC.session.cycleThinkingLevel, () => sessionStore.cycleThinkingLevel());
// 模型连通性测试:内核起独立临时会话进程 ping 一次,测完清理、不碰激活会话。
ipcMain.handle(IPC.session.testModel, (_e, cwd: string, provider: string, modelId: string) =>
  sessionStore.test(cwd, provider, modelId),
);

// ---- IPC: SessionTreeApi(会话树操作)----
ipcMain.handle(IPC.session.fork, (_e, entryId: string) => sessionStore.fork(entryId));
ipcMain.handle(IPC.session.clone, () => sessionStore.clone());
ipcMain.handle(IPC.session.getForkMessages, (_e, entryId: string) => sessionStore.getForkMessages(entryId));

// ---- IPC: SessionMaintenanceApi(会话维护)----
ipcMain.handle(IPC.session.compact, (_e, customInstructions?: string) => sessionStore.compact(customInstructions));
ipcMain.handle(IPC.session.setAutoCompaction, (_e, enabled: boolean) => sessionStore.setAutoCompaction(enabled));
ipcMain.handle(IPC.session.setAutoRetry, (_e, enabled: boolean) => sessionStore.setAutoRetry(enabled));
ipcMain.handle(IPC.session.exportHtml, async (_e, outputPath?: string) => {
  const result = await sessionStore.exportHtml(outputPath);
  return result;
});
ipcMain.handle(IPC.session.getLastAssistantText, () => sessionStore.getLastAssistantText());

// ---- IPC: QueueModeApi(队列模式)----
ipcMain.handle(IPC.session.setSteeringMode, (_e, mode: "all" | "one-at-a-time") => sessionStore.setSteeringMode(mode));
ipcMain.handle(IPC.session.setFollowUpMode, (_e, mode: "all" | "one-at-a-time") => sessionStore.setFollowUpMode(mode));

// ---- IPC: BashApi(需声明 rpc:bash 权限,高危 RCE 门控)----
ipcMain.handle(IPC.session.runBash, (_e, command: string, excludeFromContext?: boolean) =>
  sessionStore.run(command, { excludeFromContext }),
);
ipcMain.handle(IPC.session.abortBash, () => sessionStore.abortBash());

// ---- 声明能力门控:未在 manifest permissions 声明的插件调用即抛错 ----
function assertPermission(pluginId: string, permission: string): void {
  if (!registry.manifestOf(pluginId)) throw new Error(`未知插件: ${pluginId}`);
  if (!registry.hasPermission(pluginId, permission)) {
    throw new Error(`插件 ${pluginId} 未声明权限 ${permission}`);
  }
}

// ---- fs:project 圈禁:路径必须落在当前项目根(sessionStore.activeCwd)内 ----
// fail-closed:无激活 cwd 时拒绝;resolve + 前缀检查,防 .. 逃逸。
// 演进:若插件传符号链分子目录,可用 realpath 进一步加固(当前 baseline 前缀检查)。
function assertProjectPath(raw: string): string {
  const root = sessionStore.getActiveCwd();
  if (!root) throw new Error("fs:project 拒绝:无激活项目目录");
  const abs = resolve(raw.startsWith("~/") ? join(HOME_DIR, raw.slice(2)) : raw);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new Error(`fs:project 越界: ${abs} 不在项目目录 ${rootAbs} 内`);
  }
  return abs;
}

// ---- IPC:fs:project 能力(扫目录一层;路径经 assertProjectPath 圈禁到项目根)----
ipcMain.handle(IPC.fs.listDir, (_e, pluginId: string, cwd: string) => {
  assertPermission(pluginId, "fs:project");
  const abs = assertProjectPath(cwd);
  try {
    const entries = readdirSync(abs, { withFileTypes: true });
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
ipcMain.handle(IPC.fs.removePath, (_e, pluginId: string, path: string) => {
  assertPermission(pluginId, "fs:project");
  const abs = assertProjectPath(path);
  removePath(abs);
});
// ---- IPC:fs:project 能力(读目录树;路径经 assertProjectPath 圈禁到项目根)----
ipcMain.handle(IPC.fs.readDirTree, (_e, pluginId: string, cwd: string, opts?: { maxDepth?: number; ignore?: string[] }) => {
  assertPermission(pluginId, "fs:project");
  return walkDirTree(assertProjectPath(cwd), opts ?? {});
});

// ---- IPC:git:read 能力(右面板 Review 页签数据源;只读)----
ipcMain.handle(IPC.git.status, async (_e, pluginId: string, cwd: string) => {
  assertPermission(pluginId, "git:read");
  try {
    return { isRepo: true, files: await listChangedFiles(cwd) };
  } catch {
    return { isRepo: false, files: [] };
  }
});
ipcMain.handle(IPC.git.fileDiff, async (_e, pluginId: string, cwd: string, path: string) => {
  assertPermission(pluginId, "git:read");
  try {
    return await fileDiff(cwd, path);
  } catch {
    return "";
  }
});
ipcMain.handle(IPC.git.fileContent, async (_e, pluginId: string, cwd: string, path: string) => {
  assertPermission(pluginId, "git:read");
  try {
    return await fileContent(cwd, path);
  } catch (err) {
    return `读取失败: ${(err as Error).message}`;
  }
});

// ---- IPC:槽位清单(sidePanel/sidebar/mainView 壳渲染用)----
ipcMain.handle(IPC.slots.sidePanel, () => registry.sidePanelItems());
ipcMain.handle(IPC.slots.sidebar, () => registry.sidebarItems());
ipcMain.handle(IPC.slots.mainView, () => registry.mainViewItems());
ipcMain.handle(IPC.slots.titlebar, () => registry.titlebarItems());

// ---- IPC:对话框 ----
ipcMain.handle(IPC.dialog.openDirectory, async (e) => {
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
ipcMain.handle(IPC.dialog.openImages, async (e) => {
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
ipcMain.handle(IPC.kernel.status, () => currentVersion(PI_INSTALL_DIR));
ipcMain.handle(IPC.kernel.listVersions, async (_e, forceRefresh: boolean) =>
  listRegistryVersions(forceRefresh),
);
// kernel:install npm install 指定版本到 ~/.pi-desktop/pi(覆盖式,装新=更新、装旧=降级)
ipcMain.handle(IPC.kernel.install, async (e, version: string) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const send = (line: string) => win?.webContents.send("kernel:install-progress", line);
  const result = await installPi(version, PI_INSTALL_DIR, send);
  if (win) win.webContents.send("kernel:install-done", result);
  return result;
});

// ---- IPC:pi 底座 settings(pi-settings 插件,读写 ~/.pi/agent/settings.json)----
// ⚠ 偏离文档(标注):文档说壳不替底座管配置,但 settings.json 是底座标准契约,
// 写标准字段不算重复领域知识。用户明确要在桌面端编辑 pi 所有配置。
ipcMain.handle(IPC.piSettings.get, () => piSettingsStore.get());
ipcMain.handle(IPC.piSettings.set, async (_e, patch: Record<string, unknown>) => {
  await piSettingsStore.set(patch);
  return piSettingsStore.get();
});
// 解析底座 .d.ts 拿当前版本所有字段(方案 D:.d.ts 有但描述表没有的兜底展示)
// globalResolvePaths 由 shell 注入(application 不读 process 环境):进程 cwd + npm 全局目录。
const PI_SETTINGS_RESOLVE_PATHS = [
  process.cwd(),
  join(HOME_DIR, ".npm-global"),
  "/usr/local/lib",
];
ipcMain.handle(IPC.piSettings.schema, () => parseSettingsSchema(PI_INSTALL_DIR, PI_SETTINGS_RESOLVE_PATHS));

// ---- IPC:pi 底座 models(models.json,pi-model-manager 插件用)----
ipcMain.handle(IPC.models.get, () => modelsStore.get());
ipcMain.handle(IPC.models.set, async (_e, config: unknown) => {
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
    icon: resolve(__dirname, "../../build/icons/icon.png"),
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
  // bundle 修复见 scripts/patch-electron.cjs(改 icns 后 touch + lsregister)。
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(resolve(__dirname, "../../build/icons/icon.png"));
  }

  if (!existsSync(GENERAL_CONFIG_PATH)) {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(GENERAL_CONFIG_PATH, JSON.stringify({ defaultThinkingLevel: "high", sidebarDefaultOpen: false }, null, 2), "utf-8");
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

// 评估 P1-A2:此前 main 侧 pluginLoader 按 source 分轨——builtin 走 import.meta.glob
// (编译期),第三方走 file:// 动态 import。但 main 进程不渲染插件 UI(React 组件在 renderer
// 进程),main 侧 load renderer chunk 是死代码(且 main 是 CJS,import React ESM chunk 会失败)。
// 真正的插件 renderer 加载在 renderer 侧 plugins-host(经 import.meta.glob 统一加载内置,
// 无 if-builtin 分支)。main 侧 loader 改 no-op:只管注册/通知,不碰 renderer chunk。
// 这消除 main 侧的 if(source==="builtin") 双轨分支(违反 §1.4 无特权差异)。
const pluginLoader = {
  async load(_manifest: PluginManifest, _pluginPath: string): Promise<void> {
    // no-op:renderer 侧 plugins-host 负责加载插件 renderer。main 只管注册 + notifyPluginsChanged。
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

ipcMain.handle(IPC.plugins.list, async () => {
  const disabled = (await configStore.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
  const list: PluginListItem[] = [];
  for (const [id, plugin] of registry.allPlugins()) {
    const isBuiltin = plugin.source === "builtin";
    list.push({
      id,
      displayName: plugin.manifest.displayName ?? id,
      description: plugin.manifest.description,
      version: plugin.manifest.version,
      source: plugin.source,
      tier: inferTier(plugin.manifest, plugin.source),
      state: getPluginState(id, disabled),
      protected: !!plugin.manifest.protected,
      path: isBuiltin ? null : plugin.path,
      renderer: isBuiltin ? null : (plugin.manifest.renderer ?? "./renderer/index.js"),
      contributes: plugin.manifest.contributes,
      tags: resolvePluginTags(plugin.manifest),
    });
  }
  // disabled + error(renderer 上报加载失败被撤注册)：不在注册表里的也要列出供管理页展示，
  // state 由 getPluginState 判定(error 优先于 inactive)——加载失败是可见的一等状态，不再静默消失。
  for (const id of new Set([...disabled, ...erroredPlugins()])) {
    if (!registry.manifestOf(id)) {
      const discovered = rediscoverPlugin(id);
      if (discovered) {
        const isBuiltin = discovered.source === "builtin";
        list.push({
          id,
          displayName: discovered.manifest.displayName ?? id,
          description: discovered.manifest.description,
          version: discovered.manifest.version,
          source: discovered.source,
          tier: inferTier(discovered.manifest, discovered.source),
          state: getPluginState(id, disabled),
          protected: !!discovered.manifest.protected,
          path: isBuiltin ? null : discovered.path,
          renderer: isBuiltin ? null : (discovered.manifest.renderer ?? "./renderer/index.js"),
          contributes: discovered.manifest.contributes,
          tags: resolvePluginTags(discovered.manifest),
        });
      }
    }
  }
  return list;
});

ipcMain.handle(IPC.plugins.enable, async (_e, pluginId: string) => {
  return enablePlugin(lifecycleDeps, pluginId, () => rediscoverPlugin(pluginId));
});

ipcMain.handle(IPC.plugins.disable, async (_e, pluginId: string) => {
  return disablePlugin(lifecycleDeps, pluginId);
});

ipcMain.handle(IPC.plugins.uninstall, async (_e, pluginId: string) => {
  return uninstallPlugin(lifecycleDeps, pluginId);
});

ipcMain.handle(IPC.plugins.reload, async (_e, pluginId: string) => {
  return reloadPlugin(lifecycleDeps, pluginId, () => rediscoverPlugin(pluginId));
});

// renderer 上报插件 renderer 模块加载失败：撤注册 + 记 error + 广播（与 activate 失败分支同出口）。
ipcMain.handle(IPC.plugins.loadFailed, (_e, pluginId: string) => {
  reportLoadFailure(lifecycleDeps, pluginId);
});

ipcMain.handle(IPC.plugins.install, async (_e, source: { type: "url" | "local"; location: string }) => {
  const installSource = source.type === "url"
    ? new UrlSource(source.location)
    : new LocalFileSource(source.location);
  const result = await installPlugin(installSource, installedDir);
  if (!result.ok || !result.manifest || !result.pluginPath) return result;
  return activate(lifecycleDeps, result.manifest, result.pluginPath, "installed");
});

// ---- IPC: Skills 管理 ----
const skillWatchers = new Map<string, { close: () => void }>();

ipcMain.handle(IPC.skills.list, (_e, cwd: string) => {
  return scanSkills({ agentDir: PI_AGENT_DIR, cwd: cwd || process.cwd(), homeDir: HOME_DIR });
});

ipcMain.handle(IPC.skills.toggle, async (_e, opts: {
  filePath: string; sourcePath: string; enabled: boolean; scope: "user" | "project"; cwd: string;
}) => {
  await toggleSkill({ ...opts, agentDir: PI_AGENT_DIR, homeDir: HOME_DIR });
  broadcastSettingsChanged();
});

ipcMain.handle(IPC.skills.toggleForce, async (_e, opts: { filePath: string; force: boolean }) => {
  await toggleForceInvocation(opts);
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("skills:changed");
});

ipcMain.handle(IPC.skills.addPath, async (_e, opts: { path: string; scope: "user" | "project"; cwd: string }) => {
  await addSkillPath({ ...opts, agentDir: PI_AGENT_DIR, homeDir: HOME_DIR });
  broadcastSettingsChanged();
});

ipcMain.handle(IPC.skills.removePath, async (_e, opts: { path: string; scope: "user" | "project"; cwd: string }) => {
  await removeSkillPath({ ...opts, agentDir: PI_AGENT_DIR, homeDir: HOME_DIR });
  broadcastSettingsChanged();
});

ipcMain.handle(IPC.skills.getSourcePaths, (_e, cwd: string) => {
  return getSkillSourcePaths(PI_AGENT_DIR, cwd || process.cwd());
});

ipcMain.handle(IPC.skills.watch, async (_e, cwd: string) => {
  const key = cwd || process.cwd();
  if (skillWatchers.has(key)) return;
  const { watch } = await import("chokidar");
  const skills = scanSkills({ agentDir: PI_AGENT_DIR, cwd: key, homeDir: HOME_DIR });
  const pathsToWatch = new Set<string>();
  pathsToWatch.add(join(PI_AGENT_DIR, "settings.json"));
  pathsToWatch.add(join(key, ".pi", "settings.json")); // project 级 skills[] 同样影响列表(docs §8.5)
  for (const s of skills) pathsToWatch.add(s.sourcePath);
  pathsToWatch.add(join(key, ".pi", "skills"));
  pathsToWatch.add(join(key, ".agents", "skills"));
  pathsToWatch.add(join(PI_AGENT_DIR, "skills"));
  pathsToWatch.add(join(HOME_DIR, ".agents", "skills"));
  const projectSettingsPath = join(key, ".pi", "settings.json");
  // project settings 可能尚不存在(用户首次添加 project 级路径时才创建),chokidar 支持监听
  // 不存在的路径(监听父目录),强制保留它,否则创建那一刻收不到事件。
  const watchPaths = [...pathsToWatch].filter((p) => existsSync(p) || p === projectSettingsPath);
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

ipcMain.handle(IPC.skills.unwatch, (_e, cwd: string) => {
  const key = cwd || process.cwd();
  const w = skillWatchers.get(key);
  if (w) { w.close(); skillWatchers.delete(key); }
});

// ---- IPC: extension 管理(§6.4) ----
ipcMain.handle(IPC.extension.list, () => extensionStore.scanExtensions());
ipcMain.handle(IPC.extension.enable, (_e, source: string) => extensionStore.enable(source));
ipcMain.handle(IPC.extension.disable, (_e, source: string) => extensionStore.disable(source));
ipcMain.handle(IPC.extension.reorder, (_e, sources: string[]) => extensionStore.reorder(sources));

ipcMain.handle(IPC.extension.install, async (e, source: string) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const child = spawn("pi", ["install", source], { shell: false });
  child.stdout?.on("data", (d) => win?.webContents.send("extension:install-progress", d.toString()));
  child.stderr?.on("data", (d) => win?.webContents.send("extension:install-progress", d.toString()));
  return new Promise<{ ok: boolean; error: string | null }>((resolve) => {
    child.on("exit", (code) => {
      if (code === 0) resolve({ ok: true, error: null });
      else resolve({ ok: false, error: `pi install 退出码 ${code}` });
    });
  });
});
ipcMain.handle(IPC.extension.update, async (e, source: string) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const child = spawn("pi", ["update", source], { shell: false });
  child.stdout?.on("data", (d) => win?.webContents.send("extension:install-progress", d.toString()));
  child.stderr?.on("data", (d) => win?.webContents.send("extension:install-progress", d.toString()));
  return new Promise<{ ok: boolean; error: string | null }>((resolve) => {
    child.on("exit", (code) => {
      if (code === 0) resolve({ ok: true, error: null });
      else resolve({ ok: false, error: `pi update 退出码 ${code}` });
    });
  });
});
ipcMain.handle(IPC.extension.remove, async (e, source: string) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const child = spawn("pi", ["remove", source], { shell: false });
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
ipcMain.handle(IPC.restart.pendingSessions, () => {
  const keys = sessionStore.getRunningSessionKeys();
  return keys.map((k) => ({ sessionKey: k, state: restartCoordinator.getState(k) }));
});
ipcMain.handle(IPC.restart.restart, (_e, sessionKey: string) => restartCoordinator.restart(sessionKey));
ipcMain.handle(IPC.restart.restartAllIdle, () => restartCoordinator.restartIdlePending());

app.on("before-quit", (event) => {
  event.preventDefault();
  void sessionStore.stopAll().finally(() => app.exit());
});
