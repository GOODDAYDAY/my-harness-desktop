// 后端工厂(组装)—— 把「怎么 spawn、怎么翻译」收成一个实现,产出 BaseBackend。
//
// 依据 docs/design/base-interface-lineage.md §4.5 + kernel-layer.md:一个内核 = 一个「怎么 spawn、
// 怎么翻译」的实现,注册进 BackendFactory(圆心契约),由配置选当前会话用哪个。pi 工厂
// (spawn pi --mode rpc → RpcAdapter → PiBackend)与 dsh 工厂(spawn dsh-jsonrpc-agent → JSON-RPC
// 传输 → DshBackend)是同一抽象的两种参数化。
//
// 位置:组装归 bootstrap(最外层)——本层 import client(spawn + 传输 + 后端实现)+ domain(契约),
// 把接口和实现绑起来。core/application 只依赖 BackendFactory 接口,不 import 本文件。
//
// 内核专属 spawn 注入(cliPath/cordisConfig/env)经本文件的工厂入参由 bootstrap 闭包捕获;
// 中性字段(sessionId/systemPrompt*/ephemeral/maxTokens)由本文件翻译成各自内核的 spawn 形态。

import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPiSubprocess } from "../pi/backend/subprocess-lifecycle";
import { RpcAdapter } from "../pi/backend/rpc-adapter";
import { createDshSubprocess } from "../dsh/backend/subprocess-lifecycle";
import { JsonRpcTransport } from "../dsh/protocol/json-rpc";
import { PiBackend, piSeedSession } from "../pi/backend/pi-backend";
import { piDerivedSessionPath } from "../pi/backend/pi-catalog";
import { DshBackend } from "../dsh/backend/dsh-backend";
import { PiSessionCatalog } from "../pi/backend/pi-catalog";
import { DshSessionCatalog } from "../dsh/backend/dsh-catalog";
import type { BaseBackend, BackendCreateOptions, SessionCatalog } from "@my-harness-desktop/shared";

/** pi 的 seed 投影纯函数 re-export:bootstrap 的 BackendFactory.seed 用(§4.5)。 */
export { piSeedSession };

/** pi 工厂入参:中性 BackendCreateOptions + pi 专属 spawn 注入(cliPath 由 bootstrap 闭包捕获)。 */
export interface PiFactoryOptions extends BackendCreateOptions {
  cliPath?: string;
}

/** pi 工厂:把中性字段翻译成 pi 的 spawn 参数(--session/--append-system-prompt/--no-session)。 */
export function createPiBackend(opts: PiFactoryOptions): BaseBackend {
  const args: string[] = [];
  // 会话标识下沉 adapter(§12.2):pi 的私有 id = 派生文件路径(由 ns 定,幂等)。
  const sessionId = piDerivedSessionPath(opts.agentDir, opts.cwd, opts.neutralSessionId);
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

/** dsh 工厂入参:中性 + dsh 专属注入(cliPath/cordisConfig/env 由 bootstrap 闭包捕获)。 */
export interface DshFactoryOptions extends BackendCreateOptions {
  cliPath?: string;
  cordisConfig?: string;
  env?: Record<string, string>;
}

/** dsh 工厂:ephemeral 时创建临时 DSH_SESSION_ROOT(stop 时由后端清理),
 *  中性字段经 initialize 握手(provider/model/maxTokens/sessionId)。 */
export function createDshBackend(opts: DshFactoryOptions): BaseBackend {
  let tempDir: string | undefined;
  const env: Record<string, string> = { ...opts.env };
  if (opts.ephemeral) {
    tempDir = mkdtempSync(join(tmpdir(), "dsh-test-"));
    env.DSH_SESSION_ROOT = tempDir;
  }
  const transport = new JsonRpcTransport(createDshSubprocess({
    cwd: opts.cwd,
    env,
    cliPath: opts.cliPath,
    cordisConfig: opts.cordisConfig,
  }));
  return new DshBackend(transport, {
    cwd: opts.cwd,
    provider: opts.provider ?? "deepseek-official",
    model: opts.model ?? "deepseek-v4-pro",
    maxTokens: opts.maxTokens,
    sessionId: opts.neutralSessionId,
    tempDir,
    cordisConfig: opts.cordisConfig,
    settingsPath: opts.cordisConfig ? join(dirname(opts.cordisConfig), "settings.yaml") : undefined,
  });
}

/** pi 目录工厂:pi 的 SessionCatalog(读 pi JSONL,agentDir 注入)。 */
export function createPiCatalog(agentDir: string): SessionCatalog {
  return new PiSessionCatalog(agentDir);
}

/** dsh 目录工厂入参:dsh spawn 配置(bootstrap 闭包捕获)。 */
export interface DshCatalogFactoryOptions {
  cliPath?: string;
  cordisConfig?: string;
  env?: Record<string, string>;
}

/** dsh 目录:dsh 会话真相源在 dsh 进程内,目录/CRUD 经懒 spawn 的 dsh transport 走
 *  JSON-RPC(session/list/get)。首次目录操作时 spawn,之后复用(常驻 transport)。 */
export function createDshCatalog(opts: DshCatalogFactoryOptions): SessionCatalog {
  return new DshSessionCatalog({
    createTransport: async () => {
      const transport = new JsonRpcTransport(createDshSubprocess({
        cwd: process.cwd(),
        env: opts.env ?? {},
        cliPath: opts.cliPath,
        cordisConfig: opts.cordisConfig,
      }));
      transport.start();
      await transport.request("initialize", { cwd: process.cwd(), provider: "deepseek-official", model: "deepseek-v4-pro" });
      return transport;
    },
  });
}
