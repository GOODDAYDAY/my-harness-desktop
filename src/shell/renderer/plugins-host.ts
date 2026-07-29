// plugins-host —— renderer 侧插件加载器。
//
// 评估 P1-A2 兼顾方案:按文件物理形态分派(非特权分派,§1.4 本意是禁"识别内置件特殊对待"):
// - builtin 插件:源码编译进 bundle,经 import.meta.glob 加载(编译期路径解析,Vite 生成 chunk)。
// - 第三方插件(installed/user/project):独立 js 文件,经 import(file://path) 运行期加载。
// 两条路径各自内部一视同仁:glob 对所有内置平等、file:// 对所有第三方平等。判据是"文件形态"
// 而非"是否内置特权"。builtin 走 glob 不重构构建(零风险),第三方走 file:// 补加载缺口。
import { useUiStore, unregisterSettingsComponent, unregisterSidePanelComponent, unregisterSidebarComponent, unregisterMainViewComponent } from "@pi-desktop/react";

const builtinModules = import.meta.glob("../../plugins/*/renderer/index.{ts,tsx}");
if (Object.keys(builtinModules).length === 0) {
  throw new Error(
    "[plugins-host] glob 匹配 0 个内置插件 renderer,路径可能写错(应在 src/plugins/*/renderer/index.tsx)",
  );
}

/** 已加载的第三方插件 id(避免热加载重复 import)。 */
const loadedThirdParty = new Set<string>();
/** 已加载的 builtin 插件 id(热加载 enable 时,对未加载的 builtin 重新执行 glob chunk)。 */
const loadedBuiltin = new Set<string>();
/** builtin glob path → pluginId 映射(热加载按 id 找 glob chunk 重新执行)。 */
const builtinPathById = new Map<string, string>();
for (const path of Object.keys(builtinModules)) {
  const match = path.match(/plugins\/([^/]+)\/renderer/);
  if (match) builtinPathById.set(match[1], path);
}

/** file:// 加载第三方插件 renderer(独立 js 文件,运行期路径)。
 *  带时间戳避缓存(热加载重新 import 同路径时拿到新版本)。 */
async function loadThirdParty(pluginId: string, pluginPath: string, rendererEntry: string): Promise<void> {
  const fullPath = `${pluginPath}/${rendererEntry}`.replace(/\\/g, "/");
  await import(/* @vite-ignore */ `file://${fullPath}?t=${Date.now()}`);
  loadedThirdParty.add(pluginId);
}

/** glob 加载 builtin 插件(启动 + 热加载 enable 复用)。 */
async function loadBuiltin(pluginId: string): Promise<void> {
  const path = builtinPathById.get(pluginId);
  if (!path) throw new Error(`builtin 插件 ${pluginId} 的 renderer chunk 未找到`);
  await builtinModules[path]();
  loadedBuiltin.add(pluginId);
}

/** 启动加载:builtin(glob,过滤 disabled)+ 第三方(file://)。 */
async function bootstrap(): Promise<void> {
  const disabled = (await window.pi.config.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
  // builtin:glob 加载,跳过 disabled,记录 loadedBuiltin
  const builtinIds = [...builtinPathById.keys()].filter((id) => !disabled.includes(id));
  // 第三方:拉 plugins.list,对 path 非空的(第三方)file:// 加载
  const list = await window.pi.plugins.list();
  const thirdParty = list.filter((p) => p.path && p.renderer && !disabled.includes(p.id));

  let loaded = 0;
  const total = builtinIds.length + thirdParty.length;
  const onDone = (): void => {
    loaded++;
    if (loaded === total) useUiStore.getState().bumpPlugins();
  };
  if (total === 0) { useUiStore.getState().bumpPlugins(); return; }
  for (const id of builtinIds) {
    void loadBuiltin(id).then(onDone).catch((e) => {
      console.error(`[plugins-host] 内置插件加载失败: ${id}`, e);
      onDone();
    });
  }
  for (const p of thirdParty) {
    void loadThirdParty(p.id, p.path!, p.renderer!).then(onDone).catch((e) => {
      console.error(`[plugins-host] 第三方插件加载失败: ${p.id}`, e);
      onDone();
    });
  }
}

void bootstrap().catch((e) => {
  console.error("[plugins-host] 插件加载流程失败", e);
  useUiStore.getState().bumpPlugins();
});

window.pi.plugins.onUnloaded((pluginId: string, components: string[]) => {
  // disable/unload:注销组件 + 清 loaded 标记(enable 时才能重新加载)
  loadedBuiltin.delete(pluginId);
  loadedThirdParty.delete(pluginId);
  for (const name of components) {
    unregisterSettingsComponent(name);
    unregisterSidePanelComponent(name);
    unregisterSidebarComponent(name);
    unregisterMainViewComponent(name);
  }
});

// 热加载:plugins:changed 时重新拉 list,加载新启用(未加载过)的插件。
// builtin 重新执行 glob chunk(其 import 函数可重复调,重新注册组件);第三方 file:// 重新 import。
// disable 的不在此加载(其组件经 onUnloaded 注销)。
window.pi.plugins.onPluginsChanged(async (nonce: number) => {
  useUiStore.setState({ pluginsNonce: nonce }); // 触发订阅 pluginsNonce 的壳重渲染
  const disabled = (await window.pi.config.get<string[]>("plugin-manager", "disabledPlugins")) ?? [];
  const list = await window.pi.plugins.list();
  // builtin 热加载:enabled 且未加载过的,重新执行 glob chunk
  for (const id of builtinPathById.keys()) {
    if (!disabled.includes(id) && !loadedBuiltin.has(id)) {
      void loadBuiltin(id).catch((e) => console.error(`[plugins-host] 热加载内置插件失败: ${id}`, e));
    }
  }
  // 第三方热加载:enabled 且未加载过的,file:// import
  const toLoad = list.filter((p) => p.path && p.renderer && !disabled.includes(p.id) && !loadedThirdParty.has(p.id));
  for (const p of toLoad) {
    void loadThirdParty(p.id, p.path!, p.renderer!).catch((e) => {
      console.error(`[plugins-host] 热加载第三方插件失败: ${p.id}`, e);
    });
  }
});
