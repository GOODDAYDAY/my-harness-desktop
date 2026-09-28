// 组装根 —— main 进程**唯一读环境**的点，把环境解析成 `BootContext`，然后交给冷启动驱动器。
//
// 依据 docs/design/boot-surface.md §4.4。本文件的目标是「极薄」：它是"怎么拼"，不是"怎么干"。
// 曾经这里是 609 行的单体编排（15 个启动动作 + 15 个遍历循环 + 4 条只活在注释里的顺序约束
// 全挤在一个函数体内），现在启动编排被拆成 `boot/steps/` 下 14 个有名字、有声明、可被守卫断言的
// 步骤，本文件只剩三件事：**解析环境 → 跑冷启动 → 返回产物**。
//
// 为什么环境解析留在这里而不进步骤：`BootContext` 的只读输入段（paths/prefsStore/port/
// remoteConfig/auth/gateway/forceEnableKernels）被多个步骤共读，放进任何单个步骤都会造成
// 别的步骤依赖它；而"读环境"本身是组装根的职责（§1.1 判别气味四：内层不该直接读环境，
// 由外层在启动时注入）。
//
// ⚠ **本函数是 async**（曾经是同步的）。不能反过来"让启动步骤全部同步"来避免这个代价：
// `65-kernel-skills`（`migrateSkills`/`ensureSkills` 返 `Promise<boolean>`）、`75-plugin-boot`
// （`SkillsEnsure.onActivate` 返 Promise）、`95-kernel-reconcile`（npm install）本质异步。
// 两个入口（`electron.ts` / `server.ts`）因此都要 await，且必须挂 `.catch` 呈现致命失败
// ——今天 `electron.ts` 的 `whenReady().then()` 没有 catch，未捕获拒绝会让进程停在无窗口状态
// 且不报错（设计文档 §4.3.4）。
import { homedir } from "node:os";
import type { Host } from "@my-harness-desktop/shared";
import type { Gateway } from "../routing/gateway";
import type { MainContext } from "../application/context/main-context";
import type { SessionStore } from "../application/sessions/session-store";
import { createBootContext } from "./boot/context";
import { runColdBoot } from "./boot/runner";

/** assemble 的产物：electron/server 各取所需。 */
export interface Assembled {
  ctx: MainContext;
  sessionStore: SessionStore;
  gateway: Gateway;
  localToken: string;
  port: number;
}

/** 共享组装：注入 Host + isPackaged + rendererDir（§5.4），跑冷启动，返回运行期上下文。
 *  rendererDir 由入口（electron.ts/server.ts）注入而非此处推断：本文件被 rollup 打进
 *  out/main/chunks/，__dirname 多一段 chunks/，process.cwd() 又在打包态指向家目录而非
 *  asar，两者都无法可靠定位 out/renderer。入口是 entry（__dirname 恒为 out/main），
 *  resolve(__dirname,"../renderer") 在 dev/server 宿主/打包态三种上下文都对。 */
export async function assemble(
  host: Host,
  opts: { isPackaged: boolean; rendererDir: string },
): Promise<Assembled> {
  // ---- 环境解析：main 进程唯一读 process.env / os.homedir() / process.resourcesPath 的地方 ----
  const ctx = createBootContext(host, opts.rendererDir, {
    isPackaged: opts.isPackaged,
    homeDir: homedir(),
    cwd: process.cwd(),
    // resourcesPath 是 Electron 注入的；服务器宿主（server.ts）下 undefined，
    // 而 resolveBootPaths 只在 isPackaged 为真时用它（服务器宿主恒 false），故空串安全。
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? "",
    portFromEnv: process.env["MHD_PORT"],
    enableKernelsFromEnv: process.env["MHD_ENABLE_KERNELS"],
  });

  await runColdBoot(ctx);

  // 五个非空断言集中在此一处，不散在每个消费方。**它们的安全性由 `requires` 保证**：
  // `50-wiring` 写 mainContext / sessionStore，`90-transport` 写 localToken，两者都是 fatal——
  // 任一步骤失败 runColdBoot 就抛出，根本走不到这个 return。（`gateway` 与 `port` 是只读输入段，
  // 从 createBootContext 起就有值。）这条推理由 §6.2.1 的失败注入测试覆盖：注入一个 fatal 步骤
  // 失败，断言 runColdBoot 抛出、assemble 不返回。
  return {
    ctx: ctx.mainContext!,
    sessionStore: ctx.sessionStore!,
    gateway: ctx.gateway,
    localToken: ctx.localToken!,
    port: ctx.port,
  };
}
