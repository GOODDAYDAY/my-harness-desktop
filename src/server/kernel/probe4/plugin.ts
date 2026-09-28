// ⚠⚠ 这不是产品内核，是**开闭原则的实测探针**（r48 建立）。
//
// 它由 `src/server/kernel/minimal/` 整体克隆 + 改名而来（`minimal`→`probe4`），
// 存在的唯一目的：把 `electron.vite.config.ts` 与 `docs/design/kernel-plugin.md` 里那条
// **口头承诺**变成可运行的证据 ——「加第四个内核 = 加一个目录（含 plugin.ts），壳零改动」。
//
// 实测结论（r48）：新增 probe4 后，
//   · 壳机制层（src/web、src/server/{application,bootstrap,controllers,kernel/core,transport,routing}、
//     packages/{shared,react}/src）**零文件改动**（以 probe4 创建时刻为界用 mtime 核过）；
//   · 构建自动产出 `out/main/server/kernel/probe4/plugin.js` 与三个 renderer chunk（glob 生效）；
//   · `minimal-smoke.e2e.mjs --kernel probe4` 与 `--kernel minimal` **跑同一组 24 条判据、双双通过**
//     （模型合流 / 选模型 / 发送 / echo / 多轮 append / 会话文件格式 / 中立层 header.kernel /
//      落盘到 ~/.probe4/ / pi 目录无串台 / ⌘N 新会话 / 重开历史仍在 / 续跑第三条）。
//   本轮为接入它而改的**只有两个验证侧文件**：剧本参数化 + `TEST_KERNEL_IDS` 加一个 id。
//
// ⚠ 维护约定：它是 minimal 的**快照克隆**，不跟随 minimal 演进。若哪天它的冒烟红了，
//   先分辨是"壳新增了按内核名分支的代码"（真缺陷，要修壳）还是"minimal 改了而克隆体没跟"
//   （重新克隆即可）。不要因为"它只是测试内核"就直接删掉——删了这条承诺就又变回口头的了。
//
// ────────────────────────────────────────────────────────────────────────────
// probe4 内核插件(§kernel-plugin) —— probe4 内核的完整适配器集合,经 KernelPluginFactory 暴露。
//
// 依据 docs/design/kernel-plugin.md。把原来散在 bootstrap/assemble.ts(三分支 create/seed +
// 五槽位构造)的 probe4 适配器聚合成一份插件。专属参数(agentDir=~/.probe4/agent、
// cliPath=dev 源码/pkg resources)由工厂闭包从 KernelPluginContext 解析,不进 KernelPlugin 契约。

import { join, resolve } from "node:path";
import { createProbe4Backend, createProbe4Catalog, probe4SeedSession } from "./backend/probe4-backend-factory";
import { Probe4ConfigSource } from "./manager/probe4-config-source";
import { Probe4ModelSource, Probe4ModelsApi } from "./manager/probe4-models";
import { Probe4ConfigApi } from "./manager/probe4-config";
import { Probe4ExtensionSource } from "./manager/probe4-extension";
import { PROBE4_LOGO } from "./manager/probe4-logo";
import type { KernelPluginFactory, KernelVersionApi, KernelStatusView } from "@my-harness-desktop/shared";

/** probe4 版本 API:内置内核(随壳分发,不装不升不降)的诚实桩(§7.9.2)。 */
function probe4VersionApi(): KernelVersionApi {
  return {
    // 内置内核：不装不升不降、不可指定目录 —— 能力旗标显式说"没有这两面"，
    // 设置页据此隐藏对应区块（而不是画出两个点了没用的控件）。
    capabilities: () => Promise.resolve({ install: false, customDir: false }),
    status: (): Promise<KernelStatusView> =>
      Promise.resolve({ currentVersion: "built-in", installedVersion: "built-in", available: true, source: "installed", customCliDir: "", error: null }),
    setCustomCliDir: (): Promise<{ ok: boolean; error: string | null; pendingCount: number; status: KernelStatusView | null }> =>
      Promise.resolve({ ok: false, error: "probe4 是内置内核，无自定义目录", pendingCount: 0, status: null }),
    listVersions: (): Promise<{ versions: string[]; latest: string | null }> =>
      Promise.resolve({ versions: [], latest: null }),
    install: (): Promise<{ ok: boolean; error: string | null }> =>
      Promise.resolve({ ok: false, error: "probe4 是内置内核，不支持安装/升级" }),
    // 工具系统是 probe4 的**本体**不是扩展（docs/design/minimal-kernel.md §5.6.1：
    // 适配器把壳下发的 enabledToolIds 翻译成 probe4 自己的工具集/开关语义；§5.7.1：
    // 自带档位门控 + per-tool 超时）。所以它**能**强制过滤，答案恒 true。
    // ⚠ 别改回"探测某个扩展装没装"——那会让 probe4 被判为不能过滤，于是每次发送都被拼上
    // 一段冗余的散文限制说明（实测：echo 内核把它原样回显进时间线，弄坏 DOM 对账）。
    toolFilterEnforced: (): Promise<boolean> => Promise.resolve(true),
  };
}

/** probe4 内核插件工厂(§kernel-plugin §4):接收壳运行时环境,产出 KernelPlugin。 */
export const probe4KernelPlugin: KernelPluginFactory = (ctx) => {
  const agentDir = join(ctx.homedir, ".probe4", "agent");
  const cliPath = ctx.isPackaged
    ? join(process.resourcesPath, "probe4-kernel", "probe4-cli.mjs")
    : resolve(process.cwd(), "src/server/kernel/probe4/kernel/probe4-cli.mjs");
  // 私有存储读写面(模型配置 + 凭证 + 原生配置)。路径是 probe4 的私有知识,经本闭包捕获,
  // 壳的 application 层不知道也不碰(§4.9.2)。**同一份 source 同时交给读取面与写入面**——
  // 「设置页写进去的」与「模型下拉读出来的」与「子进程读的」是同一份文件。
  const configSource = new Probe4ConfigSource(agentDir);
  // 一次性迁移 legacy 明文 apiKey → 凭证文件(§4.9.1「配置里不留明文」)。幂等:
  // 写入面此前是空实现,用户只能手改 models.json 写明文,这批数据不迁走,分离规矩只对以后成立。
  configSource.migratePlaintextApiKeys();
  return {
    id: "probe4",
    logo: PROBE4_LOGO,
    createBackend: (opts) => createProbe4Backend({ ...opts, agentDir, cliPath }),
    seed: (lineage, opts) =>
      Promise.resolve(probe4SeedSession(agentDir, opts.cwd, lineage, { lineageId: opts.lineageId, header: opts.header })),
    createCatalog: () => createProbe4Catalog(agentDir),
    sessionRoot: () => join(agentDir, "sessions"),
    configRoot: () => agentDir,
    createModelSource: () => new Probe4ModelSource(configSource),
    createModelsApi: () => new Probe4ModelsApi(configSource, (cwd, p, m) => ctx.testModel(cwd, p, m)),
    createConfigApi: () => new Probe4ConfigApi(configSource),
    createExtensionSource: () => new Probe4ExtensionSource(),
    createVersionApi: probe4VersionApi,
  };
};

export default probe4KernelPlugin;
