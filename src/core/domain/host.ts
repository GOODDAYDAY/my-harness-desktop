// 宿主能力接口(web-service-architecture.md §20)——运行时环境适配(Electron/Node 服务器)。
// 这是「机制而非内容」:宿主只提供生命周期/窗口/对话框/通知等环境能力,不含业务逻辑。
//
// 依赖倒置:接口在圆心(此处),实现在 bootstrap/host/{electron,node}.ts。handler 经
// conn.host 访问;HostKernelApi 由 buildKernel 的第二参注入(§20.8)。
//
// 注意:宿主能力不是内核能力——不进 BaseBackend、不进内核专属扩展面。远程连接的
// host 是「缺省降级实现」(UNSUPPORTED_HOST/no-op),本机 Electron 连接是完整实现。

import type { AppInfo } from "./context";

/** 应用生命周期(§20.1)。 */
export interface HostLifecycle {
  onReady(cb: () => void): void;
  onBeforeQuit(cb: (e: { preventDefault(): void }) => void): void;
  quit(): void;
}

/** 窗口控制(§20.2)。服务器宿主全部 reject UNSUPPORTED_HOST,onMaximizedChanged 返回 no-op。 */
export interface HostWindow {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  isFocused(): Promise<boolean>;
  onMaximizedChanged(cb: (m: boolean) => void): () => void;
}

/** 打开图片的结果项。 */
export interface HostImage { name: string; data: string; mimeType: string; }

/** 打开文本文件的结果。 */
export interface HostTextFile { name: string; content: string; }

/** 对话框/文件选择(§20.3)。服务器宿主全部 reject UNSUPPORTED_HOST。 */
export interface HostDialog {
  openDirectory(): Promise<string | null>;
  openImages(): Promise<HostImage[]>;
  openTextFile(opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<HostTextFile | null>;
  saveTextFile(opts: { defaultName?: string; content: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  writeImages(dir: string, images: { name: string; base64: string }[]): Promise<number>;
  saveZip(opts: { defaultName?: string; files: { name: string; base64: string }[] }): Promise<string | null>;
  openZip(opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<{ name: string; files: { name: string; base64: string }[] } | null>;
}

/** 打开外部资源(§20.4)。服务器宿主 reject UNSUPPORTED_HOST。 */
export interface HostShell {
  openPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;
}

/** 系统通知(§20.5)。服务器宿主 no-op。 */
export interface HostNotify {
  show(opts: { title: string; body: string; silent?: boolean }): Promise<void>;
}

/** 应用信息 + 重启(§20.6)。 */
export interface HostApp {
  info(): Promise<AppInfo>;
  restart(): Promise<void>;
}

/** 宿主能力聚合(§20.8)。bootstrap 的 electron/server 各造一份注入 MainContext。 */
export interface Host {
  lifecycle: HostLifecycle;
  window: HostWindow;
  dialog: HostDialog;
  shell: HostShell;
  notify: HostNotify;
  app: HostApp;
  /** process.platform;远程浏览器由前端自判 "browser"。 */
  platform: string;
}
