// Node 服务器宿主(web-service-architecture.md §5.2/§20)——Host 接口的缺省降级实现。
// 窗口/对话框/shell 全 UNSUPPORTED_HOST;notify no-op;lifecycle 绑 SIGINT/SIGTERM;app 纯 Node。
// 依赖只向内:本文件 import node 内置 + core/domain 的 Host 接口,不 import electron。

import type { Host } from "@my-harness-desktop/shared";

/** 宿主能力缺失的统一拒绝(§10.1 显式降级,不静默、不伪造成功)。 */
const unsupported = (name: string) => () => Promise.reject(new Error(`${name}: UNSUPPORTED_HOST`));

/** 组装 Node 服务器宿主。无窗口、无对话框、无 shell,notify no-op,app 纯 Node。 */
export function createNodeHost(): Host {
  return {
    lifecycle: {
      onReady(cb) {
        cb(); // 服务器宿主立即就绪(§20.1)
      },
      onBeforeQuit(cb) {
        process.on("SIGINT", () => cb({ preventDefault: () => {} }));
        process.on("SIGTERM", () => cb({ preventDefault: () => {} }));
      },
      quit() {
        process.exit(0);
      },
    },
    window: {
      minimize: unsupported("window.minimize"),
      toggleMaximize: unsupported("window.toggleMaximize"),
      close: unsupported("window.close"),
      isMaximized: unsupported("window.isMaximized"),
      isFocused: unsupported("window.isFocused"),
      onMaximizedChanged: () => () => {}, // no-op(§20.2)
    },
    dialog: {
      openDirectory: unsupported("dialog.openDirectory"),
      openImages: unsupported("dialog.openImages"),
      openTextFile: unsupported("dialog.openTextFile"),
      saveTextFile: unsupported("dialog.saveTextFile"),
      writeImages: unsupported("dialog.writeImages"),
      saveZip: unsupported("dialog.saveZip"),
      openZip: unsupported("dialog.openZip"),
    },
    shell: {
      openPath: unsupported("shell.openPath"),
      openExternal: unsupported("shell.openExternal"),
      revealPath: unsupported("shell.revealPath"),
    },
    notify: {
      async show() {
        // no-op(§20.5;可选接第三方通知库,v1 不做)
      },
    },
    app: {
      async info() {
        return {
          name: "my-harness-desktop",
          version: "0.5.0-beta",
          electron: null,
          node: process.versions.node,
          chrome: null,
          platform: process.platform,
          isPackaged: false,
        };
      },
      restart: unsupported("app.restart"),
    },
    platform: process.platform,
  };
}
