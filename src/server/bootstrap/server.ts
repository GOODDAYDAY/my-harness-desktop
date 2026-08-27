// Node 服务器入口(web-service §23.2)——`node out/server/index.js` 无 Electron 环境起后端。
// 共享组装在 assemble.ts,此处只注入 Node 宿主(§5.4)+ 绑信号优雅退出。
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assemble } from "./assemble";
import { createNodeHost } from "../host/node-host";

const __dirname = dirname(fileURLToPath(import.meta.url));
const host = createNodeHost();
// rendererDir 由入口算:__dirname 恒为 out/main(入口非 chunk),../renderer 指向 out/renderer。
const assembled = assemble(host, { isPackaged: false, rendererDir: resolve(__dirname, "../renderer") });

// 优雅退出:SIGINT/SIGTERM → stopAll(停所有内核进程)→ quit(node-host 的 lifecycle 已绑信号)。
host.lifecycle.onBeforeQuit(() => {
  void assembled.sessionStore.stopAll().finally(() => host.lifecycle.quit());
});
