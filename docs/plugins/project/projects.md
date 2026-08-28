# projects 插件技术文档

projects 是 my-harness-desktop 内置的项目域壳插件，物理位置 `src/plugins/project/projects/`。它做的事一句话：在左栏（sidebar 槽）挂一个可折叠的「项目」分组，持久化一份「最近工作目录」清单，用户点一条即把壳的当前工作目录切过去并清空会话上下文，另支持「+」弹目录选择器新增、悬停删条目、dnd-kit 拖拽排序、折叠态在当前项目名贴片。

理解这个插件要抓住一条主线：它是一个**写 store、不写事件总线**的插件。全插件没有 `export const channels`，没有一次 `ctx.events.emit/invoke/on`——它驱动系统的唯一方式是对共享 store（`useUiStore` / `useSessionStore`）执行受控写入，再由框架的订阅机制和其余插件的 `useXxxStore` 订阅把「项目切换」这个事实传播开。这条主线决定了文档后文的全部结构：先讲它声明了什么（§2）、目录怎么分布（§3）、sidebar 槽契约怎么被它填（§4）、renderer 逐函数做了什么（§5），再讲项目切换的完整链路从 renderer 一路下钻到壳后端 `SessionStore.setContext`（§6），然后正面回答「它 emit/invoke 了哪些 channel」——答案是零（§7），最后专节讲「与其他插件交互」（§8），因为它自己不发事件，所谓交互其实是它写 store 之后别人被动响应。

---

## 1 定位与阅读边界

- **它是「源」插件，不是「消费者」插件**：在项目切换这条信息流里，projects 是上游——它发起 `currentCwd` 的变化，却几乎不消费任何别的插件的产出。它 import 的受控 API 只有 `usePluginContext` / `useUiStore` / `useSessionStore` / `Section`（`@my-harness-desktop/react`）和 `pathBasename`（`@my-harness-desktop/shared`），其中 `usePluginContext` 只用到了 `ctx.config` 与 `ctx.dialog` 两个切片。
- **它没有 renderer 之外的任何目录**：对照「插件开发四件套」(`locales/` + `renderer/` + `pi-extension/` + `dsh-extension/`)，projects 只有 `locales/` + `renderer/`。它不给 pi/dsh 内核补任何能力——「切工作目录」是壳机制的既有能力（`BaseBackend` 无关，`setContext` 是壳后端 `SessionStore` 的方法），不需要内核插件。这是「非必要不修改内核」的正面样本：该功能零内核侧改动。
- **它零权限**：`plugin.json` 没有 `permissions` 字段。它只用 `config`（核心默认能力）和 `dialog`（用户手势驱动能力），两者都不需声明。对比同域的 `file-tree`（声明 `fs:project`）和 `git-review`（声明 `git:read`/`git:write`/`llm:oneshot`），projects 是项目域里权限面最小的一个。
- **它没有 `configFile`、没有 `dependsOn`、没有 `settings` 槽、没有 `revealOn`**：四条缺席各有一层含义，§2 逐条拆。

---

## 2 plugin.json：声明即全部能力面

`src/plugins/project/projects/plugin.json`（64 行）是插件的完整声明，逐字段拆：

- **顶层字段**：`id: "projects"`、`version: "0.4.9"`、`tier: "official"`（对应圆心 `PluginTier` 联合的 official 档，内置官方件）、`displayName: "项目"`、`description: "左栏项目列表,快速切换工作目录"`、`tags: ["project"]`、`renderer: "./renderer/index.tsx"`。
  - `renderer` 是唯一代码入口：框架加载器按它 import 模块、读模块 exports、据 `contributes.*[].component` 字段自动匹配同名导出组件。projects 的入口模块只 export 一个 `ProjectsSection`。
- **`contributes.sidebar`（1 条）**：`{ "id": "projects", "title": "项目", "component": "ProjectsSection", "order": 5, "group": "main" }`。这是全插件唯一的「UI 挂载」贡献——它只填 `sidebar` 这一个槽，别的槽（sidePanel/settings/mainView/titlebar 等）一概不碰。§4 展开这条贡献项的完整契约与注册链。
- **`contributes.languages`（8 条）**：4 个 locale（`zh-CN`/`zh-TW`/`en`/`de`）× 2 个命名空间（`projects.projects` + `projects.plugin`）。
  - `projects.projects` → `./locales/{locale}/projects.json`，只有 3 个 key：`projects.title`（项目/專案/Projects/Projekte）、`projects.add`、`projects.remove`。
  - `projects.plugin` → `./locales/{locale}/plugin.json`，2 个 key：`plugin.projects.displayName`、`plugin.projects.description`，供插件管理页显示。
  - `resources` 是相对路径，i18n 合并器启动时读文件、按 `(id, locale)` 维度合并进 i18next resources；renderer 里 `t("projects.title")` 查。manifest 里只有 key 没有文案原文——这是「token key 合规、token 值违规」纪律的直接体现：三句 UI 文案随 locale 切换，不进圆心、不进壳。

**四条缺席字段的含义**（这些缺席不是疏漏，是能力面的边界）：

- **无 `permissions`**：`ctx.config` 是核心默认能力（`plugin-context.ts:26-31` 里 `config` 直接包 `window.kernel.config`，无权限闸），`ctx.dialog.openDirectory` 是用户手势驱动、默认放行。所以插件没有任何需要声明的能力。
- **无 `configFile`**：`configFile` 是 manifest 里声明、让框架替插件管 save/dirty/reset/浮层/拦截的字段。projects 用 `ctx.config.get/set` 直读直写 `recentCwds`/`sectionCollapsed` 两个 key，不需要「保存/丢弃」浮层（改动即时生效、即时落盘），故不声明 `configFile`。注意「无 `configFile`」与「用了 `ctx.config`」不矛盾：前者是框架驱动的配置生命周期开关，后者是运行时读写插件配置的 API（§9）。
- **无 `dependsOn`**：`dependsOn` 是「消费别人 channel」的生命周期护栏。projects 不订阅任何插件的 channel（§7），所以不需要。
- **无 `revealOn`**：`revealOn` 是 `SidePanelContribution` 的字段（右面板 Tab 的揭示触发器），而 projects 贡献的是 `sidebar` 槽，`SidebarContribution` 根本没有 `revealOn` 字段——这两个缺席不是同一件事，后者是「sidebar 槽契约本身就不支持揭示」，前者是「projects 不发任何 channel」。

---

## 3 目录与代码分布

```
src/plugins/project/projects/
  plugin.json              # 声明：sidebar(1) + languages(8)，零 permissions
  renderer/
    index.tsx              # 212 行：ProjectsSection + ProjectRow + iconBtnStyle
  locales/
    {zh-CN,zh-TW,en,de}/projects.json   # projects.* 文案（title/add/remove）
    {zh-CN,zh-TW,en,de}/plugin.json     # plugin.projects.* 文案
```

与同域 `file-tree` 的关键差异：**file-tree 是「薄壳 + 厚部件」**（`FileTree` 部件 560 行收编进 `packages/react/src/widgets/file-tree.tsx`，插件壳只有 37 行），而 **projects 是「薄壳且逻辑全在壳内」**——它 212 行的 renderer 就是全部逻辑，没有把任何东西上提成发布面部件。原因在于：projects 的列表渲染、拖拽、切换语义都不具备「别的地方也要复用」的通用性（别的插件不需要再画一份最近目录列表），而 file-tree 的目录树是通用 UI 语义（timeline 附件、context-files 都要）。这条对照本身就是「框架管通用、特化归外层」的判据：不预支、不为了抽象而抽象。

renderer 里 import 的第三方依赖只有 `@dnd-kit/core` / `@dnd-kit/sortable` / `@dnd-kit/utilities`（拖拽排序）、`lucide-react`（`Plus`/`Folder`/`X` 图标）、`react-i18next`（`useTranslation`）、`react`（`useEffect`/`useState`）。这些是「会变的实现细节」，落在插件目录里合理——它们是内容层的依赖，不是壳的依赖。

---

## 4 sidebar 槽位贡献：SidebarContribution 契约与注册链

### 4.1 契约：`SidebarContribution`

圆心 `packages/shared/src/domain/contributions.ts:110-121` 定义：

```ts
export interface SidebarContribution {
  id: string;
  title: string;
  component: string;
  order?: number;   // 小的在上；缺省 100
  group?: string;   // 同 group 共享一个 Panel；不同 group/无 group 各占独立 Panel
}
```

projects 填了五个字段全量：`id="projects"`、`title="项目"`、`component="ProjectsSection"`、`order=5`、`group="main"`。

- **`order=5` 的含义**：`sidebarItems()`（`src/server/application/loader/registry.ts:236-248`）把贡献项按 `order` 升序排。当前全仓往 `sidebar` 槽挂东西的只有 4 个插件：projects（order 5）、sessions-list（order 10，标题「对话」）、sub-agent（order 20，标题「子 Agent」）、ask（order 99，标题「提问」）。所以 projects 排在左栏最上，是「项目在上、对话在下」的布局来源——这个顺序是**贡献项数据**，不是壳写死的。
- **`group="main"` 的含义**：前端 `sidebar.tsx:38-52` 的 `groupItems()` 用 `item.group ?? item.id` 作 key 分组；同组的贡献项进同一个 `Panel`（react-resizable-panels 的 vertical PanelGroup 里的一个 Panel），不同组或无组各占独立 Panel。四个 sidebar 插件全都声明了 `group="main"`，所以它们被塞进同一个 Panel，纵向共享一条可拖拽分隔线的空间。§4.3 展开滚动容器分配对这个组的影响。

### 4.2 注册链（壳后端 → 前端）

- **壳后端聚合**：`PluginRegistry.registerOne`（`registry.ts:136-163`）遍历 `arraySlots` 映射，把 `p.manifest.contributes.sidebar` 里的每条贡献项 push 进 `sidebar` 这个 `ArraySlot`。push 前先按 `contribution.id` 调 `removeById(id)`——这是「后注册者覆盖同名贡献项」的覆盖语义：`bootstrap` 按 `builtin → installed → user → project` 顺序注册，把内置 projects 复制到项目目录就能覆盖它（无特权差异检验方式二）。
- **壳后端查询**：`registry.sidebarItems()`（`registry.ts:236-248`）返回 `{ id, title, component, pluginId, group? }[]`，按 order 升序，缺省 100。
- **IPC 暴露**：`src/server/controllers/slots-dialog.ts` 的 `IPC.slots.sidebar` handler 返回 `registry.sidebarItems()`。
- **前端拉取**：`src/web/components/sidebar.tsx:126-128` 的 `useEffect` 在 `pluginsNonce` 变化时调 `window.kernel.slots.sidebar().then(setItems)`——`pluginsNonce` 是 `useUiStore` 里插件启用/禁用/安装后 +1 的世代号（`bumpPlugins`），所以热加载后左栏自动重拉。

### 4.3 组件解析与渲染链

- **组件自动匹配**：`packages/react/src/index.ts:510-530` 的 `registerPluginComponents()` 读 `contributes.sidebar[].component`，在模块 exports 里 `asReactComponent(module[item.component])` 找到同名组件，写进 `sidebarComponents` Map。projects 的 renderer export 了 `ProjectsSection`，所以框架自动把它登记为 component 名 `"ProjectsSection"`——插件**不调任何 register 函数**（`registerSidebarComponent` 这类手动注册在现行代码里已不存在，老文档里提到的它已被自动匹配取代）。
- **渲染**：`sidebar.tsx:58-111` 的 `SidebarItemSlot` 用 `getSidebarComponent(item.component)` 取组件，外面包 `<PluginIdContext.Provider value={item.pluginId}>`——所以 `ProjectsSection` 组件树里的 `usePluginId()` 返回 `"projects"`，`usePluginContext()` 拿到的 `pluginId` 绑定层（`config`）自动落到 projects 的配置命名空间。组件拿不到就没法写自己的 config，这正是「pluginId 由框架注入、插件不手写」的落地。
- **滚动容器分配**：`SidebarItemSlot` 里用 MutationObserver 探测每个槽位内容是否为空（渲染 null 即空），滚动容器（`flex-1 overflow-y-auto`）分配给「最后一个有内容的项」，其余项 `shrink-0 max-h-[50%]` 自己滚。projects 的 `ProjectsSection` 恒渲染 `<Section>`（不会渲染 null），所以它恒占一个非空槽；但它不是 `group="main"` 的末项（sessions-list 才是），故它是 `shrink-0` 固定高度项、内容超过 3 行时自己内部滚（`maxHeight: calc(3 * 54px + 2 * var(--sidebar-row-gap))`，见 renderer 第 141 行）——这解释了「项目列表超高时它自己滚、不挤压会话列表」的行为。

---

## 5 renderer/index.tsx 逐函数拆解

### 5.1 `ProjectsSection`（第 21-156 行）：唯一导出组件

它先解构三样东西：

- `const ctx = usePluginContext()`：拿 pluginId 绑定的 config + dialog。
- `const { t } = useTranslation()`：查 `projects.*` 文案。
- `const { currentCwd, setCurrentCwd, setCurrentSessionPath, setCurrentNeutralSessionId, setSessionTitle, bumpSession } = useUiStore()`：从 ui-store 拿 6 个动作/字段。注意这里**没有订阅 `currentCwd` 之外的任何东西重渲染**——它用整 store 解构（非 selector），所以 ui-store 任何字段变化都会让它重渲染，代价可接受（左栏分组本来就要响应高亮变化）。

两个本地 state：`cwds: string[]`（最近目录清单）、`collapsed: boolean`（分组折叠态）。

- **初始化**（第 30-34 行）：`useEffect(() => { ctx.config.get("recentCwds").then(v => setCwds(v ?? [])); ctx.config.get("sectionCollapsed").then(v => setCollapsed(v ?? false)); }, [])`——挂载时读一次配置，`?? []`/`?? false` 兜底（首次运行无配置时给默认）。`eslint-disable-next-line react-hooks/exhaustive-deps` 声明这是「仅挂载读一次」的意图。

### 5.2 `persist`（第 36-39 行）：写回 + 落盘

```ts
const persist = (next: string[]): void => {
  setCwds(next);
  void ctx.config.set("recentCwds", next, { scope: "global" });
};
```

同步 setState + 异步落盘。`scope: "global"` 是关键的语义选择：最近目录清单是「跨项目共享的用户级偏好」，不随项目分层，所以显式写全局层（§9）。

### 5.3 `switchCwd`（第 41-52 行）：项目切换的入口

```ts
const switchCwd = async (dir: string): Promise<void> => {
  try {
    setCurrentCwd(dir);
    setCurrentSessionPath(null);
    setCurrentNeutralSessionId(null);
    setSessionTitle(null);
    await useSessionStore.getState().startNewChat(dir);
    bumpSession();
  } catch (err) {
    console.error("[projects] 切换目录失败:", err);
  }
};
```

五步顺序语义（§6 逐层下钻）：

- `setCurrentCwd(dir)`：写 ui-store 的 `currentCwd`，并触发 `lastCwd` 持久化 + general.json 分层重读（ui-store.ts:379-385）。
- `setCurrentSessionPath(null)` + `setCurrentNeutralSessionId(null)`：清空「当前会话」的投影地址与中立主键——切项目意味着脱离旧项目里的会话。
- `setSessionTitle(null)`：清面包屑标题（回到「新对话」）。
- `await startNewChat(dir)`：走 `useSessionStore` 的 `startNewChat`，把壳后端上下文切到新目录、清空会话投影。
- `bumpSession()`：`sessionNonce + 1`——注意这个世代号当前**没有任何订阅者**（§8.4 专门交代这个「残留信号」）。

try/catch 只 `console.error`：切换失败不弹 UI，静默保留旧态（`setCurrentCwd` 是同步的，失败点只可能在 `startNewChat` 的 `setContext` IPC 上；失败时 `currentCwd` 已改但会话投影没切，属半切换态，靠 catch 兜底不崩）。

### 5.4 `openDirectory`（第 54-59 行）：新增目录

```ts
const dir = await ctx.dialog.openDirectory();
if (!dir) return;
persist([dir, ...cwds.filter((c) => c !== dir)].slice(0, 10));
await switchCwd(dir);
```

- `ctx.dialog.openDirectory()` 弹系统目录选择器，返回绝对路径；用户取消返回空，直接 return。
- `[dir, ...cwds.filter(c => c !== dir)]`：去重 + 置顶——新选目录若已在列表，先移除再放头部。
- `.slice(0, 10)`：硬上限 10 条。「最近目录」是有限的最近，不是无限历史。
- `persist` 先落盘再 `switchCwd` 切过去。

### 5.5 `removeCwd`（第 61-76 行）：删条目 + 摘挂接

```ts
setCwds((prev) => {
  const next = prev.filter((c) => c !== dir);
  void ctx.config.set("recentCwds", next, { scope: "global" });
  return next;
});
if (dir === currentCwd) {
  setCurrentCwd("");
  setCurrentSessionPath(null);
  setCurrentNeutralSessionId(null);
  setSessionTitle(null);
}
```

- 函数式 `setCwds`：注释明确「快速连删不读渲染闭包的旧 cwds」——连删两个条目时，第二个删除若读的是渲染闭包里的旧 `cwds` 会漏删。
- 摘掉当前挂接分支：`dir === currentCwd` 时把 `currentCwd` 清空为 `""`。注释给出了这条分支的根因——`lastCwd` 随 prefs 持久化（`setCurrentCwd` 里 `window.kernel.prefs.set("lastCwd", cwd)`），若只从列表删、不清 `currentCwd`，重启后 `hydrateFromPrefs` 又会从 `lastCwd` 拉回这个目录，「删不干净」。所以清空 `currentCwd` 同时把 `lastCwd` 写成 `""`，回「无项目」空态。注意：这个分支**不调** `startNewChat`，所以壳后端 `activeCwd` 不会被清——它只清 renderer 侧状态，这是「删条目」与「切项目」的语义差异（删条目不清后端，切项目才清）。

### 5.6 `onDragEnd`（第 78-89 行）：拖拽排序

`arrayMove(prev, oldIndex, newIndex)` 后 `persist` 写回。`active.id === over.id` 早退。dnd-kit 的 `active.id`/`over.id` 就是 `ProjectRow` 的 `useSortable({ id: dir })` 里的 `dir` 字符串——**目录绝对路径即拖拽标识**，路径唯一所以 id 唯一。

### 5.7 传感器与渲染

- `sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))`：拖拽激活需要 4px 位移，避免「点击切换」被误判成拖拽开始。
- `activeName = currentCwd ? pathBasename(currentCwd) : undefined`：当前项目的目录名（`pathBasename` 是圆心纯函数，同时按 `/` 与 `\` 切分，见 `packages/shared/src/domain/path-utils.ts:13-16`）。
- `setSectionOpen(open)`：折叠态反转并落盘 `sectionCollapsed`。
- 渲染：`<Section title={t("projects.title")} open={!collapsed} onOpenChange={...} collapsedSuffix={...} actions={<button onClick={openDirectory}><Plus/></button>}>`。`Section` 是 `packages/react/src/widgets/section.tsx:24` 的受控折叠容器——`collapsedSuffix` 是折叠时贴在标题旁的项目名 chip（第 100-132 行那个 `role="button"` 的 span，点击即展开、全路径放 `title` 提示），`actions` 是右侧「+」按钮。

### 5.8 `ProjectRow`（第 158-206 行）：单条项目行

- `useSortable({ id: dir })` 提供 `attributes`/`listeners`/`setNodeRef`/`transform`/`transition`/`isDragging`；`CSS.Transform.toString(transform)` 应用到行样式，拖拽过渡动画由 dnd-kit 算。
- `name = pathBasename(dir)`：第一行大字显示目录名，第二行小字显示全路径（`title={dir}` 补全）。
- 高亮：`active = currentCwd === dir` 时用 `--sidebar-row-bg-active`/`--sidebar-row-border-active`/`--sidebar-row-shadow-active` 等 token，hover 用 `--sidebar-row-bg-hover`。**没有一处写死颜色值**——全是 token key，配色由主题插件供给（token key 合规）。
- 删除按钮：`hovered && <X/>`，`onPointerDown`/`onClick` 都 `stopPropagation`，避免触发行的 `onClick`（点击删除不能连带切换项目）。

---

## 6 项目切换的完整链路：renderer → 壳后端

这是本插件的核心，也是「与其他插件交互」的地基。一次「点项目」按下后，事实沿着两条并行的线传播：**一条写 store 的 UI 线**（同步、renderer 侧），**一条 setContext 的壳后端线**（异步、跨进程）。

### 6.1 UI 线：`setCurrentCwd` 触发的三个副作用

`setCurrentCwd` 的实现（`src/web/stores/ui-store.ts:379-385`）：

```ts
setCurrentCwd: (cwd) => {
  set({ currentCwd: cwd });
  void window.kernel.prefs.set(PREF_KEYS.lastCwd, cwd);
  setGeneralConfigCwd(cwd);
  void get().reloadGeneralConfig();
},
```

- `set({ currentCwd })`：zustand 同步改字段，所有 `useUiStore((s) => s.currentCwd)` 的订阅者立即重渲染。
- `prefs.set("lastCwd", cwd)`：把「最后工作目录」落桌面偏好（electron-store），跨重启恢复（`hydrateFromPrefs` 第 440 行读 `lastCwd`，第 476 行写入 `currentCwd`）。
- `setGeneralConfigCwd(cwd)` + `reloadGeneralConfig()`：`general-config.ts` 维护一个模块级 `currentCwdMirror`，`setCurrentCwd` 时同步；随后重读 `general.json` 的分层合并视图（项目级覆盖全局），把结果写进 `generalConfig` 字段。这个字段被 timeline（输入框策略、发送逻辑）、settings-page（`readLayered(file, currentCwd)`）等消费——所以切项目会**连带刷新框架级偏好**（如 defaultThinkingLevel 的项目级覆盖）。

### 6.2 壳后端线：`startNewChat` → `setContext`

`startNewChat`（`src/web/stores/session-store.ts:459-463`）：

```ts
startNewChat: async (cwd) => {
  sessionGen++;
  await window.kernel.sessions.setContext(cwd, null);
  set({ messages: [], snapshot: null, stats: null, thinkingLevels: [], streaming: false, switching: false, ready: true });
},
```

- `sessionGen++`：递增「投影拉取防竞态代际」。这是 renderer 侧 session-store 的模块级变量（第 349 行），`refreshStats`/`refreshThinkingLevels` 等异步 RPC 回来后先比对 `gen === sessionGen`，不一致就丢弃——防「切了项目后旧项目的 stats 写回新视图」。
- `window.kernel.sessions.setContext(cwd, null)`：跨进程调用壳后端。`plugin-context.ts:71` 的 `SessionsApi.setContext` 就是包它。第二个参数 `null` 是「新会话」的显式表达（不是「保留会话」）。
- 本地 `set({ messages: [], ... })`：清空会话投影——消息、快照、统计、思考档位、流式标记全清，`ready: true` 表示「有可展示的（空）基线」。注意这里**不递增 `syncNonce`/`openNonce`**，所以 timeline 的 Virtuoso 不会重挂，只是 messages 变空、`currentCwd` 变了导致 timeline 渲染空态（§8.2）。

`setContext` 在壳后端落到 `SessionStore.setContext`（`src/server/application/sessions/session-store.ts:296-336`）：

- `this.activeCwd = cwd`、`this.activeSessionPath = null`、`this.activeProcKey = \`new:${cwd}\``：记录发送路径上下文。`activeProcKey` 用 `new:` 前缀的壳 key 表示「未落会话文件的新会话」。
- 回收旧壳进程：若 `prevKey` 存在且不同，查旧进程「未发送过消息（`!p.touched`）且活着」→ `stop()` + delete。这是「未发送消息的新会话壳不泄漏孤儿进程」的根因修复——`pref flush`（setModel/setThinkingLevel 的 `ensureForSend`）会为本 cwd 起一个空壳进程，切目录时要收掉它。
- `isAlive(key)` 为 false（新目录没有活进程）→ `this.latestSnapshot = null`：清基线，renderer 走「文件读或等 prompt 时起」。
- 因为 `sessionPath` 为 null，**不 dispatch synthetic sessionStart**（第 333-335 行的分支只在 `sessionPath` 非空时触发）。这与 `openSession` 不同：`openSession` 传了具体 sessionPath，会 dispatch `{ type: "sessionStart", sessionFile }` 主动水合 `currentSessionPath`；而 `startNewChat` 传 null，靠 renderer 侧 `switchCwd` 已经同步清空的 `currentSessionPath` 保持「新对话」态。

### 6.3 两条线的时序关系

`switchCwd` 里 `setCurrentCwd` 是同步的（第 43 行先于 await），所以 `currentCwd` 先变、随后 `await startNewChat` 的 `setContext` IPC 才落地、最后 `bumpSession`。这意味着：

- 所有只订阅 `currentCwd` 的插件（file-tree、git-review、settings-page）在 `setContext` 完成前就已经开始对新目录重渲染。
- 依赖 `sessionInfos` 的插件（sessions-list、session-colors、timeline 的自定义字段）要等 `initSessionStore` 的 `unsubCwd` 订阅器捕获到 `currentCwd` 变化、异步 `loadSessionInfos` 拉完新目录的会话列表后才更新（§8.1）。

---

## 7 emit/invoke 的真相：一个零 channel 插件

任务要求「grep channels」——结论先给：**projects 的 renderer 没有任何 `export const channels`，也没有任何 `ctx.events.emit/invoke/on`**。这是用 grep 验证过的事实（`src/plugins/project/projects` 下 `channels|emit|invoke|events\.` 零命中）。这不是缺陷，而是它作为「源插件」的必然形态。

- **它不需要发事件，因为它有 store**：项目切换这个事实，天然属于「框架级状态」（`currentCwd` 是 `UiState` 的字段，`sessionInfos` 是 `SessionStoreState` 的字段），而不是「插件私有状态」。把「我切了项目」广播出去的正确通道就是写 `useUiStore.setCurrentCwd`——这是框架为「当前工作目录」预留的唯一写口，其余插件订阅这个 store 字段即可。若 projects 另外 emit 一个 `projects:switched` 事件，等于为一个框架已有事实再发明一套并行信号，违反「契约单源」。
- **它也不是事件消费者**：切项目之后，projects 不需要听任何别的插件「回话」——它没有「等 sessions-list 拉完再高亮」的依赖。会话列表的刷新由框架的 `sessionInfos` 机制统一管（§8.1），projects 不介入。
- **对比同域插件**：git-review（`sidePanel` Tab，`revealOn` 缺席）、file-tree（`fileActions` 槽消费方 + `fileIcons` 供给方）都靠「槽查询 + 事件总线」交互，而 projects 是纯 store 写者。三类形态（store 写者 / 槽消费者 / 事件收发者）正好构成项目域插件的三种接入姿态，projects 是第一种。
- **推论**：`dependsOn` 缺席与「零 channel」互为印证——没有 channel 消费就没有生命周期依赖需要声明。

---

## 8 与其他插件交互：项目切换如何驱动下游刷新

这一节是文档的重心。projects 自己不发事件、不调别人 API，但它写 store 之后，框架的订阅机制 + 各插件的 store 订阅把「项目切换」扩散成一场连锁刷新。逐个下游拆。

### 8.1 sessions-list（会话列表）：经框架 `sessionInfos` 刷新

sessions-list 是 `group="main"` 里 projects 的「邻居」，也是项目切换最直接的下游。它的刷新**不是** projects 直接触发的，而是框架 `initSessionStore` 维护的 `sessionInfos` 字段自动更新的结果。

- **数据源已收敛为 store**：`sessions-list/renderer/index.tsx` 读 `useSessionStore((s) => s.sessionInfos)`（不再 `ctx.sessions.list` 自己拉），`loading = sessionInfos === null`。
- **框架唯一拉取口**：`src/web/stores/session-store.ts:627-638` 里，`initSessionStore` 手动维护 `lastCwd` 变量、`useUiStore.subscribe` 比对 `state.currentCwd !== lastCwd`，变化即调 `loadForCwd()` → `loadSessionInfos(cwd)`。`loadSessionInfos`（第 394-411 行）调 `window.kernel.sessions.list(cwd)`，写 `sessionInfos` 前先查 `useUiStore.getState().currentCwd !== cwd` 防竞态（切了两次项目时旧响应丢弃）。
- 于是 projects 的 `setCurrentCwd(dir)` → 框架订阅器捕获 → 异步拉新目录会话 → `sessionInfos` 换新 → sessions-list 重渲染。projects **没有**直接调 sessions-list 的任何函数。
- 附带：`loadSessionInfos` 之外的另外两个触发源是「kernel 事件流命中列表事件」（`sessionStart`/`messageStart`/`messageEnd`/`agentSettled`，第 652-654 行）和 `kernelChanged`（跨内核切换，第 643-648 行）。它们与 projects 无关，但说明「会话列表刷新」的真相源是这三处 + cwd 订阅，projects 只是 cwd 订阅这条线的上游。

### 8.2 timeline（中区会话流）：清空投影 + 键派生

timeline 消费 `currentCwd` 的方式比 sessions-list 更细，分三层：

- **投影清空（直接来自 `startNewChat`）**：projects 调 `startNewChat(dir)` 把 `messages` 清空（`session-store.ts:462`）。timeline 订阅 `messages`/`switching`（`timeline/renderer/index.tsx:110`），第 1095 行 `if (!currentCwd || (!switching && !messages.some((m) => m.role === "user")))` 命中 → 渲染「新对话」空态。也就是说，切项目后中区从旧会话流瞬时变空态，这个效果来自 `startNewChat` 的同步 `set({ messages: [] })`，**不是**来自 `syncNonce`/`openNonce` 递增。
- **键派生（来自 `currentCwd`）**：timeline 用 `currentCwd` 拼 `draftKey`/`pendingKey`/`curKey`（第 113、447、703 行）——活会话用 `currentNeutralSessionId`，新会话壳用 `new:${currentCwd}`。切项目后 `currentCwd` 变了，输入框草稿、模型 pending 意图、排队消息这些「按会话 key 隔离」的内存态全部换到新 key，旧项目的草稿/排队消息不会串到新项目。
- **会话切换重挂（不发生在切项目时）**：timeline 的 Virtuoso `key={\`${openNonce}:${syncNonce}\`}`（第 1153 行）和滚动重置 `useEffect(..., [switching, syncNonce])`（第 163 行）只在「打开历史会话」或「快照全量替换」时触发。切项目走的是 `startNewChat`，不递增这两个 nonce，所以没有重挂——只有 messages 清空 + 键派生。这是「切项目」与「切会话」在 timeline 侧的行为差异，根因在 `startNewChat` 与 `openSession` 的字段更新不同（`openSession` 递增 `openNonce`，`startNewChat` 不递增）。

### 8.3 git-review（右面板 Review Tab）：`useWorkspace` 依赖 `currentCwd` 重刷

git-review 是「右面板 Tab + 依赖 `currentCwd`」的典型。

- `GitWorkspaceTab` 段（`git-review/renderer/index.tsx:304-306`）`const { currentCwd } = useUiStore()`，然后 `useWorkspace(currentCwd, isActive)`。
- `useWorkspace`（第 51-90 行）里 `useEffect(() => { if (visible) void refresh(); }, [cwd, visible])`——`refresh()` 调 `ctx.git.status(cwd)` 拉新目录的 `isRepo`/`branch`/`ahead`/`behind`/`files`。所以 projects 一写 `currentCwd`，git-review 的 effect 依赖变化 → 重新 `git status` 新目录。
- `if (!currentCwd) return <EmptyState ... title={t("review.openFolderFirst")} />`（第 186/210/413 行）：projects 删掉当前挂接、`setCurrentCwd("")` 后，git-review 回「先打开文件夹」空态。这条链路把「删项目」和「Git 工作区清空」也串起来了。
- 第二个刷新源是 `streaming` 收尾（第 83-87 行 `prevStreaming.current && !streaming && visible`）：一轮 AI 结束自动重刷，与 projects 无关。

### 8.4 file-tree（右面板文件树）：`currentCwd` 直接驱动

`file-tree/renderer/index.tsx` 全文只有 37 行：`const currentCwd = useUiStore((s) => s.currentCwd)`，`!currentCwd` 时渲染空态，否则 `<FileTree cwd={currentCwd} refreshKey={...} />`。projects 写 `currentCwd`，file-tree 直接换根目录重渲。这是最干净的一条「store 写者 → store 读者」链路，中间无任何事件、无任何 `setContext`。

### 8.5 session-tree（右面板会话树）与 token-stats 等

session-tree 读 `currentCwd` 判断「先打开文件夹」空态（与 git-review 同款 `if (!currentCwd)` 守卫）；token-stats 依赖会话投影（`stats` 字段），`startNewChat` 把 `stats` 清 null，它随之回「—」占位。这些是同一模式的实例：projects 写 store，下游各自用自己的 store 订阅 + `!currentCwd` 空态守卫响应。

### 8.6 `bumpSession` 的「残留信号」：一个当前无人消费的世代号

`switchCwd` 末尾 `bumpSession()` 递增 `sessionNonce`（`ui-store.ts:419`）。但 grep 全仓：`sessionNonce` 只有定义（第 125 行）、初值（第 230 行）、自增（第 419 行）三处，**没有任何读取方**。它曾经（老文档所述）是「timeline 依赖它重 resync」的信号，但现行 timeline 已经改用 `syncNonce`/`openNonce` 做重挂，`sessionNonce` 成了历史遗留的孤儿计数器。

- 这不是功能 bug（没人读 = 无害），但它是「信号」与「真相源」漂移的样本：注释说「timeline 依赖它重 resync」，代码里 timeline 已经不再读它。文档如实标注这一点，避免后来者误以为「bumpSession 触发了刷新」——**真正触发刷新的不是 sessionNonce，而是 `currentCwd` 订阅 + `startNewChat` 的 store 重置**。
- 若要收编，方向是删掉这个孤儿字段（连同 `bumpSession`），让「切项目」的语义完全由 `currentCwd` + `startNewChat` 承载；或者反过来，若有真实需求（如「切项目也想让 timeline 重挂 Virtuoso」），再给它接上消费方。当前两条路都不走，保持现状并标注。

### 8.7 一张交互总图（无箭头 = 无直接调用）

```
projects.switchCwd
  ├─ setCurrentCwd(dir) ────────────────► ① 所有 useUiStore(currentCwd) 订阅者（file-tree/git-review/settings-page/…）
  │                                         ② 框架 unsubCwd 订阅器 → loadSessionInfos → sessions-list/session-colors/timeline
  │                                         ③ prefs.lastCwd 持久化 + general.json 重读 → generalConfig 消费方
  ├─ startNewChat(dir) → sessions.setContext(dir, null) ─► 壳后端 SessionStore.setContext（activeCwd 换新、清基线）
  │     └─ set({messages:[], stats:null, ...}) ─► timeline（空态）/ token-stats（清统计）
  └─ bumpSession() ──► sessionNonce+1（当前无消费方，残留信号）
```

这张图的要点：projects 只写了两个 store 的两个动作（`setCurrentCwd`、`startNewChat`），下游的一切连锁都是「订阅 + 框架机制」的既有编排，projects 自己没有一条到下游插件的直接调用。

---

## 9 配置持久化：recentCwds 与 sectionCollapsed 的 scope:global

projects 存两个 key，都显式 `scope: "global"`：

- **`recentCwds: string[]`**：最近目录清单。
- **`sectionCollapsed: boolean`**：分组折叠态。

`ctx.config.set(key, value, { scope: "global" })` 的落点语义（`src/server/application/config/config-store.ts:86-104`）：

- `set` 里 `const targetDir = opts?.scope === "global" ? this.userDir : (projectDir ?? this.userDir)`。默认（不传 scope）写**项目级 diff 层** `<cwd>/.my-harness-desktop/config/{pluginId}.json`；传 `scope: "global"` 显式写**全局层** `{userDir}/{pluginId}.json`（即 `~/.my-harness-desktop/config/projects.json`）。
- 为什么这两个 key 必须是 global：最近目录清单是「用户级跨项目偏好」，不属于任何单个项目；折叠态同理。若走默认项目级，切项目后 `get` 的合并结果（`{...user, ...project}`）会因 `getProjectDir` 动态解析而读到不同项目各自的 diff，导致「项目 A 里的 projects 列表」和「项目 B 里的」不一致——这违背「最近目录」的语义。`config-store.ts:82` 的注释原话：「scope:'global' 显式写全局(天然全局的数据用,如 recentCwds)」——projects 正是注释里点名的那个用 global scope 的样板。
- 读侧：`ctx.config.get("recentCwds")` 走 `ConfigStore.get`（`get` → `all` → `{...entry.user, ...entry.project}` 浅合并）。因为 projects 只写 global 层，项目级 diff 恒空，读到的就是全局层那份。

**与 `configFile` 机制的分界**（承接 §2）：`configFile` 是「框架替插件管 save/dirty/reset」的声明式开关，`ctx.config` 是「插件运行时直读直写」的命令式 API。projects 的「改动即落盘、无保存浮层」符合后者，所以它不声明 `configFile`、直接用 `ctx.config`。这两条路径在 `ConfigStore` 里是两套入口（`configFile` 走 `readLayered`/`setProject`，`ctx.config` 走 `get`/`set`），projects 只用后者。

---

## 10 无特权差异与内核无关的检验

- **删掉 projects 会怎样**：壳照常启动，左栏少一个「项目」分组。加载器（`PluginRegistry`）、槽位契约（`SidebarContribution`）、配置读写（`ConfigStore`）、会话管理（`SessionStore`）全部照常。没有任何机制代码依赖「存在一个叫 projects 的插件」——`sidebar.tsx` 只认 `slots.sidebar()` 返回的贡献项，不认具体插件 id。这是「内置与第三方无特权差异」的检验方式一。
- **复制覆盖**：把 projects 的 `plugin.json` 复制到用户目录，`bootstrap` 的 `builtin → installed → user → project` 注册序 + `ArraySlot.removeById` 覆盖语义会让高优先级那份胜出。projects 走的是和第三方完全相同的 `registerOne` 路径，无 `if (builtin)` 分支。
- **内核无关**：projects 的整个 renderer 没有出现 `"pi"`/`"dsh"` 字面量、没有 `if (kernel === ...)` 分支、没有 `asPi()`。它调用的 `setContext` 是壳后端 `SessionStore` 的方法（中立语义：cwd + sessionPath），不是任何内核的专属命令。切项目这个动作**与内核是谁无关**——pi 会话存 JSONL、dsh 会话存 forest，projects 都不感知，它只关心「当前工作目录」这个壳级概念。这是「壳只认中立概念、不认内核存储」的正面实例。
- **依赖方向**：renderer 只 `import` `@my-harness-desktop/shared`（`pathBasename`）和 `@my-harness-desktop/react`（受控 API + `Section`）。没有 `@/server/...`、`@/core/...`、`@/client/...` 的任何 import。符合「壳插件只从发布面引用」的物理纪律。

---

## 11 QA

**Q1：projects 切换项目为什么不发一个 `projects:switched` 事件，而要直接写 `useUiStore.setCurrentCwd`？**

因为「当前工作目录」是框架级状态，不是插件私有状态。`currentCwd` 是 `UiState` 的正式字段（`ui-store.ts:113`），`setCurrentCwd` 是框架为它预留的写口，且它自带三个副作用（`lastCwd` 持久化、`general.json` 重读、订阅者重渲染）。projects 再 emit 一个事件，等于为同一个事实发明第二套并行信号——两个信号源必然漂移（哪个才是「真的切了」？），违反契约单源。写 store 是它唯一的正确姿势。

**Q2：`switchCwd` 里为什么是 `setCurrentCwd` → `startNewChat` → `bumpSession` 这个顺序，而不是别的顺序？**

因为三个动作的时序要求不同：`setCurrentCwd` 必须**最先**同步执行，让所有 `currentCwd` 订阅者（file-tree/git-review/框架的 unsubCwd）立即响应；`startNewChat` 必须**在 currentCwd 之后**，因为它内部 `setContext(dir, null)` 依赖「新目录」语义且是异步 IPC，且它清空 `messages` 会让 timeline 立即空态；`bumpSession` 放最后是历史遗留（现在无人消费），但它语义上表示「会话代际 +1」。若调换 `setCurrentCwd` 和 `startNewChat`，`startNewChat` 里 `sessionGen++` 与 `setContext` 会先于 `currentCwd` 更新执行，`loadSessionInfos` 的防竞态检查（`useUiStore.getState().currentCwd !== cwd`）会拿旧值比对，拉取时序出错。

**Q3：`removeCwd` 删掉当前项目时为什么只清 `currentCwd` 而不调 `startNewChat`？**

删条目和切项目是两种语义：切项目要「把会话上下文迁移到新目录」（`setContext` + 清投影），删条目是「这个目录从最近列表消失」。若删条目也调 `startNewChat`，会在壳后端产生一次无谓的 `setContext("", null)` 且清掉 `messages`；而删条目只清 renderer 侧 `currentCwd` 到空态（配合 `setCurrentCwd("")` 把 `lastCwd` 也清掉，防止重启拉回），让下游插件回「先打开文件夹」空态即可。壳后端 `activeCwd` 残留着旧值不影响——下次 `setContext` 会覆盖它。

**Q4：`recentCwds` 上限 10 条写死在哪？为什么是 10？**

写死在 `openDirectory` 的 `.slice(0, 10)`（renderer 第 57 行）。它是「最近目录」的容量上限，10 是产品取舍（足够覆盖日常来回切换的少数项目，又不至于列表冗长）。注意这是个**硬编码常量**且没有可配置入口——它属于「内容」但被焊在了插件里。按「会变的内容该可替换」的纪律，严格说这个 10 应做成配置或至少提炼成常量；当前它留在代码里是「已知的轻量偏离」，不构成壳的泄漏（壳里没有这个 10）。

**Q5：projects 没有 `dependsOn`，那它「依赖」`useSessionStore`/`useUiStore` 这些 store 算不算跨插件依赖？**

不算。`dependsOn` 管的是「事件总线 channel 的消费依赖」（`ctx.events.on/invoke` 别人的 channel），而 `useUiStore`/`useSessionStore` 是**框架共享状态**，不属于任何插件。读共享 store 不需要声明 `dependsOn`（共享 store 只读纪律 `§8.2`）。projects 对这两个 store 的「读 + 写」都是框架契约内的动作，不是插件间通信。

**Q6：切换项目后，timeline 为什么没有走「Virtuoso 重挂」？它靠什么清空旧会话流？**

靠 `startNewChat` 的同步 `set({ messages: [], snapshot: null, stats: null, ... })`。Virtuoso 重挂的 key 是 `${openNonce}:${syncNonce}`，这两个 nonce 只在 `openSession`（递增 `openNonce`）和「非空快照全量替换」（`applySnapshot` 递增 `syncNonce`）时变；`startNewChat` 不变它们，所以不重挂。切项目后 timeline 清空是「messages 数组清空 → 空态分支命中」，不是「组件卸载重挂」。这是刻意设计：切项目不需要滚动位置重置（本来就没有旧消息要滚），重挂是多余工作。

**Q7：projects 的拖拽排序用的是路径字符串当 id，路径里如果有重复（同一个目录）会怎样？**

不会重复——`openDirectory` 的 `cwds.filter(c => c !== dir)` 保证列表里目录唯一，`removeCwd` 的 `filter` 也按路径全等删，所以 `dir` 在 `cwds` 里恒唯一，`useSortable({ id: dir })` 的 id 恒唯一。dnd-kit 依赖 id 唯一性做拖拽定位，路径唯一是它的前提。若未来引入「同一目录的多份视图」这种形态，id 策略要改，但当前「目录绝对路径」就是唯一主键。

**Q8：projects 和同域 file-tree、git-review 的交互姿态有什么本质区别？**

三者的区别在于「改变世界的通道」：projects 是**纯 store 写者**（写 `currentCwd`，零事件零槽消费）；file-tree 是**槽消费者 + 槽供给者**（消费 `fileActions` 槽渲染右键菜单、供给 `fileIcons` 槽的图标规则，右面板 `sidePanel` 槽的 Tab）；git-review 是**store 读者 + 权限能力消费者**（读 `currentCwd`/`messages` 派生轮次，用 `git:read`/`git:write`/`llm:oneshot` 权限调能力）。projects 最「轻」——它甚至不贡献 sidePanel，只贡献 sidebar 这一个 UI 槽。三者的共同点是都不直接调用对方插件，交互全部经 store、槽、事件总线三类框架机制间接完成。
