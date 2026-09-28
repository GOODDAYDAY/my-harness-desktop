// 步骤 90：起 HTTP + WS 服务、远程绑定策略与热重绑、注册远程访问 handler。
//
// 收编设计文档 §1.1.2 的动作 #14，**以及**远程绑定与热重绑闭包（`assemble.ts:538-573`）——
// 后者不在"15 个动作"的清点里，它是 #14 的一部分实现而非独立动作。`registerRemote` 也归本步骤
// （今天它在 `assemble.ts:447-455`，靠两个 `let` 变量在 transport 起来后回填）：把 handler 注册
// 与它所依赖的句柄放在同一步，跨步骤的可变引用就彻底消失了。
//
// **为什么 requires `70` 与 `75`**：内核的 loader 只在 spawn 时扫一次扩展目录，而 listen 之后
// renderer 才能连上、才能发送、才会触发 spawn。这条约束今天只活在 `assemble.ts:503` 的注释里，
// 现在是图上一条可断言的边（§4.2.1、§6.1.1）。
//
// **为什么 fatal**：端口起不来 = 壳无法被访问。但 fatal 之前必须**收尾**（见 `closeTransport`），
// 否则已 listen 的端口与已连上的 WS 客户端会悬着。
import type { BootStep } from "../types";
import { createHttpServer } from "../../../transport/http/http-server";
import { attachWsServer } from "../../../transport/ws/ws-server";
import { registerRemote } from "../../../controllers/remote";

/** listen 失败/后续构造失败时的收尾。语义要写准（设计文档 §4.3.4 逐条更正过四处技术错误）：
 *  · 端口**不是**靠本函数释放的——`close()` 同步关闭监听 handle，端口在调用那一刻就释放；
 *    回调等的是**既有连接排空**。
 *  · await 保护的是：连接排空完成（软退出能真的退出）+ 收尾确认先于异常冒泡。
 *  · 1 秒上限是"给等待加上限"，不是"给关闭加上限"：超时即放弃等待，close 与排空在后台继续。
 *  · 升级后的 WS 连接**确实计入** `close()` 的等待集合（Node 实测），所以必须先
 *    `closeAllClients()` 显式终止；另一个真实延迟来源是关不掉的 keep-alive 连接
 *    （Node < 18.2 没有 `closeAllConnections`，故用 `?.()`）。
 *  · 计时器用 ref'd + `clearTimeout`，不用 `unref`：不依赖"事件循环里恰好还有别的 ref'd handle"。 */
async function closeTransport(ctx: { httpServer?: import("node:http").Server; wsHandle?: { closeAllClients: () => void } }): Promise<void> {
  try { ctx.wsHandle?.closeAllClients(); } catch (e) { console.error("[boot:90-transport] closeAllClients 失败:", e); }
  try { ctx.httpServer?.closeAllConnections?.(); } catch { /* 无此方法的老 Node 忽略 */ }
  await new Promise<void>((res) => {
    const server = ctx.httpServer;
    if (!server) { res(); return; }
    const t = setTimeout(res, 1000);            // ref'd：等待期间吊住事件循环
    server.close(() => { clearTimeout(t); res(); });
  });
}

const step: BootStep = {
  id: "90-transport",
  scope: "global",
  failure: "fatal",
  requires: ["50-wiring", "70-fit-extensions", "75-plugin-boot"],
  async run(ctx) {
    const { gateway, host, auth, remoteConfig, port, rendererDir } = ctx;

    const httpServer = createHttpServer({ staticDir: rendererDir, gateway, auth });
    const wsHandle = attachWsServer(httpServer, gateway, host, auth.createTokenVerifier());
    // 先写入 ctx，收尾时才拿得到（§4.3.4）。
    ctx.httpServer = httpServer;
    ctx.wsHandle = wsHandle;

    try {
      // 网络绑定（§8.6）：默认关闭 = 仅 loopback；开启且 bind=lan 才 0.0.0.0。
      const bindFor = (): string =>
        remoteConfig.get().enabled && remoteConfig.get().bind === "lan" ? "0.0.0.0" : "127.0.0.1";
      let currentBind = bindFor();

      await new Promise<void>((res, rej) => {
        httpServer.once("error", rej);
        httpServer.listen(port, currentBind, () => { httpServer.removeListener("error", rej); res(); });
      });

      // 热重绑：开关远程访问立即重监听，不需重启。既有连接被断开——客户端已有断连横幅引导刷新，
      // 重绑窗口极短。竞态收敛：重绑进行中的再次开关不重入，listen 完成后按最新配置自检补一轮。
      // 防御：全程 try/catch + 常驻 error 监听——重绑路径上任何未捕获异常都会杀掉主进程
      // （应用整体暴毙的根因排查结论）。
      httpServer.on("error", (e) => console.error("[remote] HTTP server error:", e));
      let rebinding = false;
      const rebindRemote = (): void => {
        const next = bindFor();
        if (next === currentBind || rebinding) return;
        rebinding = true;
        currentBind = next;
        try { wsHandle.closeAllClients(); } catch (e) { console.error("[remote] closeAllClients 失败:", e); }
        try { httpServer.closeAllConnections?.(); } catch { /* 无此方法的老 Node 忽略 */ }
        httpServer.close(() => {
          try {
            httpServer.listen(port, next, () => {
              console.log(`[remote] 网络绑定已切换: ${next}:${port}`);
              rebinding = false;
              if (bindFor() !== currentBind) rebindRemote(); // 连点收敛
            });
          } catch (e) {
            console.error("[remote] 重监听抛出:", e);
            setTimeout(() => {
              try { httpServer.listen(port, next); } catch (e2) { console.error("[remote] 补救重监听失败:", e2); }
              rebinding = false;
            }, 500);
          }
        });
      };

      // 远程访问 handler 归本步骤：它的 rebind 与 deviceManager 都依赖上面刚建好的句柄。
      registerRemote(gateway, auth, {
        port,
        rebind: () => rebindRemote(),
        deviceManager: {
          list: () => wsHandle.listConnections(),
          kick: (id: string) => wsHandle.kick(id),
          kickAll: () => wsHandle.kickAll(),
        },
      });

      ctx.localToken = auth.localToken;
    } catch (e) {
      // listen 之后的动作（热重绑闭包、registerRemote）失败同样要收尾——所以 try 覆盖整个 run 体，
      // 不只是 listen 调用。
      await closeTransport(ctx);
      throw e;
    }
  },
};

export default step;
