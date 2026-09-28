// Node 服务器入口(web-service §23.2)——`node out/server/index.js` 无 Electron 环境起后端。
// 共享组装在 assemble.ts,此处只注入 Node 宿主(§5.4)+ 绑信号优雅退出。
//
// ⚠ `assemble` 是 async（启动编排步骤化之后必然如此，理由见 assemble.ts 文件头），
// 所以本入口持的是 Promise。两条纪律：
//   ① **必须挂 `.catch`**——服务器宿主无 GUI，致命启动失败的呈现方式是"日志 + 非零退出码"
//      （设计文档 §4.3.4 的入口接手表）。不挂 catch 就是未捕获拒绝，进程停在半死状态。
//   ② `onBeforeQuit` 必须容忍 assemble 尚未完成（启动失败时它永远不会完成）：
//      经 Promise 链收尾，任何一步失败都仍要 `quit()`，否则进程退不出去。
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assemble } from "./assemble";
import { createNodeHost } from "../host/node-host";

const __dirname = dirname(fileURLToPath(import.meta.url));
const host = createNodeHost();
// rendererDir 由入口算:__dirname 恒为 out/main(入口非 chunk),../renderer 指向 out/renderer。
const assembled = assemble(host, { isPackaged: false, rendererDir: resolve(__dirname, "../renderer") });

// 致命启动失败：打日志 + 非零退出码（服务器宿主的正确呈现方式）。
void assembled.catch((e) => {
  console.error("[server] 启动失败:", e);
  process.exitCode = 1;
});

// 优雅退出:SIGINT/SIGTERM → stopAll(停所有内核进程)→ quit(node-host 的 lifecycle 已绑信号)。
host.lifecycle.onBeforeQuit(() => {
  void assembled
    .then((a) => a.sessionStore.stopAll())
    .catch((e) => console.error("[server] 退出前收尾失败(仍继续退出):", e))
    .finally(() => host.lifecycle.quit());
});
