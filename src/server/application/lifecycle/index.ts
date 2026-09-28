import type { PluginManifest, PluginState } from "@my-harness-desktop/shared";
// 同层单向依赖：`boot-ops.ts` 定义操作表与驱动器，本文件消费它们（反之不成立，
// 故 `SkillsEnsure` / `PluginExtensionEnsure` 也定义在 boot-ops 侧、由本文件引用——
// 若两处互相 import 就是同层循环，设计文档 REV-11 记过这个坑）。
import { runOps, PLUGIN_ATTACH_OPS, PLUGIN_DETACH_OPS } from "./boot-ops";
import type { PluginBootDeps, SkillsEnsure, PluginExtensionEnsure } from "./boot-ops";
import type { DiscoveredPlugin } from "../loader/discover";
import type { PluginRegistry } from "../loader/registry";
import type { ConfigStore } from "../config/config-store";

// 无特权差异(§1.4):不可卸载由 manifest 的 protected 字段声明,内核不硬编码插件 id。
// plugin-manager/i18n/theme 各自在 plugin.json 声明 protected: true。

const pluginStates = new Map<string, PluginState>();

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function canUninstall(pluginId: string, registry: PluginRegistry): boolean {
  const manifest = registry.manifestOf(pluginId);
  if (manifest?.protected) return false;
  return true;
}

export function checkDependents(pluginId: string, registry: PluginRegistry): string[] {
  const dependents: string[] = [];
  for (const [id, plugin] of registry.allPlugins()) {
    if (id === pluginId) continue;
    if (pluginStates.get(id) === "error") continue;
    const deps = plugin.manifest.dependsOn ?? [];
    if (deps.includes(pluginId)) dependents.push(id);
  }
  return dependents;
}

export function canDeactivate(pluginId: string, registry: PluginRegistry): { ok: boolean; blockedBy?: string[] } {
  if (!canUninstall(pluginId, registry)) return { ok: false, blockedBy: ["protected"] };
  const dependents = checkDependents(pluginId, registry);
  if (dependents.length > 0) return { ok: false, blockedBy: dependents };
  return { ok: true };
}

export function getPluginState(pluginId: string, disabled: string[]): PluginState {
  if (pluginStates.get(pluginId) === "error") return "error";
  if (disabled.includes(pluginId)) return "inactive";
  return "active";
}

export function setPluginError(pluginId: string): void {
  pluginStates.set(pluginId, "error");
}

export function clearPluginState(pluginId: string): void {
  pluginStates.delete(pluginId);
}

export function collectComponentNames(manifest: PluginManifest): string[] {
  const names: string[] = [];
  // settings 槽有展示分组(tabs):入口(壳)可能无 component,component 在各 TAB 里,一并收集。
  for (const s of manifest.contributes?.settings ?? []) {
    if (s.component) names.push(s.component);
    for (const t of s.tabs ?? []) if (t.component) names.push(t.component);
  }
  for (const sp of manifest.contributes?.sidePanel ?? []) names.push(sp.component);
  for (const sb of manifest.contributes?.sidebar ?? []) names.push(sb.component);
  return names;
}

export interface PluginLifecycleDeps {
  registry: PluginRegistry;
  configStore: ConfigStore;
  loader: {
    load: (manifest: PluginManifest, pluginPath: string) => Promise<void>;
    unload: (pluginId: string) => void;
  };
  notifyPluginsChanged: () => void;
  notifyPluginUnloaded: (pluginId: string, components: string[]) => void;
  /** 技能挂摘面。**类型单源在 `./boot-ops`**（冷启动步骤与暖启动共用同一份实现，
   *  故也共用同一个类型声明；此前这里内联写了一遍形状，与操作表侧是两份定义）。 */
  skillsEnsure?: SkillsEnsure;
  /** 插件携带**内核扩展**的挂摘面（`manifest.extensions` 声明才触发）。同上，单源在 `./boot-ops`。
   *  按内核 id 派发、不是一个内核一个字段：实现自己知道"哪个 id 归我"，其余 id 显式忽略
   *  （不静默吞——见装配点 `makeExtensionDispatch` 的 warn）。加第四个内核：本层零改动。 */
  pluginExtensionEnsure?: PluginExtensionEnsure;
}

export async function activate(
  deps: PluginLifecycleDeps,
  manifest: PluginManifest,
  pluginPath: string,
  source: DiscoveredPlugin["source"],
): Promise<{ ok: boolean; error: string | null }> {
  try {
    deps.registry.registerOne({ manifest, path: pluginPath, source });
    await deps.loader.load(manifest, pluginPath);
    // 启动面经**与冷启动同一张表、同一个驱动器**装载（单实体暖启动，§5.1.3）。
    // 此前这里是内联的 `skillsEnsure.onActivate` 调用 + 一个手写 for 循环遍历
    // `manifest.extensions`——与冷启动那份循环是**两份实现**（判别气味三），且暖侧没有
    // 逐实体/逐内核的隔离：一个内核的技能钩子抛错会冒泡到本函数的 catch，被记成
    // "插件激活失败"并撤注册（`setPluginError`）。现在失败被 `runOps` 就地降级并点名到
    // 操作与实体，插件保持 active——这是有意的行为改善（设计文档 §6.4.1 失败路径 ②）。
    await runOps(
      PLUGIN_ATTACH_OPS,
      "warm",
      [{ id: manifest.id, manifest, path: pluginPath, source }],
      bootDepsOf(deps),
      (e) => e.id,
    );
    clearPluginState(manifest.id);
    deps.notifyPluginsChanged();
    return { ok: true, error: null };
  } catch (e) {
    deps.registry.unregister(manifest.id);
    setPluginError(manifest.id);
    return { ok: false, error: errMsg(e) };
  }
}

export async function deactivate(deps: PluginLifecycleDeps, pluginId: string): Promise<void> {
  const manifest = deps.registry.manifestOf(pluginId);
  if (!manifest) return;
  // `manifestOf` 与 `allPlugins()` 读同一个 `byId` Map，所以 manifest 非空即 entry 必非空
  // （此前的 `&& plugin` 是防御性死代码，且它让"技能摘除被跳过、扩展摘除照跑"这种
  // 半截状态在类型上看起来是可能的）。
  const plugin = deps.registry.allPlugins().get(pluginId)!;
  deps.registry.unregister(pluginId);
  // 摘除同样经共享表 + 共享驱动器（detach 侧两个操作都是 warm-only：冷启动时禁用插件
  // 根本不注册，所以不存在"启动时要摘"的情形）。
  await runOps(
    PLUGIN_DETACH_OPS,
    "warm",
    [{ id: pluginId, manifest, path: plugin.path, source: plugin.source }],
    bootDepsOf(deps),
    (e) => e.id,
  );
  const components = collectComponentNames(manifest);
  deps.notifyPluginUnloaded(pluginId, components);
  deps.notifyPluginsChanged();
}

/** 从生命周期依赖取操作表所需的窄视图（冷暖两侧的 `bootDeps` 同形状、内容同源）。 */
function bootDepsOf(deps: PluginLifecycleDeps): PluginBootDeps {
  return { skillsEnsure: deps.skillsEnsure, pluginExtensionEnsure: deps.pluginExtensionEnsure };
}

export async function reloadPlugin(
  deps: PluginLifecycleDeps,
  pluginId: string,
  rediscover: () => DiscoveredPlugin | undefined,
): Promise<{ ok: boolean; error: string | null }> {
  const plugin = deps.registry.allPlugins().get(pluginId);
  if (!plugin) return { ok: false, error: "plugin.error.notLoaded" };
  await deactivate(deps, pluginId);
  const discovered = rediscover();
  if (!discovered) return { ok: false, error: "plugin.error.notFound" };
  return activate(deps, discovered.manifest, discovered.path, discovered.source);
}

export async function disablePlugin(
  deps: PluginLifecycleDeps,
  pluginId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const disabled = (await deps.configStore.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
  if (!disabled.includes(pluginId)) {
    await deps.configStore.set("plugin-manager", "disabledPlugins", [...disabled, pluginId]);
  }
  await deactivate(deps, pluginId);
  return { ok: true, error: null };
}

export async function enablePlugin(
  deps: PluginLifecycleDeps,
  pluginId: string,
  rediscover: () => DiscoveredPlugin | undefined,
): Promise<{ ok: boolean; error: string | null }> {
  // 先 rediscover 成功再清禁用标记:旧序先清标记后 rediscover,失败时标记已清但
  // 插件未激活——磁盘态与内存态脱节(重启后"复活"半个卸载)。
  const discovered = rediscover();
  if (!discovered) return { ok: false, error: "plugin.error.notFound" };
  const disabled = (await deps.configStore.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
  await deps.configStore.set(
    "plugin-manager",
    "disabledPlugins",
    disabled.filter((id) => id !== pluginId),
  );
  return activate(deps, discovered.manifest, discovered.path, discovered.source);
}

/** renderer 上报插件 renderer 模块加载失败：与 activate() 的失败分支同出口：
 *  撤回贡献注册（槽位消费方——右栏/设置页/侧栏/标题栏——自然不再列出）+ 记 error 态 + 广播。
 *  根因修复（此前 renderer 加载失败只 console.error：main 注册表昭告了贡献、
 *  renderer 却无组件可注册，右栏出现"组件未注册"孤儿 Tab）。 */
export function reportLoadFailure(deps: PluginLifecycleDeps, pluginId: string): void {
  setPluginError(pluginId);
  deps.registry.unregister(pluginId);
  deps.notifyPluginsChanged();
}

/** 列当前处于 error 态的插件 id（plugins:list 需要把它们列出供管理页展示）。 */
export function erroredPlugins(): string[] {
  return [...pluginStates.entries()].filter(([, s]) => s === "error").map(([id]) => id);
}

export async function uninstallPlugin(
  deps: PluginLifecycleDeps,
  pluginId: string,
): Promise<{ ok: boolean; error: string | null; errorArgs?: string[] }> {
  const check = canDeactivate(pluginId, deps.registry);
  if (!check.ok) {
    if (check.blockedBy?.includes("protected")) {
      return { ok: false, error: "plugin.error.protected" };
    }
    return { ok: false, error: "plugin.error.dependents", errorArgs: check.blockedBy ?? [] };
  }
  const disabled = (await deps.configStore.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
  if (!disabled.includes(pluginId)) {
    await deps.configStore.set("plugin-manager", "disabledPlugins", [...disabled, pluginId]);
  }
  await deactivate(deps, pluginId);
  return { ok: true, error: null };
}
