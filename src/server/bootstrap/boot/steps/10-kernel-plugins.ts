// 步骤 10：装载内核插件（+ 注入内核运行时）。
//
// 收编设计文档 §1.1.2 的动作 #1（`initKernelRuntime`）与 #2（扫描装载内核插件）。
// 两者合并成一步的理由：`initKernelRuntime` 注入的是 `KernelManager` 基类要用的运行时
// （spawn npm / fetch registry），而内核插件工厂在构造各自的 KernelManager 时就会用到它；
// 分开的话本步骤必须 requires 一个只有一行的步骤，没有收益。
//
// **为什么 fatal**：注册表是后续一切内核面的来源（`20-kernel-surfaces` 投影它、
// `ModelCatalog` 从它遍历模型源）。装载失败意味着壳没有任何内核可用，起不来是正确的。
// 注意"某个内核插件装载失败"与"扫描根不可读"都归 fatal：`loadKernelPlugin` 对缺产物/缺导出
// 本来就抛（`kernel-plugin-loader.ts:111-121`），那是显式失败不是静默缺面。
import type { KernelPluginContext } from "@my-harness-desktop/shared";
import type { Prefs } from "../../../application/context/main-context";
import { broadcastRefreshRequested } from "../../../routing/broadcast";
import type { BootStep } from "../types";
import { KernelRegistry } from "../../../kernel/core/kernel-registry";
import { liveKernelAccessors } from "../kernel-accessors";
import { initKernelRuntime } from "../../../kernel/core/kernel-manager";
import { createNpmKernelRuntime } from "../../../client/npm/kernel-runtime";
import { createKernelPluginLoader } from "../kernel-plugin-loading";

const step: BootStep = {
  id: "10-kernel-plugins",
  scope: "global",
  failure: "fatal",
  run(ctx) {
    // 内核版本管理的运行时（npm spawn / registry fetch）经接口注入，基类不 import client。
    initKernelRuntime(createNpmKernelRuntime());

    const registry = new KernelRegistry();
    const { paths, prefsStore, lateRefs, gateway, isPackaged, forceEnableKernels } = ctx;

    // 扫描 + 装载能力抽成装载器（`../kernel-plugin-loading.ts`）：冷启动与**暖重载**
    // 共用同一份"怎么找、怎么装"，避免两处规则漂移。装载器存进 KernelRuntimeState，
    // 因为 BootContext 冷启动结束即弃（§2.4.3），而暖重载仍需要它。
    const loader = createKernelPluginLoader({
      paths,
      prefsStore,
      lateRefs,
      isPackaged,
      forceEnableKernels,
      // 经 broadcast 层的具名助手，不在步骤里拼 channel 字面量（channel 名单源在 channel-contract）。
      broadcastRefresh: () => broadcastRefreshRequested(gateway),
    });
    for (const entry of loader.scan()) loader.load(registry, entry);

    ctx.kernelRegistry = registry;
    // 注册表 + 它的活视图在同一步诞生（理由见 BootContext.kernelAccessors 的注释：
    // memo 缓存只能有一份，否则 bump() 清不干净）。
    ctx.kernelAccessors = liveKernelAccessors(registry);
    ctx.kernelLoader = loader;
  },
};

export default step;
