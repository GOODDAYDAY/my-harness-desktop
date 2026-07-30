import type { PluginManifest, PluginState } from "../../domain/contributions";
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
  for (const s of manifest.contributes?.settings ?? []) names.push(s.component);
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
    clearPluginState(manifest.id);
    deps.notifyPluginsChanged();
    return { ok: true, error: null };
  } catch (e) {
    deps.registry.unregister(manifest.id);
    setPluginError(manifest.id);
    return { ok: false, error: errMsg(e) };
  }
}

export function deactivate(deps: PluginLifecycleDeps, pluginId: string): void {
  const manifest = deps.registry.manifestOf(pluginId);
  if (!manifest) return;
  deps.registry.unregister(pluginId);
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
  deactivate(deps, pluginId);
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
  deactivate(deps, pluginId);
  return { ok: true, error: null };
}

export async function enablePlugin(
  deps: PluginLifecycleDeps,
  pluginId: string,
  rediscover: () => DiscoveredPlugin | undefined,
): Promise<{ ok: boolean; error: string | null }> {
  const disabled = (await deps.configStore.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
  await deps.configStore.set(
    "plugin-manager",
    "disabledPlugins",
    disabled.filter((id) => id !== pluginId),
  );
  const discovered = rediscover();
  if (!discovered) return { ok: false, error: "plugin.error.notFound" };
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
  deactivate(deps, pluginId);
  return { ok: true, error: null };
}
