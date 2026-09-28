// probe4 后端与目录工厂 —— 把「怎么 spawn、怎么翻译」收成 probe4 自己的一个实现，产出中性契约。
//
// 依据 docs/design/boot-surface.md §3.6.3 与 docs/design/minimal-kernel.md §4.1/§8.2.2。
//
// **为什么住在 probe4 自己的目录里，而不是共享的 kernel/factories/**（根因，勿回退）：
// 共享工厂文件必须同时 import 三个内核的内部实现，于是任一内核的插件都会传递依赖到另外两个
// ——删掉一个内核目录会让其它内核编译不过，「内核可整体卸载」当场变成假的。
// probe4 是「第三个可托管内核」的活证据（它的 manifest 在 test-plugins/，不随壳分发），
// 恰恰最需要这条独立性：测试把它种进隔离 HOME 时才装载，生产扫描根里没有它。
// 现由 dependency-audit 检验⑪（内核目录自包含）守住。
//
// 依赖方向：本文件 import probe4 自己的实现（同目录）+ 圆心契约，不 import 任何别的内核。

import type { BaseBackend, BackendCreateOptions, SessionCatalog } from "@my-harness-desktop/shared";
import { Probe4Backend } from "./probe4-backend";
import { Probe4Catalog, probe4DerivedSessionPath, probe4SeedSession } from "./probe4-catalog";
import { createProbe4Subprocess } from "./subprocess-lifecycle";
import { Probe4Transport } from "./probe4-transport";

/** probe4 的 seed 投影纯函数 re-export：插件工厂的 `seed` 面用（预 seed：文件态内核，先 seed 得路径再 spawn）。 */
export { probe4SeedSession };

/** probe4 工厂入参：中性 `BackendCreateOptions` + probe4 专属 spawn 注入。 */
export interface Probe4FactoryOptions extends BackendCreateOptions {
  /** probe4 的数据根（`~/.probe4/agent`）——内核私有知识不进中性契约。 */
  agentDir: string;
  /** `probe4-cli.mjs` 绝对路径。 */
  cliPath: string;
}

/** probe4 工厂：文件态内核（§8.2.2 预 seed），会话 id 由 `lineageId ?? neutralSessionId` 派生，
 *  与 pi 同源（分支重 spawn 按分支 lineageId 派生，避免写回根文件）。spawn 独立 CLI + JSONL transport。 */
export function createProbe4Backend(opts: Probe4FactoryOptions): BaseBackend {
  const lineageId = opts.lineageId ?? opts.neutralSessionId;
  const sessionId = probe4DerivedSessionPath(opts.agentDir, opts.cwd, lineageId);
  const handle = createProbe4Subprocess({
    cliPath: opts.cliPath,
    agentDir: opts.agentDir,
    cwd: opts.cwd,
    sessionId: lineageId,
  });
  const transport = new Probe4Transport(handle);
  return new Probe4Backend(transport, {
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    sessionId,
    provider: opts.provider,
    model: opts.model,
  });
}

/** probe4 目录工厂：probe4 的 `SessionCatalog`（读 probe4 线性会话文件，agentDir 注入）。 */
export function createProbe4Catalog(agentDir: string): SessionCatalog {
  return new Probe4Catalog(agentDir);
}
