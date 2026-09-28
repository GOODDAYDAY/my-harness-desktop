// 内核插件的**差量重载**（boot-surface.md §3.6.2，图 5）。
//
// 入参是 `KernelRuntimeState` 而不是 `BootContext`——后者冷启动结束即弃（§2.4.3），
// 暖路径能用的东西必须在冷启动时就存进状态（`loader` / `accessors` / `bootDeps`）。
//
// ## 差量判据是 (id, version)，不是 id
//
// 只比 id 集合的后果：用户改了一个内核插件的代码或 manifest 后点重载，它落在
// "两边都有 → 不动"分支，工厂不重跑，**改动完全不生效且没有任何报错**。这也与壳插件侧的
// `reloadPlugin`（deactivate → rediscover → activate，会重读 manifest）不对称。
// `version` 的旧值只能从注册表取（`KernelRegistry.versionOf`，r14 加的），
// 因为 `KernelPlugin` 契约里没有 version 面。
//
// ## ⚠ 与图 5 的一处顺序偏差（实证后修正，文档已同步）
//
// 图 5 画的是「对变动内核跑暖操作(G) → 重建 surfaces + bump(H)」。这个顺序对**新增内核**是错的：
// `KERNEL_FIT_OPS` 经 `syncOf(k, d)` 读 `d.surfaces().extensionSyncs`，而 surfaces 还是旧的、
// 没有新内核的条目 → `syncOf` 返回 `undefined` → `syncFit()` 永不执行 →
// **新内核的适配扩展装不上，且不报错**（`if (fitId)` 直接跳过）。
// 本实现改为「改注册表 → 重建 surfaces + bump → 跑暖操作 → 广播」。
// 安全性依据：`buildKernelSurfaces` 是纯函数（重跑无副作用），且三张暖表里只有
// `KERNEL_FIT_OPS` 读 surfaces，另两张（`KERNEL_SKILL_OPS` 的 `k.ensureSkills`、
// `KERNEL_BRIDGE_OPS` 的 `startBridge(k, …)`）都只用插件自身与注入的回调——
// 所以提前重建对它们没有任何影响，只是让 FIT 那张表能看见新内核。
//
// ## 四个必须钉死的语义（§3.6.2）
//
// 1. **同 id 同 version 不重跑工厂**。dsh 的工厂带七个副作用（`kernel/dsh/plugin.ts:33-57`）：
//    这些操作幂等，但重复执行会重写 `cordis.yml`、重跑迁移扫描——无收益，且有踩到用户手改配置的风险。
// 2. **消失的内核不 stop 已在跑的进程**。`unregister` 只摘注册表条目；已构造的 backend 实例
//    仍然活着（它不查注册表）。会话进程的生命周期归 `SessionStore`，不归重载。
// 3. **暖操作只对变动的内核跑**（新增的 + version 变了的）。三张含 warm 的表逐个调；
//    `kernel-skills-migrate` 与 `kernel-extension-reconcile` 是 cold-only，会被相位过滤掉
//    （后者需要完整 active 集合，暖路径每次只动一个实体、拿不到全集，孤儿目录等下次冷启动清）。
// 4. **重建 surfaces 后必须原子替换 + 清缓存 + 广播**。`bump()` 不是可选收尾：
//    不 bump 的话访问器会返回由旧插件实例造出来的缓存对象，重载看起来成功、实际全在用旧实现
//    （`kernel-accessors.test.ts` 有一条反向证明钉住这点）。

import type { KernelId, KernelPlugin, KernelReloadReport } from "@my-harness-desktop/shared";
import type { KernelPluginEntry } from "../../kernel/core/kernel-plugin-loader";
import { runOps } from "../../application/lifecycle/boot-ops";
import { buildKernelSurfaces } from "../kernel-surfaces";
import { KERNEL_BRIDGE_OPS, KERNEL_FIT_OPS, KERNEL_SKILL_OPS } from "./ops";
import type { KernelRuntimeState } from "./types";

// 结果类型是圆心的 `KernelReloadReport`（跨 main→renderer 的载荷，两侧共用一份定义）。
// ⚠ 不要在这里另定义一个同形状接口：那是 §1.3 的"同一概念两份定义"，必然漂移。

/**
 * 差量重载内核插件。
 *
 * @returns 变化清单。**永不因为"没有变化"而抛**；装载失败进 `errors` 而不是抛出（见上）。
 */
export async function reloadKernelPlugins(state: KernelRuntimeState): Promise<KernelReloadReport> {
  const { registry, loader, accessors, bootDeps } = state;

  const added: KernelId[] = [];
  const replaced: { id: KernelId; from: string; to: string }[] = [];
  const removed: KernelId[] = [];
  const unchanged: KernelId[] = [];
  const errors: { id: string; message: string }[] = [];

  // ---- 1. 扫出"应当装载"的清单，按 (id, version) 与当前注册表对比 ----
  const wanted: KernelPluginEntry[] = loader.scan();
  const wantedIds = new Set(wanted.map((e) => e.manifest.id));

  // 消失的内核：只摘注册表条目（语义 2：不 stop 已在跑的进程）
  for (const id of registry.ids()) {
    if (!wantedIds.has(id)) {
      registry.unregister(id);
      removed.push(id);
    }
  }

  // 新增 / 版本变更 / 原样保留
  const reloaded: KernelPlugin[] = [];
  for (const entry of wanted) {
    const id = entry.manifest.id;
    const known = registry.has(id);
    const oldVersion = registry.versionOf(id);
    if (known && oldVersion === entry.version) {
      unchanged.push(id);          // 语义 1：工厂不重跑
      continue;
    }
    try {
      if (known) {
        // 同 id 异 version：必须先 unregister 再 load——注册表对重复 id 是 fail-fast 的，
        // 而且"直接覆盖"会让持有旧插件引用的消费者静默 stale。
        registry.unregister(id);
        loader.load(registry, entry);
        replaced.push({ id, from: oldVersion ?? "(未知)", to: entry.version });
      } else {
        loader.load(registry, entry);
        added.push(id);
      }
      const plugin = registry.get(id);
      if (plugin) reloaded.push(plugin);
    } catch (e) {
      errors.push({ id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  const changed = added.length + replaced.length + removed.length > 0;
  if (!changed) return result();

  // ---- 2. 先重建 surfaces + 清访问器缓存（顺序理由见文件头"与图 5 的偏差"）----
  // 原子替换：surfaces 是普通字段赋值，消费者经 getter 读，不会看到半成品。
  state.surfaces = buildKernelSurfaces(registry, accessors);
  accessors.bump();                // 语义 4：不 bump 就会拿到旧插件实例造出来的缓存对象

  // ---- 3. 只对变动的内核跑暖操作（语义 3）----
  // 三张含 warm 的表逐个调；cold-only 的操作（skills-migrate / extension-reconcile）
  // 被 runOps 的相位过滤掉，不需要在这里挑。
  const nameOf = (k: KernelPlugin): string => k.id;
  // 三张表**逐张显式调**，不写成 `for (const table of [A,B,C]) runOps(table, …)`。
  // 两个理由：① 静态守卫（`static-guards.test.ts` §6.1.3）按**字面表名**扫暖调用点，
  //   传变量的循环它看不见——而那条守卫的存在意义就是"声明了 warm 相位的表必须真有暖读者"，
  //   为了让循环写法通过去放宽判据是本末倒置；② 三张表语义不同（技能挂摘 / 适配扩展同步 /
  //   提问桥），显式三行让"这里跑了哪三件事"一眼可见，循环反而把它抽象掉了。
  await runOps(KERNEL_SKILL_OPS, "warm", reloaded, bootDeps, nameOf);
  await runOps(KERNEL_FIT_OPS, "warm", reloaded, bootDeps, nameOf);
  await runOps(KERNEL_BRIDGE_OPS, "warm", reloaded, bootDeps, nameOf);

  // ---- 4. 广播（只在真有变化时）----
  bootDeps.notifyKernelsChanged();

  return result();

  /** `changed` 必须是**普通字段**而不是 getter：这份对象要经 JSON 过 IPC，getter 不会被序列化。 */
  function result(): KernelReloadReport {
    return { added, replaced, removed, unchanged, errors, changed };
  }
}
