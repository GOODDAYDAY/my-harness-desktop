// 插件模块注册表 —— 保留模块引用,供 getPluginComponent 查组件(§1.2 组件解析)。
//
// 设计:packages/react 拥有此注册表,plugins-host 加载后写入,组件渲染时查询。
// 与 componentRegistries(settings/sidePanel 等槽位)不同:
// 槽位注册表按 slot→component 名→组件实例,此处是 pluginId → 完整 module exports。
// 布局引擎的 ViewInstance.component 来自插件 exports,需查原始模块(槽位契约的自动匹配只管静态声明)。

const pluginModules = new Map<string, Record<string, unknown>>();

/** React 组件判定:普通函数组件 + memo/forwardRef/lazy 等 exotic 组件(带 $$typeof 的对象)。
 *  根因:旧码只认 typeof function,memo() 返回对象 → memo 包装的导出(如 MarkdownText)
 *  被静默丢弃、消费方落兜底(会话流 markdown 长期退化为纯文本的根因)。 */
export function asReactComponent(exp: unknown): unknown {
  if (typeof exp === "function") return exp;
  if (typeof exp === "object" && exp !== null && "$$typeof" in exp) return exp;
  return undefined;
}

/** 注册插件模块(plugins-host 加载后调用)。 */
export function registerPluginModule(pluginId: string, mod: Record<string, unknown>): void {
  pluginModules.set(pluginId, mod);
}

/** 注销插件模块(plugins-host onUnloaded 调用)。 */
export function unregisterPluginModule(pluginId: string): void {
  pluginModules.delete(pluginId);
}

/** 同步查插件模块的导出组件。
 *  返回:若 export 是组件(函数或 exotic)则返回,否则 undefined(容忍缺失)。 */
export function getPluginComponent(pluginId: string, name: string): unknown {
  const mod = pluginModules.get(pluginId);
  if (!mod) return undefined;
  return asReactComponent(mod[name]);
}

/** 返回当前已加载的全部插件 id 集合(供 layout-store sweepStaleViews 用,§4.3)。 */
export function getLoadedPluginIds(): Set<string> {
  return new Set(pluginModules.keys());
}

/** 查插件的 Overlay 命名导出(零可见槽插件的后台挂载点,§4.1 Overlay 机制)。
 *  返回:若 export 是组件则返回,否则 undefined。 */
export function getPluginOverlay(pluginId: string): unknown {
  const mod = pluginModules.get(pluginId);
  if (!mod) return undefined;
  return asReactComponent(mod["Overlay"]);
}
