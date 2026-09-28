// 内核插件的**扫描 + 装载**能力（boot-surface.md §3.6.2）。
//
// 为什么要单独抽出来：冷启动（`steps/10-kernel-plugins.ts`）与暖重载（`kernel-reload.ts`）
// 要做的是**同一件事**——扫壳插件根目录、按默认开关过滤、逐个执行工厂装载进注册表。
// 若各写一份，两者必然漂移（历史上"扫描规则改了、重载没跟着改"就是这个形状）。
// 抽成一个装载器后，冷启动把它存进 `KernelRuntimeState.loader`，暖重载直接复用。
//
// ⚠ 为什么必须存进 `KernelRuntimeState` 而不是暖路径现场重建：`loadKernelPlugin` 需要
// `KernelPluginContext`，而它由 `paths` / `prefsStore` / `lateRefs` / `isPackaged` 闭包捕获——
// 这些都挂在 `BootContext` 上，而 **`BootContext` 冷启动结束即弃**（§2.4.3）。
// 所以"暖路径要的东西必须在冷启动时就存下来"，装载器就是那个存下来的东西。

import type { KernelPluginContext } from "@my-harness-desktop/shared";
import type { KernelRegistry } from "../../kernel/core/kernel-registry";
import {
  defaultEnabledEntries,
  loadKernelPlugin,
  scanKernelPlugins,
  // KernelPluginEntry 定义在装载器里（不在圆心发布面）：它是"扫到的一个内核插件目录"的
  // 装载期形状，属机制细节，不是壳与内核之间的契约。
  type KernelPluginEntry,
} from "../../kernel/core/kernel-plugin-loader";
import type { BootPaths } from "./types";
import type { Prefs } from "../../application/context/main-context";
import type { JsonPrefsStore } from "../../application/config/json-prefs";
import type { KernelLateRefs } from "./late-refs";

/** 装载器的依赖（全部来自冷启动期的 `BootContext`，由 step 10 一次性捕获）。 */
export interface KernelPluginLoaderDeps {
  paths: BootPaths;
  prefsStore: JsonPrefsStore<Prefs>;
  lateRefs: KernelLateRefs;
  isPackaged: boolean;
  /** `MHD_ENABLE_KERNELS` 解析结果。**冷启动时捕获、暖重载沿用同一份**：
   *  它是启动期环境变量，重载时重新读 `process.env` 会让"同一个开关在两次装载里含义不同"
   *  （用户改了环境但没重启进程，这种半生效状态最难排查）。 */
  forceEnableKernels: ReadonlySet<string>;
  /** 内核安装/切换完成后的通用刷新信号（经 broadcast 层的具名助手，不在这里拼 channel 字面量）。 */
  broadcastRefresh: () => void;
}

/** 扫描 + 装载内核插件的能力面。 */
export interface KernelPluginLoader {
  /** 扫出**应当装载**的内核插件清单（builtin 在前、user 在后；已按默认开关过滤）。 */
  scan(): KernelPluginEntry[];
  /** 装载一个插件进注册表（**执行工厂** = 跑该内核的 `ensure*` 首次准备）。 */
  load(registry: KernelRegistry, entry: KernelPluginEntry): void;
}

export function createKernelPluginLoader(deps: KernelPluginLoaderDeps): KernelPluginLoader {
  const { paths, prefsStore, lateRefs, isPackaged, forceEnableKernels, broadcastRefresh } = deps;

  // 内核插件工厂拿到的上下文（除 testModel）。**三个回调经 lateRefs 延迟解析**——
  // 它们要调用的 SessionStore 在 50-wiring 才创建，而内核装载必须先跑（投影面来自注册表）。
  // 这是消不掉的循环依赖，理由与契约见 ./late-refs.ts 文件头。
  const base: Omit<KernelPluginContext, "testModel"> = {
    isPackaged,
    homedir: paths.homeDir,
    dataRoot: paths.dataRoot,
    // ⚠ 走 store 的**动态键** API，不再 `key as keyof Prefs` 强转。
    //   强转的后果是：内核自定义的键必须**枚举进 application 层的 `Prefs`** 才类型安全，
    //   于是出现了 `customCliDir`（隐式 pi 的）与 `dshCustomCliDir` 两个按内核名分的字段
    //   ——§6.3 检验④ 禁的形态，加第四个内核就要改中层类型。
    //   圆心契约（`kernel-plugin.ts`）本来就写着「核心不硬编码 key 名，key 由插件自定」，
    //   动态键 API 是这句话的正式实现：键不进 `Prefs`、不需要强转、照样持久化。
    prefs: {
      get: <T>(key: string): T | undefined => prefsStore.getDynamic(key) as T | undefined,
      set: <T>(key: string, value: T): void => { prefsStore.setDynamic(key, value); },
      // 一次性迁移要能"摘掉"旧键（不是留个空壳在盘上），所以 prefs 面除 get/set 还有 remove。
      remove: (key: string): void => { prefsStore.removeDynamic(key); },
    },
    markSessionsPendingRestart: (reason) => lateRefs.markSessionsPendingRestart(reason),
    broadcastRefresh,
    builtinSkillsDir: paths.bundledSkillsDir,
    getCwd: () => lateRefs.getActiveCwd(),
  };

  return {
    scan() {
      // 内核插件**扫的就是壳插件根目录**——manifest 带 `kernel` 块者，既是一个壳插件、
      // 也是一个内核插件（内核面与它的 desktop 对接面同属一个目录）。
      // builtin 在前、user 在后：用户装的第三方内核插件可覆盖同名（registry 对重复 id fail-fast）。
      // 默认装载过滤：`kernel.enabled === false` 的内核默认不装载（如 minimal 是验证用内核）；
      // `MHD_ENABLE_KERNELS` 运行时强制启用。**扫描 = 存在性**（卸载 = 删 plugin.json），
      // **装载 = 默认开关**（enabled），两轴正交。
      return defaultEnabledEntries(
        [...scanKernelPlugins(paths.builtinPluginsDir), ...scanKernelPlugins(paths.userPluginsDir)],
        forceEnableKernels,
      );
    },
    load(registry, entry) {
      loadKernelPlugin(registry, entry, paths.kernelBuildRoot, {
        ...base,
        // testModel 需要知道是哪个内核 —— 由 entry.manifest.id 提供（内核 id 单源在 manifest）。
        testModel: (cwd, provider, modelId) => lateRefs.testModel(cwd, provider, modelId, entry.manifest.id),
      });
    },
  };
}
