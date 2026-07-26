// @pi-desktop/core —— 圆心契约类型的发布面(给插件 import 的包)。
//
// 依据 docs/plugins(20-guide-extension.md 等):插件只 import @pi-desktop/core
// 拿类型,不直接 import 项目内的 src/domain。
// 本包自洽定义契约类型(与 src/domain 字段一致,domain 是项目内圆心源、
// 本包是给插件的发布面;两份保持字段一致,演进时一并改)。
// 零运行时逻辑、零外部依赖(纯类型)。

/** 主题:token key → 最终 CSS 值字符串的扁平映射(圆心消费的唯一主题数据结构)。 */
export type Theme = Record<string, string>;

/** 插件配置 API(DESIGN.md:760-764):get sync / set async / all sync。 */
export interface PluginConfigApi {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): Promise<void>;
  all(): Record<string, unknown>;
}

/** 插件 worker 侧 PluginContext(圆心拥有,部分子对象按需注入)。 */
export interface PluginContext {
  config: PluginConfigApi;
}

/** 主题槽贡献项(06 §4.1)。 */
export interface ThemeContribution {
  id: string;
  name: string;
  tokens: Record<string, string>;
  base?: string;
}

/** 设置子页槽(settings)贡献项(DESIGN.md §3.3)。 */
export interface SettingsContribution {
  id: string;
  title: string;
  component: string;
}

/** SlotName:八槽名(DESIGN.md §3.3)。 */
export type SlotName =
  | "languages"
  | "themes"
  | "management"
  | "cardRenderers"
  | "sidePanel"
  | "viewers"
  | "commands"
  | "settings";

/** 插件 manifest 顶层 contributes 字段。 */
export interface PluginContributes {
  themes?: ThemeContribution[];
  settings?: SettingsContribution[];
}

/** 插件 manifest(04-module §2.2)。 */
export interface PluginManifest {
  id: string;
  version: string;
  displayName?: string;
  main?: string;
  renderer?: string;
  permissions?: string[];
  contributes?: PluginContributes;
  author?: string;
  homepage?: string;
  dependsOn?: string[];
  source?: "project" | "user" | "installed" | "builtin";
}
