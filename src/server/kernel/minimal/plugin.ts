// minimal 内核插件(§kernel-plugin) —— minimal 内核的完整适配器集合,经 KernelPluginFactory 暴露。
//
// 依据 docs/design/kernel-plugin.md。把原来散在 bootstrap/assemble.ts(三分支 create/seed +
// 五槽位构造)的 minimal 适配器聚合成一份插件。专属参数(agentDir=~/.minimal/agent、
// cliPath=dev 源码/pkg resources)由工厂闭包从 KernelPluginContext 解析,不进 KernelPlugin 契约。

import { join, resolve } from "node:path";
import { createMinimalBackend, createMinimalCatalog, minimalSeedSession } from "../factories/kernel-factories";
import { MinimalModelSource, MinimalModelsApi } from "./manager/minimal-models";
import { MinimalConfigApi } from "./manager/minimal-config";
import { MinimalExtensionSource } from "./manager/minimal-extension";
import { MINIMAL_LOGO } from "./manager/minimal-logo";
import type { KernelPluginFactory, KernelVersionApi, KernelStatusView } from "@my-harness-desktop/shared";

/** minimal 版本 API:内置内核(随壳分发,不装不升不降)的诚实桩(§7.9.2)。 */
function minimalVersionApi(): KernelVersionApi {
  return {
    status: (): Promise<KernelStatusView> =>
      Promise.resolve({ currentVersion: "built-in", installedVersion: "built-in", available: true, source: "installed", customCliDir: "", error: null }),
    setCustomCliDir: (): Promise<{ ok: boolean; error: string | null; pendingCount: number; status: KernelStatusView | null }> =>
      Promise.resolve({ ok: false, error: "minimal 是内置内核，无自定义目录", pendingCount: 0, status: null }),
    listVersions: (): Promise<{ versions: string[]; latest: string | null }> =>
      Promise.resolve({ versions: [], latest: null }),
    install: (): Promise<{ ok: boolean; error: string | null }> =>
      Promise.resolve({ ok: false, error: "minimal 是内置内核，不支持安装/升级" }),
  };
}

/** minimal 内核插件工厂(§kernel-plugin §4):接收壳运行时环境,产出 KernelPlugin。 */
export const minimalKernelPlugin: KernelPluginFactory = (ctx) => {
  const agentDir = join(ctx.homedir, ".minimal", "agent");
  const cliPath = ctx.isPackaged
    ? join(process.resourcesPath, "minimal-kernel", "minimal-cli.mjs")
    : resolve(process.cwd(), "src/server/kernel/minimal/kernel/minimal-cli.mjs");
  return {
    id: "minimal",
    logo: MINIMAL_LOGO,
    createBackend: (opts) => createMinimalBackend({ ...opts, agentDir, cliPath }),
    seed: (lineage, opts) =>
      Promise.resolve(minimalSeedSession(agentDir, opts.cwd, lineage, { lineageId: opts.lineageId, header: opts.header })),
    createCatalog: () => createMinimalCatalog(agentDir),
    createModelSource: () => new MinimalModelSource(agentDir),
    createModelsApi: () => new MinimalModelsApi(agentDir),
    createConfigApi: () => new MinimalConfigApi(),
    createExtensionSource: () => new MinimalExtensionSource(),
    createVersionApi: minimalVersionApi,
  };
};

export default minimalKernelPlugin;
