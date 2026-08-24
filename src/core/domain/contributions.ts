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
  /** renderer 侧组件名,设置页按名映射到对应组件渲染。展示分组入口(有 tabs)无自身 component,
   *  component 在各 TAB 里——入口是壳,只画 TAB 条 + 当前 TAB 的 pane。 */
  component?: string;
  /** 配置文件路径(~ 开头)。null=无配置文件(不显示打开按钮)。 */
  configFile?: string | null;
  /** 写入合并方式:"deep"=深合并,"replace"=整份覆盖。默认 "replace"。 */
  configMerge?: "deep" | "replace";
  /** 保存模式:"framework"=框架管 save(有浮层/拦截),"manual"=实时生效(无浮层,仅打开按钮)。默认 "framework"。 */
  saveMode?: "framework" | "manual";
  /** 内核模型配置源:声明后 framework 用 kernelModels[kernel] 的 readConfig/saveConfig 读写
   *  中性 JSON(providers+default),不直读 configFile。configFile 仍可声明(用于「打开配置」按钮)。
   *  与 saveMode 无关;声明即隐含「走内核模型源」,pi/dsh 各自实现翻译。 */
  kernelModels?: "pi" | "dsh";
  /** 内核原生配置源:声明后 framework 用 kernelConfig[kernel] 的 get/set 读写全量 JSON
   *  (pi=settings.json,dsh=settings.yaml 非模型 namespace)。表单走共享描述驱动渲染,
   *  标题/说明/字段由各内核适配器 kernelConfig[kernel].describe() 一次性吐出。 */
  kernelConfig?: "pi" | "dsh";
  /** 排序,小的在上;缺省 100。Pi 永远第一(0),语言置底(999)。 */
  order?: number;
  /** 展示分组:声明后本项成为「入口」(壳),渲染成顶部 TAB 条 + 当前 TAB 的 pane。
   *  每个 TAB 是一个完整 SettingsContribution(自带 component/configFile/saveMode),
   *  config/dirty/save 按 TAB 独立、机制零改动——只合并展示,不合并 config(设计 §3.1)。 */
  tabs?: SettingsContribution[];
}

/** 通用设置字段组(settingsGroups)贡献项:插件纯声明式往「通用」设置页挂一框字段——
 *  组标题/字段/控件类型/默认值全在 manifest,由通用页的通用渲染器渲成 UI,插件零渲染代码。
 *  字段值统一落通用页 configFile(general.json),save/dirty/分层/广播走既有框架管线;
 *  同 id 整框覆盖(后注册高优先级胜出,ArraySlot 通用语义)。 */
export interface SettingsGroupContribution {
  /** 组 id(页内唯一)。 */
  id: string;
  /** 组标题 i18n key(文案由贡献方自己的 languages 资源提供)。 */
  titleKey: string;
  /** 排序,小的在上;缺省 100。 */
  order?: number;
  /** 字段列表(声明顺序即渲染顺序)。 */
  fields: SettingsFieldDecl[];
}

/** 通用设置字段声明:一个键 + 一个控件。 */
export interface SettingsFieldDecl {
  /** 通用页 configFile 里的键(建议 pluginId 前缀防撞)。 */
  key: string;
  /** 控件类型:boolean→开关;enum→字符串下拉;int→数字档位下拉。 */
  type: "boolean" | "enum" | "int";
  /** 未写入时的显示默认值(消费方仍各自兜底)。 */
  default?: boolean | string | number;
  /** 字段名 i18n key。 */
  titleKey: string;
  /** 说明 i18n key(可省)。 */
  descKey?: string;
  /** 可选项:enum 传 {value,labelKey?} 对象数组;int 传数字数组(数字即 label)。 */
  options?: Array<number | { value: string; labelKey?: string }>;
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
  /** 揭示触发器:该 channel 被 emit/invoke 时,框架展开右面板并激活本 Tab。
   *  声明式(与 fileActions 的约定频道同范式)——插件代码不出现自己的 contribution id,
   *  框架经事件总线 tap 侦听,激活是幂等 ensure(已激活仅展开面板)。 */
  revealOn?: string;
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

/** 标题栏槽(titlebar):插件往标题栏右侧贡献按钮(如 debug-bar 插件)。
 *  壳在右面板开关左侧渲染,按 order 升序排列。 */
export interface TitlebarContribution {
  id: string;
  /** renderer 侧组件名,经自动匹配 export 注册后按名查。 */
  component: string;
  /** 排序,小的在右面板开关左侧更靠右;缺省 100。 */
  order?: number;
}

/** 文件动作槽(fileActions)贡献项:插件往"文件"上下文贡献动作(如盲审文件)。
 *  声明静态走 manifest(与 sidePanel 同构),运行时触发走 invoke 事件路由——
 *  消费方(文件树等)查槽渲染菜单,点击后框架把 invoke 路由到贡献者的
 *  <pluginId>:fileActionInvoke 频道(约定频道,payload 见 file-actions.ts)。 */
export interface FileActionContribution {
  /** 动作 id(插件内唯一),invoke payload 原样回传。 */
  id: string;
  /** i18n key(语言插件供给),消费方渲染时 t(labelKey) 解——菜单文案不进 manifest。 */
  labelKey: string;
  /** lucide 图标名,可选(无则不渲图标)。 */
  icon?: string;
  /** 适用目标:"file"=仅文件,"dir"=仅目录,"both"=两者(缺省)。 */
  when?: { target?: "file" | "dir" | "both" };
  /** 排序,小的在前;缺省 100。 */
  order?: number;
}

/** 消息动作槽(messageActions)贡献项:插件往消息行贡献动作按钮(如重试、复制、收藏)。
 *  与 fileActions 同范式:声明走 manifest,触发走 invoke 事件路由——
 *  消费方(timeline)查槽渲染按钮,点击后框架把 invoke 路由到贡献者的
 *  <pluginId>:messageActionInvoke 约定频道。 */
export interface MessageActionContribution {
  /** 动作 id(插件内唯一)。 */
  id: string;
  /** renderer 侧组件名,框架从插件 exports 自动匹配——组件收到 { message, text } props,自己渲染按钮、自己处理点击。 */
  component: string;
  /** 按钮位置:"left"=消息内容侧,"right"=消息行末尾;缺省 "left"。 */
  placement?: "left" | "right";
  /** 适用消息角色:哪些 role 的消息显示此按钮。缺省=所有角色。 */
  when?: { role?: string[] };
  /** 排序,同 placement 内小的在前;缺省 100。 */
  order?: number;
}

/** 会话分组槽(sessionGroupings):插件声明会话分组策略——
 *  sessions-list 消费方查槽,把 custom[parentPathKey] 存在的 session 嵌套在父会话下。
 *  声明式贡献 + 消费方查槽(三段式,与 fileActions 同范式:domain 契约 → registry 注册 →
 *  renderer hook 查询 → sessions-list buildGroups 消费)。
 *  双向解耦:sessions-list 不认识贡献方(清单来自内核注册表),贡献方不认识 sessions-list。 */
export interface SessionGroupingContribution {
  /** 分组策略 id(插件内唯一)。 */
  id: string;
  /** custom 域 key,值=父会话路径(匹配 SessionInfo.path);有此 key 的 session 作为子项嵌套在父会话下。 */
  parentPathKey: string;
  /** 子行 i18n label key(缩进行标题,如 "subagent.childLabel");不提供则不显子分组标题。 */
  childLabelKey?: string;
  /** 子行 lucide 图标名(如 "git-fork");不提供则用默认缩进图标。 */
  childIcon?: string;
  /** 排序,小的优先;缺省 100。多个分组策略时,先匹配 order 小的。 */
  order?: number;
}

/** Composer 策略槽(composerPolicies):插件声明输入框条件渲染策略——
 *  timeline 消费方查槽,session.custom[customKey] 存在时把输入框换为只读提示条。
 *  声明式 + 数据驱动(无需函数:条件是 custom 域 key 的存在性,提示文案走 i18n)。
 *  三段式:domain 契约 → registry 注册 → renderer hook 查询 → timeline 渲染前查表。 */
export interface ComposerPolicyContribution {
  /** 策略 id(插件内唯一)。 */
  id: string;
  /** custom 域 key,存在即触发只读(数据驱动:key 在 session.custom 里有值就匹配)。 */
  customKey: string;
  /** 只读提示文案 i18n key(如 "subagent.composerReadonly");不提供则用默认文案。 */
  readonlyMessageKey?: string;
  /** 排序,小的优先;缺省 100。多个策略同时命中时取 order 最小的。 */
  order?: number;
}

/** composerAttachments 槽(设计 docs/design/plugin-decoupling.md §5.2):插件往 composer 上方的
 *  停靠区贡献"附件渲染组件"——数据经既有 timeline:composerAttachments 通道送达 timeline,
 *  渲染由本槽贡献方承担(谁的数据谁画)。与 blockRenderers 同规则:manifest 静态声明 + 查槽。
 *  组件 props 契约:{ payload: ComposerAttachmentPayload }。
 *  区分同名两个机制:timeline:composerAttachments 是数据通道(保留),本槽是渲染器契约(新增)。 */
export interface ComposerAttachmentContribution {
  /** 贡献 id(插件内唯一)。 */
  id: string;
  /** 渲染组件名(框架从 manifest 自动匹配 export)。 */
  component: string;
  /** 排序,小的优先;缺省 100。 */
  order?: number;
}

/** timeline:composerAttachments 通道的 payload 形状(圆心唯一源,timeline 与贡献方共用)。
 *  items 是"待发送附件"清单(贡献方定义字段、消费方只挂载);promptFragment 是发送时拼进
 *  prompt 的文本;editorActive 是贡献方"编辑器打开"的互斥信号。channels 已随渲染归位删除
 *  (编辑/删除动作在贡献方组件内部直调自己状态,不再经 timeline 路由回贡献方)。 */
export interface ComposerAttachmentPayload {
  /** 归属会话 key。 */
  sessionKey: string;
  /** 附件条目(贡献方定义形状,消费方只挂载不解释)。 */
  items: Array<{ id: string; messageId?: string; seq: string; quotePreview: string; comment: string }>;
  /** 发送时拼进 prompt 的文本(如 review 块)。 */
  promptFragment?: string;
  /** 贡献方"编辑器打开"互斥信号(timeline 用于挂载区内互斥)。 */
  editorActive?: boolean;
}

/** composerActions 槽(设计 docs/design/sticker-plugin.md §5.1):插件往 composer 底部工具栏
 *  的 children 渲染点贡献按钮(表情包快速入口等)。机械镜像 titlebar 槽:manifest 静态声明 + 查槽,
 *  消费方(timeline)查槽后按 getPluginComponent 匹配组件、渲染进 Composer 的 children。
 *  组件 props 无(按钮自持点击/弹窗)。 */
export interface ComposerActionContribution {
  /** 贡献 id(插件内唯一)。 */
  id: string;
  /** 渲染组件名(框架从 manifest 自动匹配 export)。 */
  component: string;
  /** 排序,小的优先;缺省 100。 */
  order?: number;
}

/** 代码块渲染槽(codeBlockRenderers)贡献项:插件按围栏语言贡献渲染器——
 *  ```mermaid / ```puml 这类围栏代码块,由消费方(markdown 文本渲染器、文件预览)
 *  按 language 查槽分发。与 blockRenderers 的分工:blockRenderers 管"整块类型"
 *  (text/toolCall/thinking…),本槽管"文本块内部的围栏语言"。
 *  组件 props 契约:{ code: string; streaming?: boolean }——解析失败/流式未闭合时
 *  组件内部自降级为源码呈现,消费方不感知。 */
export interface CodeBlockRendererContribution {
  /** 贡献 id(插件内唯一);同 id 被后注册插件整项替换。 */
  id: string;
  /** 围栏语言名清单(小写比较),如 ["mermaid"]、["puml","plantuml"]。 */
  languages: string[];
  /** 可被本渲染器预览的文件扩展名清单(小写比较,不带点),如 ["mmd","mermaid"]。
   *  消费方(文件预览)按扩展名查槽:命中即图路由;不声明则该语言不参与文件预览。
   *  映射知识归贡献方(与 fileIcons 槽同构)——新增图语言不动文件预览。 */
  fileExtensions?: string[];
  /** renderer 侧组件名,框架从插件 exports 自动匹配。 */
  component: string;
  /** 同语言多项时小者胜;缺省 100。 */
  order?: number;
}

/** 文件图标槽(fileIcons)贡献项:插件往文件树贡献"扩展名/文件名 → 图标"映射规则。
 *  声明静态走 manifest(与 fileActions 同构);消费方(文件树)查槽后按 key 合并解析——
 *  文件名精确匹配优先,扩展名其次,都未命中用默认文件图标(domain/file-icons 纯函数)。
 *  覆盖语义两层:同 contribution.id = 整规则替换(registry removeById,高优先级 source 覆盖);
 *  不同 id = 消费侧按 key 合并,后注册者(高优先级 source)在同 key 上胜出——
 *  第三方插件可只改一个扩展名的图标,不必整批重声明。 */
export interface FileIconContribution {
  /** 规则 id(插件内唯一);同 id 被后注册插件整规则替换。 */
  id: string;
  /** 图标名(PluginIcon 词表,如 "file-code"),未知名消费方回退默认文件图标。 */
  icon: string;
  /** 适用扩展名清单(不带点,大小写不敏感),如 ["ts","tsx"]。 */
  extensions?: string[];
  /** 适用精确文件名清单(大小写不敏感),如 ["dockerfile",".gitignore"];优先级高于扩展名。 */
  filenames?: string[];
  /** 图标颜色(CSS 颜色值或 token var);不提供则用主题默认。 */
  color?: string;
  /** 排序,小的在前;缺省 100。 */
  order?: number;
}

/** 系统提示槽(systemPrompts):插件往 pi 会话 spawn 时注入 --append-system-prompt 文件。
 *  声明式:manifest 声明 file(相对插件目录),SessionStore spawn 时收集所有贡献项,
 *  解析为绝对路径后经 --append-system-prompt 注入底座 system prompt。
 *  插件卸载 → 贡献移除 → 不注入(内容外挂,内核只提供机制)。 */
export interface SystemPromptContribution {
  id: string;
  /** 相对插件目录的文件路径(如 "./CLAUDE.md")。 */
  file: string;
  /** 排序,小的先注入;缺省 100。 */
  order?: number;
}

/** 字体预设槽(fontPresets)贡献项:插件声明一组字体选项——等宽/英文/中文三组。
 *  纯声明式(与 themes/settingsGroups 同构):id/labelKey/stack 全在 manifest,零代码。
 *  消费方(theme-manager 字体 tab)查槽渲染,主题合并按选择 id 查栈应用。
 *  字体栈是会变的内容(§2.2 判据),从圆心外推为插件贡献——新增字体选项 = 改插件 JSON,
 *  内核一行不动;第三方插件可贡献自己的字体条目,与内置走同一槽、同一合并逻辑。
 *  契约单源落点:字体栈唯一一份,住在贡献插件的 manifest,注册表/合并/消费方都查它。 */
export interface FontPresetContribution {
  /** 选项 id(插件内唯一),也是偏好里存的取值(跨 category 全局唯一,注册表按 id 扁平聚合)。 */
  id: string;
  /** 分组:mono=等宽(--font-family-mono 整体替换);english=英文段(拼进 --font-family-sans
   *  开头,决定拉丁字符);chinese=中文段(拼进 --font-family-sans 结尾,决定汉字与 generic 回落方向)。 */
  category: "mono" | "english" | "chinese";
  /** 展示名 i18n key(语言插件供给,随语言变——"黑体(默认)"在中文/德文/英文环境文案各不同)。 */
  labelKey: string;
  /** CSS font-family 值,直接注入主题变量(mono 整体替换;sans 英文/中文段拼接,见 merge.ts)。 */
  stack: string;
  /** 仅中文字体消费:sans 栈末尾 generic 回落方向——黑体 sans-serif、宋体/楷体/行楷/仿宋 serif。
   *  跟随"实际显示中文的那款字体"走;english 永不落栈尾,不消费此字段。 */
  generic?: "serif" | "sans-serif";
}

/** SlotName:槽名(DESIGN.md §3.3 八槽 + 扩展槽 sidebar + mainView + titlebar + messageRenderers + fileActions + systemPrompts)。 */
export type SlotName =
  | "languages"
  | "themes"
  | "management"
  | "cardRenderers"
  | "sidePanel"
  | "sidebar"
  | "mainView"
  | "titlebar"
  | "messageRenderers"
  | "fileActions"
  | "fileIcons"
  | "sessionGroupings"
  | "composerPolicies"
  | "composerAttachments"
  | "composerActions"
  | "messageActions"
  | "blockRenderers"
  | "codeBlockRenderers"
  | "viewers"
  | "commands"
  | "settings"
  | "settingsGroups"
  | "fontPresets"
  | "systemPrompts";

/** 插件 manifest 顶层 contributes 字段(各槽位数组,按需出现)。 */
export interface PluginContributes {
  themes?: ThemeContribution[];
  settings?: SettingsContribution[];
  /** 通用设置字段组槽:插件声明式往「通用」设置页挂框,消费方(通用页)经 slots:settingsGroups 查。 */
  settingsGroups?: SettingsGroupContribution[];
  sidePanel?: SidePanelContribution[];
  sidebar?: SidebarContribution[];
  /** 中区主视图槽(评估 P1-C:timeline 插件贡献,壳只留空容器)。 */
  mainView?: MainViewContribution[];
  /** 标题栏槽:插件往标题栏右侧贡献按钮。 */
  titlebar?: TitlebarContribution[];
  languages?: LanguageContribution[];
  messageRenderers?: MessageRendererContribution[];
  /** 文件动作槽:插件往文件上下文贡献动作(盲审文件等),消费方经 slots:fileActions 查。 */
  fileActions?: FileActionContribution[];
  /** 文件图标槽:插件往文件树贡献扩展名/文件名 → 图标映射,消费方(文件树)经 slots:fileIcons 查。 */
  fileIcons?: FileIconContribution[];
  /** 消息动作槽:插件往消息行贡献动作按钮(重试/复制/收藏等),消费方(timeline)经 slots:messageActions 查。 */
  messageActions?: MessageActionContribution[];
  /** 块级渲染槽:插件往会话流贡献块组件(工具卡/思考链/气泡/文本/分隔线),消费方(timeline)经 slots:blockRenderers 查。 */
  blockRenderers?: BlockRendererContribution[];
  /** 代码块渲染槽:插件按围栏语言贡献渲染器(mermaid/puml 等),消费方(markdown/文件预览)经 slots:codeBlockRenderers 查。 */
  codeBlockRenderers?: CodeBlockRendererContribution[];
  /** 会话分组槽:插件声明会话分组策略,消费方(sessions-list)经 slots:sessionGroupings 查。 */
  sessionGroupings?: SessionGroupingContribution[];
  /** Composer 策略槽:插件声明输入框条件渲染策略,消费方(timeline)经 slots:composerPolicies 查。 */
  composerPolicies?: ComposerPolicyContribution[];
  /** composerAttachments 槽:插件贡献 composer 附件渲染组件(数据经 timeline:composerAttachments 通道)。 */
  composerAttachments?: ComposerAttachmentContribution[];
  /** composerActions 槽:插件往 composer 底部工具栏贡献按钮(表情包快速入口等)。 */
  composerActions?: ComposerActionContribution[];
  /** 系统提示槽:插件往 pi 会话 spawn 注入 --append-system-prompt 文件,卸载即停止注入。 */
  systemPrompts?: SystemPromptContribution[];
  /** 字体预设槽:插件声明字体选项(等宽/英文/中文三组),消费方(theme-manager)经 fonts:list 查,
   *  主题合并经注册表按选择 id 查栈应用。 */
  fontPresets?: FontPresetContribution[];
  // 其余槽随各阶段补
}

export interface MessageRendererContribution {
  role: string;
  component: string;
}

/** 块级渲染槽(blockRenderers)贡献项:插件往会话流贡献块组件——工具卡、思考链、
 *  用户气泡、Markdown 文本、分隔线。与 messageActions 同范式:声明静态走 manifest,
 *  消费方(timeline)经 slots:blockRenderers 查槽,组件经框架自动匹配(§7.4)。
 *  解析规则(docs/design/timeline-block-renderers.md §3.2):输入 (block, name?)——
 *  toolCall 的 name 是工具名(小写),divider 的 name 是 kind,其余块类型无 name;
 *  names 精确命中的特化层优先于未声明 names 的通用层;层内 order 小者胜,
 *  同 order 注册序后者胜(数组按 source 升序 builtin→installed→user→project,
 *  同 order 下后注册者=高优先级 source)。无名字的块类型声明 names 是死贡献,静默跳过。 */
export interface BlockRendererContribution {
  /** 贡献 id(插件内唯一);同 id 被后注册插件整项替换(registry removeById 通用语义)。 */
  id: string;
  /** 块类型。五种内置词汇 + 开放字符串(未来块类型不挡,分解器认领前先落合成 toolCall 兜底)。 */
  block: "thinking" | "toolCall" | "text" | "userText" | "divider" | (string & {});
  /** 名字清单,仅 toolCall/divider 有意义:toolCall 比工具名(小写),divider 比 kind。
   *  缺省 = 该块类型通用项(兜底);声明 = 只在名字命中时生效。 */
  names?: string[];
  /** renderer 侧组件名,框架从插件 exports 自动匹配;组件收块类型对应的标准 props(见设计 §3.1)。 */
  component: string;
  /** 同层多项时小者胜;缺省 100。 */
  order?: number;
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
  /** 主题 token 清单语义版本兼容范围（如 "^1.0"）。仅贡献 themes 槽的插件需要声明：
   *  加载器注册 themes 前按 semver 判定其与圆心 THEME_TOKEN_SCHEMA_VERSION 兼容，
   *  不兼容则跳过该插件 themes 注册并告警（06 §4.1.2）。未声明视为兼容（向后兼容）。 */
  tokenSchemaVersion?: string;
  /** 是否受保护（不可卸载）。protected 插件可禁用但不能从注册表移除。 */
  protected?: boolean;
  /** 信任级别：official(官方) / verified(认证) / community(社区)。未声明时由 source 推断。 */
  tier?: PluginTier;
  /** 插件分类 tag(公共元数据)。声明式部分:框架推导(见 derivePluginTags)覆盖不了
   *  的语义在此追加,最终 tags = 推导 ∪ 声明(resolvePluginTags)。 */
  tags?: string[];
  /** 插件携带的 pi 底座 extension 目录（插件目录内相对路径，如 "./pi-extension"）。
   *  声明后框架在 activate 时把它同步到 ~/.pi/agent/extensions/<pluginId>/，
   *  deactivate/uninstall 时摘除——内容插件私货的生命周期通道，区别于
   *  toolgate 等内核基础设施的 bootstrap 常驻同步（llm-recorder-design.md §5）。 */
  piExtension?: string;
  /** 插件携带的 dsh cordis 插件目录（插件目录内相对路径，如 "./dsh-extension"）。
   *  声明后框架在 activate 时把它同步到 ~/.dsh/.my-harness-desktop-plugins/<pluginId>/，
   *  并在 cordis.yml 挂载相对路径块；deactivate/uninstall 时摘除。与 piExtension 对称：
   *  读用户全局 CLAUDE.md 的能力，pi 侧走 piExtension（read-claude-md 底座扩展），
   *  dsh 侧走本字段（dsh cordis 插件）——同一能力在两个内核里的对称实现。 */
  dshExtension?: string;
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
  /** 最终分类 tag(resolvePluginTags 解析:框架推导 ∪ manifest 声明)。 */
  tags: string[];
}

/** 推荐 tag 词表。标识符非用户可见文案(文案走 i18n pluginManager.tag* key)。
 *  推荐而非强制:manifest 可自由追加词表外 tag,管理页 chip 按词表序优先排列。 */
export const RECOMMENDED_PLUGIN_TAGS = [
  "theme", "i18n", "management", "session", "project", "git",
  "conversation", "review", "dev", "productivity", "insight",
] as const;

/** 槽位 → 默认 tag 推导(机制规则,稳定):themes→theme / languages→i18n / settings·settingsGroups→management。
 *  无语义槽(sidebar/sidePanel/mainView/titlebar)不推导,由 manifest.tags 显式声明。 */
export function derivePluginTags(contributes?: PluginContributes): string[] {
  const tags: string[] = [];
  if (contributes?.themes?.length) tags.push("theme");
  if (contributes?.languages?.length) tags.push("i18n");
  if (contributes?.settings?.length || contributes?.settingsGroups?.length) tags.push("management");
  return tags;
}

/** 解析最终 tags:推导 ∪ 声明,去重保序。 */
export function resolvePluginTags(manifest: Pick<PluginManifest, "tags" | "contributes">): string[] {
  return [...new Set([...derivePluginTags(manifest.contributes), ...(manifest.tags ?? [])])];
}

/** 设置页槽位项(settings:list IPC 返回的每行,供设置页左列表 + 框架管 save/dirty)。
 *  聚合 SettingsContribution 的运行时形态 + pluginId,字段经 registry 兜底默认值。 */
export interface SettingsItem {
  id: string;
  title: string;
  /** 图标名(缺省 "settings",registry 兜底)。 */
  icon: string;
  /** 展示分组入口(有 tabs)无自身 component;叶子项必有。 */
  component?: string;
  pluginId: string;
  /** 配置文件路径(null=无配置文件,如 theme-manager 走 prefs 不走框架 save)。 */
  configFile: string | null;
  /** 写入合并方式。 */
  configMerge: "deep" | "replace";
  /** 保存模式:framework=框架管 save,manual=实时生效。 */
  saveMode: "framework" | "manual";
  /** 内核模型配置源(见 SettingsContribution.kernelModels)。 */
  kernelModels?: "pi" | "dsh";
  /** 内核原生配置源(见 SettingsContribution.kernelConfig)。 */
  kernelConfig?: "pi" | "dsh";
  /** 展示分组子项(入口项有值,普通项 undefined)。每个子项是完整 SettingsItem,
   *  config/dirty/save 按子项 id 各自独立;pluginId 随父项继承。 */
  tabs?: SettingsItem[];
}
