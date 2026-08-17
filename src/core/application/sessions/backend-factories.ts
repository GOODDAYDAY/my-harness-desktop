// 后端工厂 —— 把「怎么 spawn、怎么翻译」收成一个实现,产出 BaseBackend。
//
// 依据 docs/design/base-interface-lineage.md §4.5:一个后端 = 一个实现,注册进 BaseBackendFactory,
// 由配置选当前会话用哪个。pi 工厂(spawn pi --mode rpc → RpcAdapter → PiBackend)与 dsh 工厂
// (spawn dsh --profile → JSON-RPC 传输 → DshBackend)是同一抽象的两种参数化。
//
// 依赖方向:本层 import client(spawn + 传输)+ domain + 各自后端,不 import electron/shell。

import { createPiSubprocess } from "../../../client/pi/subprocess-lifecycle";
import { RpcAdapter } from "../../../client/pi/rpc-adapter";
import { createDshSubprocess } from "../../../client/dsh/subprocess-lifecycle";
import { JsonRpcTransport } from "../../../client/dsh/json-rpc";
import { PiBackend } from "./pi-backend";
import { DshBackend } from "./dsh-backend";
import type { BaseBackend } from "../../domain/backend";

/** 后端工厂入参(BaseBackendFactory.create 的 opts)。 */
export interface BackendFactoryOptions {
  cwd: string;
  agentDir: string;
  args?: string[];
  env?: Record<string, string>;
  cliPath?: string;
}

/** pi 工厂:spawn pi --mode rpc → RpcAdapter → PiBackend。 */
export function createPiBackend(opts: BackendFactoryOptions): BaseBackend {
  const adapter = new RpcAdapter(createPiSubprocess({
    cwd: opts.cwd,
    args: opts.args,
    env: opts.env,
    cliPath: opts.cliPath,
  }));
  return new PiBackend(adapter, { cwd: opts.cwd, agentDir: opts.agentDir });
}

/** dsh 工厂:spawn dsh --profile → JSON-RPC 传输 → DshBackend。 */
export function createDshBackend(
  opts: BackendFactoryOptions & { provider?: string; model?: string; maxTokens?: number },
): BaseBackend {
  const transport = new JsonRpcTransport(createDshSubprocess({ cwd: opts.cwd, env: opts.env }));
  return new DshBackend(transport, {
    cwd: opts.cwd,
    provider: opts.provider ?? "deepseek-official",
    model: opts.model ?? "deepseek-v4-pro",
    maxTokens: opts.maxTokens,
  });
}
