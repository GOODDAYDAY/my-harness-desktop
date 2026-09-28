// 启动面（boot surface）的内核侧操作表 —— 组装根侧（bootstrap）。
//
// 依据 docs/design/boot-surface.md §3.3.1。**分表原则：一张表 = 一个驱动点要跑的操作集合。**
// 这条原则是被设计文档第一版草稿的缺陷逼出来的：草稿只有一张 `KERNEL_OPS`，却在读者表里把
// 6 个 cold 操作一一指派给 6 个不同步骤——而 `runOps` 只按 `phases` 过滤，整表传入会让
// 一次性迁移与提问桥在每个 per-entity 步骤里**各跑一遍**（6 个内核步骤 × 6 个操作）。
// 按驱动点分表之后，每个步骤传入的表恰好是它该跑的那些操作，`phases` 只负责在同一张表内
// 区分冷/暖子集。
//
// 依赖方向：本文件在 `bootstrap/`（组装根），import `application/lifecycle/boot-ops` 的
// `BootOp` **类型**（向内，允许）与圆心契约。内层不 import 本文件。
import type { KernelId, KernelPlugin, QuestionRequestEvent } from "@my-harness-desktop/shared";
import type { BootOp } from "../../application/lifecycle/boot-ops";
import type { PluginRegistry } from "../../application/loader/registry";
import type { KernelSurfaces } from "../kernel-surfaces";

/** 内核侧一个扩展同步面（`createPluginExtensionSync()` 的返回形状，圆心内联定义）。 */
// `createPluginExtensionSync` 是**可选**方法，所以 `KernelPlugin["createPluginExtensionSync"]`
// 是 `(() => X) | undefined`，`ReturnType` 吃不下这个联合——要先 NonNullable 掉方法本身，
// 再取返回类型（圆心把这个形状写成内联对象类型而非具名接口，故只能这样派生）。
type ExtensionSync = ReturnType<NonNullable<KernelPlugin["createPluginExtensionSync"]>>;

/**
 * 内核侧操作的依赖形状。由 `50-wiring` 构造、挂在 `KernelRuntimeState.bootDeps` 上，
 * 因此**运行期暖重载也能拿到它**——它不属于冷启动即弃的 `BootContext`。
 */
export interface KernelBootDeps {
  /** getter 而非持值：暖重载会整体替换 surfaces（§3.6.2），持值会 stale。 */
  surfaces: () => KernelSurfaces;
  /** **现读**偏好，不持值：用户可能先关偏好、再装一个内核插件，暖路径必须读到当时的值。
   *  返回 `boolean` 而非 `boolean | undefined`——`DEFAULT_PREFS.bundledSkillsEnabled = true`
   *  （`main-context.ts:72`）保证 `prefsStore.get` 必有值。 */
  bundledSkillsEnabled: () => boolean;
  /** 收集器：`kernel-fit-extension` 把 `syncFit()` 返回的适配扩展 id 投进来。
   *  Set 由 `50-wiring` 创建并写入 `ctx.extensionActiveIds`（赋值点唯一），此后只经本引用 mutate
   *  ——不是对 `ctx` 字段赋值，所以"每字段只写一次"契约不需要例外（§4.1）。 */
  extensionActiveIds: Set<string>;
  /** 现算 reconcile 所需的完整 active 集合（实现见 `reconcileActiveSet`）。 */
  reconcileActive: () => Set<string>;
  /** 技能挂摘/迁移真的改了配置文件时广播 `settings:changed`
   *  （保留 `assemble.ts:478/483` 的既有行为）。 */
  notifySettingsChanged: () => void;
  /** 内核插件**清单变了**（装/删/改后差量重载成功）时广播 `refresh.requested`。
   *  为什么要有这一条：renderer 的 `window.kernel.kernelIds` 与由它构造的三张映射是
   *  boot 时取回的**跨进程快照**（§3.6.4），main 侧的注册表再新鲜它也不知道；
   *  这个信号就是让 renderer 重拉的唯一触发点。与 `notifySettingsChanged` 分工：
   *  那条说"配置文件变了"，这条说"有哪些内核变了"。 */
  notifyKernelsChanged: () => void;
  /** 提问汇入统一通道（`SessionStore.injectQuestion`）。 */
  injectQuestion: (req: QuestionRequestEvent) => void;
}

/** 按内核 id 找它的扩展同步面。`surfaces.extensionSyncs` 是 `{ kernel, sync }[]`
 *  （`kernel-surfaces.ts:105-107`），不是 Record，故用 find。 */
function syncOf(k: KernelPlugin, d: KernelBootDeps): ExtensionSync | undefined {
  return d.surfaces().extensionSyncs.find((e) => e.kernel === k.id)?.sync;
}

/**
 * reconcile 的完整 active 集合 = 适配扩展 id（收集器）**∪** 声明了内核扩展的插件 id（现算）。
 *
 * **为什么插件 id 现算而不是也走收集器**：设计文档第一版草稿让 `70-fit-extensions` 初始化
 * 收集器、`75-plugin-boot` 往里累加、`80-extension-reconcile` 消费——但 `BootOp.run` 返回
 * `void`、`runOps` 也返回 `Promise<void>`，**没有任何通道把 id 从操作回传到步骤**；若改由
 * 步骤体自己遍历累加，又正好撞上 §6.2.2 那条"per-entity 步骤不许自写实体遍历"的守卫。
 * 现算的代价可忽略：`PluginRegistry.allPlugins()` 直接 `return this.byId`
 * （`registry.ts:181-183`，纯内存零 IO），N×O(插件数) ≈ 3×50 次 Map 迭代，整个冷启动只跑一遍。
 * 对照 §3.6.3 给访问器做缓存的理由——判据是"每次调用的代价是不是构造性的"，不是"调用次数多不多"。
 *
 * 与今天等价：`assemble.ts:517-523` 对**任何**声明了 `manifest.extensions` 的插件都
 * `active.add(id)`，不区分是哪个内核；而各内核的 `reconcile` 只扫自己的目录，
 * 所以集合里含额外 id 无害。
 */
export function reconcileActiveSet(fitIds: ReadonlySet<string>, registry: PluginRegistry): Set<string> {
  const active = new Set(fitIds);
  for (const [id, p] of registry.allPlugins()) {
    if (Object.keys(p.manifest.extensions ?? {}).length > 0) active.add(id);
  }
  return active;
}

/**
 * 起提问桥并接上中性提问通道。
 *
 * §5.3.3 的两条硬约束**不由本函数保证**，写在这里只是提醒读者它们在哪：
 *   · "只对变动内核跑"由 `reloadKernelPlugins` 的差量逻辑保证（§3.6.2）——桥实例每次新建，
 *     而 `DshQuestionBridge` 用**实例内**的 `emitted: Set` 去重（`dsh-question-bridge.ts:41`），
 *     新实例的去重集合是空的，会把既存问句全部重投一遍。危害要说准（此前写过"已回答的提问
 *     卡片复活"，**说过头了**）：已结算的重复投递被 `SessionStore.injectQuestion` 的账本查重
 *     吸收（`session-store.ts:2001-2002`：`status !== "pending"` 直接 return），所以卡片不复活；
 *     真实代价是**仍待答**的提问会被重复广播一次，外加无谓的 watcher 重建。守卫见
 *     `dsh-question-bridge.scan-first.test.ts`（两个 describe 各钉一半）；
 *   · "先扫后听"由 `DshQuestionBridge.start()` 内部保证（`dsh-question-bridge.ts:45-52`：
 *     `mkdirSync` → `scan()` → `watch`，且 `if (this.watcher) return` 幂等）。
 *     这条让 `85-question-bridges` 相对现行代码后移（§4.2.3 位次 11）不漏投。
 */
function startBridge(k: KernelPlugin, inject: (req: QuestionRequestEvent) => void): void {
  const bridge = k.createQuestionBridge?.();
  if (!bridge) return;
  bridge.start();
  bridge.onQuestion((req) => inject({
    kind: "question",
    requestId: req.requestId,
    sessionKey: req.sessionId,
    questions: req.questions,
  }));
}

// ============ 五张表（一张表 = 一个驱动点） ============

/** `60-kernel-migrations` 的表。一次性历史状态迁移。 */
export const KERNEL_MIGRATE_OPS: BootOp<KernelPlugin, KernelBootDeps>[] = [
  {
    id: "kernel-legacy-migration",
    entity: "kernel",
    phases: ["cold"],
    run: (k) => { k.migrateLegacyState?.(); },
  },
];

/** `65-kernel-skills` 的表（冷启动跑两个操作；暖重载只跑 bundled 那个）。 */
export const KERNEL_SKILL_OPS: BootOp<KernelPlugin, KernelBootDeps>[] = [
  {
    id: "kernel-skills-migrate",
    entity: "kernel",
    // cold-only 的理由是**语义的**：迁移是一次性数据修复（把旧数据根 `~/.pi-desktop*` 的技能
    // 条目路径重写到新数据根），只在"从旧版本升级后的第一次启动"有事可做，之后每次调用都是
    // 零次循环。给一个永远无事可做的动作声明暖时机就是死字段（§2.2.1）。
    phases: ["cold"],
    async run(k, d) {
      if (await k.migrateSkills?.()) d.notifySettingsChanged();
    },
  },
  {
    id: "kernel-bundled-skills",
    entity: "kernel",
    // cold+warm：它是**收敛操作**（`pi-bundled-skills.ts:55-58`：已在目标态返 false，
    // 否则挂或摘，且只碰"解析后等于受管目录"的条目），运行期新增内核时按当前偏好挂上
    // 它的内置技能正是用户想要的——新增内核因此与既有内核行为一致，不需要"要等下次冷启动"的提示。
    phases: ["cold", "warm"],
    async run(k, d) {
      if (await k.ensureSkills?.(d.bundledSkillsEnabled())) d.notifySettingsChanged();
    },
  },
];

/** `70-fit-extensions` 的表（暖重载也跑：新内核需要它的适配扩展）。 */
export const KERNEL_FIT_OPS: BootOp<KernelPlugin, KernelBootDeps>[] = [
  {
    id: "kernel-fit-extension",
    entity: "kernel",
    phases: ["cold", "warm"],
    run: (k, d) => {
      const fitId = syncOf(k, d)?.syncFit?.();
      if (fitId) d.extensionActiveIds.add(fitId);
    },
  },
];

/** `80-extension-reconcile` 的表。cold-only：全量对账需要完整的 active 集合，
 *  暖启动每次只动一个实体、拿不到全集；孤儿目录因此等到下次冷启动才被清掉（§5.1.1）。 */
export const KERNEL_RECONCILE_OPS: BootOp<KernelPlugin, KernelBootDeps>[] = [
  {
    id: "kernel-extension-reconcile",
    entity: "kernel",
    phases: ["cold"],
    run: (k, d) => syncOf(k, d)?.reconcile?.(d.reconcileActive()),
  },
];

/** `85-question-bridges` 的表（暖重载只对**变动**内核跑，理由见 `startBridge`）。 */
export const KERNEL_BRIDGE_OPS: BootOp<KernelPlugin, KernelBootDeps>[] = [
  {
    id: "kernel-question-bridge",
    entity: "kernel",
    phases: ["cold", "warm"],
    run: (k, d) => startBridge(k, d.injectQuestion),
  },
];

/** 按内核 id 找扩展同步面（供步骤与暖重载复用；导出以便单测）。 */
export function extensionSyncOf(k: KernelPlugin, d: KernelBootDeps): ExtensionSync | undefined {
  return syncOf(k, d);
}

/** 类型别名导出：暖重载与步骤都要声明"某个内核的扩展同步面"。 */
export type { ExtensionSync as KernelExtensionSync };
export type { KernelId };
