// preload 桥 —— renderer 与 main 之间的受控通道(contextBridge)。
//
// 依据 DESIGN.md §3.2.5(RendererPluginContext)、structure/16 §7.3.1。
// 暴露 scoped pi.* API:renderer 不直接拿 Node/Electron,经此受控访问。
// config(插件配置)、prefs(桌面偏好)、themes(主题列表/合并)、settings(设置槽)。
// security:contextIsolation=true,nodeIntegration=false(preload 在隔离上下文跑)。
import { contextBridge, ipcRenderer } from "electron";

/** 暴露到 renderer 的 pi 全局对象(window.pi)。 */
const pi = {
  /** 插件配置:读写 ~/.pi-desktop/plugins-data/{id}/config.json。renderer 不直接写,经此 → main → ConfigStore。 */
  config: {
    get: <T>(pluginId: string, key: string): Promise<T | undefined> =>
      ipcRenderer.invoke("config:get", pluginId, key),
    set: (pluginId: string, key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke("config:set", pluginId, key, value),
    all: (pluginId: string): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke("config:all", pluginId),
  },
  /** 桌面偏好(electron-store):currentThemeId/fontScale/fontMono/fontSans 等。 */
  prefs: {
    get: <T>(key: string): Promise<T> => ipcRenderer.invoke("prefs:get", key),
    set: (key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke("prefs:set", key, value),
  },
  /** 主题:列表 + 合并(经 application/theme/merge)。 */
  themes: {
    list: (): Promise<{ id: string; name: string }[]> =>
      ipcRenderer.invoke("themes:list"),
    build: (
      themeId: string,
      fontScale: number,
      fontMono: string,
      fontSans: string,
    ): Promise<Record<string, string>> =>
      ipcRenderer.invoke("themes:build", themeId, fontScale, fontMono, fontSans),
  },
  /** 设置页:settings 槽贡献项列表。 */
  settings: {
    list: (): Promise<
      { id: string; title: string; component: string; pluginId: string }[]
    > => ipcRenderer.invoke("settings:list"),
  },
  /** pi 内核管理:版本状态 / registry 版本清单 / 触发更新(spawn `pi update`,底座自己更新)。 */
  kernel: {
    status: (): Promise<{
      currentVersion: string | null;
      available: boolean;
      error: string | null;
    }> => ipcRenderer.invoke("kernel:status"),
    listVersions: (forceRefresh = false): Promise<{
      versions: string[];
      latest: string | null;
    }> => ipcRenderer.invoke("kernel:listVersions", forceRefresh),
    /** 安装/切换 pi 版本到 ~/.pi-desktop/pi(覆盖式:装新=更新、装旧=降级)。
     *  进度经 onProgress,完成经 onDone。完成信号以 onDone 为准(main send done),
     *  不靠 invoke 返回值(invoke reply 与 done 事件顺序不保证,曾致 onDone 不触发卡住)。 */
    install: (
      version: string,
      onProgress: (line: string) => void,
      onDone: (r: { ok: boolean; error: string | null }) => void,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const off1 = ipcRenderer.on("kernel:install-progress", (_e, line) => onProgress(line));
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        off1();
        off2();
      };
      let resolveFn: ((r: { ok: boolean; error: string | null }) => void) | null = null;
      const off2 = ipcRenderer.on("kernel:install-done", (_e, r) => {
        // 先调 onDone 再延迟 cleanup:在监听器内同步移除 off2(自己)会中断后续
        // onDone 调用,故 onDone 先执行、cleanup 延迟到当前监听器返回后(setTimeout 0)
        try {
          onDone(r);
        } catch (e) {
          console.error("[pi-desktop] kernel install onDone threw", e);
        }
        resolveFn?.(r);
        setTimeout(() => cleanup(), 0);
      });
      const invokeP = ipcRenderer.invoke("kernel:install", version) as Promise<{ ok: boolean; error: string | null }>;
      // invoke reject/异常时也清(兜底,正常路径 onDone 触发 cleanup)
      invokeP.catch(() => cleanup());
      return new Promise((resolve) => {
        resolveFn = resolve;
        // 兜底:onDone 5 分钟未到(安装卡死)也 resolve,避免 Promise 永悬
        setTimeout(() => { if (!cleaned) { cleanup(); resolveFn?.({ ok: false, error: "安装超时" }); } }, 300000);
      });
    },
  },
  /** pi 底座 settings(读写 ~/.pi/agent/settings.json,底座标准契约)。 */
  piSettings: {
    get: (): Promise<Record<string, unknown>> => ipcRenderer.invoke("pi-settings:get"),
    set: (patch: Record<string, unknown>): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke("pi-settings:set", patch),
    /** 解析底座 .d.ts 拿当前版本所有字段(未知字段兜底用) */
    schema: (): Promise<{ key: string; type: string }[]> => ipcRenderer.invoke("pi-settings:schema"),
  },
};

contextBridge.exposeInMainWorld("pi", pi);

export {};
