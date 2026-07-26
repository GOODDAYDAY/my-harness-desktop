// 圆心:槽位贡献项类型契约。
//
// 依据 DESIGN.md §3.3(八槽契约)。这是圆心拥有的稳定契约——
// 各槽位贡献项的形状在此定义,加载器按它校验,渲染层按它消费。
// 零外部依赖:不 import react/electron/pi(圆心纯度纪律,structure/16 §10.1)。

/** 设置子页槽(settings)贡献项:插件自己的配置页(DESIGN.md §3.3 / 952 行)。 */
export interface SettingsContribution {
  /** 配置页 id,设置页左列表项标识 */
  id: string;
  /** 配置页标题,设置页左列表显示 */
  title: string;
  /** renderer 侧组件名,设置页按名映射到对应组件渲染 */
  component: string;
  /** 配置文件路径(~ 开头)。null=不参与框架 save(实时生效的偏好)。 */
  configFile?: string | null;
  /** 写入合并方式:"deep"=深合并,"replace"=整份覆盖。默认 "replace"。 */
  configMerge?: "deep" | "replace";
}

/** 主题槽(themes)贡献项(06 §4.1 ThemeContribution 镜像,圆心拥有)。 */
export interface ThemeContribution {
  id: string;
  name: string;
  tokens: Record<string, string>;
  base?: string;
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

/** 插件 manifest 顶层 contributes 字段(各槽位数组,按需出现)。 */
export interface PluginContributes {
  themes?: ThemeContribution[];
  settings?: SettingsContribution[];
  // 其余六槽随各阶段补,本次只用到 themes/settings
}

/**
 * 插件 manifest(04-module §2.2 字段集,圆心拥有的最小镜像)。
 * 加载器发现后按它校验、注册表按它填充。manifest 不含 config 字段
 * (04-module:511:config 走运行期存储、不进 manifest,未知顶层字段被拒)。
 */
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
  /** 加载器发现时填的来源标记(project>user>installed>builtin),不在 manifest 里声明。 */
  source?: "project" | "user" | "installed" | "builtin";
}
