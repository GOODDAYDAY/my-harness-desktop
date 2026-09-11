import type { PluginManifest, PluginState, KernelId } from "@my-harness-desktop/shared";
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
  skillsEnsure?: {
    onActivate(pluginId: string, pluginPath: string, source: DiscoveredPlugin["source"]): Promise<void>;
    onDeactivate(pluginId: string, pluginPath: string, source: DiscoveredPlugin["source"]): Promise<void>;
  };
  /**
   * 插件携带**内核扩展**的挂摘（manifest.extensions 声明才触发）。
   *
   * 按内核 id 派发，不是一个内核一个字段：装配点拿到的这一份实现自己知道"哪个 id 归我"，
   * 其余 id 显式忽略（不静默吞——见装配点的实现注释）。实现在各内核插件里
   * （pi = 写 ~/.pi/agent/extensions/，dsh = 同步目录 + 挂 cordis.yml 块），
   * application 只持接口——与 skillsEnsure 同一形状。加第四个内核：圆心与生命周期层零改动。
   */
  pluginExtensionEnsure?: {
    onActivate(kernel: KernelId, pluginId: string, pluginPath: string, extensionDir: string): void;
    onDeactivate(kernel: KernelId, pluginId: string): void;
  };
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
    if (deps.skillsEnsure) await deps.skillsEnsure.onActivate(manifest.id, pluginPath, source);
    // 遍历插件声明的内核扩展（{内核 id: 相对路径}），逐个派发给对应内核的同步实现。
    for (const [kernel, dir] of Object.entries(manifest.extensions ?? {})) {
      deps.pluginExtensionEnsure?.onActivate(kernel, manifest.id, pluginPath, dir);
    }
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
  const plugin = deps.registry.allPlugins().get(pluginId);
  deps.registry.unregister(pluginId);
  if (deps.skillsEnsure && plugin) {
    await deps.skillsEnsure.onDeactivate(pluginId, plugin.path, plugin.source);
  }
  for (const kernel of Object.keys(manifest.extensions ?? {})) {
    deps.pluginExtensionEnsure?.onDeactivate(kernel, pluginId);
  }
  const components = collectComponentNames(manifest);
  deps.notifyPluginUnloaded(pluginId, components);
  deps.notifyPluginsChanged();
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
