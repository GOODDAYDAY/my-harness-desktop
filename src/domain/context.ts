// 圆心:PluginContext 契约 —— 插件能调用的 API 接口(圆心拥有,零外部依赖)。
//
// 依据 DESIGN.md §3.2.4(PluginContext 接口)、§3.2.5(RendererPluginContext)。
// 圆心只定义接口形状,实现在 application/shell 注入(依赖倒置)。
// 接口里只用圆心中性类型,不 import react/electron/pi(圆心纯度纪律)。
//
// 本文件当前只钉死 config 子对象(本次"插件配置"目标的核心契约);
// rpc/events/i18n/management 等子对象随各阶段补,在此先占位最小集。

/** 插件配置 API(DESIGN.md:760-764)。worker 侧持有,renderer 侧不暴露。 */
export interface PluginConfigApi {
  /** 同步读一个配置 key;不存在返回 undefined,调用方用 ?? 兜底默认值。 */
  get<T>(key: string): T | undefined;
  /** 异步写一个配置 key;落盘完成 resolve。 */
  set<T>(key: string, value: T): Promise<void>;
  /** 同步读整个合并后的配置快照(项目级覆盖用户级)。 */
  all(): Record<string, unknown>;
}

/** 插件 worker 侧 PluginContext(圆心拥有,部分子对象按需注入)。 */
export interface PluginContext {
  /** 插件自己的配置(隔离在 ~/.pi/desktop/plugins-data/{id}/config.json)。 */
  config: PluginConfigApi;
}

/**
 * RendererPluginContext 不含 config(DESIGN.md:795-830)——
 * renderer 拿只读配置快照,改了经 onSave→worker 落盘。
 * 本文件暂不展开 renderer 侧接口,后续阶段补。
 */
