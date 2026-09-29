// dsh 内核插件(§kernel-plugin) —— dsh 内核的完整适配器集合,经 KernelPluginFactory 暴露。
//
// 依据 docs/design/kernel-plugin.md。把原来散在 bootstrap/assemble.ts 的 dsh 适配器
// (configSource 构造 + ensure* 初始化 + zstd 迁移 + create/seed/catalog/model/config/extension/version)
// 聚合成一份插件。dsh 的「首次运行准备」(ensure* 写 cordis.yml/凭证插件/明文会话日志 + zstd 工件迁移)
// 有副作用,放在工厂内部(工厂 = 装配 + 初始化入口,bootstrap 装配点调用工厂即完成准备)。

import { join, dirname, resolve } from "node:path";
import { DshConfigSource } from "./backend/dsh-config-source";
import { migrateZstdSessionArtifacts } from "./backend/dsh-artifact-migration";
import { createDshBackend, createDshCatalog } from "./backend/dsh-backend-factory";
import { createDshKernelManager } from "./manager/dsh-kernel";
import { DshExtensionManager } from "./extension/dsh-extension-manager";
import { createDshModelsApi } from "./manager/dsh-kernel-api";
import { createDshConfigApi } from "./manager/dsh-kernel-config";
import { DSH_LOGO } from "./manager/dsh-logo";
import { wrapVersionApi } from "../core/kernel-version";
import { DshSkillProvider } from "./extension/dsh-skill-provider";
import { FIT_DSEXTENSION_ID, syncPluginDshExtension, removePluginDshExtension, syncFitDshExtension, reconcilePluginDshExtensions } from "./extension/dsh-extension-installer";
import { DshQuestionBridge } from "./manager/dsh-question-bridge";
import { writeApiKey } from "./backend/dsh-credentials-store";
import type { KernelPluginFactory } from "@my-harness-desktop/shared";

/** dsh 内核插件工厂(§kernel-plugin §4):接收壳运行时环境,产出 KernelPlugin。 */
export const dshKernelPlugin: KernelPluginFactory = (ctx) => {
  const cordisPath = process.env.DSH_CORDIS_CONFIG ?? join(ctx.homedir, ".dsh", "cordis.yml");
  const settingsPath = join(ctx.homedir, ".dsh", "settings.yaml");
  const installDir = join(ctx.dataRoot, "dsh");
  const sessionRoot = join(ctx.dataRoot, "dsh", "sessions");

  const configSource = new DshConfigSource(cordisPath, settingsPath, installDir);
  // 首次运行准备(有副作用:缺 cordis 写默认 / skill fork base / credentials 插件 / 明文会话日志)。
  configSource.ensureDefaultCordis();
  configSource.ensureAgentCoreSkillForkBase();
  configSource.ensureCredentialsPlugin();
  configSource.ensurePlainSessionLog();
  // 明文部署的历史 zstd 工件迁移(幂等;只在明文部署下做)。
  if (configSource.sessionsCompression() === "none") {
    try {
      migrateZstdSessionArtifacts(sessionRoot);
    } catch (err) {
      console.warn("[dsh-migration] 工件编码迁移失败:", err instanceof Error ? err.message : String(err));
    }
  }
  // 清理悬空默认(agent-default-model 指向已删路由 → 清指针,回落首个 provider/模型)。
  void (async () => {
    const def = configSource.getDefaultModel();
    if (def && !configSource.listProviders().some((p) => p.provider === def.provider)) {
      await configSource.clearDefaultModel().catch((err: unknown) => console.warn("[plugin] 后台操作失败(非用户动作,不弹提示):", err));
    }
  })();
  // 启用 dsh 技能消费方(幂等;失败只 warn 不炸启动)。
  try {
    configSource.addPlugin("@deepseek-ai/dsh-tool-skill");
  } catch (err) {
    console.warn("[dsh-skill] 启用 tool-skill 失败:", err instanceof Error ? err.message : String(err));
  }

  const kernelManager = createDshKernelManager(installDir);
  const cliPath = (): string | undefined => {
    const custom = ctx.prefs.get<string>("dshCustomCliDir");
    if (custom) {
      const resolved = kernelManager.resolveCustomCli(custom);
      if (resolved) return resolved.cliJs;
    }
    return kernelManager.resolveCustomCli(installDir)?.cliJs;
  };
  // dsh 默认 provider/模型(纯自定义):agent-default-model → 首个 provider/模型 → 空串。
  const defaultProviderModel = (): { provider: string; model: string } => {
    const providers = configSource.listProviders();
    const first = providers[0];
    const defaultModel = configSource.getDefaultModel();
    const defaultValid = defaultModel !== null && providers.some((p) => p.provider === defaultModel.provider);
    return {
      provider: defaultValid ? defaultModel!.provider : (first?.provider ?? ""),
      model: defaultValid ? defaultModel!.model : (first?.models[0]?.id ?? ""),
    };
  };
  const extensionManager = new DshExtensionManager({
    dshConfigSource: configSource,
    dshKernelManager: kernelManager,
    installDir,
    onConfigChanged: ctx.markSessionsPendingRestart,
  });

  return {
    id: "dsh",
    logo: DSH_LOGO,
    createBackend: (opts) => {
      const fallback = defaultProviderModel();
      return createDshBackend({
        ...opts,
        provider: opts.provider ?? fallback.provider,
        model: opts.model ?? fallback.model,
        cliPath: cliPath(),
        cordisConfig: cordisPath,
        env: { DSH_SESSION_ROOT: sessionRoot, DSH_HOME: dirname(cordisPath) },
      });
    },
    // dsh 的 seed 是 RPC(依赖进程),无预 seed → 返回 null,走 create → start → backend.seed。
    seed: () => Promise.resolve(null),
    createCatalog: () => createDshCatalog({
      cliPath: cliPath(),
      cordisConfig: cordisPath,
      env: { DSH_SESSION_ROOT: sessionRoot, DSH_HOME: dirname(cordisPath) },
      ...defaultProviderModel(),
    }),
    createModelSource: () => configSource,
    createModelsApi: () => createDshModelsApi(configSource, ctx.testModel),
    createConfigApi: () => createDshConfigApi(configSource),
    createExtensionSource: () => extensionManager,
    createVersionApi: () => wrapVersionApi(kernelManager, {
      customCliPrefsKey: "dshCustomCliDir",
      customCliError: "目录无效：未找到 apps/cli/lib/bin.js，也不是 npm 安装目录",
      prefs: ctx.prefs,
      markPending: ctx.markSessionsPendingRestart,
      refresh: ctx.broadcastRefresh,
    }),
    // 技能能力面(读 dsh fork 插件播报 + 写 disabled 名单)。
    createSkillProvider: () => new DshSkillProvider({ dshHome: join(ctx.homedir, ".dsh") }),
    // 扩展同步能力(壳插件携带 dsh-extension → cordis;用插件自己的 configSource)。
    // 旧状态一次性迁移：prefs 里的明文 apiKey（旧机制 spawn 时注入进程 env）→ dsh 凭证库
    // （~/.dsh/.credentials.yaml refs；新机制 dsh 运行时直接读凭证库，不注入 env）。
    // 读 raw prefs 而不是 typed：字段已从 Prefs 类型删除，只剩历史数据。一次幂等——迁完就清空旧 map，
    // 避免"凭证库 + prefs"双份真相。deepseek-official 官方路由已废弃，旧单值 dshApiKey 一并清除。
    sessionRoot: () => sessionRoot,
    configRoot: () => dirname(cordisPath),
    migrateLegacyState: () => {
      const legacyKeys = ctx.prefs.get<Record<string, unknown>>("dshApiKeys") ?? {};
      for (const [provider, key] of Object.entries(legacyKeys)) {
        if (typeof key === "string" && key) writeApiKey(join(ctx.homedir, ".dsh", ".credentials.yaml"), provider, key);
      }
      if (Object.keys(legacyKeys).length > 0) ctx.prefs.remove("dshApiKeys");
      // 旧单值 dshApiKey 指向已废弃的 deepseek-official 官方路由：随迁移一并清除，不落凭证库。
      if (typeof ctx.prefs.get<string>("dshApiKey") === "string") ctx.prefs.remove("dshApiKey");
    },
    createPluginExtensionSync: () => ({
      onActivate: (pluginId, pluginPath, extension) => {
        syncPluginDshExtension(pluginId, join(pluginPath, extension), configSource);
      },
      onDeactivate: (pluginId) => {
        removePluginDshExtension(pluginId, configSource);
      },
      // 资产路径是 dsh 自己的私有知识（dev = 仓库里那块合并扩展；pkg = extraResources 随壳分发），
      // 由插件解析——壳不再持有 DSH_FIT_EXTENSION_SOURCE / FIT_DSEXTENSION_ID 这类内核专属常量。
      syncFit: () => {
        const sourceDir = ctx.isPackaged
          ? join(process.resourcesPath, "my-harness-desktop-dsh-extension")
          : resolve(process.cwd(), "src/server/kernel/dsh/extension/dsh-extension");
        syncFitDshExtension(sourceDir, configSource);
        return FIT_DSEXTENSION_ID;
      },
      reconcile: (activeIds) => {
        reconcilePluginDshExtensions(activeIds, configSource);
      },
    }),
    // 提问桥能力(监听问句目录 → 投中性提问事件)。
    createQuestionBridge: () => new DshQuestionBridge(),
  };
};

export default dshKernelPlugin;
