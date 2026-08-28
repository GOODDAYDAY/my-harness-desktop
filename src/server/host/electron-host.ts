// Electron 宿主(web-service-architecture.md §20)——Host 接口的 Electron 实现。
// 宿主能力(生命周期/窗口/对话框/通知/shell/app)是运行时环境,不是内核能力,不进 BaseBackend。
// 组装归 bootstrap:本文件 import electron(最外层),core 一行不 import 本文件。
//
// 阶段 1 单窗口:getWindow() 由 bootstrap 注入返回主窗口;阶段 2 server 宿主各方法降级。

import { app, BrowserWindow, dialog, shell, Notification, nativeTheme } from "electron";
import { writeFile, readFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import JSZip from "jszip";
import type { Host, HostImage, HostTextFile, HostPickedFile } from "@my-harness-desktop/shared";
import { classifyReferenceFile } from "@my-harness-desktop/shared";

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};

/** 组装 Electron 宿主。getWindow 返回主窗口(阶段 1 单窗口),remote 连接改用缺省降级 host。 */
export function createElectronHost(getWindow: () => BrowserWindow | null): Host {
  return {
    lifecycle: {
      onReady(cb) {
        void app.whenReady().then(cb);
      },
      onBeforeQuit(cb) {
        app.on("before-quit", (e) => cb(e as unknown as { preventDefault(): void }));
      },
      quit() {
        app.quit();
      },
    },
    window: {
      async minimize() { getWindow()?.minimize(); },
      async toggleMaximize() {
        const w = getWindow();
        if (!w) return;
        if (w.isMaximized()) w.unmaximize(); else w.maximize();
      },
      async close() { getWindow()?.close(); },
      async isMaximized() { return getWindow()?.isMaximized() ?? false; },
      async isFocused() { return getWindow()?.isFocused() ?? false; },
      onMaximizedChanged(cb) {
        // 阶段 1 单窗口:maximize/unmaximize → 回调;bootstrap 侧把它广播成 push(§19.4)。
        const w = getWindow();
        if (!w) return () => {};
        const onMax = () => cb(true);
        const onUnmax = () => cb(false);
        w.on("maximize", onMax);
        w.on("unmaximize", onUnmax);
        return () => {
          w.off("maximize", onMax);
          w.off("unmaximize", onUnmax);
        };
      },
    },
    dialog: {
      async openDirectory() {
        const w = getWindow();
        const result = w
          ? await dialog.showOpenDialog(w, { properties: ["openDirectory"] })
          : await dialog.showOpenDialog({ properties: ["openDirectory"] });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
      },
      async openImages(): Promise<HostImage[]> {
        const w = getWindow();
        const opts = {
          properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[],
          filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
        };
        const result = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
        if (result.canceled) return [];
        const out: HostImage[] = [];
        for (const p of result.filePaths) {
          const mimeType = IMAGE_MIME[extname(p).toLowerCase()];
          if (!mimeType) continue;
          if (statSync(p).size > 10 * 1024 * 1024) continue;
          out.push({ name: p.split("/").pop() ?? p, data: readFileSync(p).toString("base64"), mimeType });
        }
        return out;
      },
      async openFiles(): Promise<HostPickedFile[]> {
        const w = getWindow();
        const opts = { properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[] };
        const result = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
        if (result.canceled) return [];
        const out: HostPickedFile[] = [];
        for (const p of result.filePaths) {
          const name = p.split("/").pop() ?? p;
          // 可参考文件(文本/代码 + 图片)都按绝对路径引用返回,不读内容、不读 base64。
          // 图片输入是协议/模型能力,壳只传路径(§composer-file-attach)。
          if (classifyReferenceFile(name) !== null) out.push({ name, path: p });
        }
        return out;
      },
      async openTextFile(opts): Promise<HostTextFile | null> {
        const w = getWindow();
        const dialogOpts = { properties: ["openFile" as const], filters: opts?.filters };
        const result = w ? await dialog.showOpenDialog(w, dialogOpts) : await dialog.showOpenDialog(dialogOpts);
        if (result.canceled || result.filePaths.length === 0) return null;
        const p = result.filePaths[0];
        if (statSync(p).size > 1024 * 1024) throw new Error(`file too large (>1MB): ${p}`);
        return { name: p.split("/").pop() ?? p, content: readFileSync(p, "utf-8") };
      },
      async saveTextFile(opts) {
        const w = getWindow();
        const dialogOpts = {
          title: opts.name,
          defaultPath: opts.defaultFileName,
          filters: opts.filters ?? [{ name: "JSON", extensions: ["json"] }],
        };
        const result = w ? await dialog.showSaveDialog(w, dialogOpts) : await dialog.showSaveDialog(dialogOpts);
        if (result.canceled || !result.filePath) return null;
        await writeFile(result.filePath, opts.content, "utf-8");
        return result.filePath;
      },
      async writeImages(dir, images) {
        for (const img of images) {
          await writeFile(join(dir, img.name), Buffer.from(img.base64, "base64"));
        }
        return images.length;
      },
      async saveZip(opts) {
        try {
          const w = getWindow();
          const zip = new JSZip();
          for (const f of opts.files) zip.file(f.name, Buffer.from(f.base64, "base64"));
          const buf = await zip.generateAsync({ type: "nodebuffer" });
          const dialogOpts = { title: opts.name, defaultPath: opts.defaultFileName, filters: [{ name: "贴纸包", extensions: ["zip"] }] };
          const result = w ? await dialog.showSaveDialog(w, dialogOpts) : await dialog.showSaveDialog(dialogOpts);
          if (result.canceled || !result.filePath) return null;
          await writeFile(result.filePath, buf);
          return result.filePath;
        } catch (err) {
          console.error("[main] saveZip 失败:", err);
          throw err;
        }
      },
      async openZip(opts) {
        const w = getWindow();
        const dialogOpts = { properties: ["openFile" as const], filters: opts?.filters ?? [{ name: "贴纸包", extensions: ["zip"] }] };
        const result = w ? await dialog.showOpenDialog(w, dialogOpts) : await dialog.showOpenDialog(dialogOpts);
        if (result.canceled || result.filePaths.length === 0) return null;
        const p = result.filePaths[0];
        const data = await readFile(p);
        const zip = await JSZip.loadAsync(data);
        const files: { name: string; base64: string }[] = [];
        for (const entry of Object.values(zip.files)) {
          if (entry.dir) continue;
          const buf = await entry.async("nodebuffer");
          files.push({ name: entry.name, base64: buf.toString("base64") });
        }
        return { name: p.split("/").pop() ?? p, files };
      },
    },
    shell: {
      async openPath(path) {
        // Electron 失败不抛错而是返回错误串——不翻成 reject 的话 renderer 永远收到成功,
        // 「打开原始文件」点了没反应也不报错的根因(§1.5 不允许静默缺面)。
        const r = await shell.openPath(path);
        if (r) throw new Error(`openPath(${path}): ${r}`);
      },
      async openExternal(url) { await shell.openExternal(url); },
      async revealPath(path) { shell.showItemInFolder(path); },
    },
    notify: {
      async show(opts) {
        if (!Notification.isSupported()) return;
        const n = new Notification({ title: opts.title, body: opts.body, silent: opts.silent ?? false });
        n.on("click", () => { getWindow()?.show(); getWindow()?.focus(); });
        n.show();
      },
    },
    app: {
      async info() {
        return {
          name: app.getName(),
          version: app.getVersion(),
          electron: process.versions.electron,
          node: process.versions.node,
          chrome: process.versions.chrome,
          platform: process.platform,
          isPackaged: app.isPackaged,
        };
      },
      async restart() {
        app.relaunch();
        app.quit();
      },
    },
    theme: {
      shouldUseDarkColors: () => nativeTheme.shouldUseDarkColors,
      onThemeChanged: (cb) => {
        nativeTheme.on("updated", cb);
        return () => nativeTheme.off("updated", cb);
      },
    },
    platform: process.platform,
  };
}
