# 右侧栏（sidePanel）架构

## 1 sidePanel 是什么

- sidePanel 是壳预定的右侧面板槽位：壳只提供一个「图标条 + 内容区」的空容器机制，具体每个 Tab 的内容由壳插件往槽里贡献，壳不认具体插件、只认槽位契约（`packages/shared/src/domain/contributions.ts` 的 `SidePanelContribution`）。
- 物理形态是两层独立组件，各自生命周期独立，落在 `src/web/components/right-panel.tsx`：
  - `SidePanelStrip()`（`right-panel.tsx` 第 86 行）是右侧 48px 宽的竖排图标条，**不在布局树 PanelGroup 内**——它在 `src/web/app-main.tsx` 第 51 行作为 `<LayoutEngine />` 的兄弟节点渲染在 `ChatView` 里，right 组折叠时内容区缩为 0 而图标条永远可见，这是重新展开右面板的唯一入口。
  - `RightPanelContent()`（`right-panel.tsx` 第 253 行）是内容区，由动态布局引擎在 right 组内渲染（经 `shell:sidePanel` 内建视图），内部是一个纵向 `PanelGroup`（`react-resizable-panels`），每个活跃 tab 是一个可缩放 `Panel`，面板间有 `PanelResizeHandle` 分隔。
- 与左侧栏 sidebar 的差异根因是「内容控制权分界线位置不同」，不是架构缺陷：
  - 左栏的壳控制了约 90% 的视觉结构（每一行都是 icon+label+actions，每个分组都是标题栏+折叠内容），所以左栏能做统一的风格切换。
  - 右面板的壳只控制四个壳层部分——面板头（icon+label 的点击栏）、图标条、内容容器（`overflow-y-auto` 滚动区）、分隔线——内容区只给一层 padding 容器，里面是插件自绘的草稿纸：`git-review` 画文件列表+diff、`token-stats` 画统计卡、`session-tree` 画树节点，壳无法用一个「行」抽象覆盖它们。
- 弥合方向不是让壳变厚去覆盖插件内部布局（那违反薄壳纪律），而是给插件一套「框架提供、插件消费」的基础组件与风格 token（`docs/design/panel-style-system.md`）；壳控部分全部经 CSS 变量 `--sidepanel-*` 分派，不硬编码颜色/尺寸。
- 「右面板开/关」的真相源在 layout store 的 right 组 `hidden` 字段（`DEFAULT_GROUP_IDS.RIGHT === "right"`），不在 ui-store；ui-store 只维护 tab 列表与偏好，这层职责划分在 `ui-store.ts` 第 388-389 行注释里钉死：tab 开关与 right 组显隐同生共死。

## 2 sidePanel 槽契约

- 圆心定义，契约单源：`packages/shared/src/domain/contributions.ts` 第 81-95 行定义 `SidePanelContribution`，只 `import type { KernelId } from "./kernel"`，零外部依赖（文件头注释声明「圆心纯度纪律」）。
- 六个字段逐一落点：
  - `id: string`——贡献 id（插件内唯一），图标条的活跃键、prefs 持久化的键、`removeById` 覆盖的键，都是它。
  - `label: string`——Tab 显示名，契约字段名是 `label` 不是 `title`（第 83 行注释明确）。
  - `icon: string`——lucide 图标名（如 `git-compare`），渲染层经 `PluginIcon` 按名映射。
  - `component: string`——renderer 侧组件名，框架从插件 module exports 自动匹配，不手写 register。
  - `order?: number`——Tab 排序，小的在前，缺省 100（扩展字段，DESIGN.md 未含）。
  - `revealOn?: string`——揭示触发器，该 channel 被 emit/invoke 时框架展开右面板并激活本 Tab（第 91-94 行，声明式）。
- 槽名在 `SlotName` 联合（第 377-404 行）里以 `"sidePanel"` 字符串字面量存在，`PluginContributes.sidePanel?: SidePanelContribution[]`（第 412 行）是 manifest 顶层的声明落点。
- 契约里**没有 `pluginId`**：`pluginId` 不是插件自己声明的，是注册表在聚合时「哪个插件贡献了它」而附上的运行时字段——这是「契约（圆心拥有的形状）vs 运行时投影（registry 附加 pluginId）」的分界，渲染层拿到的 `SidePanelItem` 是 `{id,label,icon,component,pluginId,revealOn?}` 七字段。
- 契约注释里写「经 registerSidePanelComponent 注册」是一处轻微 stale：真实机制是 `registerPluginComponents`（`packages/react/src/index.ts` 第 510 行）读 manifest 的 `contributes.sidePanel[].component` 自动匹配，插件不调任何 register 函数（§5 详述）。

## 3 谁贡献 Tab：13 个贡献项 / 12 个插件

- 当前共有 13 个 sidePanel 贡献项，分布在 12 个插件目录（grep `src/plugins/**/plugin.json` 的 `"sidePanel"` 确认）；按 `order` 升序（图标条从上到下）罗列：
  - `session-bookmarks` → `bookmarks`，order 5，icon `bookmark`，权限 `fs:project`，`revealOn: "bookmarks:addRequested"`。
  - `git-review` → `review`，order 10，icon `git-compare`，权限 `git:read`/`git:write`/`llm:oneshot`。
  - `blind-review` → `blind-review`，order 15，icon `eye-off`，权限 `fs:project`。
  - `tool-manager` → `tools`，order 15，icon `sliders-horizontal`，无权限。
  - `file-tree` → `files`，order 30，icon `folder-open`，权限 `fs:project`（同时贡献 30+ 条 `fileIcons` 槽）。
  - `im-graph` → `im-graph`，order 40，icon `network`，权限 `sessions:bus`。
  - `session-tree` → `tree`，order 40，icon `list-tree`，`dependsOn: ["timeline"]`。
  - `token-stats` → `stats`，order 50，icon `bar-chart-3`（同时贡献 `titlebar`、`composerStats` 槽）。
  - `llm-recorder` → `llm-records`，order 55，icon `scroll-text`，权限 `fs:project`，`piExtension: "./pi-extension"`。
  - `stickers` → `stickers`，order 60，icon `sticker`（同时贡献 `settings`、`composerActions` 槽）。
  - `sub-agent` → 两个贡献项：`sub-agents-panel`（order 60，icon `git-fork`）+ `sub-agent-dialog`（order 70，icon `message-square`，`revealOn: "subagent:dialog"`），权限 `sessions:bus`。
  - `session-colors` → `session-colors`，order 80，icon `pin`（同时贡献 `messageActions` 槽）。
- 一个插件贡献多个 Tab 是合法的：`sub-agent` 一个 plugin.json 里声明两条 `sidePanel` 数组项，各自独立 order/icon/component/revealOn——这说明槽契约的粒度是「贡献项」而非「插件」，同一插件可以占多个 Tab 位。
- `revealOn` 的当前消费者只有两个：`sub-agent` 的 `subagent:dialog` 和 `session-bookmarks` 的 `bookmarks:addRequested`——其余 11 个 Tab 不声明 `revealOn`，只被动等用户点击图标激活（§6 详述两条揭示链）。
- order 相同是常态且确定性：`blind-review`/`tool-manager` 同为 15，`im-graph`/`session-tree` 同为 40，`stickers`/`sub-agents-panel` 同为 60；`Array.prototype.sort` 稳定排序保证同 order 按注册序（builtin → installed → user → project）排定，不随机。
- 覆盖语义（无特权差异）：`registry.registerOne` 在 push 前先按 `contribution.id` 清同 id 旧项（`registry.ts` 第 152-158 行 `removeById` 再 `push`）——把内置插件复制到高优先级目录（user/project）即覆盖同名贡献，同级内置和第三方走同一条注册路径。

## 4 谁消费渲染：从注册表到 React 组件的完整链路

- 后端注册表 `src/server/application/loader/registry.ts` 是消费链的第一站：
  - `sidePanel` 字段用通用 `ArraySlot<SidePanelContribution>` 容器（第 84 行），与 settings/sidebar 等数组类槽共用同一容器实现（第 53-72 行，开闭原则：加新数组类槽只加字段+SlotName+查询方法）。
  - `registerOne`（第 136-163 行）经 `arraySlots` 映射（第 107-128 行）通用遍历注册，不逐槽写 for。
  - `sidePanelItems()`（第 220-233 行）把每个贡献项投影成 `{id,label,icon,component,pluginId,revealOn?}`，先按 `order ?? 100` 排序、再 `.map(({ order: _order, ...rest }) => rest)` 把 order 从返回里剥掉——order 只用于排序，不流向渲染层。
- 网关 `src/server/controllers/slots-dialog.ts` 第 12 行：`gateway.register(IPC.slots.sidePanel, () => registry.sidePanelItems())`——这是「槽位清单（Core）」类 handler，与 dialog（Host）类 handler 同文件分组。
- 前端桥 `src/web/kernel/build-kernel.ts` 第 100-101 行：`slots.sidePanel()` 定义成 `transport.invoke(IPC.slots.sidePanel)`，返回 `{id,label,icon,component,pluginId,revealOn?}[]`——`window.kernel.slots.sidePanel` 是前端拿槽清单的唯一入口，壳插件不直连 transport。
- 数据加载集中在 `right-panel.tsx` 的 `useSidePanelData()`（第 59-71 行）+ `loadSidePanelData(nonce)`（第 35-49 行）：
  - 模块级单例缓存 `sidePanelCache` 以 `nonce` 为 key，`SidePanelStrip` 与 `RightPanelContent` 共享同一份数据，同 nonce 只发一次请求。
  - `sidePanelInflight` 做单飞（in-flight 去重），`pluginsNonce`（`useUiStore` 的 `bumpPlugins()` 自增）进依赖——插件启用/禁用/安装后重拉 sidePanel 槽贡献。
  - `SidePanelData.ready` 标志 + `EMPTY_DATA`（`{items:[],ready:false}`）区分「占位期」与「真实空」：占位期 items 为空，prune 等消费方必须等 ready，否则活跃 tab 会被误判成死 id 全清（第 25-27 行注释）。
- 组件按名解析是第二步：`RightPanelContent` 第 459 行 `getSidePanelComponent(item.component)` 查组件注册表（`packages/react/src/index.ts` 第 463 行），命中则 `<Comp isActive={isActive} />`，未命中渲染 i18n 回退「组件未注册」（`right-panel.tsx` 第 500-504 行）。
- 组件注册表的 key 是**组件名字符串**（`sidePanelComponents = new Map<string, ComponentType<{isActive:boolean}>>`，`index.ts` 第 455 行），不是 pluginId——这意味着 sidePanel 槽的组件名全局唯一；`pluginId` 只用于渲染时包一层 `PluginIdContext.Provider value={item.pluginId}`（`right-panel.tsx` 第 497-499 行），让组件内部 `usePluginContext()` 的 pluginId 绑定（config/fs/git 权限）正确解析到贡献方。

## 5 组件自动匹配与 pluginId 注入

- 壳插件不手写 `registerSidePanelComponent`：框架加载 renderer module 后，读 manifest 的 `contributes.sidePanel[].component` 字段，在 module 的 exports 里找同名组件自动注册——这是 §7.4 组件自动匹配纪律在 sidePanel 槽的具体落地。
- 注册入口是 `packages/react/src/index.ts` 的 `registerPluginComponents(module, contributes)`（第 510-530 行）：
  - 遍历 `["settings","sidePanel","sidebar","mainView","titlebar"]` 五个槽，对 sidePanel 这类非 settings 槽直接取 `contributes[slot]` 数组，逐个 `asReactComponent(module[item.component])` 匹配，命中 `registry.set(item.component, comp)`。
  - `asReactComponent`（`packages/react/src/plugin-modules.ts` 第 13-17 行）同时认普通函数组件和 memo/forwardRef/lazy 等 exotic 组件（带 `$$typeof`），旧码只认 `typeof function` 导致 memo 包装的导出被静默丢弃是历史 bug。
  - `unregisterPluginComponents`（第 532-543 行）按同形状注销，插件卸载时摘除组件名，配合 `onUnloaded` 生命周期。
- 加载器在 `src/web/app/plugins-host.ts`：`loadBuiltin`（第 29-54 行）/`loadThirdParty`（第 56-80 行）都调 `registerPluginComponents(mod, manifest.contributes ?? {})`，之后 `bumpPlugins()` 让槽宿主重拉清单。
- 插件侧只 export 组件即可，零注册代码——`sub-agent` 的 `renderer/index.tsx` 第 16-17 行 `export { SubAgentPanel } from "./panel"; export { SubAgentDialog } from "./dialog";` 与 manifest 的 `component: "SubAgentDialog"` 一一对应。
- pluginId 注入同样零硬编码：`RightPanelContent` 第 497 行 `PluginIdContext.Provider value={item.pluginId}` 包住 `<Comp />`，组件里 `usePluginContext()` 拿到的 `pluginId` 是框架从 Provider 注入的，插件代码不出现自己的 plugin id 字符串字面量（§8.3 零硬编码纪律）。
- 首帧闪「组件未注册」的规避在 `app-main.tsx` 第 205-212 行：渲染闸门纳入 `pluginsReady`（plugins-host 完成所有 renderer chunk import 后才 render），否则槽宿主首渲染时 manifest 已查到、组件还没 import 完，会闪回退文案。

## 6 revealOn 声明式揭示

- 语义：`revealOn: "<channel>"` 让贡献项「被某个事件 channel 触发时自动展开右面板并激活本 Tab」，触发方不认识贡献者、贡献者代码不出现自己的 contribution id，框架居中撮合（`right-panel.tsx` 第 116-119 行注释）。
- 实现链路极短，落在 `SidePanelStrip` 的一个 effect（`right-panel.tsx` 第 120-130 行）：
  - 第一步建映射表：遍历 `items`，把每个 `item.revealOn` 收进 `byChannel: Map<channel, tabId>`。
  - 第二步挂框架内部侦听：`eventBus.tap((channel) => { const tabId = byChannel.get(channel); if (tabId) activateSidePanelTab(tabId); })`。
  - `byChannel.size === 0` 时直接 return 不挂 tap（无揭示需求的常见态零开销）。
- `eventBus.tap`（`packages/react/src/event-bus.ts` 第 40-43 行）是框架内部观察者钩子，不进 `PluginEventsApi`（插件不可用）；`fireTaps`（第 45-53 行）在**任何 `emit`/`invoke`/`emitSystem` 派发前同步触发** tap 回调，只观察不参与 pub/sub，回调抛错被 try/catch 兜底不阻断派发。
- `activateSidePanelTab`（`src/web/stores/ui-store.ts` 第 397-403 行）是「揭示语义」setter，与 `toggleSidePanelTab` 的关键差异是**不做反向关闭**：
  - tab 不在活跃集则补入 `[...tabs, id]`，已在则返回原引用（幂等，不触发无谓重渲染）。
  - 无条件 `setGroupHidden("right", false)` 确保右面板展开——即「已激活仅展开面板」的幂等 ensure 语义（契约第 93 行注释同义）。
  - 对比 `toggleSidePanelTab`（第 390-396 行）：已激活则移除并 `setGroupHidden("right", next.length === 0)` 折叠。
- 当前两条真实消费者链：
  - **emit 自揭示（sub-agent）**：`renderer/dialog-state.ts` 第 104-105 行，`openDialogFor()` 打开与某子 agent 的对话面板时 `ctx.events.emit("subagent:dialog")`，manifest 里 `sub-agent-dialog` 贡献项声明同值 `revealOn`，框架 tap 命中即展开并激活「对话」Tab。channel 由 `renderer/index.tsx` 第 13 行 `export const channels = ["subagent:dialog"]` 代码级声明（emit 只能发自己声明过的 channel）。
  - **invoke 自揭示（session-bookmarks）**：`renderer/message-actions.tsx` 第 32-37 行，`BookmarkAction` 按钮（渲染在 timeline 消息行）点击时 `ctx.events.invoke("bookmarks:addRequested", {...})`，manifest 里 `bookmarks` 贡献项声明同值 `revealOn`。关键在 invoke 的入队语义：收藏 tab 未挂载时请求在总线入队，`revealOn` 揭示本 tab → 挂载 → `BookmarksTab` 的 `ctx.events.on("bookmarks:addRequested", handler)`（`renderer/index.tsx` 第 208 行）冲刷恰好一次投递——`event-bus.ts` 第 184-191 行的 pendingInvokes 冲刷逻辑配合揭示语义实现「懒挂载组件的可靠投递」，不靠 replayLast 误重放。
- 揭示与订阅是两条正交的线：`bookmarks:addRequested` 既被 tap 监听（展开激活 tab），又被 `BookmarksTab` 的 `on` 订阅（接收 payload 创建收藏）；tap 只认 channel 字符串、不认 payload、不认谁发的，所以同一 channel 可以同时驱动「框架展开」和「业务处理」。
- 边界澄清：`session-tree:bookmarkRequested`（session-tree 的 `renderer/index.tsx` 第 24 行声明、第 269 行 emit）被 `BookmarksTab` 第 209 行订阅，但**不是 revealOn 通道**——session-tree 的 tree Tab 没有声明 revealOn，这是纯 pub/sub 跨插件通信，和揭示无关。

## 7 状态：ui-store 与 layout-store 的职责划分

- 两份 store 各管一半，边界钉死（`ui-store.ts` 第 388-389 行注释）：
  - `useUiStore`（`src/web/stores/ui-store.ts`）管 tab 列表与偏好：`activeSidePanelTabs: string[]`（活跃 tab id 列表，纵向堆叠，第 119 行注释写「最多 3 个同时可见」是文档意图，代码无硬上限）、`sidePanelOrder: string[]`（图标条自定义排序）、`sidepanelStyle`、`sidepanelFontScale`、`pluginsNonce`。
  - `useLayoutStore`（`src/web/stores/layout-store.ts`）管 right 组的 `hidden`：`setGroupHidden("right", ...)` 是显隐真相源，`useGroupHidden(DEFAULT_GROUP_IDS.RIGHT)`（第 694-696 行）是显隐的唯一查询入口，消费方不各自遍历树。
- 三个 tab 相关 action 的分工：
  - `toggleSidePanelTab`（第 390-396 行）：toggle 语义，tabs 清空即折叠、有 tab 即展开，写 `prefs.activeSidePanelTabs` 持久化。
  - `activateSidePanelTab`（第 397-403 行）：揭示语义，幂等补入 + 展开，只在真的补入时写 prefs（`next !== tabs` 才 set），未变则返回原引用。
  - `pruneSidePanelTabs(validIds)`（第 404-413 行）：清单刷新后剔除死 tab id（卸载/禁用插件贡献已从清单消失但 prefs 持久化的活跃数组不自动收缩）；幂等无死 id 返回原引用；尚有余项时不折叠（交给 Strip 兜底 effect 自动激活第一个），清单整体消失才折叠 right 组。
- 首激活兜底：`SidePanelStrip` 第 109-114 行的 effect，`rightPanelHidden === false && activeTabs.length === 0 && orderedItems.length > 0` 时自动 `toggleSidePanelTab(orderedItems[0].id)`——右面板展开却无活跃 tab 时激活第一项，避免「展开但空白」。
- 持久化双通道：
  - `activeSidePanelTabs` 与 `sidePanelOrder` 走 `window.kernel.prefs`（全局桌面偏好，`ui-store.ts` 第 37-38 行 `PREF_KEYS`），`hydrateFromPrefs`（第 421-482 行）启动恢复。
  - `sidePanelOrder` 曾误落 `general.json` 项目级（按项目分层，与「桌面 UI 偏好」语义相悖），`hydrateFromPrefs` 第 448-461 行做一次性迁移：prefs 已有值不覆盖，general.json 残留键无害（读侧已不消费）。
- 排序的唯一读取口是 `useSidePanelOrder()`（`right-panel.tsx` 第 54-56 行）读 `useUiStore(s => s.sidePanelOrder)`；`applyCustomOrder`（第 73-84 行）把贡献清单按自定义顺序重排，无 id 的项保持原序在末尾，空数组 = 默认槽位序早退。
- 拖拽排序用 `@dnd-kit/core` + `@dnd-kit/sortable`（`SidePanelStrip` 第 103-105、132-140 行），`handleDragEnd` 经 `arrayMove` 算新序后 `setSidePanelOrder` 同帧同步内存 + prefs——Strip 与 Content 双组件经同一 store 订阅派生，无分层、无启动竞态、无「图标变了面板没变」的漂移。

## 8 风格系统与字体缩放

- 壳控视觉全经 CSS 变量 `--sidepanel-*`，由 `data-sidepanel-style` 属性选择器分派：`SidePanelStrip`（第 87 行）和 `RightPanelContent`（第 255 行）都在根元素挂 `data-sidepanel-style={sidepanelStyle}`（读 `useUiStore(s => s.sidepanelStyle)`），与左栏 `data-sidebar-style` 完全同构。
- `SidepanelStyle = StylePresetId = "default" | "card" | "minimal" | "outline" | "glass"`（`packages/shared/src/contract/style-presets.ts` 第 14、18 行），与左栏同一族值；`SIDEPANEL_STYLE_PRESETS`（第 37-43 行）是独立清单但 labelKey 复用 `settings.style.*`。
- 契约单源纪律在样式上的落地：`SIDEPANEL_STYLE_PRESETS` 只持有 `id + labelKey`，样式内容（CSS 变量值）唯一真源是 `index.css` 的 `[data-sidepanel-style="<id>"]` 属性选择器块——历史上 sidebar-styles.ts / panel-styles.ts / domain/panel-tokens.ts 三处 vars map 与 index.css 是同一概念的三份副本，已开始漂移（`sidepanel.card.shadow` 的 `"none"` vs `"var(--shadow-sm)"` 是实证），现已收敛为「清单契约 + CSS 真源」两处（第 1-11 行注释）。预览卡渲染挂同一 data attribute，与生产同一条 CSS 路径，漂移物理上不可能。
- `--sidepanel-*` token 清单（从 `right-panel.tsx` 实际使用处枚举）：面板头 `--sidepanel-header-py/-px/-border/-bg/-fs/-fw`、内容容器 `--sidepanel-content-py/-px`、图标条按钮 `--sidepanel-icon-btn-size/-radius/-bg/-bg-active/-border`、激活指示条 `--sidepanel-icon-active-indicator/-height`、图标 `--sidepanel-icon-size/-gap`、分隔线 `--sidepanel-divider-display/-color`、glass 特效 `--sidepanel-glass-blur`（`backdrop-filter` 用，非 glass 风格为 `none`）。
- 字体缩放独立于风格：`RightPanelContent` 第 444-452 行经 CSS 变量计算注入 `--sidepanel-font-scale`，覆盖 `--font-size-{xs,sm,base,lg}` + `--sidepanel-header-fs`/`--sidepanel-section-fs`；偏好键 `sidepanelFontScale`（`ui-store.ts` 第 103 行注释「仅作用于右面板子树」），与 `sidebarFontScale`/`timelineFontScale` 三分区独立。
- 与左栏风格系统的关系：两个独立偏好 `sidebarStyle`/`sidepanelStyle` 分别存储（用户可左栏 card、右面板 minimal）；token 命名空间独立 `--sidebar-*` vs `--sidepanel-*`，同处一棵 DOM 树互不覆盖；5 种风格视觉语言概念一致但具体 token 值独立。
- 插件内容区的风格消费：壳不强制插件内容视觉一致（右面板内容多样性的必然结果），弥合方向是 `packages/react/src/panel/` 提供的基础组件——`PanelRow`/`PanelIconButton`/`PanelToolbar`/`PanelSearchInput`/`PanelStatRow`/`PanelCard`/`PanelSectionTitle`/`PanelTabs`（`index.ts` 第 339-348 行 re-export），让插件消费面板 token 而非手写 `iconBtnStyle` 常量。

## 9 尺寸模型与收起动画

- 尺寸模型 v2 用「id 键控权重」取代 v1 的 `autoSaveId` 位置存档（`right-panel.tsx` 第 218-231 行注释）：
  - 单一数据源 `weightsRef: Map<panelId, weight>`，渲染时 `defaultSize = weight(id) / Σweight(全部 renderIds) × 100`。
  - `sizeFor(id)`（第 300-308 行）遍历本批 `renderIds`，缺权重的 id 以均权幂等填充，返回归一百分比。
  - `syncWeights(sizes)`（第 312-318 行）是 `onLayout` 的唯一回写点，按 `renderIds` 序把尺寸写回 id 权重——初始化、拖拽、关闭动画中间帧都经它。
  - 核心原则是「id 键控，不键位」：板块重排/增删，权重始终跟着板块走，杜绝按位置存档/恢复的错位污染。
  - 尺寸不跨会话持久化：冷启动恒平分，会话内手动拖动/开关板块有效。
- 收起动画用 rAF 驱动 `ImperativePanelHandle.resize()` 平滑收起到 0，不用 `panel.collapse()`（无完成回调）、不用 CSS 高度动画（与 PanelGroup 的 flex-grow 布局打架）、不赌 setTimeout 时长（`right-panel.tsx` 第 218-231 行注释 + `startCloseAnim` 第 328-355 行）。
- 状态机：`renderIds`（PanelGroup 渲染的 panel id 序 = 活跃 ∪ closing）+ `closingIds`（正在收起的 id）+ `weightsRef`（尺寸）+ `rafIdsRef`/`startSizesRef`（动画帧与起始尺寸）。
  - 主 reconcile effect（第 358-421 行）检测 `orderedItems` 变化：removed → closing 保留原位；added → reconcile 插回；顺序变 → reconcile 重排（closing 保位）。
  - `reconcile(prev, active, closing)`（第 284-297 行）把 closing id 按上帧位置插回 active 骨架，保证收起动画期间 closing panel 原位不跳。
  - closing 期间重新激活同一 tab（第 364-370 行）：移出 `closingIds` → cancel effect（第 424-434 行）停 rAF → `resize` 回 `startSizes` 记录的起始尺寸精确恢复。
  - `finishClose`（第 322-326 行）摘除权重——onLayout 每帧已把幸存者吸收后的尺寸写回权重，移除后 re-render 按剩余权重归一，移除瞬间零跳变。
- 单 panel 直删路径：`panelRefs.current.size <= 1` 时直接移除、不进 closing/rAF（第 390 行 `instant`），根因是单 panel 组恒 100% 无邻居可吸收空间，且库 imperative `resize()` 在 1-panel 组算出 `[-1,0]` pivot 断言抛错白屏（第 384-389 行注释）。
- 幂等守卫：`setClosingIds`/`setRenderIds` 全部调用有 `sameIds` 浅比较（第 237-239 行）——否则 closingIds 作为 effect 依赖，内容没变却返回新数组会让 effect 自触发，动画期间每秒数百次空转（根因记录 G-20260802-01，`sidepanel-close-animation.md` §3.3）。
- 动画参数：`CLOSE_ANIM_MS = 240`，`easeInOutCubic` 缓动（第 232-235 行）。

## 10 与事件总线 / 左侧栏 / 主视图的交互

- 与事件总线的交互是「tap 旁听 + 插件自订阅」两条线，都是事件驱动不轮询：
  - 框架侧：`SidePanelStrip` 的 `eventBus.tap` 旁听所有 emit/invoke/emitSystem，命中 `revealOn` 映射就 `activateSidePanelTab`（§6）。
  - 插件侧：Tab 组件挂载后 `ctx.events.on` 订阅自己的 channel 处理业务（`BookmarksTab` 订 `bookmarks:addRequested` + `session-tree:bookmarkRequested`）；channel 由 `export const channels` 代码级声明，框架加载 module 后 `eventBus.registerChannels` 自动注册（`plugins-host.ts` 第 35-40 行）。
  - `revealOn` 让「懒挂载 tab + invoke 入队 + 首订阅者冲刷」三者闭环：invoke 无订阅者时入队，tap 先展开激活 tab，tab 挂载订阅时恰好一次冲刷（`event-bus.ts` 第 184-191 行），不靠 sleep/replayLast。
- 与左侧栏 sidebar 是同级的布局树兄弟，互不感知：
  - 两者都是 `buildDefaultTree`（`packages/shared/src/domain/layout.ts` 第 294-330 行）产出的默认三组之一：root split horizontal `[left, main, right]`，各自独立 `hidden`、独立尺寸份额。
  - 开关快捷键独立：`app-main.tsx` 第 119-144 行，⌘B 切左栏、⌘J 切右面板，都走 `setGroupHidden("left"/"right", !hidden)`。
  - 标题栏两个按钮独立：`titlebar.tsx` 第 59-61 行 `PanelLeft` 切左栏、第 87-89 行 `PanelRight` 切右面板。
  - 左栏内容由 sidebar 槽（sessions-list/projects/sub-agent 等）贡献，右面板由 sidePanel 槽贡献，两个槽互不引用、不共享组件注册表。
- 与主视图 mainView 的交互是「主视图触发、右面板响应」的典型揭示场景：
  - mainView 槽由 timeline 插件贡献（`layout-store.ts` 第 205-217 行 `createMainViewSlotView`，`syncMainViewSlot` 重查 mainView 槽），它是中区消息流。
  - timeline 消息行渲染 `messageActions` 槽（`session-bookmarks` 的 `BookmarkAction`/`ForkAction`，`message-actions.tsx`），用户点「收藏」按钮 → `ctx.events.invoke("bookmarks:addRequested", {...})` → 框架 tap 展开右面板激活「收藏」Tab → 收藏创建后原位改标题。
  - 这就是「主视图动作 → 右面板揭示」的完整闭环，触发方（timeline 渲染的 BookmarkAction）不认识贡献者（session-bookmarks 的 BookmarksTab），靠 `revealOn` + 事件总线居中撮合。
- 布局树的种子视图：`shell:sidePanel`（`createShellSidePanelView`，`layout-store.ts` 第 195-203 行）是 right 组的唯一内建视图，`component: "RightPanelContent"`、`pluginId: "shell"`、`closable: false`；`layout-engine.tsx` 第 67-70 行 `shellComponentTable` 把 `pluginId === "shell"` 的组件名映射到壳内部组件（`Sidebar`/`RightPanelContent`），其余 `getPluginComponent(pluginId, component)` 查插件 exports。
- `system:layoutChanged` 广播：layout-store 任何变更（`emitAndPersist`，第 232-235 行）都 `eventBus.emitSystem("system:layoutChanged", {})` 并 300ms debounced 持久化树骨架；right 组 hidden 变化因此对外可观测，但 sidePanel 的 tab 状态（activeSidePanelTabs）不走这棵树，走 prefs。
- 共享 store 只读：sidePanel Tab 组件可以读 `useUiStore`（如 `BookmarksTab` 读 `currentCwd`/`currentNeutralSessionId`）和 `useSessionStore`（`BookmarkAction` 读 `snapshot.state.sessionName`），但不能调 store 的 setter——改变框架状态（展开/激活/折叠）走 `toggleSidePanelTab`/`activateSidePanelTab`（框架 action）或 `ctx.events`（跨插件通信），不直接 set 框架 store。

## 11 QA

**Q：sidePanel 和 sidebar 都是「面板」，为什么不共用一个槽？**

它们的内容控制权分界线位置不同。左栏的壳控制了行/组的固定结构，能统一风格切换；右面板的壳只控图标条+面板头+内容容器四块 chrome，内容区是插件自绘的草稿纸。硬塞一个槽会让壳要么变厚去覆盖右面板的内容多样性（违反薄壳），要么让左栏失去统一风格。两个槽各自独立 `hidden`、独立尺寸、独立偏好（`sidebarStyle`/`sidepanelStyle`），互不污染。

**Q：贡献项里的 `component` 名和插件 export 名不一致会怎样？**

`registerPluginComponents` 的 `asReactComponent(module[item.component])` 匹配不到就 `console.warn` 跳过，注册表里没有这个组件名；渲染时 `getSidePanelComponent` 返回 undefined，右面板渲染 i18n 回退文案「组件未注册」。首帧闪烁已由 `app-main.tsx` 的 `pluginsReady` 渲染闸门规避，但运行期不一致仍是回退兜底而非崩溃。

**Q：`revealOn` 触发的 channel 一定要是贡献方自己声明/拥有的吗？**

不强制。tap 只认 channel 字符串、不认权属——任何插件的 emit/invoke/emitSystem 只要 channel 命中映射就触发揭示。当前两个消费者恰好都是「自声明自触发」（sub-agent emit 自己的 `subagent:dialog`、session-bookmarks invoke 自己的 `bookmarks:addRequested`），但架构上允许第三方触发：只要触发方 emit/invoke 一个贡献方声明过 `revealOn` 的 channel 即可，双方经 `dependsOn` 声明生命周期护栏。

**Q：invoke 无订阅者时会丢吗？revealOn 怎么保证不丢？**

不丢。`eventBus.invoke`（`event-bus.ts` 第 134-152 行）在 `state.handlers.size === 0` 时把 payload 入 `pendingInvokes` 队列，首个订阅者 `on` 挂载时按序冲刷恰好一次投递。`revealOn` 的 tap 在 invoke 派发前同步触发 `activateSidePanelTab` 展开并激活 tab，tab 组件挂载后立即订阅，订阅动作冲刷队列——懒挂载组件因此可靠收到一次性命令，不靠 `replayLast`（那是 emit 的可回放语义，不适合一次性 invoke）。

**Q：`toggleSidePanelTab` 和 `activateSidePanelTab` 到底什么时候用哪个？**

用户点图标/点面板头用 `toggle`（已激活则收起，未激活则展开）；声明式揭示用 `activate`（幂等补入+展开，不做反向关闭）。区别只有一处：activate 永远 `setGroupHidden("right", false)`，toggle 在 tabs 清空时 `setGroupHidden("right", true)`。揭示语义要求「用户点收藏后右面板一定展开且目标 tab 一定可见」，所以用 activate 而非 toggle。

**Q：插件卸载/禁用后，之前激活的 tab 会残留吗？**

不会残留成孤儿 tab。`SidePanelStrip` 第 98-101 行的 prune effect 在清单刷新后（ready 守卫）调 `pruneSidePanelTabs(items.map(i => i.id))`，把已从槽清单消失的死 id 从 prefs 持久化的 `activeSidePanelTabs` 里剔除；同时 `onUnloaded` 已 `unregisterPluginComponents` 摘组件，`bumpPlugins` 让清单重拉。尚有余项时不折叠（Strip 兜底 effect 自动激活第一个），清单整体消失才折叠 right 组。

**Q：sidePanel 的 `component` 名为什么必须全局唯一，而其他槽可以按 pluginId 区分？**

因为 `sidePanelComponents` 注册表是 `Map<组件名, 组件>`，key 只有组件名字符串，`getSidePanelComponent(item.component)` 按名查；`pluginId` 只用于渲染时包 `PluginIdContext`，不参与组件解析 key。对比动态布局视图走 `getPluginComponent(pluginId, component)`（`plugin-modules.ts` 第 31-35 行）是「pluginId+组件名」双键。这是两类渲染的差异：sidePanel 是静态槽位自动匹配（单键），动态视图是布局树按 pluginId 查模块 exports（双键）。

**Q：右面板折叠后，里面的 tab 组件还活着吗？**

活着。`RightPanelContent` 渲染所有活跃 tab 的组件，非活跃用 CSS `display:none` 隐藏（`layout-engine.tsx` 的 `KeepAliveView` 对动态视图同理）；right 组折叠为 0 时 `react-resizable-panels` 的 `collapsedSize={0}` 不卸载子树。所以 `token-stats`/`session-tree` 的 store/事件订阅在折叠/切 tab 时不丢失，流式会话在折叠的右面板里照常运行。
