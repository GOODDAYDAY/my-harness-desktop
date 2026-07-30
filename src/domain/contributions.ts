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
  /** 图标名(如 "palette"、"pi"),设置页左列表 + 内容区头部显示。缺省 "settings"。 */
  icon?: string;
  /** renderer 侧组件名,设置页按名映射到对应组件渲染 */
  component: string;
  /** 配置文件路径(~ 开头)。null=无配置文件(不显示打开按钮)。 */
  configFile?: string | null;
  /** 写入合并方式:"deep"=深合并,"replace"=整份覆盖。默认 "replace"。 */
  configMerge?: "deep" | "replace";
  /** 保存模式:"framework"=框架管 save(有浮层/拦截),"manual"=实时生效(无浮层,仅打开按钮)。默认 "framework"。 */
  saveMode?: "framework" | "manual";
  /** 排序,小的在上;缺省 100。Pi 永远第一(0),语言置底(999)。 */
  order?: number;
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

/** 中区主视图槽(mainView):壳的中区内容由贡献此槽的插件渲染(如 timeline 插件)。
 *  评估 P1-C:此前 message-list 焊在 shell(内容焊死内核,违反 §7.2"时间线渲染→timeline 插件")。
 *  开 mainView 槽:壳只留空中区容器 + 按槽查组件渲染,时间线内容外挂 timeline 插件。 */
export interface MainViewContribution {
  id: string;
  /** renderer 侧组件名,经 registerMainViewComponent 注册后按名查。 */
  component: string;
  /** 排序,小的优先(多个 mainView 贡献按优先级选,缺省 100)。 */
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
  /** 同 group 的贡献项共享一个 Panel(非末项 shrink-0、末项 flex-1 填满剩余空间)。
   *  不同 group 或无 group 各占独立 Panel(向后兼容)。 */
  group?: string;
}

/**
 * 语言槽(languages)贡献项(05-plugin-i18n §2.1)。纯声明式:i18n 插件贡献各 locale 的
 * key→文案字典,core 启动时合并成 i18next resources,渲染时 t(key) 查。无 main/renderer。
 *
 * locale 用 BCP 47 短码或地理区域码:zh-CN(简体)/zh-TW(繁体)/en/de 等。
 * (偏离 05 §2.1 "只用 2 位短码"——简繁必须靠区域码区分,放开为接受区域码。)
 */
export interface LanguageContribution {
  /** 语言包贡献项标识,通常 {pluginId} 或 {pluginId}.{namespace};(插件,locale)维度唯一。 */
  id: string;
  /** locale:zh-CN / zh-TW / en / de 等。 */
  locale: string;
  /** key→文案 扁平映射(dot namespace,如 "sessions.title"),或指向外部 JSON 文件的相对路径。 */
  resources: Record<string, string> | string;
}

/** SlotName:槽名(DESIGN.md §3.3 八槽 + 扩展槽 sidebar + mainView)。 */
export type SlotName =
  | "languages"
  | "themes"
  | "management"
  | "cardRenderers"
  | "sidePanel"
  | "sidebar"
  | "mainView"
  | "viewers"
  | "commands"
  | "settings";

/** 插件 manifest 顶层 contributes 字段(各槽位数组,按需出现)。 */
export interface PluginContributes {
  themes?: ThemeContribution[];
  settings?: SettingsContribution[];
  sidePanel?: SidePanelContribution[];
  sidebar?: SidebarContribution[];
  /** 中区主视图槽(评估 P1-C:timeline 插件贡献,壳只留空容器)。 */
  mainView?: MainViewContribution[];
  /** 语言槽:i18n 插件贡献各 locale 的文案字典(纯声明式,无 main/renderer)。 */
  languages?: LanguageContribution[];
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
  description?: string;
  main?: string;
  renderer?: string;
  permissions?: string[];
  contributes?: PluginContributes;
  author?: string;
  homepage?: string;
  dependsOn?: string[];
  /** 是否受保护（不可卸载）。protected 插件可禁用但不能从注册表移除。 */
  protected?: boolean;
  /** 信任级别：official(官方) / verified(认证) / community(社区)。未声明时由 source 推断。 */
  tier?: PluginTier;
  /** 加载器发现时填的来源标记(project>user>installed>builtin),不在 manifest 里声明。 */
  source?: "project" | "user" | "installed" | "builtin";
}

/** 插件信任级别。 */
export type PluginTier = "official" | "verified" | "community";

/** 插件运行时状态：active(已加载) / inactive(已禁用) / error(加载失败)。 */
export type PluginState = "active" | "inactive" | "error";

/** 插件管理列表项（plugins:list IPC 返回的每行数据）。 */
export interface PluginListItem {
  id: string;
  displayName: string;
  description?: string;
  version: string;
  source: "project" | "user" | "installed" | "builtin";
  tier: PluginTier;
  state: PluginState;
  protected: boolean;
  path: string | null;
  renderer: string | null;
  contributes?: PluginContributes;
}

/** 设置页槽位项(settings:list IPC 返回的每行,供设置页左列表 + 框架管 save/dirty)。
 *  聚合 SettingsContribution 的运行时形态 + pluginId,字段经 registry 兜底默认值。 */
export interface SettingsItem {
  id: string;
  title: string;
  /** 图标名(缺省 "settings",registry 兜底)。 */
  icon: string;
  component: string;
  pluginId: string;
  /** 配置文件路径(null=无配置文件,如 theme-manager 走 prefs 不走框架 save)。 */
  configFile: string | null;
  /** 写入合并方式。 */
  configMerge: "deep" | "replace";
  /** 保存模式:framework=框架管 save,manual=实时生效。 */
  saveMode: "framework" | "manual";
}
