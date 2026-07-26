// 设置页组件注册中心 —— shell/renderer 侧,按 component 名查配置页组件。
//
// ⚠ 已知架构缺口(盲审 H2,演进待修):
// 真加载器应在 main 侧发现插件后,按 manifest.renderer 入口动态 import、收集
// 导出的组件、按 component 名建表(04-module-plugin-loader.md)。当前无完整加载器,
// 退化为"插件 renderer 模块加载时主动 registerSettingsComponent(name, Comp) 注册自己"
// ——这使内置插件(theme-manager)与第三方插件加载路径不一致:第三方插件无此入口。
// 后续加载器落地后,删本文件,改加载器按 component 名动态 import renderer 模块解析。
// 本次保留为验证可见链路的最小通路,标注备查。
import type { ComponentType } from "react";

const registry = new Map<string, ComponentType<unknown>>();

/** 插件 renderer 注册自己的配置页组件(按 component 名)。 */
export function registerSettingsComponent(name: string, comp: ComponentType<unknown>): void {
  registry.set(name, comp);
}

/** 按 component 名查配置页组件(供 settings-page 渲染)。 */
export function getSettingsComponent(name: string): ComponentType<unknown> | undefined {
  return registry.get(name);
}
