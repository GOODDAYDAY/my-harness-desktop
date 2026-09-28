// dsh 后端与目录工厂 —— 把「怎么 spawn、怎么翻译」收成 dsh 自己的一个实现，产出中性契约。
//
// 依据 docs/design/boot-surface.md §3.6.3 与 docs/design/base-interface-lineage.md §4.5。
//
// **为什么住在 dsh 自己的目录里，而不是共享的 kernel/factories/**（根因，勿回退）：
// 共享工厂文件必须同时 import 三个内核的内部实现，于是任一内核的插件都会传递依赖到另外两个
// ——删掉一个内核目录会让其它内核编译不过，「内核可整体卸载」当场变成假的。
// 现由 dependency-audit 检验⑪（内核目录自包含）守住。
//
// 依赖方向：本文件 import dsh 自己的实现（同目录 / 同内核 protocol）+ 圆心契约，
// 不 import 任何别的内核。内核专属注入（cliPath/cordisConfig/env）由 dsh 的插件工厂
// 从 KernelPluginContext 解析后经闭包传入，不进中性契约。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BaseBackend, BackendCreateOptions, SessionCatalog } from "@my-harness-desktop/shared";
import { createDshSubprocess } from "./subprocess-lifecycle";
import { JsonRpcTransport } from "../protocol/json-rpc";
import { DshBackend } from "./dsh-backend";
import { DshSessionCatalog } from "./dsh-catalog";

/** dsh 工厂入参：中性 + dsh 专属注入（cliPath/cordisConfig/env 由插件工厂闭包捕获）。 */
export interface DshFactoryOptions extends BackendCreateOptions {
  cliPath?: string;
  cordisConfig?: string;
  env?: Record<string, string>;
}

/** dsh 工厂：ephemeral 时创建临时 DSH_SESSION_ROOT（stop 时由后端清理），
 *  中性字段经 initialize 握手（provider/model/maxTokens/sessionId）。 */
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
    // 不再写死官方路由（已废弃）：provider/model 由插件工厂按用户配置
    // （agent-default-model → 首个 provider/模型）显式传入，空串 = 调用方未提供（initialize 会诚实报错）。
    provider: opts.provider ?? "",
    model: opts.model ?? "",
    maxTokens: opts.maxTokens,
    sessionId: opts.lineageId ?? opts.neutralSessionId,
    tempDir,
    cordisConfig: opts.cordisConfig,
    settingsPath: opts.cordisConfig ? join(dirname(opts.cordisConfig), "settings.yaml") : undefined,
  });
}

/** dsh 目录工厂入参：dsh spawn 配置（插件工厂闭包捕获）。 */
export interface DshCatalogFactoryOptions {
  cliPath?: string;
  cordisConfig?: string;
  env?: Record<string, string>;
  /** initialize 握手用的 provider/model（插件工厂按用户默认模型/首个 provider 传入）。 */
  provider?: string;
  model?: string;
}

/** dsh 目录：dsh 会话真相源在 dsh 进程内，目录/CRUD 经懒 spawn 的 dsh transport 走
 *  JSON-RPC（session/list/get）。首次目录操作时 spawn，之后复用（常驻 transport）。 */
export function createDshCatalog(opts: DshCatalogFactoryOptions): SessionCatalog {
  return new DshSessionCatalog({
    // 会话持久化根单源：与 spawn 注入的 DSH_SESSION_ROOT 同一值（§20.4 目录解析原始文件用）
    sessionRoot: opts.env?.DSH_SESSION_ROOT,
    createTransport: async () => {
      const transport = new JsonRpcTransport(createDshSubprocess({
        cwd: process.cwd(),
        env: opts.env ?? {},
        cliPath: opts.cliPath,
        cordisConfig: opts.cordisConfig,
      }));
      transport.start();
      await transport.request("initialize", { cwd: process.cwd(), provider: opts.provider ?? "", model: opts.model ?? "" });
      return transport;
    },
  });
}
