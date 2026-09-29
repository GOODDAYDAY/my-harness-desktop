// buildKernel —— 从 transport 三原语构建 window.kernel(web-service-architecture.md §4/§15)。
// 原 preload.ts 的 kernel 对象整体迁来:ipcRenderer.invoke/on/removeListener → transport
// .invoke/on/off;platform 由宿主注入(纯值,不经 transport)。依赖只向内,零 electron。
// 非组件的壳代码取 i18n：用 i18next 单例（拿不到 useTranslation）。
import { i18next } from "../app/i18n-init";
import type { KernelApi } from "@my-harness-desktop/react";
import type { RemoteTransport } from "../transport/ws-transport";

import { IPC } from "@my-harness-desktop/shared";
import type { HeaderPatch, SessionToolConfig, KnownToolInfo, GitStatusResult, GitLogEntry, SessionHeaderChangedEvent, ForkOptions, SessionCapabilities, ConcurrencyMode, KernelPluginReloadReport } from "@my-harness-desktop/shared";
import type { KernelId, KernelLogo, KernelStatusView, KernelVersionApi } from "@my-harness-desktop/shared";


/** 从 RemoteTransport + 平台值构建完整 kernel API(§15.3)。Core 方法走 transport,platform 注入。
 *  kernelIds = 已注册内核清单(boot 时从 kernel.list IPC 拿,替代 KERNEL_IDS 字面量数组)。 */
export function buildKernel(transport: RemoteTransport, platform: string, kernelIds: KernelId[]): KernelApi {
/** 中性模型配置 API 的 preload 桥（pi/dsh 共用一个形状）。 */
function kernelModelsFor(kernel: KernelId) {
  return {
    list: (): Promise<unknown[]> => transport.invoke(IPC.kernelModels.list, kernel),
    set: (provider: string, detail: unknown): Promise<unknown[]> => transport.invoke(IPC.kernelModels.set, kernel, provider, detail),
    remove: (provider: string): Promise<unknown[]> => transport.invoke(IPC.kernelModels.remove, kernel, provider),
    rename: (oldId: string, newId: string): Promise<unknown[]> => transport.invoke(IPC.kernelModels.rename, kernel, oldId, newId),
    getDefault: (): Promise<unknown> => transport.invoke(IPC.kernelModels.getDefault, kernel),
    setDefault: (sel: unknown): Promise<unknown> => transport.invoke(IPC.kernelModels.setDefault, kernel, sel),
    test: (cwd: string, provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> =>
      transport.invoke(IPC.kernelModels.test, kernel, cwd, provider, modelId),
    readConfig: (): Promise<unknown> => transport.invoke(IPC.kernelModels.readConfig, kernel),
    saveConfig: (config: unknown): Promise<unknown> => transport.invoke(IPC.kernelModels.saveConfig, kernel, config),
  };
}

/** 中性内核原生配置 API 的 preload 桥（pi/dsh 共用一个形状）。 */
function kernelConfigFor(kernel: KernelId) {
  return {
    get: (): Promise<Record<string, unknown>> => transport.invoke(IPC.kernelConfig.get, kernel),
    set: (obj: Record<string, unknown>): Promise<Record<string, unknown>> => transport.invoke(IPC.kernelConfig.set, kernel, obj),
    fields: (): Promise<unknown[]> => transport.invoke(IPC.kernelConfig.fields, kernel),
  };
}

/** 内核版本管理的中性桥(带 kernel 参数):status/setCustomCliDir/listVersions/install。
 *  install 的进度/完成事件带 kernel 首参,按 kernel 过滤(避免多内核并发安装串扰)。 */
function kernelVersionFor(kernel: KernelId): KernelVersionApi {
  return {
    capabilities: () => transport.invoke(IPC.kernelVersion.capabilities, kernel),
    status: (): Promise<KernelStatusView> => transport.invoke(IPC.kernelVersion.status, kernel),
    setCustomCliDir: (dir: string) => transport.invoke(IPC.kernelVersion.setCustomCliDir, kernel, dir),
    listVersions: (forceRefresh = false) => transport.invoke(IPC.kernelVersion.listVersions, kernel, forceRefresh),
    install: (version, onProgress, onDone) => {
      const progListener = (k: KernelId, line: string): void => { if (k === kernel) onProgress(line); };
      let cleaned = false;
      const doneListener = (k: KernelId, r: { ok: boolean; error: string | null }): void => {
        if (k !== kernel) return;
        try { onDone(r); } catch (e) { console.error("[my-harness-desktop] kernel install onDone threw", e); }
        resolveFn?.(r);
        setTimeout(() => cleanup(), 0);
      };
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        transport.off(IPC.kernelVersion.installProgress, progListener);
        transport.off(IPC.kernelVersion.installDone, doneListener);
      };
      transport.on(IPC.kernelVersion.installProgress, progListener);
      transport.on(IPC.kernelVersion.installDone, doneListener);
      let resolveFn: ((r: { ok: boolean; error: string | null }) => void) | null = null;
      const invokeP = transport.invoke(IPC.kernelVersion.install, kernel, version) as Promise<{ ok: boolean; error: string | null }>;
      invokeP.catch(() => cleanup());
      return new Promise((resolve) => {
        resolveFn = resolve;
        // ⚠ 这个 error 会**显示给用户**（内核设置页的安装结果），所以文案必须走 i18n。
        //   此前写死中文 "安装超时"，en/de/zh-TW 用户会看到一句中文——而它藏在 `.ts` 里，
        //   硬编码中文守卫当时只 walk `.tsx`，所以从没被扫到（r42 扩宽了扫描范围）。
        //   这里不是 React 组件、拿不到 useTranslation，改用 i18next 单例；
        //   300 秒超时触发时 i18n 必然已初始化完毕，不存在"t 返回 key"的时序风险。
        setTimeout(() => { if (!cleaned) { cleanup(); resolveFn?.({ ok: false, error: i18next.t("shell.installTimeout") }); } }, 300000);
      });
    },
    // tool-gate 扩展可用性探测(能力探测,带 kernel 参数;后端 pi 有、dsh/minimal 无 → false)。
    toolFilterEnforced: (): Promise<boolean> => transport.invoke(IPC.kernelVersion.toolFilterEnforced, kernel),
  };
}

/** **当前**内核清单（可变；`reloadKernelIds` 会整体替换）。boot 时以传入的快照为初值。 */
let currentKernelIds: KernelId[] = [...kernelIds];

/** 三张 per-id 映射。**对象引用恒定、内容可重建**——这样 `const { kernels } = window.kernel`
 *  解构出去的引用仍然有效（重载后读到的是新内容），不需要消费者重新取一次。
 *  这正是服务端 §3.6.3 选"函数形状"要解决的同一个问题在 renderer 侧的对应解法：
 *  renderer 的契约是 `Record<KernelId, X>`（插件里写 `ctx.kernels.pi`），改成函数会波及所有插件，
 *  所以这里用"稳定引用 + 原地重建"达到同样效果。 */
const kernelVersionMap = {} as KernelApi["kernels"];
const kernelModelsMap = {} as KernelApi["kernelModels"];
const kernelConfigMap = {} as KernelApi["kernelConfig"];

function rebuildKernelMaps(ids: KernelId[]): void {
  for (const m of [kernelVersionMap, kernelModelsMap, kernelConfigMap]) {
    for (const k of Object.keys(m)) delete (m as Record<string, unknown>)[k];
  }
  for (const id of ids) {
    // 三个 *For 助手返回的是"按 IPC 频道拼出来的面"，比契约类型略松（少几个可选成员的精确类型），
    // 此前靠 `Object.fromEntries(...) as KernelApi["kernelModels"]` 整体断言掩盖；改成原地填充后
    // 断言要落在**每个赋值**上。断言的依据没变（还是那三个助手的实现），只是位置从整体挪到逐项。
    kernelVersionMap[id] = kernelVersionFor(id) as KernelApi["kernels"][KernelId];
    kernelModelsMap[id] = kernelModelsFor(id) as unknown as KernelApi["kernelModels"][KernelId];
    kernelConfigMap[id] = kernelConfigFor(id) as unknown as KernelApi["kernelConfig"][KernelId];
  }
}

// ⚠ **boot 时的初始填充**：三张映射现在是可变对象（为了引用恒定、内容可重建），
//   所以必须在构造时填一次——否则 `window.kernel.kernels` 一开始是空对象，
//   所有 `ctx.kernels.pi` 用法都会拿到 undefined（首版改造就漏了这一步，
//   靠 tsc 与 e2e 都没拦住，是 review 时发现的：空对象在类型上完全合法）。
rebuildKernelMaps(currentKernelIds);

/** 重新拉取内核清单（经 `kernel.list` IPC，main 侧是活的注册表投影）并重建三张映射。 */
async function reloadKernelIds(): Promise<KernelId[]> {
  const list = (await transport.invoke(IPC.kernel.list)) as { id: KernelId }[];
  currentKernelIds = list.map((x) => x.id);
  rebuildKernelMaps(currentKernelIds);
  return currentKernelIds;
}

// 自订阅通用刷新信号：**window.kernel 自己保证自己的新鲜度**，不依赖某个调用方记得去调
// reloadKernelIds（挂进 plugins-host 的桥接里也行，但那样"新鲜度"就成了别人的责任，
// 换一个入口装配就会漏）。语义依据见 §3.6.4：`refresh.requested` 是"外部状态变了，重探"，
// 而内核清单正是 renderer 在 boot 时探过、之后不会自己变新鲜的东西。
// 代价是每次刷新信号多一个 IPC 往返（`kernel.list` 很轻：只回 id + logo），换来的是不会 stale。
void transport.on(IPC.refresh.requested, () => { void reloadKernelIds().catch((err: unknown) => console.warn("[build-kernel] 后台操作失败(非用户动作,不弹提示):", err)); });

/** 暴露到 renderer 的 kernel 全局对象(window.kernel)。 */
const kernel = {
  /** 已注册内核 id 清单。**getter**，返回的是"最近一次拉取"的清单而不是 boot 时的定值
   *  （§3.6.4）：内核插件重载 / 装卸内核之后它会跟着变，消费者不必知道这件事。
   *  ⚠ 用 getter 而不是重新赋值整个属性，是为了让 `const { kernelIds } = window.kernel`
   *  这种解构**至少不会拿到一个再也无法更新的死数组**——解构出的仍是旧值（JS 语义如此），
   *  但直接读 `window.kernel.kernelIds` 的地方一律新鲜。要彻底摆脱解构陷阱得把契约改成
   *  函数形状（服务端 §3.6.3 就是这么做的），那会波及所有插件的 `ctx.kernel.*` 用法，
   *  本轮不做；已在契约注释里写明"以直接读属性为准"。 */
  get kernelIds(): KernelId[] {
    return currentKernelIds;
  },
  /** 重新拉取内核清单并重建三张 per-id 映射（§3.6.4）。
   *  返回拉取后的清单，方便调用方直接断言/使用。幂等、可重复调。 */
  reloadKernelIds: (): Promise<KernelId[]> => reloadKernelIds(),
  // 差量重载内核插件：main 侧按 (id,version) 对比、重跑变动内核的工厂、重建投影面、清访问器缓存。
  // 返回的变化清单是 renderer 唯一能据以更新的**权威结果**（kernelIds 快照要靠它才知道变了什么）。
  reloadKernels: async (): Promise<KernelPluginReloadReport> => {
    const report = (await transport.invoke(IPC.kernel.reload)) as KernelPluginReloadReport;
    // 重载成功后立刻自拉一次：不等 `refresh.requested` 广播绕回来（那条广播 main 侧确实会发，
    // 但"触发者自己"没必要多等一个往返；且广播是尽力而为的信号，自拉才是确定的）。
    if (report.changed) await reloadKernelIds();
    return report;
  },
  /** 插件配置:统一项目级配置通道(项目级 <cwd>/.my-harness-desktop/config/{id}.json 默认,
   *  全局 ~/.my-harness-desktop/config/{id}.json 兜底)。renderer 不直接写,经此 → main → ConfigStore。 */
  config: {
    get: <T>(pluginId: string, key: string): Promise<T | undefined> =>
      transport.invoke(IPC.config.get, pluginId, key),
    set: (pluginId: string, key: string, value: unknown, opts?: { scope?: "project" | "global" }): Promise<void> =>
      transport.invoke(IPC.config.set, pluginId, key, value, opts),
    all: (pluginId: string): Promise<Record<string, unknown>> =>
      transport.invoke(IPC.config.all, pluginId),
    getScope: (pluginId: string, scope: "project" | "global"): Promise<Record<string, unknown>> =>
      transport.invoke(IPC.config.getScope, pluginId, scope),
  },
  /** 桌面偏好(electron-store):currentThemeId/fontScale/fontMono/fontEnglish/fontChinese 等。 */
  prefs: {
    get: <T>(key: string): Promise<T> => transport.invoke(IPC.prefs.get, key),
    set: (key: string, value: unknown): Promise<void> =>
      transport.invoke(IPC.prefs.set, key, value),
    /** 偏好变更推送(第 22 项):其他端 prefs.set 后到达,本端同步主题/语言等。 */
    onChanged: (cb: (change: { key: string; value: unknown }) => void): (() => void) => {
      const listener = (change: { key: string; value: unknown }) => cb(change);
      transport.on(IPC.prefs.changed, listener);
      return () => { transport.off(IPC.prefs.changed, listener); };
    },
  },
  /** 主题:列表 + 合并(经 application/theme/merge)。 */
  themes: {
    list: (): Promise<{ id: string; name: string }[]> =>
      transport.invoke(IPC.themes.list),
    build: (
      themeId: string,
      fontScale: number,
      fontMono: string,
      fontEnglish: string,
      fontChinese: string,
    ): Promise<Record<string, string>> =>
      transport.invoke(IPC.themes.build, themeId, fontScale, fontMono, fontEnglish, fontChinese),
    /** 系统明暗变化推送(__auto__ 动态 base 重 build 用);返回清理函数。 */
    onSystemChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      transport.on(IPC.themes.systemChanged, listener);
      return () => {
        transport.off(IPC.themes.systemChanged, listener);
      };
    },
  },
  /** 字体预设:fontPresets 槽贡献项列表(theme-manager 字体 tab 查槽渲染,不感知 IPC/注册表)。 */
  fonts: {
    list: (): Promise<{ id: string; category: "mono" | "english" | "chinese"; labelKey: string; stack: string; generic?: "serif" | "sans-serif" }[]> =>
      transport.invoke(IPC.fonts.list),
  },
  /** 设置页:settings 槽贡献项列表。 */
  settings: {
    list: (): Promise<
      { id: string; title: string; icon: string; component: string; pluginId: string; configFile: string | null; configMerge: "deep" | "replace"; saveMode: "framework" | "manual" }[]
    > => transport.invoke(IPC.settings.list),
  },
  /** 槽位清单:sidePanel(右面板 Tab)/ sidebar(左栏分组)/ titlebar(标题栏按钮)。 */
  slots: {
    sidePanel: (): Promise<{ id: string; label: string; icon: string; component: string; pluginId: string; revealOn?: string }[]> =>
      transport.invoke(IPC.slots.sidePanel),
    sidebar: (): Promise<{ id: string; title: string; component: string; pluginId: string }[]> =>
      transport.invoke(IPC.slots.sidebar),
    mainView: (): Promise<{ id: string; component: string; pluginId: string }[]> =>
      transport.invoke(IPC.slots.mainView),
    titlebar: (): Promise<{ id: string; component: string; pluginId: string }[]> =>
      transport.invoke(IPC.slots.titlebar),
    fileActions: (): Promise<{ id: string; labelKey: string; icon?: string; when?: { target?: "file" | "dir" | "both" }; pluginId: string }[]> =>
      transport.invoke(IPC.slots.fileActions),
    fileIcons: (): Promise<{ id: string; icon: string; extensions?: string[]; filenames?: string[]; color?: string; pluginId: string }[]> =>
      transport.invoke(IPC.slots.fileIcons),
    messageActions: (): Promise<{ id: string; component: string; placement?: "left" | "right"; when?: { role?: string[] }; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.messageActions),
    blockRenderers: (): Promise<{ id: string; block: string; names?: string[]; component: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.blockRenderers),
    codeBlockRenderers: (): Promise<{ id: string; languages: string[]; component: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.codeBlockRenderers),
    sessionGroupings: (): Promise<{ id: string; parentPathField: string; childLabelKey?: string; childIcon?: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.sessionGroupings),
    composerPolicies: (): Promise<{ id: string; customField: string; readonlyMessageKey?: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.composerPolicies),
    composerAttachments: (): Promise<{ id: string; component: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.composerAttachments),
    composerActions: (): Promise<{ id: string; component: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.composerActions),
    composerStats: (): Promise<{ id: string; component: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.composerStats),
    composerTop: (): Promise<{ id: string; component: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.composerTop),
    composerVoice: (): Promise<{ id: string; component: string; order?: number; pluginId: string }[]> =>
      transport.invoke(IPC.slots.composerVoice),
    settingsGroups: (): Promise<{ id: string; titleKey: string; order?: number; fields: { key: string; type: "boolean" | "enum" | "int"; default?: boolean | string | number; titleKey: string; descKey?: string; options?: Array<number | { value: string; labelKey?: string }> }[]; pluginId: string }[]> =>
      transport.invoke(IPC.slots.settingsGroups),
  },
  /** 内核版本管理(中性,从 KERNEL_IDS 注册清单遍历):status/setCustomCliDir/listVersions/install。 */
  kernels: kernelVersionMap,
  /** 中性内核管理 API：模型页(kernel-design-spec.md §12.5):从 KERNEL_IDS 注册清单遍历。 */
  kernelModels: kernelModelsMap,
  /** 模型探测(发现 + ping;domain ModelProbeApi):纯 HTTP,内核无关。 */
  modelsProbe: {
    discover: (input: { baseUrl: string; apiKey?: string; api?: string }): Promise<unknown> =>
      transport.invoke(IPC.modelProbe.discover, input),
    ping: (input: { baseUrl: string; apiKey?: string; api?: string; model: string }): Promise<unknown> =>
      transport.invoke(IPC.modelProbe.ping, input),
  },
  /** 中性内核原生配置 API(kernel 配置 TAB 用):从 KERNEL_IDS 注册清单遍历。 */
  kernelConfig: kernelConfigMap,
  /** 内核身份标(logo)取回:每个内核在自己适配器声明,壳经此取回渲染(不硬编码)。 */
  kernelLogos: {
    get: (kernel: KernelId): Promise<KernelLogo> => transport.invoke(IPC.kernelLogos.get, kernel),
  },
  /** pi settings 经中性面 kernelConfig["pi"] 访问,不再暴露专属 piSettings 桥。 */
  /** i18n:语言槽合并后给 renderer init + locale 列表 + 检测(05-plugin-i18n)。 */
  i18n: {
    resources: (): Promise<{
      resources: Record<string, Record<string, Record<string, string>>>;
      ns: string[];
      supportedLngs: string[];
    }> => transport.invoke(IPC.i18n.resources),
    list: (): Promise<{ id: string; name: string }[]> => transport.invoke(IPC.i18n.list),
    detect: (navigatorLanguage: string): Promise<string> => transport.invoke(IPC.i18n.detect, navigatorLanguage),
  },
  /** 中性模型面:合流清单 + 兜底模型;pi models.json 整份读写经 kernelModels["pi"].readConfig/saveConfig。 */
  models: {
    /** 合流模型清单(各内核的模型源合流,带 kernel 标;会话流模型下拉用)。 */
    list: (): Promise<unknown[]> => transport.invoke(IPC.models.list),
    /** 中性「默认或首项模型」(新会话无显式选择时的发送兜底;不直读 pi models.json)。 */
    getFallbackModel: (): Promise<{ provider: string; model: string; kernel: KernelId } | null> =>
      transport.invoke(IPC.models.getFallbackModel),
  },
  /** 用系统默认编辑器打开文件(框架"打开配置"按钮用)。 */
  openFile: (path: string): Promise<void> => transport.invoke(IPC.misc.openFile, path),
  /** 在系统文件管理器中显示该路径(核心默认,与 openFile 同级)。 */
  revealPath: (path: string): Promise<void> => transport.invoke(IPC.misc.revealPath, path),
  /** 通用 JSON 配置文件读写(框架级配置管理)。 */
  configFile: {
    get: (path: string): Promise<Record<string, unknown>> => transport.invoke(IPC.configFile.get, path),
    set: (path: string, data: Record<string, unknown>, mergeMode: "deep" | "replace"): Promise<Record<string, unknown>> =>
      transport.invoke(IPC.configFile.set, path, data, mergeMode),
    getLayered: (cwd: string, relPath: string): Promise<Record<string, unknown> | null> =>
      transport.invoke(IPC.configFile.getLayered, cwd, relPath),
    getProject: (cwd: string, relPath: string): Promise<Record<string, unknown> | null> =>
      transport.invoke(IPC.configFile.getProject, cwd, relPath),
    setProject: (cwd: string, relPath: string, data: Record<string, unknown>, mode: "deep" | "replace"): Promise<Record<string, unknown>> =>
      transport.invoke(IPC.configFile.setProject, cwd, relPath, data, mode),
    clearProject: (cwd: string, relPath: string): Promise<void> =>
      transport.invoke(IPC.configFile.clearProject, cwd, relPath),
    /** 追加一行 JSONL(白名单内;条目形状是内容层的事,通道中性)。 */
    append: (path: string, entry: Record<string, unknown>): Promise<void> =>
      transport.invoke(IPC.configFile.append, path, entry),
    /** 读白名单内文件为 base64(不存在返回 null)。 */
    readBinary: (path: string): Promise<string | null> =>
      transport.invoke(IPC.configFile.readBinary, path),
    /** 写二进制文件(base64 解码后落盘;白名单内)。 */
    writeBinary: (path: string, base64: string): Promise<void> =>
      transport.invoke(IPC.configFile.writeBinary, path, base64),
  },
  /** 会话能力(核心):生命周期 + 消息发送 + 模型 + 树 + 维护 + 队列 + bash。 */
  sessions: {
    // SessionsApi(生命周期)
    start: (cwd: string, sessionPath?: string): Promise<{ ok: boolean }> =>
      transport.invoke(IPC.session.start, cwd, sessionPath),
    stop: (sessionPath?: string | null): Promise<{ ok: boolean }> => transport.invoke(IPC.session.stop, sessionPath),
    setContext: (cwd: string, sessionPath: string | null): Promise<void> =>
      transport.invoke(IPC.session.setContext, cwd, sessionPath),
    getSnapshot: (): Promise<unknown> => transport.invoke(IPC.session.getSnapshot),
    sync: (): Promise<unknown> => transport.invoke(IPC.session.sync),
    switchKernel: (target: KernelId): Promise<void> => transport.invoke(IPC.session.switchKernel, target),
    // 类型从圆心 import,不在此内联重写(此前是本地副本,圆心一改就漂——§1.3 契约单源)
    getCapabilities: (): Promise<SessionCapabilities> => transport.invoke(IPC.session.getCapabilities),
    openSession: (sessionPath: string): Promise<unknown> =>
      transport.invoke(IPC.session.open, sessionPath),
    readToolConfig: (sessionPath: string): Promise<SessionToolConfig | null> =>
      transport.invoke(IPC.session.readToolConfig, sessionPath),
    renameSession: (sessionPath: string, name: string): Promise<{ ok: boolean }> =>
      transport.invoke(IPC.session.rename, sessionPath, name),
    updateHeader: (sessionPath: string, patch: HeaderPatch): Promise<{ ok: boolean }> =>
      transport.invoke(IPC.session.updateHeader, sessionPath, patch),
    // 中立层会话注解(机制面):只写中立层不进内核,渲染由 messageRenderers 槽按 role 认领
    annotate: (sessionPath: string, customType: string, content: string): Promise<void> =>
      transport.invoke(IPC.session.annotate, sessionPath, customType, content),
    deleteSessions: (paths: string[]): Promise<{ ok: boolean }> =>
      transport.invoke(IPC.session.delete, paths),
    list: (cwd: string): Promise<unknown[]> => transport.invoke(IPC.sessions.list, cwd),
    rawFilePaths: (sessionId: string): Promise<{ desktop: string | null; kernel: string | null }> =>
      transport.invoke(IPC.sessions.rawFilePaths, sessionId),
    projectStats: (cwd: string): Promise<unknown> => transport.invoke(IPC.sessions.projectStats, cwd),
    getTree: (sessionId: string): Promise<unknown> => transport.invoke(IPC.sessions.getTree, sessionId),
    bookmark: (sessionPath: string, entryId: string, id: string, label: string, preview: string): Promise<unknown> => transport.invoke(IPC.sessions.bookmark, sessionPath, entryId, id, label, preview),
    resume: (snapshotId: string): Promise<unknown> => transport.invoke(IPC.sessions.resume, snapshotId),
    deleteBookmark: (snapshotId: string): Promise<unknown> => transport.invoke(IPC.sessions.deleteBookmark, snapshotId),
    onEvent: (cb: (event: unknown) => void): (() => void) => {
      const listener = (event: unknown) => cb(event);
      transport.on(IPC.session.event, listener);
      return () => { transport.off(IPC.session.event, listener); };
    },
    /** 列表行变更推送(归档/置顶/改名/删除,第 21 项):payload 自带补丁,订阅方本地打行(copy 例外重拉)。 */
    onHeaderChanged: (cb: (info: SessionHeaderChangedEvent) => void): (() => void) => {
      const listener = (info: unknown) => cb(info as SessionHeaderChangedEvent);
      transport.on(IPC.session.headerChanged, listener);
      return () => { transport.off(IPC.session.headerChanged, listener); };
    },
    onKernelEvent: (cb: (event: unknown) => void): (() => void) => {
      const listener = (event: unknown) => cb(event);
      transport.on(IPC.session.kernelEvent, listener);
      return () => { transport.off(IPC.session.kernelEvent, listener); };
    },
    onQuestion: (cb: (req: unknown) => void): (() => void) => {
      const listener = (req: unknown) => cb(req);
      transport.on(IPC.session.question, listener);
      return () => { transport.off(IPC.session.question, listener); };
    },
    answerQuestion: (requestId: string, answers: unknown): Promise<void> =>
      transport.invoke(IPC.session.answerQuestion, requestId, answers),
    getPendingQuestions: (): Promise<unknown> =>
      transport.invoke(IPC.session.pendingQuestions),
    listTools: (): Promise<unknown> =>
      transport.invoke(IPC.session.listTools),
    onSnapshot: (cb: (snapshot: unknown) => void): (() => void) => {
      const listener = (snapshot: unknown) => cb(snapshot);
      transport.on(IPC.session.snapshot, listener);
      return () => { transport.off(IPC.session.snapshot, listener); };
    },
    /** 中立层基线读 + 变更订阅(session-single-source §3.2,渲染层镜像的数据源)。 */
    getNeutral: (ns: string): Promise<unknown> => transport.invoke(IPC.sessions.getNeutral, ns),
    onNeutralChange: (cb: (change: unknown) => void): (() => void) => {
      const listener = (change: unknown) => cb(change);
      transport.on(IPC.session.neutralChange, listener);
      return () => { transport.off(IPC.session.neutralChange, listener); };
    },
    // MessagingApi
    prompt: (text: string, images?: { data: string; mimeType: string; name?: string }[], display?: { image?: { src: string; title?: string } }, prefs?: unknown): Promise<void> =>
      transport.invoke(IPC.session.prompt, text, images, display, prefs),
    abort: (): Promise<void> => transport.invoke(IPC.session.abort),
    // ModelApi
    getModels: (): Promise<unknown[]> => transport.invoke(IPC.session.getModels),
    setModel: (provider: string, modelId: string, kernel: KernelId): Promise<void> =>
      transport.invoke(IPC.session.setModel, provider, modelId, kernel),
    // 模型连通性测试(内核隔离临时会话,不碰激活会话)
    testModel: (cwd: string, provider: string, modelId: string, kernel: KernelId): Promise<{ ok: boolean; error?: string }> =>
      transport.invoke(IPC.session.testModel, cwd, provider, modelId, kernel),
    setThinkingLevel: (level: string): Promise<void> =>
      transport.invoke(IPC.session.setThinkingLevel, level),
    // SessionTreeApi
    fork: (parentLineageId: string, boundary?: string, position?: "before" | "at", opts?: ForkOptions): Promise<string> => transport.invoke(IPC.session.fork, parentLineageId, boundary, position, opts),
    // 中性树面(session-single-source §4.2 + unify §7.1):壳的实现,与内核无关。
    // forkFromSession 已从 pi 扩展面收编(同一 deriveSession 派生核,dsh 也可分叉)。
    forkFromSession: (srcNs: string, entryId: string, position?: "before" | "at", opts?: ForkOptions): Promise<string> =>
      transport.invoke(IPC.session.forkFromSession, srcNs, entryId, position, opts) as Promise<string>,
    clone: (): Promise<void> => transport.invoke(IPC.session.clone),
    getForkMessages: (entryId: string): Promise<unknown[]> => transport.invoke(IPC.session.getForkMessages, entryId),
    // SessionMaintenanceApi
    getStats: (): Promise<unknown> => transport.invoke(IPC.session.getStats),
    // QueueModeApi
    // BashApi (需声明 rpc:bash 权限)
    runBash: (command: string, excludeFromContext?: boolean): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
      transport.invoke(IPC.session.runBash, command, excludeFromContext),
    abortBash: (): Promise<void> => transport.invoke(IPC.session.abortBash),
    // ⚠ 此处曾是 `pi: { … }` 分组（还附了一段「不要因为组名叫 pi 就判定这里写死了内核身份，
    // 判据看它打到哪个 IPC」的注释）——**需要一段注释来解释「为什么这个内核名不是内核身份」，
    // 本身就说明名字错了**。已平铺：这一层是原始 IPC 面，每个方法本就有自己的 channel，
    // 分组不提供信息、只把内核名带进壳的公开 API。语义分组在 PluginContext 那层。
    steer: (text: string, images?: { data: string; mimeType: string; name?: string }[]): Promise<void> =>
      transport.invoke(IPC.session.steer, text, images),
    followUp: (text: string, images?: { data: string; mimeType: string; name?: string }[]): Promise<void> =>
      transport.invoke(IPC.session.followUp, text, images),
    abortRetry: (): Promise<void> => transport.invoke(IPC.session.abortRetry),
    cycleModel: (): Promise<void> => transport.invoke(IPC.session.cycleModel),
    getThinkingLevels: (): Promise<string[]> => transport.invoke(IPC.session.getThinkingLevels),
    cycleThinkingLevel: (): Promise<void> => transport.invoke(IPC.session.cycleThinkingLevel),
    compact: (customInstructions?: string): Promise<void> => transport.invoke(IPC.session.compact, customInstructions),
    setAutoCompaction: (enabled: boolean): Promise<void> => transport.invoke(IPC.session.setAutoCompaction, enabled),
    setAutoRetry: (enabled: boolean): Promise<void> => transport.invoke(IPC.session.setAutoRetry, enabled),
    getLastAssistantText: (): Promise<string> => transport.invoke(IPC.session.getLastAssistantText),
    setSteeringMode: (mode: ConcurrencyMode): Promise<void> => transport.invoke(IPC.session.setSteeringMode, mode),
    setFollowUpMode: (mode: ConcurrencyMode): Promise<void> => transport.invoke(IPC.session.setFollowUpMode, mode),
    // SessionSnapshotApi
    copySession: (srcPath: string, targetPath: string): Promise<void> =>
      transport.invoke(IPC.session.copySession, srcPath, targetPath),
  },
  /** Session Bus 能力(声明 sessions:bus 权限后可用;pluginId 首参,main 门控)。 */
  bus: {
    status: (pluginId: string): Promise<unknown> => transport.invoke(IPC.bus.status, pluginId),
    send: (pluginId: string, to: string, kind: string, payload: unknown, replyTo?: string): Promise<{ delivered: string }> =>
      transport.invoke(IPC.bus.send, pluginId, to, kind, payload, replyTo),
    sessionCreate: (pluginId: string, opts: { task?: string; cwd?: string; name?: string; model?: { provider: string; modelId: string }; toolConfig?: unknown; watch?: boolean; channels?: string[] }): Promise<unknown> =>
      transport.invoke(IPC.bus.sessionCreate, pluginId, opts),
    sessionAbort: (pluginId: string, session: string): Promise<unknown> =>
      transport.invoke(IPC.bus.sessionAbort, pluginId, session),
    channelMember: (pluginId: string, channel: string, action: "join" | "leave", member?: string): Promise<unknown> =>
      transport.invoke(IPC.bus.channelMember, pluginId, channel, action, member),
    tapStart: (pluginId: string, opts: { session?: string; channel?: string; filter?: "done" | "lifecycle" | "stream"; deliverTo?: string }): Promise<{ tapId: string; filter: string }> =>
      transport.invoke(IPC.bus.tapStart, pluginId, opts),
    tapStop: (pluginId: string, tapId?: string): Promise<unknown> =>
      transport.invoke(IPC.bus.tapStop, pluginId, tapId),
    onMessage: (cb: (message: unknown) => void): (() => void) => {
      const listener = (message: unknown) => cb(message);
      transport.on(IPC.bus.event, listener);
      return () => { transport.off(IPC.bus.event, listener); };
    },
  },
  /** fs:project 能力(声明 permissions 后可用;pluginId 首参,main 门控)。 */
  fs: {
    listDir: (pluginId: string, cwd: string): Promise<{ name: string; isDir: boolean }[]> =>
      transport.invoke(IPC.fs.listDir, pluginId, cwd),
    removePath: (pluginId: string, path: string): Promise<void> =>
      transport.invoke(IPC.fs.removePath, pluginId, path),
    readDirTree: (pluginId: string, cwd: string, opts?: { maxDepth?: number; ignore?: string[] }): Promise<{ name: string; isDir: boolean; children?: unknown[] }> =>
      transport.invoke(IPC.fs.readDirTree, pluginId, cwd, opts),
    readFile: (pluginId: string, path: string): Promise<string> =>
      transport.invoke(IPC.fs.readFile, pluginId, path),
    readFileBase64: (pluginId: string, path: string): Promise<string> =>
      transport.invoke(IPC.fs.readFileBase64, pluginId, path),
    createFile: (pluginId: string, path: string): Promise<void> =>
      transport.invoke(IPC.fs.createFile, pluginId, path),
    createDir: (pluginId: string, path: string): Promise<void> =>
      transport.invoke(IPC.fs.createDir, pluginId, path),
    renamePath: (pluginId: string, from: string, to: string): Promise<void> =>
      transport.invoke(IPC.fs.renamePath, pluginId, from, to),
    copyPath: (pluginId: string, from: string, to: string): Promise<void> =>
      transport.invoke(IPC.fs.copyPath, pluginId, from, to),
  },
  /** git:read 能力(声明 permissions 后可用;pluginId 首参,main 门控)。 */
  git: {
    status: (pluginId: string, cwd: string): Promise<GitStatusResult> =>
      transport.invoke(IPC.git.status, pluginId, cwd),
    fileDiff: (pluginId: string, cwd: string, path: string): Promise<string> =>
      transport.invoke(IPC.git.fileDiff, pluginId, cwd, path),
    fileContent: (pluginId: string, cwd: string, path: string): Promise<string> =>
      transport.invoke(IPC.git.fileContent, pluginId, cwd, path),
    log: (pluginId: string, cwd: string, limit: number): Promise<GitLogEntry[]> =>
      transport.invoke(IPC.git.log, pluginId, cwd, limit),
  },
  /** git:write 能力(收敛面:commit/push;pluginId 首参,main 门控)。 */
  gitWrite: {
    commit: (pluginId: string, cwd: string, message: string, files: string[]): Promise<{ ok: boolean; hash?: string; error?: string }> =>
      transport.invoke(IPC.git.commit, pluginId, cwd, message, files),
    push: (pluginId: string, cwd: string): Promise<{ ok: boolean; error?: string }> =>
      transport.invoke(IPC.git.push, pluginId, cwd),
  },
  /** llm:oneshot 能力(一次性问内核;pluginId 首参,main 门控)。 */
  llm: {
    oneshot: (pluginId: string, prompt: string): Promise<string> =>
      transport.invoke(IPC.llm.oneshot, pluginId, prompt),
  },
  /** 对话框(用户手势驱动)。 */
  dialog: {
    openDirectory: (): Promise<string | null> => transport.invoke(IPC.dialog.openDirectory),
    openImages: (): Promise<{ name: string; data: string; mimeType: string }[]> =>
      transport.invoke(IPC.dialog.openImages),
    openFiles: (opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<{ name: string; path: string }[]> =>
      transport.invoke(IPC.dialog.openFiles, opts),
    openTextFile: (opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<{ name: string; content: string } | null> =>
      transport.invoke(IPC.dialog.openTextFile, opts),
    saveTextFile: (opts: { name: string; content: string; filters?: { name: string; extensions: string[] }[]; defaultFileName?: string }): Promise<string | null> =>
      transport.invoke(IPC.dialog.saveTextFile, opts),
    writeImages: (dir: string, images: { name: string; base64: string }[]): Promise<number> =>
      transport.invoke(IPC.dialog.writeImages, dir, images),
    saveZip: (opts: { name: string; files: { name: string; base64: string }[]; defaultFileName?: string }): Promise<string | null> =>
      transport.invoke(IPC.dialog.saveZip, opts),
    openZip: (opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<{ name: string; files: { name: string; base64: string }[] } | null> =>
      transport.invoke(IPC.dialog.openZip, opts),
  },
  /** Skills 管理（核心默认能力）。 */
  skills: {
    list: (cwd: string): Promise<unknown[]> => transport.invoke(IPC.skills.list, cwd),
    getCapabilities: (): Promise<unknown> => transport.invoke(IPC.skills.getCapabilities),
    setEnabled: (skill: unknown, enabled: boolean): Promise<void> =>
      transport.invoke(IPC.skills.setEnabled, { skill, enabled }),
    setModelInvocable: (skill: unknown, value: boolean): Promise<void> =>
      transport.invoke(IPC.skills.setModelInvocable, { skill, value }),
    getBundled: (): Promise<{ path: string; enabled: boolean }> =>
      transport.invoke(IPC.skills.getBundled),
    setBundledEnabled: (enabled: boolean): Promise<void> =>
      transport.invoke(IPC.skills.setBundledEnabled, enabled),
    watch: (cwd: string, onChanged: () => void): (() => void) => {
      const listener = () => onChanged();
      transport.on(IPC.skills.changed, listener);
      transport.invoke(IPC.skills.watch, cwd);
      return () => {
        transport.off(IPC.skills.changed, listener);
        transport.invoke(IPC.skills.unwatch, cwd);
      };
    },
  },
  plugins: {
    list: (): Promise<unknown[]> => transport.invoke(IPC.plugins.list),
    enable: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      transport.invoke(IPC.plugins.enable, pluginId),
    disable: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      transport.invoke(IPC.plugins.disable, pluginId),
    uninstall: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      transport.invoke(IPC.plugins.uninstall, pluginId),
    reload: (pluginId: string): Promise<{ ok: boolean; error: string | null }> =>
      transport.invoke(IPC.plugins.reload, pluginId),
    /** 插件 renderer 模块加载失败时上报：主进程撤注册 + 记 error 态 + 广播 pluginsChanged。 */
    reportLoadFailed: (pluginId: string): Promise<void> =>
      transport.invoke(IPC.plugins.loadFailed, pluginId),
    install: (source: { type: "url" | "local"; location: string }): Promise<{ ok: boolean; error: string | null }> =>
      transport.invoke(IPC.plugins.install, source),
    onUnloaded: (cb: (pluginId: string, components: string[]) => void): (() => void) => {
      const listener = (data: { pluginId: string; components: string[] }) => cb(data.pluginId, data.components);
      transport.on(IPC.plugin.unloaded, listener);
      return () => { transport.off(IPC.plugin.unloaded, listener); };
    },
    onPluginsChanged: (cb: (nonce: number) => void): (() => void) => {
      const listener = (nonce: number) => cb(nonce);
      transport.on(IPC.plugins.changed, listener);
      return () => { transport.off(IPC.plugins.changed, listener); };
    },
  },
  /** settings.json 被外部写入(如 skill-toggle 改 skills 字段)的通知,settings-page 订阅后重读(评估 P1-E 失同步修复)。 */
  onSettingsChanged: (cb: () => void): (() => void) => {
    const listener = () => cb();
    transport.on(IPC.settings.changed, listener);
    return () => { transport.off(IPC.settings.changed, listener); };
  },
  /** 通用刷新信号(装/升/降级内核、自定义内核路径变更等操作完成):消费方(会话流)
   *  收到后重探挂载时探测的外部状态,不用重启。契约单源 IPC.refresh.requested,
   *  语义不绑具体资源——将来 tool-gate 安装等操作完成后也发这个。 */
  onRefreshRequested: (cb: () => void): (() => void) => {
    const listener = () => cb();
    transport.on(IPC.refresh.requested, listener);
    return () => { transport.off(IPC.refresh.requested, listener); };
  },
  /** 内核拓展管理(中性,按 kernel 作用域):pi/dsh 各交一个 KernelExtensionSource。 */
  kernelExtensions: {
    capabilities: (kernel: string): Promise<unknown> => transport.invoke(IPC.kernelExtensions.capabilities, kernel),
    list: (kernel: string): Promise<unknown[]> => transport.invoke(IPC.kernelExtensions.list, kernel),
    enable: (kernel: string, id: string): Promise<void> => transport.invoke(IPC.kernelExtensions.enable, kernel, id),
    disable: (kernel: string, id: string): Promise<void> => transport.invoke(IPC.kernelExtensions.disable, kernel, id),
    install: (
      kernel: string,
      source: string,
      onProgress: (line: string) => void,
    ): Promise<{ ok: boolean; error?: string }> => {
      const progListener = (line: string) => onProgress(line);
      transport.on(IPC.kernelExtensions.installProgress, progListener);
      return transport.invoke(IPC.kernelExtensions.install, kernel, source).finally(() => {
        transport.off(IPC.kernelExtensions.installProgress, progListener);
      });
    },
    uninstall: (
      kernel: string,
      id: string,
      onProgress: (line: string) => void,
    ): Promise<{ ok: boolean; error?: string }> => {
      const progListener = (line: string) => onProgress(line);
      transport.on(IPC.kernelExtensions.installProgress, progListener);
      return transport.invoke(IPC.kernelExtensions.uninstall, kernel, id).finally(() => {
        transport.off(IPC.kernelExtensions.installProgress, progListener);
      });
    },
  },
  restart: {
    pendingSessions: (): Promise<{ sessionKey: string; state: unknown }[]> =>
      transport.invoke(IPC.restart.pendingSessions),
    restart: (sessionKey: string): Promise<void> => transport.invoke(IPC.restart.restart, sessionKey),
    restartAllIdle: (): Promise<void> => transport.invoke(IPC.restart.restartAllIdle),
    onStateChange: (cb: (sessionKey: string, state: unknown) => void): (() => void) => {
      const listener = (sessionKey: string, state: unknown) => cb(sessionKey, state);
      transport.on(IPC.restart.state, listener);
      return () => { transport.off(IPC.restart.state, listener); };
    },
  },
  /** 运行平台(platform 直传):renderer 平台分支用(标题栏自绘按钮等)。 */
  platform: platform,
  /** 应用基本信息(name/version/electron/node/chrome/isPackaged)。 */
  app: {
    info: (): Promise<{
      name: string; version: string; electron: string; node: string; chrome: string;
      platform: string; isPackaged: boolean;
    }> => transport.invoke(IPC.app.info),
    /** 整 App 重启,退出链路同手动退出(经 before-quit 回收 pi 子进程)。 */
    restart: (): Promise<void> => transport.invoke(IPC.app.restart),
  },
  /** 系统通知(mac 通知中心 / win toast / linux libnotify):纯机制,文案由调用方传。 */
  notify: {
    show: (opts: { title: string; body: string; silent?: boolean }): Promise<void> =>
      transport.invoke(IPC.notification.show, opts),
  },
  /** 窗口控制(win/linux 自绘标题栏按钮用;mac 红绿灯原生,不消费)。 */
  window: {
    minimize: (): Promise<void> => transport.invoke(IPC.window.minimize),
    toggleMaximize: (): Promise<void> => transport.invoke(IPC.window.toggleMaximize),
    close: (): Promise<void> => transport.invoke(IPC.window.close),
    isMaximized: (): Promise<boolean> => transport.invoke(IPC.window.isMaximized),
    isFocused: (): Promise<boolean> => transport.invoke(IPC.window.isFocused),
    onMaximizedChanged: (cb: (maximized: boolean) => void): (() => void) => {
      const listener = (maximized: boolean) => cb(maximized);
      transport.on(IPC.window.maximizedChanged, listener);
      return () => { transport.off(IPC.window.maximizedChanged, listener); };
    },
  },
  /** 远程访问控制面(§18.6)。 */
  remote: {
    status: (): Promise<unknown> => transport.invoke(IPC.remote.status),
    start: (): Promise<unknown> => transport.invoke(IPC.remote.start),
    stop: (): Promise<unknown> => transport.invoke(IPC.remote.stop),
    setPassword: (password: string): Promise<unknown> => transport.invoke(IPC.remote.setPassword, password),
    refreshPassword: (): Promise<unknown> => transport.invoke(IPC.remote.refreshPassword),
    setLanPasswordEnabled: (enabled: boolean): Promise<unknown> => transport.invoke(IPC.remote.setLanPasswordEnabled, enabled),
    qr: (): Promise<string | null> => transport.invoke(IPC.remote.qr),
    onStateChanged: (cb: (state: unknown) => void): (() => void) => {
      const listener = (...args: unknown[]) => cb(args[0]);
      transport.on(IPC.remote.stateChanged, listener);
      return () => { transport.off(IPC.remote.stateChanged, listener); };
    },
    // 设备管理(第 23/24 项):已连接设备清单 + 踢单个/踢全部 + 增减推送。
    connections: (): Promise<unknown> => transport.invoke(IPC.remote.connections),
    kick: (id: string): Promise<{ ok: boolean }> => transport.invoke(IPC.remote.kick, id),
    kickAll: (): Promise<{ ok: boolean; kicked: number }> => transport.invoke(IPC.remote.kickAll),
    onConnectionsChanged: (cb: (list: unknown) => void): (() => void) => {
      const listener = (...args: unknown[]) => cb(args[0]);
      transport.on(IPC.remote.connectionsChanged, listener);
      return () => { transport.off(IPC.remote.connectionsChanged, listener); };
    },
  },
};

  return kernel as KernelApi;
}
