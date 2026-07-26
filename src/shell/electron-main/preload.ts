// preload 桥 —— renderer 与 main 之间的受控通道(contextBridge)。
//
// 依据 DESIGN.md §3.2.5(RendererPluginContext)、structure/16 §7.3.1。
// 暴露 scoped pi.* API:renderer 不直接拿 Node/Electron,经此受控访问。
// config(插件配置)、prefs(桌面偏好)、themes(主题列表/合并)、settings(设置槽)。
// security:contextIsolation=true,nodeIntegration=false(preload 在隔离上下文跑)。
import { contextBridge, ipcRenderer } from "electron";

/** 暴露到 renderer 的 pi 全局对象(window.pi)。 */
const pi = {
  /** 插件配置:读写 ~/.pi/desktop/plugins-data/{id}/config.json。renderer 不直接写,经此 → main → ConfigStore。 */
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
    /** 触发更新。进度经 onUpdate 行回调,完成经 onDone。listener 严格清理防泄漏(盲审 M1)。 */
    update: (
      onUpdate: (line: string) => void,
      onDone: (r: { ok: boolean; error: string | null }) => void,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const off1 = ipcRenderer.on("kernel:update-progress", (_e, line) => onUpdate(line));
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        off1();
        off2();
      };
      const off2 = ipcRenderer.on("kernel:update-done", (_e, r) => {
        cleanup();
        onDone(r);
      });
      // invoke reject / 异常时也清;done 正常路径 off2 内已清,cleanup 幂等
      return ipcRenderer.invoke("kernel:update").finally(cleanup);
    },
    /** 下载安装 pi 到 ~/.pi-desktop/pi(⚠ 偏离文档,用户要 npm install)。 */
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
      const off2 = ipcRenderer.on("kernel:install-done", (_e, r) => {
        cleanup();
        onDone(r);
      });
      return ipcRenderer.invoke("kernel:install", version).finally(cleanup);
    },
  },
};

contextBridge.exposeInMainWorld("pi", pi);

export {};
