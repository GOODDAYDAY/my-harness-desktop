// minimal 后端与目录工厂 —— 把「怎么 spawn、怎么翻译」收成 minimal 自己的一个实现，产出中性契约。
//
// 依据 docs/design/boot-surface.md §3.6.3 与 docs/design/minimal-kernel.md §4.1/§8.2.2。
//
// **为什么住在 minimal 自己的目录里，而不是共享的 kernel/factories/**（根因，勿回退）：
// 共享工厂文件必须同时 import 三个内核的内部实现，于是任一内核的插件都会传递依赖到另外两个
// ——删掉一个内核目录会让其它内核编译不过，「内核可整体卸载」当场变成假的。
// minimal 是「第三个可托管内核」的活证据（它的 manifest 在 test-plugins/，不随壳分发），
// 恰恰最需要这条独立性：测试把它种进隔离 HOME 时才装载，生产扫描根里没有它。
// 现由 dependency-audit 检验⑪（内核目录自包含）守住。
//
// 依赖方向：本文件 import minimal 自己的实现（同目录）+ 圆心契约，不 import 任何别的内核。

import type { BaseBackend, BackendCreateOptions, SessionCatalog } from "@my-harness-desktop/shared";
import { MinimalBackend } from "./minimal-backend";
import { MinimalCatalog, minimalDerivedSessionPath, minimalSeedSession } from "./minimal-catalog";
import { createMinimalSubprocess } from "./subprocess-lifecycle";
import { MinimalTransport } from "./minimal-transport";

/** minimal 的 seed 投影纯函数 re-export：插件工厂的 `seed` 面用（预 seed：文件态内核，先 seed 得路径再 spawn）。 */
export { minimalSeedSession };

/** minimal 工厂入参：中性 `BackendCreateOptions` + minimal 专属 spawn 注入。 */
export interface MinimalFactoryOptions extends BackendCreateOptions {
  /** minimal 的数据根（`~/.minimal/agent`）——内核私有知识不进中性契约。 */
  agentDir: string;
  /** `minimal-cli.mjs` 绝对路径。 */
  cliPath: string;
}

/** minimal 工厂：文件态内核（§8.2.2 预 seed），会话 id 由 `lineageId ?? neutralSessionId` 派生，
 *  与 pi 同源（分支重 spawn 按分支 lineageId 派生，避免写回根文件）。spawn 独立 CLI + JSONL transport。 */
export function createMinimalBackend(opts: MinimalFactoryOptions): BaseBackend {
  const lineageId = opts.lineageId ?? opts.neutralSessionId;
  const sessionId = minimalDerivedSessionPath(opts.agentDir, opts.cwd, lineageId);
  const handle = createMinimalSubprocess({
    cliPath: opts.cliPath,
    agentDir: opts.agentDir,
    cwd: opts.cwd,
    sessionId: lineageId,
  });
  const transport = new MinimalTransport(handle);
  return new MinimalBackend(transport, {
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    sessionId,
    provider: opts.provider,
    model: opts.model,
  });
}

/** minimal 目录工厂：minimal 的 `SessionCatalog`（读 minimal 线性会话文件，agentDir 注入）。 */
export function createMinimalCatalog(agentDir: string): SessionCatalog {
  return new MinimalCatalog(agentDir);
}
