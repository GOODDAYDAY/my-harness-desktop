// pi 内核插件(§kernel-plugin) —— pi 内核的完整适配器集合,经 KernelPluginFactory 暴露。
//
// 依据 docs/design/kernel-plugin.md。把原来散在 bootstrap/assemble.ts + controllers/kernel.ts
// 的 pi 适配器(create/seed/catalog/model/config/extension/version)聚合成一份插件。
// 专属参数(agentDir=~/.pi/agent、installDir=数据根/pi、cliPath=prefs.customCliDir 解析)由工厂
// 闭包从 KernelPluginContext 解析,不进 KernelPlugin 契约。壳服务(sessionStore/restartCoordinator/
// gateway)经 ctx 的中性能力回调(testModel/markSessionsPendingRestart/broadcastRefresh)注入。

import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { createPiBackend, createPiCatalog, piSeedSession } from "./backend/pi-backend-factory";
import { ModelsStore } from "./model/models-store";
import { PiSettingsStore } from "./model/pi-settings-store";
import { PiModelSource } from "./model/pi-model-source";
import { createPiModelsApi } from "./manager/pi-kernel-api";
import { createPiConfigApi } from "./manager/pi-kernel-config";
import { parseSettingsSchema } from "./model/pi-settings-store";
import { PiExtensionManager } from "./extension/pi-extension-manager";
import { PiKernelManager, PI_SPEC } from "./manager/pi-kernel";
import { PI_LOGO } from "./manager/pi-logo";
import { wrapVersionApi } from "../core/kernel-version";
import { fitPiExtensionAvailable, installFitPiExtension, FIT_PI_EXTENSION_ID } from "./extension/my-harness-fit-pi-extension-installer";
import { runPiOneshot } from "./extension/pi-oneshot";
import { readLegacyPiSessions } from "./backend/pi-legacy-sessions";
import { PiSkillProvider } from "./extension/pi-skill-provider";
import { ensureBundledSkillsEntry, ensurePluginSkillsEntry, migrateLegacySkillPatterns } from "./extension/pi-bundled-skills";
import { syncPluginPiExtension, removePluginPiExtension, reconcilePluginPiExtensions } from "./extension/pi-extension-installer";
import type { KernelPluginFactory } from "@my-harness-desktop/shared";
import type { PiSettingsApi } from "./manager/pi-settings-contract";

/** pi 内核插件工厂(§kernel-plugin §4):接收壳运行时环境,产出 KernelPlugin。 */
export const piKernelPlugin: KernelPluginFactory = (ctx) => {
  const agentDir = join(ctx.homedir, ".pi", "agent");
  const installDir = join(ctx.dataRoot, "pi");
  const modelsStore = new ModelsStore({ agentDir });
  const settingsStore = new PiSettingsStore({ agentDir });
  const kernelManager = new PiKernelManager(PI_SPEC, installDir);
  const cliPath = (): string | undefined => {
    const dir = ctx.prefs.get<string>("customCliDir");
    return dir ? kernelManager.resolveCustomCli(dir)?.cliJs : undefined;
  };
  const piSettings: PiSettingsApi = {
    get: () => settingsStore.get(),
    set: (patch) => settingsStore.set(patch),
    replace: (obj) => settingsStore.replace(obj),
    schema: async () => parseSettingsSchema(installDir, [process.cwd(), join(ctx.homedir, ".npm-global"), "/usr/local/lib"]),
  };
  const extensionManager = new PiExtensionManager({
    agentDir,
    piSettings: settingsStore,
    onConfigChanged: ctx.markSessionsPendingRestart,
  });
  return {
    id: "pi",
    logo: PI_LOGO,
    createBackend: (opts) => createPiBackend({ ...opts, agentDir, cliPath: cliPath() }),
    seed: (lineage, opts) =>
      Promise.resolve(piSeedSession(agentDir, opts.cwd, lineage, { lineageId: opts.lineageId, header: opts.header })),
    createCatalog: () => createPiCatalog(agentDir),
    createModelSource: () => new PiModelSource(modelsStore),
    createModelsApi: () => createPiModelsApi(modelsStore, settingsStore, ctx.testModel),
    createConfigApi: () => createPiConfigApi(piSettings, { installDir, homeDir: ctx.homedir }),
    createExtensionSource: () => extensionManager,
    createVersionApi: () => wrapVersionApi(kernelManager, {
      customCliPrefsKey: "customCliDir",
      customCliError: "目录无效：未找到 dist/cli.js，也不是 npm 安装目录",
      prefs: ctx.prefs,
      markPending: ctx.markSessionsPendingRestart,
      refresh: ctx.broadcastRefresh,
      // pi 的工具强制过滤**就是**靠桌面适配扩展里的 tool-gate 实现的，所以对这个内核而言
      // 「能不能强制过滤」== 「那个扩展装好了没」。pi 私有的函数名留在 pi 目录内，
      // 机制层只见中性面名（圆心 KernelVersionApi.toolFilterEnforced 的语义按内核各自兑现）。
      toolFilterEnforced: fitPiExtensionAvailable,
    }),
    // llm:oneshot 一次性问 pi 内核(cwd = 激活项目根,运行时注入;cliPath 用插件自己的解析)。
    createOneshot: () => (prompt, cwd) => runPiOneshot(prompt, { cwd, cliPath: cliPath() }),
    // 技能能力面(读 settings.json skills[] + 扫内置 skills 目录 + 播报)。
    createSkillProvider: () => new PiSkillProvider({
      agentDir,
      homeDir: ctx.homedir,
      builtinSkillsDir: ctx.builtinSkillsDir,
      getCwd: ctx.getCwd,
    }),
    // 内置 skills 挂/摘 + 旧命名迁移(pi settings.json skills[])。
    ensureSkills: (enabled) => ensureBundledSkillsEntry({
      settingsPath: join(agentDir, "settings.json"),
      targetDir: ctx.builtinSkillsDir,
      enabled,
      homeDir: ctx.homedir,
    }),
    migrateSkills: () => migrateLegacySkillPatterns(join(agentDir, "settings.json")),
    // 壳插件生命周期钩子:插件携带 skills 目录/pi 扩展的挂/摘(返回 changed 供壳广播)。
    createLifecycle: () => ({
      skillsEnsure: {
        onActivate: async (pluginId, pluginPath, source) => {
          const skillsDir = join(pluginPath, "skills");
          if (!existsSync(skillsDir) || readdirSync(skillsDir).length === 0) return false;
          const settingsPath = source === "project"
            ? join(ctx.getCwd() ?? "", ".pi", "settings.json")
            : join(agentDir, "settings.json");
          return ensurePluginSkillsEntry({ settingsPath, skillsDir, active: true, homeDir: ctx.homedir });
        },
        onDeactivate: async (pluginId, pluginPath, source) => {
          const skillsDir = join(pluginPath, "skills");
          if (!existsSync(skillsDir)) return false;
          const settingsPath = source === "project"
            ? join(ctx.getCwd() ?? "", ".pi", "settings.json")
            : join(agentDir, "settings.json");
          return ensurePluginSkillsEntry({ settingsPath, skillsDir, active: false, homeDir: ctx.homedir });
        },
      },
    }),
    // 壳插件携带的 pi 扩展：写 ~/.pi/agent/extensions/<pluginId>/（内核侧扩展位）。
    // 中立面叫 createPluginExtensionSync —— 壳遍历注册表按内核 id 派发，不认内核名。
    // 旧会话历史迁移：读 pi 自己的老 JSONL（私有知识），交中立会话；**落库与去重是壳的事**
    // （中立层是壳的 canonical，内核不感知）。此前这段代码在 application 层、import 了 pi-catalog，
    // 是"application 不许 import 内核实现"红线上唯一一条明文豁免——现在豁免取消。
    readLegacySessions: () => readLegacyPiSessions(agentDir).sessions,
    sessionRoot: () => join(agentDir, "sessions"),
    configRoot: () => agentDir,
    // pi 的技能清单住在 settings.json 的 skills[] 里：全局 + 项目级 + 桌面的 desktop-skills.json。
    // 这是 pi 的私有布局，由 pi 自己报——壳不再硬编码这三个路径。
    skillWatchPaths: (cwd) => [
      join(agentDir, "settings.json"),
      join(cwd, ".pi", "settings.json"),
      join(agentDir, "desktop-skills.json"),
    ],
    createPluginExtensionSync: () => ({
      // 随壳分发的适配扩展（packages/my-harness-fit-pi-extension → ~/.pi/agent/extensions/…）。
      // 资产路径由 pi 自己解析（installFitPiExtension 内部按 isPackaged 分流），壳不传参、不认路径。
      syncFit: () => {
        installFitPiExtension(ctx.isPackaged);
        return FIT_PI_EXTENSION_ID;
      },
      onActivate: (pluginId, pluginPath, extensionDir) => {
        syncPluginPiExtension(pluginId, join(pluginPath, extensionDir));
      },
      onDeactivate: (pluginId) => {
        removePluginPiExtension(pluginId);
      },
      reconcile: (activeIds) => {
        reconcilePluginPiExtensions(activeIds);
      },
    }),
  };
};

export default piKernelPlugin;
