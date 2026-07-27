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
  /** 配置文件路径(~ 开头)。null=无配置文件(不显示打开按钮)。 */
  configFile?: string | null;
  /** 写入合并方式:"deep"=深合并,"replace"=整份覆盖。默认 "replace"。 */
  configMerge?: "deep" | "replace";
  /** 保存模式:"framework"=框架管 save(有浮层/拦截),"manual"=实时生效(无浮层,仅打开按钮)。默认 "framework"。 */
  saveMode?: "framework" | "manual";
}

/** 主题槽(themes)贡献项(06 §4.1 ThemeContribution 镜像,圆心拥有)。 */
export interface ThemeContribution {
  id: string;
  name: string;
  tokens: Record<string, string>;
  base?: string;
}

/** 侧栏槽(sidePanel)贡献项:右侧板的 Tab(DESIGN.md:939 钉的 {id,label,icon,component})。 */
export interface SidePanelContribution {
  id: string;
  /** Tab 显示名(契约字段名是 label,不是 title)。 */
  label: string;
  /** lucide 图标名(如 "git-branch"),渲染层按名映射。 */
  icon: string;
  /** renderer 侧组件名,经 registerSidePanelComponent 注册后按名查。 */
  component: string;
  /** Tab 排序,小的在前;缺省 100(扩展字段,DESIGN.md 未含)。 */
  order?: number;
}

/** 左栏分组槽(sidebar)贡献项 —— 八槽之外的扩展槽(DESIGN.md 未含,本轮新开):
 *  左栏分组(对话/项目等)以可折叠 section 形式挂在左栏,order 小的在上。 */
export interface SidebarContribution {
  id: string;
  /** 分组标题(如 "对话"/"项目")。 */
  title: string;
  /** renderer 侧组件名,经 registerSidebarComponent 注册后按名查。 */
  component: string;
  /** 排序,小的在上;缺省 100。 */
  order?: number;
}

/** SlotName:槽名(DESIGN.md §3.3 八槽 + 扩展槽 sidebar)。 */
export type SlotName =
  | "languages"
  | "themes"
  | "management"
  | "cardRenderers"
  | "sidePanel"
  | "sidebar"
  | "viewers"
  | "commands"
  | "settings";

/** 插件 manifest 顶层 contributes 字段(各槽位数组,按需出现)。 */
export interface PluginContributes {
  themes?: ThemeContribution[];
  settings?: SettingsContribution[];
  sidePanel?: SidePanelContribution[];
  sidebar?: SidebarContribution[];
  // 其余槽随各阶段补
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
