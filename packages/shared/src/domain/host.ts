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
  /** ⚠ 已知状态（r132 实测）：**契约与三个宿主实现都在，但全仓没有调用方**。
   *  取证：`onReady` 只出现在 ① 本契约 ② `src/server/host/node-host.ts`
   *  ③ `src/server/host/electron-host.ts` ④ `scripts/e2e-inmem.mjs` 的宿主桩——
   *  四处全是**声明/实现**，没有一处 `host.lifecycle.onReady(...)` 调用。
   *
   *  为什么**不删**：设计文档 `docs/design/web-service-architecture.md` §20.1 明确要求它
   *  （第 164 行的能力映射表、第 729 行的接口清单、第 735 行的语义
   *  「服务器：onReady 立即触发；Electron：app.whenReady」）。
   *  按纪律（r102）：**有文档背书的成员，删之前要先推翻文档的理由**——
   *  而这里的理由是成立的（宿主就绪是启动时序的一环，Electron 下对应 app.whenReady）。
   *
   *  所以这是一处**文档与代码的分歧**，不是单纯的死成员。两条出路（都需单独一轮验证）：
   *    ① **接上**：bootstrap 在冷启动/起 HTTP 服务之前先 `await` 宿主就绪
   *       （Electron 下这能消除"app 未 ready 就建窗口"的潜在时序问题）；
   *    ② **双删**：同时改契约与 §20.1 文档，并说明为什么不再需要宿主就绪钩子。
   *  在做出选择之前，本注释就是这处状态的单源记录（避免下一个人再花一轮重新查）。 */
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

/** 打开参考文件的结果项(文本/代码 + 图片,均按绝对路径引用;二进制不返回)。
 *  图片不读 base64——图片输入是协议/模型能力(§composer-file-attach),壳只传路径。 */
export interface HostPickedFile {
  name: string;
  path: string;
}

/** 对话框/文件选择(§20.3)。服务器宿主全部 reject UNSUPPORTED_HOST。 */
export interface HostDialog {
  openDirectory(): Promise<string | null>;
  openImages(): Promise<HostImage[]>;
  openTextFile(opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<HostTextFile | null>;
  /** 选一个或多个「可参考文件」(文本/代码 + 图片),返回绝对路径引用。二进制被跳过。 */
  openFiles(opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<HostPickedFile[]>;
  saveTextFile(opts: { name: string; content: string; filters?: { name: string; extensions: string[] }[]; defaultFileName?: string }): Promise<string | null>;
  writeImages(dir: string, images: { name: string; base64: string }[]): Promise<number>;
  saveZip(opts: { name: string; files: { name: string; base64: string }[]; defaultFileName?: string }): Promise<string | null>;
  openZip(opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<{ name: string; files: { name: string; base64: string }[] } | null>;
}

/** 打开外部资源(§20.4)。服务器宿主 reject UNSUPPORTED_HOST。 */
export interface HostShell {
  /** 用系统默认应用打开路径。打不开(文件不存在等)必须 reject,不得静默 resolve。 */
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

/** 系统明暗主题(§20.7)——Electron 的 nativeTheme;服务器宿主 no-op/固定 light。 */
export interface HostTheme {
  /** 系统当前是否深色模式。 */
  shouldUseDarkColors(): boolean;
  /** 订阅系统主题切换,返回取消函数。 */
  onThemeChanged(cb: () => void): () => void;
}

/** 宿主能力聚合(§20.8)。bootstrap 的 electron/server 各造一份注入 MainContext。 */
export interface Host {
  lifecycle: HostLifecycle;
  window: HostWindow;
  dialog: HostDialog;
  shell: HostShell;
  notify: HostNotify;
  app: HostApp;
  theme: HostTheme;
  /** process.platform;远程浏览器由前端自判 "browser"。 */
  platform: string;
}
