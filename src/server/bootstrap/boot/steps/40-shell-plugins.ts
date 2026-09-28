// 步骤 40：壳插件发现与注册 + i18n 合并 + 配置通道 + 通用设置种子。
//
// 收编设计文档 §1.1.2 的动作 #5（四根发现注册）、#6（i18n 合并）、#8（general.json 种子）。
//
// **两处与今天不同，都是有意的**：
//
// ① **禁用插件根本不注册**（今天 `assemble.ts:207-210` 先 `registerAll` 全部，再 L354-355
//    对 `disabledPlugins` 逐个 `unregister`）。`assemble.ts:349-353` 的注释解释了为什么要绕：
//    "disabledPlugins 由 demo/用户直接写 config（不经 disablePlugin/deactivate 的撤注册），
//    故启动时在此统一撤——plugins:list 仍经 rediscover 兜底列出它们供管理页展示"。
//    改成不注册是安全的，判据是 `plugins:list` 的数据来源本来就不只是注册表：
//    `controllers/plugins.ts:104-127` 有第二段循环，专门对 `disabled` 与 `erroredPlugins()` 里
//    **不在注册表中**的 id 调 `rediscoverPlugin(id)` 从磁盘重扫，并按 `getPluginState` 标注状态。
//    所以：列出由那段兜底负责（state = inactive），重新启用走 `enablePlugin` 的
//    rediscover → 清标记 → activate（`lifecycle/index.ts:157-173`），都不要求插件先在注册表里。
//    连带简化：`75-plugin-boot` 不再需要 `disabled` 过滤（禁用插件不在注册表里，遍历遇不到）。
//
// ② **ConfigStore 在此构造**，而它的 `getProjectDir` 回调要读 SessionStore（`50-wiring` 才建）。
//    这不是问题：`SessionStore.activeCwd` 初值就是 `null`（`session-store.ts:186`），冷启动期间
//    `getActiveCwd()` 本来返回 null，故 `lateRefs.getActiveCwd()` 未绑定时返回 null 与今天
//    **逐字等价**（详见 `../late-refs.ts` 里该方法的说明）。
//
// **为什么 fatal**：注册表是壳插件系统的根，i18n 与槽位贡献都从它来。但注意 fatal 覆盖的是
// **结构性**失败（扫描根不可读、注册表真冲突）；单个插件的 `plugin.json` 解析失败是
// `discoverPlugins` 内部的**跳过**（`loader/discover.ts:48-56`，`catch {}` 在 L53），不会让本步骤抛出。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BootStep } from "../types";
import { PluginRegistry } from "../../../application/loader/registry";
import { discoverPlugins } from "../../../application/loader/discover";
import { mergeLanguageContributions } from "../../../application/i18n/merge";
import { ConfigStore } from "../../../application/config/config-store";

const step: BootStep = {
  id: "40-shell-plugins",
  scope: "global",
  failure: "fatal",
  requires: ["20-kernel-surfaces"],
  run(ctx) {
    const { paths, lateRefs } = ctx;

    // ---- 配置通道（统一项目级配置，unified-project-config.md）----
    // 全局层 = <数据根>/config；项目级经 getProjectDir 动态解析（切项目不用清缓存，
    // 缓存 key 含 projectDir 维度）。getActiveCwd 是 main 侧 cwd 事实源。
    const configStore = new ConfigStore({
      userDir: paths.configDir,
      getProjectDir: () => {
        const cwd = lateRefs.getActiveCwd();
        return cwd ? join(cwd, ".my-harness-desktop", "config") : null;
      },
    });
    const disabled = new Set(configStore.get<string[]>("plugin-manager", "disabledPlugins") ?? []);

    // ---- 四根发现 + 注册（低到高优先级：builtin < installed < user < project）----
    const registry = new PluginRegistry();
    // 过滤一：内核面**未装载**的内核插件——没有内核却显示它的设置页，只会得到一堆报错。
    // 判据从注册表现算（`manifest.kernel` 有而 `kernelRegistry` 没有），不再另存一份
    // "未装载 id 集合"跨步骤传递：注册表是单源，重算比传状态更不容易漂。
    const kernelRegistry = ctx.kernelRegistry!;
    const isLoadable = (id: string, hasKernelBlock: boolean): boolean =>
      !hasKernelBlock || kernelRegistry.has(id);
    // 过滤二：禁用插件根本不注册（见文件头 ①）。
    for (const [root, source] of [
      [paths.builtinPluginsDir, "builtin"],
      [paths.installedPluginsDir, "installed"],
      [paths.userPluginsDir, "user"],
      [paths.projectPluginsDir, "project"],
    ] as const) {
      const discovered = discoverPlugins(root, source).filter(
        (p) => isLoadable(p.manifest.id, !!p.manifest.kernel) && !disabled.has(p.manifest.id),
      );
      registry.registerAll(discovered);
    }

    // ---- i18n：合并所有插件的 languages 贡献项成 i18next resources（05-plugin-i18n §6）----
    // main 只合并 + 给 renderer；renderer 端 init i18next + react-i18next（跨堆，各持实例）。
    const i18nResources = mergeLanguageContributions(registry.languageContributions());

    // ---- 通用设置种子（general.json）----
    // 不经 ConfigStore：它管的是按 pluginId 分命名空间的插件配置，而 general.json 是壳自己的
    // 通用设置（直读写文件）。归进本步骤的理由是"同一批配置文件在同一个步骤里就位"。
    const generalPath = paths.generalConfigPath;
    if (!existsSync(generalPath)) {
      if (!existsSync(paths.configDir)) mkdirSync(paths.configDir, { recursive: true });
      writeFileSync(generalPath, JSON.stringify({ defaultThinkingLevel: "high", sidebarDefaultOpen: true }, null, 2), "utf-8");
    } else {
      // 一次性迁移：旧种子写的是 sidebarDefaultOpen:false（非用户显式选择），按新默认翻 true。
      // 迁移标记保证只翻一次——用户此后手动关掉写显式 false，不再被回翻。
      try {
        const cfg = JSON.parse(readFileSync(generalPath, "utf-8")) as Record<string, unknown>;
        if (cfg["sidebarDefaultOpen"] === false && cfg["sidebarDefaultOpenMigrated"] !== true) {
          cfg["sidebarDefaultOpen"] = true;
          cfg["sidebarDefaultOpenMigrated"] = true;
          writeFileSync(generalPath, JSON.stringify(cfg, null, 2), "utf-8");
        }
      } catch { /* 种子迁移失败不阻塞启动 */ }
    }

    ctx.registry = registry;
    ctx.configStore = configStore;
    ctx.i18nResources = i18nResources;
  },
};

export default step;
