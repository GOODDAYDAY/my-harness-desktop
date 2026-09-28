// pi 后端与目录工厂 —— 把「怎么 spawn、怎么翻译」收成 pi 自己的一个实现，产出中性契约。
//
// 依据 docs/design/boot-surface.md §3.6.3 与 docs/design/base-interface-lineage.md §4.5：
// 一个内核 = 一个「怎么 spawn、怎么翻译」的实现，由该内核的插件工厂调用。
//
// **为什么住在 pi 自己的目录里，而不是共享的 kernel/factories/**（根因，勿回退）：
// 共享工厂文件必须同时 import 三个内核的内部实现，于是 `kernel/pi/plugin.ts → factories →
// kernel/dsh/backend/*` 形成传递依赖——删掉 dsh 目录会让 pi 编译不过，「内核可整体卸载」
// （kernel-plugin.md 的验收前提、dependency-audit 检验⑧的立法意图）当场变成假的。
// 检验⑧只扫 `kernel/<id>/` 内部，`factories` 不在其列，所以这条传递依赖长期逃过守卫；
// 现由检验⑪（内核目录自包含）守住。
//
// 依赖方向：本文件 import pi 自己的实现（同目录）+ 圆心契约，不 import 任何别的内核。
// 内核专属 spawn 注入（agentDir/cliPath）由 pi 的插件工厂从 KernelPluginContext 解析后经
// 闭包传入，不进中性契约（`BackendCreateOptions` 只收真中性字段）。

import type { BaseBackend, BackendCreateOptions, SessionCatalog } from "@my-harness-desktop/shared";
import { createPiSubprocess } from "./subprocess-lifecycle";
import { RpcAdapter } from "./rpc-adapter";
import { PiBackend, piSeedSession } from "./pi-backend";
import { PiSessionCatalog, piDerivedSessionPath } from "./pi-catalog";

/** pi 的 seed 投影纯函数 re-export：插件工厂的 `seed` 面用（预 seed：纯文件写，先 seed 得路径再 spawn）。 */
export { piSeedSession };

/**
 * pi 工厂入参：中性 `BackendCreateOptions` + pi **专属**注入。
 *
 * `agentDir`（pi 的会话根 `~/.pi/agent`）在这里、不在中性契约里：它是 pi 的私有知识，
 * 由 pi 的插件工厂从 `KernelPluginContext` 解析后经闭包捕获传进来。实测「每个内核都忽略
 * 壳传的 agentDir、一律用自己的」——那种字段留在契约里会误导新内核。
 */
export interface PiFactoryOptions extends BackendCreateOptions {
  agentDir: string;
  cliPath?: string;
}

/** pi 工厂：把中性字段翻译成 pi 的 spawn 参数（`--session` / `--append-system-prompt` / `--no-session`）。 */
export function createPiBackend(opts: PiFactoryOptions): BaseBackend {
  const args: string[] = [];
  // 会话标识下沉 adapter（§12.2）：pi 的私有 id = 派生文件路径（由 **lineageId** 定，幂等）。
  // 分支重 spawn 传 lineageId（分支），root 传 ns（lineageId 缺省 = neutralSessionId）。
  const sessionId = piDerivedSessionPath(opts.agentDir, opts.cwd, opts.lineageId ?? opts.neutralSessionId);
  if (!opts.ephemeral) args.push("--session", sessionId);
  for (const p of opts.systemPromptPaths ?? []) args.push("--append-system-prompt", p);
  for (const t of opts.systemPromptTexts ?? []) args.push("--append-system-prompt", t);
  if (opts.ephemeral) args.push("--no-session");
  const adapter = new RpcAdapter(createPiSubprocess({
    cwd: opts.cwd,
    args,
    cliPath: opts.cliPath,
  }));
  return new PiBackend(adapter, { cwd: opts.cwd, agentDir: opts.agentDir, sessionId });
}

/** pi 目录工厂：pi 的 `SessionCatalog`（读 pi JSONL，agentDir 注入）。 */
export function createPiCatalog(agentDir: string): SessionCatalog {
  return new PiSessionCatalog(agentDir);
}
