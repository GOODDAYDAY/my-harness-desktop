// 内核注册表的**活访问器**（boot-surface.md §3.6.3）。
//
// 解决的问题：注册表的派生面今天以**构造期快照**被四类消费者持有（`ModelCatalog.sources`、
// `SkillAggregator.providers`、`SessionStore.kernelFacts`、`MainContext` 的九个派生字段），
// 内核插件重载后它们全部 stale。而 `MainContext` 这一类最容易被低估——
// **14 个 controller 文件里有 10 个在注册时解构 `ctx`**，解构出的局部常量在重载后不会更新。
//
// 处置方案是**函数形状**，不是 Proxy 活视图。函数形状解决 stale 的机制很朴素：
// **函数引用在解构下是安全的**——`const { kernelModels } = ctx` 拿到的是函数本身，
// 调用它时才读注册表，因此永远新鲜。仓库里已有先例：`MainContext.kernelSkillWatchPaths`
// （`application/context/main-context.ts:97`）本来就是函数。
//
// 第一版草稿提的 Proxy（`get`/`has`/`ownKeys` 三个 trap）被实测否掉，三个缺陷：
//   · 缺 `getOwnPropertyDescriptor` trap 时，`Object.keys` / `for...in` / 对象展开 /
//     `JSON.stringify` **全部静默返回空集合**（`ownKeys` 报告键存在、`getOwnProperty` 报告
//     键不存在，枚举协议据此过滤掉全部键）——这比它要消灭的 stale 更隐蔽：消费者拿到的
//     不是陈旧值而是空集。
//   · 补 trap 能修好枚举（`{ value, enumerable: true, configurable: true }`，`configurable`
//     必须为 true，否则对可扩充 target 报告"不存在的不可配置属性"会抛 TypeError），
//     但缓存失效仍需额外机制。
//   · 三个缺陷叠在 15 行草图里，说明方案太聪明。
//
// ⚠ 本文件只是两套去 stale 机制中的**一套**。分工见 §3.6.3：
//   · 本文件（+ `state.surfaces` 原子替换 + `bump()`）管的是**经函数形状访问器读**的消费者；
//   · `ModelCatalog` / `SkillAggregator` / `SessionStore.kernelFacts` 是**构造期注入快照**，
//     替换 surfaces 不会追溯更新它们，必须各自改持 getter。
//   两者管不同的持有方式，缺一不可：只做前者，`ModelCatalog` 里的旧 `sources` 数组永远不含
//   新内核；只做后者，`MainContext` 的 Record 字段仍是启动时的快照。

import type {
  KernelConfigApi,
  KernelModelSource,
  KernelExtensionSource,
  KernelId,
  KernelLogo,
  KernelModelsApi,
  KernelPlugin,
  KernelVersionApi,
} from "@my-harness-desktop/shared";
import type { KernelRegistry } from "../../kernel/core/kernel-registry";

/** 单发能力面的形状（`KernelPlugin.createOneshot` 的返回值）。 */
export type KernelOneshot = (prompt: string, cwd?: string) => Promise<string>;

/** 注册表派生面的活访问器：六个 per-id + 两个枚举 + 一个失效钩子。 */
export interface KernelAccessors {
  kernelModels(kernel: KernelId): KernelModelsApi | undefined;
  kernelConfig(kernel: KernelId): KernelConfigApi | undefined;
  kernelVersionApi(kernel: KernelId): KernelVersionApi | undefined;
  /** 缺面返回 undefined（`createOneshot` 是可选面）。调用方负责可行动错误，不静默。 */
  kernelOneshot(kernel: KernelId): KernelOneshot | undefined;
  kernelExtensionSource(kernel: KernelId): KernelExtensionSource | undefined;
  /** 模型清单源（`ModelCatalog` 合流用）。走同一份 memo，保证实例稳定。 */
  kernelModelSource(kernel: KernelId): KernelModelSource | undefined;
  /** logo 走 last-known 表，语义见 `logoOf`。 */
  kernelLogo(kernel: KernelId): KernelLogo | undefined;
  /** 全部在册内核 id。**不过缓存**（构造数组比查缓存更便宜，且缓存它会让 `bump` 语义复杂化）。 */
  kernelIds(): KernelId[];
  /** 各内核自报的配置根（缺面的内核被过滤掉）。不过缓存，理由同 `kernelIds`。 */
  kernelConfigRoots(): string[];
  /** 作废全部缓存实例。`reloadKernelPlugins` 替换 surfaces 后调一次。 */
  bump(): void;
}

/**
 * last-known logo 表：**不随 `bump()` 清空**（模块级，进程内累积）。
 *
 * 为什么 logo 要特殊对待（§3.6.3）：内核被 `unregister` 后，它的会话进程**可能仍在跑**
 * （卸载注册表条目不等于杀会话，见 `KernelRegistry.unregister` 的注释），此时
 * `registry.get(id)` 返回 `undefined`。但 logo 是**不可变数据**——同一个内核 id 的 logo
 * 永远相同——所以正在跑的会话不该因为内核被卸载就丢掉图标。
 *
 * 三种情形：在册 → 返回它的 logo；已卸载但本进程内曾在册 → 返回 last-known logo
 * （这是**更正确**的行为，那个会话确实跑在该内核上）；从未在册 → `undefined`，
 * renderer 侧回落占位。
 */
const knownLogos = new Map<KernelId, KernelLogo>();

function logoOf(registry: KernelRegistry, id: KernelId): KernelLogo | undefined {
  const live = registry.get(id)?.logo;
  if (live) {
    knownLogos.set(id, live);
    return live;
  }
  return knownLogos.get(id);
}

/**
 * 造一份绑定到 `registry` 的活访问器。
 *
 * **缓存是为了保持"实例稳定"这个既有性质，不是为了性能。** 今天的 `kernel-surfaces.ts`
 * 在构造期对每个插件调一次工厂，消费者拿到的是同一个实例；改成每次调用现造会打破这一点
 * （例如把 `createExtensionSource()` 的结果按引用比较的地方会失效）。所以按 `kind:id` 记住实例。
 *
 * **失效是整体清空（`bump`）而不是逐 id**：重载本来就是一次性事件，而它正是**应当**打破
 * 实例稳定性的时刻——同 id 异 version 的插件换了工厂，旧实例必须作废。逐 id 失效更复杂
 * 且容易漏（第一版草稿宣称"逐 id 失效"却没实现失效逻辑）。
 *
 * ⚠ `bump()` 不是可选的收尾动作：`unregister(id)` 后重新 `register` 同 id，若不 bump，
 * `memo` 会返回由**旧 plugin 实例**造出来的缓存对象——重载看起来成功了，实际全在用旧实现。
 * 这正是 Proxy 方案里"缓存失效需要额外机制"那条缺陷的函数形状版，必须显式调用。
 */
export function liveKernelAccessors(registry: KernelRegistry): KernelAccessors {
  let cache = new Map<string, unknown>();

  const bump = (): void => {
    cache = new Map();
  };

  /** 有插件就（按需）造并缓存；无插件返回 undefined（显式缺面，不伪造）。 */
  const memo = <T>(kind: string, id: KernelId, make: (plugin: KernelPlugin) => T | undefined): T | undefined => {
    const plugin = registry.get(id);
    if (!plugin) return undefined;
    const key = `${kind}:${id}`;
    if (!cache.has(key)) cache.set(key, make(plugin));
    return cache.get(key) as T | undefined;
  };

  return {
    kernelModels: (id) => memo("models", id, (p) => p.createModelsApi()),
    kernelConfig: (id) => memo("config", id, (p) => p.createConfigApi()),
    kernelVersionApi: (id) => memo("version", id, (p) => p.createVersionApi()),
    kernelOneshot: (id) => memo("oneshot", id, (p) => p.createOneshot?.()),
    kernelExtensionSource: (id) => memo("ext", id, (p) => p.createExtensionSource()),
    kernelModelSource: (id) => memo("modelSource", id, (p) => p.createModelSource()),
    kernelLogo: (id) => logoOf(registry, id),
    kernelIds: () => registry.ids(),
    kernelConfigRoots: () =>
      registry
        .all()
        .map((p) => p.configRoot?.())
        .filter((r): r is string => !!r),
    bump,
  };
}
