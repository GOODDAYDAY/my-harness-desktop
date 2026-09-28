// 壳插件的**差量重扫**（boot-surface.md §6.4.3 验收① 的前置缺口，r20 补）。
//
// ## 为什么需要它
//
// 内核插件重载（`boot/kernel-reload.ts`）只动**内核注册表**。但「一个内核 = 一个插件」：
// 同一个目录既是内核插件（`manifest.kernel` 面），也是壳插件（`renderer/` + `locales/` +
// `contributes.settings`）。于是只重载内核侧会留下两个方向的用户可见缺陷：
//
//   · **投递新内核插件** → 内核装载了、模型能选了，但**设置页 TAB 不出现**
//     （TAB 来自壳插件的 `contributes.settings`，走的是壳插件注册表）；
//   · **删掉内核插件** → 内核注销了，但设置页 TAB **还在**，点进去只能拿到
//     "内核 X 没有原生配置面" 的可行动错误。而 `40-shell-plugins` 在**冷启动**时
//     本来就有一条过滤专门防这个：「内核面未装载的内核插件不注册——没有内核却显示
//     它的设置页，只会得到一堆报错」。暖路径不做同样的过滤，就是两条路径行为不一致。
//
// 另有一处既有能力覆盖不到：`reloadPlugin(deps, id, rediscover)` 要求插件**已在注册表里**
// （`if (!plugin) return { ok:false, error:"plugin.error.notLoaded" }`），而
// `rediscoverPlugin(id)` 也是**按 id** 找——所以"目录里出现了一个此前不认识的插件"
// 在不重启的情况下**没有任何入口能拾起它**。本文件补的就是这个入口。
//
// ## 与冷启动共用同一套语义（不另立规则）
//
// · 四根发现顺序 = 优先级低→高（builtin < installed < user < project），后者覆盖前者
//   （`registerOne` 里 `byId.set` + 数组槽的"push 前先按 contribution.id 清同 id 旧项"）；
// · 两条过滤与冷启动逐字对应：`isKernelLoadable`（内核面未装载的不注册）与 `disabled`
//   （禁用插件根本不注册）；
// · **先 deactivate 再 activate**：`registerOne` 对数组槽是覆盖语义，但 `languages.push`
//   **没有去重**——重复注册会让语言贡献翻倍。`reloadPlugin` 也是这个顺序，同理。

import { discoverPlugins, type DiscoveredPlugin } from "../loader/discover";
import { activate, deactivate, type PluginLifecycleDeps } from "./index";
import type { ShellReloadReport } from "@my-harness-desktop/shared";

/** 四根插件目录（与 `MainPaths` 对应；由装配点传入，本层不读环境）。 */
export interface ShellPluginRoots {
  builtin: string;
  installed: string;
  user: string;
  project: string;
}

// 结果类型是圆心的 `ShellReloadReport`（跨 main→renderer 的载荷，两侧共用一份定义）。

/**
 * 差量重扫四根插件目录，把注册表收敛到"当前应当装载的集合"。
 *
 * @param isKernelLoadable 与 `40-shell-plugins` 的同名判据同源：`(id, hasKernelBlock) => boolean`。
 *   由装配点给成"查内核注册表"（注册表是单源，重算比传状态更不容易漂）。
 */
export async function reloadShellPlugins(
  deps: PluginLifecycleDeps,
  roots: ShellPluginRoots,
  isKernelLoadable: (id: string, hasKernelBlock: boolean) => boolean,
): Promise<ShellReloadReport> {
  const activated: string[] = [];
  const deactivated: string[] = [];
  const unchanged: string[] = [];
  const errors: { id: string; message: string }[] = [];

  const disabled = new Set((await deps.configStore.get<string[]>("plugin-manager", "disabledPlugins")) ?? []);

  // ---- 1. 算出"当前应当装载的集合"（与冷启动同一套顺序与过滤）----
  const desired = new Map<string, DiscoveredPlugin>();
  for (const [root, source] of [
    [roots.builtin, "builtin"],
    [roots.installed, "installed"],
    [roots.user, "user"],
    [roots.project, "project"],
  ] as const) {
    for (const p of discoverPlugins(root, source)) {
      // 过滤一：内核面未装载的内核插件（没有内核却显示它的设置页，只会得到一堆报错）
      if (!isKernelLoadable(p.manifest.id, !!p.manifest.kernel)) continue;
      // 过滤二：禁用插件根本不注册
      if (disabled.has(p.manifest.id)) continue;
      desired.set(p.manifest.id, p);   // 后一根覆盖前一根（高优先级胜出）
    }
  }

  const current = deps.registry.allPlugins();

  // ---- 2. 该摘的：目录消失 / 内核面不再可装载 / 被禁用 ----
  for (const id of [...current.keys()]) {
    if (desired.has(id)) continue;
    try {
      await deactivate(deps, id);
      deactivated.push(id);
    } catch (e) {
      errors.push({ id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  // ---- 3. 该装的：此前不认识的 id ----
  for (const [id, p] of desired) {
    if (current.has(id)) {
      unchanged.push(id);
      continue;
    }
    const r = await activate(deps, p.manifest, p.path, p.source);
    if (r.ok) activated.push(id);
    else errors.push({ id, message: r.error ?? "plugin.error.unknown" });
  }

  const changed = activated.length + deactivated.length > 0;
  return { activated, deactivated, unchanged, errors, changed };
}
