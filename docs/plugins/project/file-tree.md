# file-tree 插件技术文档

file-tree 是 my-harness-desktop 内置的项目域壳插件，物理位置 `src/plugins/project/file-tree/`。它做的一件事是：在右面板（sidePanel 槽）挂一个「文件」Tab，把当前项目目录画成 VSCode Explorer 式的可展开目录树，支持新建/重命名/剪切/复制/粘贴/删除/复制路径/在 Finder 中显示，点击文件用系统默认应用打开。它同时是两件机制性东西的供给者：往 `fileIcons` 槽贡献 36 条「扩展名/文件名 → 图标」映射规则（这是全仓默认文件图标的唯一来源），往 `languages` 槽贡献四个 locale 的文案。它自己又消费 `fileActions` 槽——把别的插件贡献的文件动作（盲审、预览）渲染进右键菜单末段，点击后把 invoke 路由回贡献者。

理解这个插件要先分清两层：**插件壳**极薄（`renderer/index.tsx` 只有 37 行，`plugin.json` 是纯声明），**真正干活的 `FileTree` 部件**早已收编进发布面 `packages/react/src/widgets/file-tree.tsx`（560 行）。文档会以这条「薄壳 + 厚部件」的分界为主线，先讲插件声明了什么、贡献了什么，再讲部件怎么消费数据、怎么和别的插件交互，最后落到 fs:project 权限圈禁和事件总线上。

## 1 plugin.json：声明即全部能力面

`plugin.json` 顶层字段（`packages/shared/src/domain/contributions.ts` 的 `PluginManifest` 镜像）：

- `id: "file-tree"`，`version: "0.4.9"`，`tier: "official"`（`PluginTier` 联合），`tags: ["project"]`。
- `renderer: "./renderer/index.tsx"`：唯一的代码入口，框架按它 import 模块、读 exports。
- `permissions: ["fs:project"]`：唯一声明能力。插件不声明 `git:read`/`git:write`，所以它碰不到任何 git 面；`openFile`/`revealPath` 走 Host 壳能力，不需要声明（见 §8）。

`contributes` 下挂了三个槽，这是插件全部的功能面：

- **`sidePanel`**：一条贡献项 `{ id: "files", label: "文件", icon: "folder-open", component: "FileTreeTab", order: 30 }`。`component` 字段与 `renderer/index.tsx` 里 `export function FileTreeTab` 同名——框架自动匹配，插件不调任何 register 函数（§4.3）。
- **`fileIcons`**：36 条规则（§3.2），是「文件图标」知识的单源。
- **`languages`**：8 条语言贡献项 = 4 个 locale（zh-CN/zh-TW/en/de）× 2 个命名空间（`file-tree.files` + `file-tree.plugin`）。

注意它**没有** `configFile`、没有 `settings` 槽、没有 `dependsOn`、没有 `revealOn`。这四条缺席各有含义：无 `configFile` 意味着框架不为它管 save/dirty/config 持久化（它没有可配置项，ignore 列表和 maxDepth 都是部件默认值，不是用户配置）；无 `dependsOn` 意味着它在事件总线上不订阅任何别的插件的 channel——它「消费」fileActions/fileIcons 走的是槽查询（IPC），不是事件订阅；无 `revealOn` 意味着没有任何 channel 触发时会自动展开「文件」Tab（§7.3 会解释这个缺席与 invokeFileAction 里另一个揭示机制的区别）。

## 2 目录与代码分布

```
src/plugins/project/file-tree/
  plugin.json              # 声明：sidePanel + fileIcons + languages + fs:project 权限
  renderer/
    index.tsx              # FileTreeTab（37 行）：读 currentCwd + 渲染 FileTree 部件
  locales/
    {zh-CN,zh-TW,en,de}/files.json    # files.* 文案（菜单/空态/删除确认）
    {zh-CN,zh-TW,en,de}/plugin.json   # plugin.file-tree.* 文案（displayName/description）
```

真正承载文件树逻辑的代码**不在插件目录里**，而在发布面：

- `packages/react/src/widgets/file-tree.tsx`：`FileTree` 部件（560 行），全部交互逻辑。
- `packages/react/src/widgets/file-tree.css`：对 react-complex-tree 默认样式的主题 token 映射（130 行）。
- `packages/react/src/file-actions.ts` / `file-icons.ts`：`fileActions`/`fileIcons` 槽的 renderer 侧查询与触发机制。
- `packages/react/src/widgets/context-menu.tsx`、`plugin-icon.tsx`、`empty-state.tsx`：共享右键菜单、图标词表、空态。
- `packages/shared/src/domain/contributions.ts`：`FileActionContribution` / `FileIconContribution` / `SidePanelContribution` 契约。
- `packages/shared/src/domain/file-icons.ts`：`buildFileIconIndex` / `resolveFileIcon` 纯函数。
- `packages/shared/src/domain/path-utils.ts`：`pathBasename`。
- `packages/shared/src/domain/sessions.ts`：`FsApi` / `FileTreeNode` / `ReadDirTreeOptions`。

这个分布本身就是「薄壳 + 内容外挂 + 机制收进框架」的一个活样本：树怎么画是**通用 UI 语义**（任何想显示目录树的地方都要），所以收进 `@my-harness-desktop/react`；file-tree 插件只贡献「哪个 Tab、什么图标规则、什么文案」这些**会变的内容**。

## 3 槽位贡献全景

### 3.1 sidePanel：右面板「文件」Tab

`SidePanelContribution` 契约（`contributions.ts:81-95`）钉的字段是 `{ id, label, icon, component, order?, revealOn? }`。file-tree 填了前五个，`revealOn` 缺席。`label` 是契约字段名（不是 `title`），`icon` 是 lucide 图标名 `"folder-open"`，经 `PluginIcon` 的 `ICONS` 词表（`packages/react/src/widgets/plugin-icon.tsx`）解析；`order: 30` 决定它在右面板图标条里的排序（`registry.sidePanelItems()` 按 order 升序，缺省 100）。

注册链：`PluginRegistry.registerOne`（`registry.ts:136-163`）遍历 `arraySlots` 把这条贡献项 push 进 `sidePanel` 的 `ArraySlot`，然后 `slots-dialog.ts:12` 的 `IPC.slots.sidePanel` handler 返回 `registry.sidePanelItems()`，前端 `right-panel.tsx` 的 `useSidePanelData()` 经 `window.kernel.slots.sidePanel()` 拉取。组件 `FileTreeTab` 由 `right-panel.tsx` Content 段经 `getSidePanelComponent(item.component)` 解析，外面包 `PluginIdContext.Provider value={item.pluginId}`，所以组件树里的 `usePluginId()` 返回 `"file-tree"`（§4.3）。

### 3.2 fileIcons：36 条图标映射规则

`FileIconContribution` 契约（`contributions.ts:328-341`）钉的字段：`id`（规则 id，插件内唯一）、`icon`（PluginIcon 词表名）、`extensions?`（扩展名清单，不带点、大小写不敏感）、`filenames?`（精确文件名清单，优先级高于扩展名）、`color?`（CSS 颜色值或 token var，不提供用主题默认）、`order?`（缺省 100）。

file-tree 贡献的 36 条规则分三类：

- **纯 `extensions` 规则（约 30 条）**：按语言/格式/用途分组。`ts` 规则覆盖 `["ts","tsx","mts","cts"]`（`icon: "file-code"`、`color: "#3178c6"`，TypeScript 蓝）；`js` 覆盖 `["js","jsx","mjs","cjs"]`（`#d8b53a`）；`py`/`rust`/`go`/`jvm`/`native`/`code-other` 各自一组。`json`（`file-json` 图标）、`notebook`（`ipynb`）、`config`（`yaml/yml/toml/ini/cfg/conf/env/properties/editorconfig`，`file-cog` 图标）、`style`（`css/scss/sass/less/styl`）、`web`（`html/htm/xml/xhtml`）、`markdown`、`diagram`（`puml/plantuml/iuml/mmd/mermaid`，`workflow` 图标）、`text`、`shell`（`sh/bash/zsh/fish/ps1/bat/cmd`，`file-terminal`）、`db`（`sql/sqlite/sqlite3/db`，`database`）、`api-schema`（`graphql/gql/proto`）、`image`/`video`/`audio`/`archive`/`pdf`/`office-doc`/`sheet`/`slides`/`binary`/`key`/`font`/`lock`（`file-lock`）。
- **纯 `filenames` 规则（6 条）**：`docker`（`dockerfile/containerfile/.dockerignore`）、`git-files`（`.gitignore/.gitattributes/.gitmodules/.gitkeep`）、`lockfiles`（`package-lock.json/yarn.lock/pnpm-lock.yaml/cargo.lock/gemfile.lock/composer.lock/poetry.lock/bun.lockb`）、`build-files`（`makefile/gnumakefile/cmakelists.txt/justfile`）、`docs-files`（`readme/readme.md/readme.txt/changelog/changelog.md/license/license.md/copying/notice/authors`）。这些走**精确文件名匹配**，优先级高于扩展名——所以 `yarn.lock` 命中 `lockfiles` 的 `file-lock`，而不会掉进 `lock` 扩展名规则（`["lock"]`）或 `js` 的裸名匹配之外。

关键点：这些 `color` 值是**内容**（会变的细节），它住在贡献插件的 manifest 里，不进圆心、不进壳。`buildFileIconIndex` 纯函数（`packages/shared/src/domain/file-icons.ts`）把它们摊平成两张 Map，消费方（FileTree 部件）只查表、不持有这些十六进制值。

### 3.3 languages：四语言 × 双命名空间

`LanguageContribution`（`contributions.ts:130-137`）每条是 `{ id, locale, resources }`。file-tree 用了两个命名空间：

- `file-tree.files`：`files.*` 文案，共 14 个 key（`files.openFolderFirst`、`newFile`、`newFolder`、`cut`、`copy`、`paste`、`copyPath`、`copyRelativePath`、`revealInFinder`、`rename`、`delete`、`deleteConfirm`）。这些是菜单和空态文案。
- `file-tree.plugin`：`plugin.file-tree.displayName` / `plugin.file-tree.description`，管理页显示的插件名与描述。

`resources` 是相对路径（`./locales/zh-CN/files.json`），i18n 合并器启动时读文件合并进 i18next resources，渲染时 `t("files.newFile")` 查。`labelKey` 字段在 manifest 里**只有 key、没有文案原文**——这是「token key 合规、token 值违规」纪律的直接体现：菜单文案不进 manifest，随 locale 切换。

## 4 渲染链路：FileTreeTab 与 FileTree 共享部件

### 4.1 FileTreeTab（插件侧薄壳）

`renderer/index.tsx` 全文只有 `FileTreeTab` 一个导出，37 行。逐行拆：

- `useUiStore((s) => s.currentCwd)`：从框架 UI store 读当前项目根（`src/web/stores/ui-store.ts:113`）。注意 `useUiStore` 是从 `@my-harness-desktop/react` 导入的——它是 `packages/react/src/index.ts:331` `export * from "../../../src/web/stores/ui-store"` 的 re-export。插件不直接 import `src/web`。
- `useState(0)` 维护 `refreshKey`：右上角刷新按钮 `onClick={() => setRefreshKey(k => k + 1)}` 自增，作为 `FileTree` 的 `refreshKey` prop。刷新语义是「重新调用 readDirTree」，不是轮询。
- `pathBasename(currentCwd)`：把项目根取末段显示在工具栏（`packages/shared/src/domain/path-utils.ts:13`，同时按 `/` 与 `\` 切分，跨 Windows 盘符路径）。
- 无 `currentCwd` 时渲染 `EmptyState`（`packages/react/src/widgets/empty-state.tsx`），文案 `t("files.openFolderFirst")`——这是 fail-closed 的 UI 侧表现：没激活项目根就显示空态，不渲染树。

`FileTreeTab` 没有声明 `isActive` prop，但 `right-panel.tsx:498` 仍传 `<Comp isActive={isActive} />`；React 把多余 prop 静默忽略，组件签名不写也不报错——它不消费右面板激活态（不需要「激活才拉数据」的优化）。

### 4.2 FileTree（收编进发布面的共享部件）

`FileTree` 的 props 契约（`file-tree.tsx:58-68`）：`cwd`（必填）、`ignore?`（忽略目录名集合）、`maxDepth?`（首屏递归限深）、`onOpenFile?`（文件点击回调）、`refreshKey?`（变化时重拉）。file-tree 插件只传 `cwd` 和 `refreshKey`，`ignore`/`maxDepth` 走部件默认（`DEFAULT_IGNORE = ["node_modules",".git","dist","out",".next","coverage","target"]`，`maxDepth ?? 4`）。

部件的职责边界（文件头注释钉的能力全景）：

- 数据源只有 `window.kernel.fs.readDirTree(pluginId, cwd, { maxDepth, ignore })`，不是 `listDir`。
- 右键菜单（`CtxMenu` 共享部件）：新建文件/文件夹、剪切/复制/粘贴、复制路径/相对路径、在 Finder 中显示、重命名、删除（内联二次确认）。
- 变更 IPC 走 `window.kernel.fs.*`，完成后重拉树——「IPC resolve 即事件」，不轮询不 sleep；展开态跨重拉保留。
- 深度懒加载（§6.1）。
- fileActions 槽消费：菜单末段渲染插件贡献的动作。
- fileIcons 槽消费：行图标按文件名/扩展名查槽解析，未命中回退通用文件图标。

部件**绕过 `usePluginContext()`**，直接读 `window.kernel.fs`（`build-kernel.ts` 构造的全局桥）和 `usePluginId()` 拿 pluginId——这是它作为「共享部件」而非「插件组件」的位置决定的（§10 QA 专门回答）。

### 4.3 pluginId 注入与组件自动匹配

两个框架自动机制在此交汇：

- **pluginId 注入**：`right-panel.tsx:497` 用 `PluginIdContext.Provider value={item.pluginId}` 包住 `FileTreeTab`，`FileTreeTab` → `FileTree` → `usePluginId()`（`plugin-id-context.ts:5`）整条链拿到 `"file-tree"`。插件代码里没有一个 `"file-tree"` 字面量。
- **组件自动匹配**：`plugins-host.ts:33` 的 `registerPluginComponents(mod, manifest.contributes ?? {})` 读 `contributes.sidePanel[].component === "FileTreeTab"`，在 module exports 里找同名导出，写进 `sidePanelComponents` Map；`right-panel.tsx:459` 的 `getSidePanelComponent("FileTreeTab")` 查回组件。这是 `packages/react/src/index.ts:510-530` 的 `registerPluginComponents` 实现，插件不手动注册。

## 5 数据层：fs:project 权限圈禁

file-tree 的一切文件操作都命中 `fs:project` 权限颗粒。这个颗粒的完整链路分三层，每一层职责钉死，任何一层都不得越界。

### 5.1 圆心契约

`packages/shared/src/domain/sessions.ts` 钉了两份中性类型：

- `FsApi`（`sessions.ts:401-419`）：9 个方法 `listDir/removePath/readDirTree/readFile/readFileBase64/createFile/createDir/renamePath/copyPath`。注释明确「命名无 Read 前缀：removePath/createFile 等写操作同域，读写合一」——fs:project 是一个读写合一的颗粒，不是 fs:read + fs:write 拆开。
- `FileTreeNode`（`sessions.ts:423-427`）：`{ name, isDir, children? }`。`children` 的语义是全文最关键的一个约定：**目录的 `children: undefined` = 未下钻（限深边界/读失败），空数组 = 已 walk 的空目录**。这个区分让消费方能识别「待展开懒加载」和「真空目录」，是懒加载机制（§6.1）的地基。
- `ReadDirTreeOptions`（`sessions.ts:430-435`）：`maxDepth?`（注释写「默认 3」）、`ignore?`（忽略目录名集合）。

`FsApi.readDirTree` 注释点破了「内容 vs 常量」的分界：「ignore/maxDepth 是内容（调用方定），不是内核常量——契约形状长期稳定，参数随调用方演进」。这就是为什么 `DEFAULT_IGNORE` 在 `file-tree.tsx:40`（部件侧）而不是在 `walkDirTree`（执行侧）或圆心——ignore 列表是会变的内容。

### 5.2 IPC 边界：权限门控 + 路径圈禁（fail-closed）

`src/server/controllers/fs-git.ts` 是 fs:project 的网关 handler。两个 helper 钉死安全语义：

- `assertPermission(pluginId, "fs:project")`（`fs-git.ts:17-18`）→ 转发到 `registry.assertPermission`（`registry.ts:413-418`）：未知插件抛「未知插件」、未声明权限抛「插件 X 未声明权限 fs:project」。file-tree 在 manifest 声明了，所以通过。
- `assertProjectPath(raw)`（`fs-git.ts:23-32`）：
  - 先 `sessionStore.getActiveCwd()` 取当前激活项目根，无则抛「fs:project 拒绝：无激活项目目录」——**fail-closed**，没有项目根就拒绝一切文件访问。
  - `resolve()` 展开相对路径（`~` 前缀展开到 `ctx.paths.homeDir`），再 `rootAbs + sep` 前缀检查：`abs !== rootAbs && !abs.startsWith(rootAbs + sep)` 抛「越界」。这是防 `..` 逃逸的前缀检查，注释标注「演进：若插件传符号链分子目录，可用 realpath 进一步加固（当前 baseline 前缀检查）」。

9 个 `IPC.fs.*` handler 全部先 `assertPermission` 再 `assertProjectPath`，无一例外（`fs-git.ts:35-84`）。`renamePath`/`copyPath` 是**双路径逐个圈禁**（`assertProjectPath(from)` 和 `assertProjectPath(to)`），不是只查 from——剪切/复制粘贴不能把文件搬到项目外。

### 5.3 执行层：三个 fs 文件的分工

`src/server/client/fs/` 三个文件是「纯执行函数，不做权限门控、不做路径圈禁（都在 IPC 边界做）」：

- `fs-tree.ts` 的 `walkDirTree(dir, opts, depth=0)`（`fs-tree.ts:21-61`）：递归 walk。`ignoreSet` 按名跳过目录（不回读子树，省 IO 屏蔽 node_modules）；`depth >= maxDepth` 时返回 `{ name, isDir: true }`（children 缺席，即 deferred）；`readdir` 失败返回 `{ name, isDir: true }`（同样 children 缺席）；单子目录失败不中断整树。**排序不在此做**——「目录在前字母序是渲染语义，由 widget 收敛」（`sortChildren`，`file-tree.tsx:71-79`）。
- `fs-ops.ts`：`readTextFile`（1MB 上限）、`readFileAsBase64`（25MB 上限）、`createEmptyFile`（`open(abs,"wx")` 已存在抛 EEXIST）、`createSingleDir`（`mkdir recursive:false`）、`renamePath`（先 `assertNotExists(to)` 挡 POSIX 静默覆盖）、`copyPath`（`fsp.cp` `force:false, errorOnExist:true`）。全文件统一「已存在即抛错」的拒绝语义，冲突交给调用方提示。
- `fs-sync.ts`：`removePath`（`rmSync recursive:true, force:true`，对不存在路径静默成功）和 `copyFileWithDir`。这是**同步**原语，注释说它服务 pi 会话存储层与通用删除。file-tree 的删除走的是它——`fs-git.ts:5` 从 fs-sync import `removePath`，`IPC.fs.removePath` handler（`fs-git.ts:51-55`）调 `removePath(abs)`。

注意一个分工细节：file-tree 的增删改查里，**删除是同步**（fs-sync.rmSync），**新建/重命名/复制是异步**（fs-ops 的 async 函数），**读树是异步**（fs-tree.walkDirTree）。这不影响 renderer 侧——`window.kernel.fs.*` 全是 IPC 桥（`build-kernel.ts:183-193`），对前端统一是 Promise，同步/异步差异被封在 server 端。

### 5.4 默认值与内容的归属

`walkDirTree` 的 `maxDepth` 兜底是 3（`fs-tree.ts:26`），`ReadDirTreeOptions` 注释也写「默认 3」；但 `FileTree` 部件显式传 `maxDepth ?? 4`（`file-tree.tsx:168`、`203`），`FileTreeProps` 注释写「默认 4」。所以 file-tree 插件实际生效的首屏限深是 **4**，不是 server 端的兜底 3。这不是 bug，是「执行侧保守兜底 + 调用方显式定内容」的正常分层：server 的 3 是对「没传参数」的兜底，file-tree 作为内容方把「浏览项目要下钻几层」定成 4。写新消费方时，想要别的深度就传 `maxDepth`，不要改 `walkDirTree` 的兜底。

## 6 文件树部件的内部机制

这一节拆 `FileTree` 部件（`packages/react/src/widgets/file-tree.tsx`）的关键机制。每个机制都对应一个根因修复，注释里写着「为什么之前的代码会触发、为什么现在不会」。

### 6.1 树的扁平化与 deferred 懒加载

react-complex-tree 的数据模型是「items 表 + index 引用」，不是嵌套树。`flattenChildren(node, path, items)`（`file-tree.tsx:85-111`）把 domain `FileTreeNode` 递归摊平成 `Record<TreeItemIndex, TreeItem>`，`items[childPath].children` 只存直接子项 index。摊平的同时做两件事：

- `sortChildren`（`file-tree.tsx:71-79`）：目录在前、各自 `localeCompare` 字母序。排序是渲染语义，收敛在部件，不在 server。
- `deferred` 标记（`file-tree.tsx:94`）：`child.isDir && child.children === undefined` 时给 RowData 打 `deferred: true`。这就是「限深边界/读失败」目录。

懒加载统一入口 `ensureChildren(dirPath)`（`file-tree.tsx:162-192`）：

- `inflightRef` 去重（防连点并发），失败保 deferred 标记（折叠再展开即重试），成功后 `delete data.deferred` 并把子树摊平进 items。
- 末尾**链式补拉**：`collectDeferredPaths` 收集新子树里仍 deferred 的深层目录，逐个判断「此刻是否展开着」（`expandedRef.current.includes(p)`），是则 `void ensureChildren(p)` 下钻。这段解决的是「刷新重建 items 后，深层已展开目录在新树里又变 deferred、展开态悬空」的时序问题。

`load()`（`file-tree.tsx:194-236`）是首屏/刷新的总入口：`readDirTree` 失败时 `setItems({})/setRoots([])/setExpandedItems([])` 清空三态——注释点破「fs:project 是 fail-closed 的，拒绝语义 = 空树，不能放任 unhandled rejection，也不残留上一棵树的陈旧条目」。切项目时 `setExpandedItems(prev => prev.filter(i => i.startsWith(cwd + "/")))` 清掉不归属当前 cwd 的展开 id；刷新同 cwd 时 id 不变，展开态自然保留。

### 6.2 展开态全控（viewState）

`ControlledTreeEnvironment` 是**全控组件**：`viewState` 是唯一数据源，`onExpand/onCollapse` 只是通知，库不反哺 viewState（`file-tree.tsx:370-380` 注释）。部件因此自持 `expandedItems` state，`viewState = useMemo(() => ({ [TREE_ID]: { expandedItems } }), [expandedItems])`（`file-tree.tsx:380`）。注释明确标注了根因：「之前传 `viewState={{}}` + 空 handler 等于永远折叠，树点不开」——`env.expandItem` 只转发回调不改状态，常量 viewState 让点击零反馈。

配套的 `expandedRef`（`file-tree.tsx:154-158`）是 `expandedItems` 的 ref 镜像：`ensureChildren`/`load` 是「不把 expandedItems 列进依赖」的闭包，链式补拉要读「此刻哪些目录展开着」只能经 ref 取。注释解释了为什么不能把 expandedItems 列进依赖——那会让每次展开都整树重拉，事件驱动退化成拉取式。

### 6.3 变更统一入口 runMutation

所有写操作（新建/重命名/删除/粘贴）收敛到 `runMutation(fn, expandPath?)`（`file-tree.tsx:243-255`）：先 `setErrorMsg(null)` 清错误，`await fn()` 执行 IPC，失败 `setErrorMsg(message)` 上浮错误条并 return，成功后若有 `expandPath` 则把它加进展开集，最后 `await load()` 重拉。这个收敛让「冲突/越权」两类失败走同一条反馈路径（错误条），不在每个菜单项里各写一遍 try/catch。

### 6.4 新建 = 临时节点 + 程序化 rename

新建文件/文件夹没有手滚 input，而是「插临时节点 + 程序化 rename」：

- `startNewEntry(parentPath, kind)`（`file-tree.tsx:258-274`）：插入 `tempIndex = ${parentPath}/.__new__` 的 `TreeItem`（`data.temp: "file"|"dir"`），展开父目录，`treeRef.current?.startRenamingItem(tempIndex)` 进入库自带的 rename 态。
- `onRenameItem`（`file-tree.tsx:289-306`）：`data.temp` 存在时是「新建确认」分支——`removeTempEntry` 清临时节点，校验名字（非空、不含 `/`、非 `.`/`..`），调 `createDir`/`createFile`；否则是「真重命名」分支，调 `renamePath`。
- `onAbortRenamingItem`（`file-tree.tsx:308-311`）：abort 时若 `data.temp` 清临时节点。

这是「手写收敛到成熟包」的落点：F2/startRenamingItem/onRenameItem/onAbortRenamingItem 全用库自带 rename，不自己滚 input。

### 6.5 剪贴板与删除二次确认

- 剪贴板是**部件内部 state**（`clipboard: { op: "cut"|"copy"; path; isDir } | null`，`file-tree.tsx:145`），不走系统剪贴板。cut 源行半透明显示（`isCutSource ? { opacity: 0.5 }`，VSCode 同款）。`paste(targetDir)`（`file-tree.tsx:322-334`）里 cut 是一次性消费（先清剪贴板再落 IPC，失败也不重复粘贴），`dest === clipboard.path` 时早退防自粘贴。冲突（目标已存在）由 server 端 `assertNotExists` 拒绝，上浮错误条——「paste 冲突由内核拒绝」。
- 删除是**行内二次确认**（`renderItemTitle` 里 `confirmDeletePath` 分支，`file-tree.tsx:521-534`），不弹窗，`confirmDelete`（`file-tree.tsx:314-320`）清确认态、若剪贴板指向该路径则同时清剪贴板、`runMutation(removePath)`。

### 6.6 键盘快捷键

`onKeyDown`（`file-tree.tsx:336-361`）挂在 `.ft-host`：`INPUT` 标签内不拦截（rename input 里 Delete/Cmd 是编辑语义）；`Delete` 删除（根目录 `data.path !== cwd` 守卫）；`Cmd/Ctrl + C/X/V` 走复制/剪切/粘贴（`X` 也守根目录）。快捷键收敛在部件，文件树的键盘语义是「通用 UI 语义」，不是某个插件的私货。

### 6.7 错误条

`errorMsg` state 渲染成 `.ft-error`（`file-tree.css:83-98`），token 化 danger 色，含关闭按钮。所有失败路径（`ensureChildren` catch、`runMutation` catch）统一 `setErrorMsg`。这是「拒绝语义显式化」——越权/冲突不静默、不伪造成功。

## 7 与其他插件交互（专节）

这一节是全文核心：file-tree 与别的插件怎么解耦协作。三层关系：**贡献**（它给别人）、**消费**（别人给它）、**触发**（它代表用户调别人）。

### 7.1 fileActions 菜单消费（三段式机制）

file-tree 是 `fileActions` 槽的**消费方**。机制是 `contributions.ts:149-164` 钉的三段式，`packages/react/src/file-actions.ts` 实现：

- **① 声明（贡献者）**：别的插件在 `plugin.json` 写 `contributes.fileActions`。当前两个贡献者：
  - `blind-review`（`src/plugins/insight/blind-review/plugin.json:15-24`）：`{ id: "blindReviewFile", labelKey: "review.fileAction", icon: "eye-off", when: { target: "file" } }`。
  - `file-preview`（`src/plugins/project/file-preview/plugin.json:15-24`）：`{ id: "previewFile", labelKey: "preview.fileAction", icon: "eye", when: { target: "file" } }`。
- **② 消费（file-tree）**：`FileTree` 部件调 `useFileActions()`（`file-actions.ts:32-46`）查槽，得到 `FileActionItem[]`（`FileActionContribution & { pluginId }`）。查询走 `window.kernel.slots.fileActions()` IPC（`slots-dialog.ts:16` → `registry.fileActionItems()`），以 `pluginsNonce` 失效重拉（同 nonce 单发缓存）。
- **③ 触发**：菜单末段渲染 `contributed` 动作（`file-tree.tsx:506-515`），点击调 `invokeFileAction(pluginId, a, { path, isDir, cwd })`。

`when.target` 过滤（`file-tree.tsx:455-458`）：`const target = a.when?.target ?? "both"`，目录行保留 `target !== "file"` 的动作（即 dir/both），文件行保留 `target !== "dir"` 的动作（即 file/both）。所以盲审/预览（`when.target: "file"`）只出现在文件行，不出现在目录行。

`invokeFileAction`（`file-actions.ts:60-68`）做两件事：先 `revealPluginSidePanel(action.pluginId)` 浮出贡献者 UI（见 §7.3），再 `eventBus.invoke(callerId, fileActionInvokeChannel(action.pluginId), payload)`。`fileActionInvokeChannel(pluginId)`（`file-actions.ts:18-20`）返回约定频道 `"${pluginId}:fileActionInvoke"`——所以点「盲审文件」实际 invoke 的是 `"blind-review:fileActionInvoke"`，点「预览」invoke 的是 `"file-preview:fileActionInvoke"`。

`FileActionInvokePayload`（`file-actions.ts:22-27`）是 `{ actionId, path, isDir, cwd }`——`actionId` 是贡献声明的 `id` 原样回传，贡献者据此知道「哪个动作被点了」；`path`/`isDir`/`cwd` 是文件上下文。贡献者侧订阅自己的频道（如 `blind-review/renderer/index.tsx:29` `export const channels = ["blind-review:fileActionInvoke"]`、`397` 处 `ctx.events.on(...)`），收到 payload 后自己画自己的 UI。

**双向解耦的关键**：file-tree 不认识 blind-review/file-preview（动作清单来自注册表），贡献者不认识 file-tree（只收 invoke）。file-tree 的代码里没有 `"blind-review"` 字面量——它拿到的 `action.pluginId` 是运行时从槽清单来的，invoke 频道名由 `fileActionInvokeChannel(action.pluginId)` 动态拼接。这就是「消费而非翻译」+「零硬编码」的落地。

### 7.2 fileIcons 的贡献与消费双重身份

file-tree 在 `fileIcons` 槽上是**既贡献又消费**的双重身份：

- **贡献**：36 条规则进 `registry.fileIconItems()`（`registry.ts:286-291`），按 order 升序（file-tree 全缺省 100，保注册序）。
- **消费**：`FileTree` 部件调 `useFileIconIndex()`（`file-icons.ts:35-38`）= `useFileIcons()` + `useMemo(buildFileIconIndex)`，然后 `renderItemTitle` 里 `resolveFileIcon(fileIconIndex, data.name)`（`file-tree.tsx:543`）逐行解析。

解析链（`packages/shared/src/domain/file-icons.ts`）：

- `buildFileIconIndex(contributions)`（`file-icons.ts:16-24`）：把清单摊平成 `byName`（精确文件名，小写）和 `byExt`（扩展名，小写不带点）两张 Map，**后出现的贡献项在同一 key 上覆盖先出现者**。注册序 builtin → installed → user → project，所以高优先级 source 自然胜出。
- `resolveFileIcon(index, name)`（`file-icons.ts:27-35`）：文件名精确匹配优先；其次扩展名（`dot <= 0` 时不取——点开头文件如 `.gitignore` 整体是文件名，不算有扩展名）；都未命中返回 `null`。

命中后 `resolvePluginIcon(hit.icon)` 查 lucide 词表（`plugin-icon.tsx:86-88`），未知名回退 `null` → 部件用 `FileIcon` 兜底（`file-tree.tsx:544` 的 `?? FileIcon`）；`hit.color` 存在则 `style={{ color: hit.color }}`，无则继承主题。

**自己会覆盖自己吗？** 不会，且顺序是刻意的。`lockfiles` 规则（filenames 匹配 `package-lock.json/yarn.lock/...`）在 manifest 里排在 `json`（extensions）和 `lock`（extensions）之后，`buildFileIconIndex` 后写覆盖先写，所以 `yarn.lock` 先命中 `lockfiles` 的 `byName` 精确匹配（filename 优先于 ext，见 `resolveFileIcon` 先查 `byName`），根本走不到 ext 覆盖这层。而 `docker`/`git-files`/`build-files`/`docs-files` 这些 filenames 规则同理。这条「filename 优先于 extension」的优先级写死在 `resolveFileIcon` 纯函数里，不靠 manifest 顺序凑巧。

**第三方覆盖**：`FileIconContribution` 注释（`contributions.ts:324-327`）钉了两层覆盖语义——同 `contribution.id` = 整规则替换（`ArraySlot.removeById`，`registry.ts:66-68`）；不同 id = 消费侧按 key 合并，后注册者（高优先级 source）在同 key 胜出。所以第三方插件想改一个扩展名的图标，只需贡献一条 `{ id: 自己的id, extensions: ["ts"], icon: ..., color: ... }`，不必整批重声明 36 条——这正是「内容外挂 + 无特权差异」的检验方式：把 file-tree 复制到 user/project 目录，以更高 source 覆盖内置版。

### 7.3 revealOn 揭示与 fileAction 揭示（两个机制）

「揭示」（让某个右面板 Tab 展开并激活）在系统里有两个**不同**的机制，都跟 file-tree 有关，容易混：

**机制一：`revealOn` 声明式揭示。** `SidePanelContribution.revealOn?`（`contributions.ts:91-94`）——一个贡献项声明「当 channel X 被 emit/invoke 时，框架展开右面板并激活**本** Tab」。实现链：

- `registry.sidePanelItems()`（`registry.ts:220-233`）把 `revealOn` 透传到前端清单。
- `right-panel.tsx:120-130` 的 effect：把 `items` 里所有 `revealOn` 聚成 `byChannel: Map<channel, tabId>`，`eventBus.tap(channel => { if (byChannel.get(channel)) activateSidePanelTab(tabId) })`。
- `eventBus.tap`（`event-bus.ts:40-43`）是框架内部侦听，任何 emit/invoke/emitSystem 派发前同步触发，只观察不阻断。
- `activateSidePanelTab`（`ui-store.ts:397-403`）是幂等 reveal：tab 不在活跃集则补入，`setGroupHidden("right", false)` 展开右面板——与 `toggleSidePanelTab` 的区别是「不做反向关闭」。

现在声明 `revealOn` 的贡献者是 `sub-agent`（`revealOn: "subagent:dialog"`）和 `session-bookmarks`（`revealOn: "bookmarks:addRequested"`）——它们揭示的是**自己的** Tab。**file-tree 的 sidePanel 贡献没有 `revealOn`**，所以没有任何 channel 会自动把「文件」Tab 揭出来。这不是能力缺口，是「文件 Tab 没有『被某事件叫醒』的语义」——用户想看文件树就点图标，没有哪个别的插件需要「一键跳到文件树」。

**机制二：`invokeFileAction` 里的命令式揭示。** 这是 file-tree **作为触发方**用的另一个揭示——`revealPluginSidePanel(pluginId)`（`file-actions.ts:49-57`）：

- 点文件动作时，先 `window.kernel.slots.sidePanel()` 查全部 sidePanel 贡献，找 `item.pluginId === action.pluginId` 的那条（即贡献者的 Tab），`toggleSidePanelTab(item.id)` 把它激活。
- 目的：**先浮出贡献者 UI 触发挂载 → 组件挂载后订阅自己的频道 → 再把 invoke 路由过去**。这是「懒挂载组件可靠投递」的前置步骤——如果贡献者 Tab 没挂载，它的 `ctx.events.on("blind-review:fileActionInvoke")` 还没执行，invoke 只能进 `pendingInvokes` 队列等首个订阅者（`event-bus.ts:143-147`）。先 reveal 让它挂载，invoke 就能立即投递。

两个机制的本质区别：`revealOn` 是**声明式、事件驱动、揭示自己**（贡献者声明「我的 Tab 响应哪个 channel」），`invokeFileAction` 的 reveal 是**命令式、动作驱动、揭示别人**（消费方点名「把贡献者的 Tab 浮出来」）。前者契约在 manifest，后者逻辑在 `file-actions.ts` 的共享函数里。两者都幂等（`activateSidePanelTab` 与 `toggleSidePanelTab` 的 includes 判断）。

### 7.4 事件总线与 channel 全景（emit/invoke）

先把结论钉死：**file-tree 插件自己不 emit 任何 channel，也不 export `channels`，更不订阅任何 channel**（`renderer/index.tsx` 无 `export const channels`，无 `ctx.events.*` 调用）。它唯一触碰事件总线的动作，发生在共享部件 `FileTree` 里：`invokeFileAction` → `eventBus.invoke(callerId, "<贡献者>:fileActionInvoke", payload)`。

`eventBus.invoke`（`event-bus.ts:134-152`）是定向分派原语，与 pub/sub 的 `emit` 区分：

- channel 必须属于某个已加载插件（`channels.get(channel)` 不存在则抛「未被任何已加载插件注册」）；`callerId` 是 file-tree 的 pluginId `"file-tree"`（`file-tree.tsx:511` 传的 `pluginId` = `usePluginId()`）。
- 无订阅者时入 `pendingInvokes` 队列，首个订阅者 attach 时**恰好一次**冲刷（`event-bus.ts:184-191`），不做 replayLast 重放——invoke 是一次性命令，不是可回放状态。

所以 file-tree 的 channel 全景是：

- **emit：无。**
- **invoke：动态的 `"${pluginId}:fileActionInvoke"`**，当前会命中 `blind-review:fileActionInvoke` 和 `file-preview:fileActionInvoke`（若第三方插件也贡献 fileActions，则还有 `<thirdparty>:fileActionInvoke`）。
- **间接被侦听**：`right-panel.tsx` 的 `eventBus.tap` 会看到这次 invoke，但 `byChannel` 里没有 file-tree 相关项（file-tree 无 revealOn），所以 tap 是 no-op——它只对 sub-agent/bookmarks 的 revealOn channel 有反应。

这就是为什么 file-tree 的 `plugin.json` **不需要 `dependsOn`**：`dependsOn` 是「消费别人 channel 的生命周期护栏」，file-tree 消费 fileActions/fileIcons 走的是**槽查询 IPC**（`window.kernel.slots.*`），不是事件订阅，不涉及时序。它 invoke 的是约定频道，`eventBus.invoke` 的 `pendingInvokes` 队列已兜住「贡献者还没挂载」的时序。

### 7.5 与相邻插件的关系拓扑

把 file-tree 放进 project 域和相邻域的坐标系：

- **file-tree → blind-review / file-preview**：消费它们的 `fileActions` 贡献，invoke 它们的 `fileActionInvoke` 频道。file-tree 是菜单宿主，它们是动作提供者。
- **file-tree → file-preview 的 titlebar**：无直接关系。file-preview 还贡献 `titlebar` 槽（`preview-opener`），与 file-tree 无交互。
- **file-tree → 全部插件**：贡献 `fileIcons` 36 条规则，是全仓默认文件图标的知识源。任何「渲染文件图标」的消费方（file-preview 的文件预览、blind-review 的项目树序列化等）都从这 36 条 + 第三方覆盖里查。`blind-review/core/assemble.ts` import `FileTreeNode` 序列化项目树（`serializeTree`），但它读的是 `readDirTree` 返回的中性 `FileTreeNode`，与 file-tree 插件本身无耦合——它复用的是 `FsApi` 契约，不是 file-tree 的组件。
- **file-tree ← 用户手势**：`openFile`（`window.kernel.openFile`，`build-kernel.ts:292` → `IPC.misc.openFile` → `conn.host.shell.openPath`）和 `revealPath`（`IPC.misc.revealPath` → `conn.host.shell.revealPath`，Electron 是 `shell.showItemInFolder`，`electron-host.ts:166`）走 Host 壳能力，不是 fs:project，也不是插件间 channel。
- **file-tree ← 框架**：`currentCwd` 来自 `useUiStore`（框架 store），`pluginsNonce` 驱动槽清单重拉（插件启停时 `bumpPlugins`）。file-tree 只**读** store，不调 setter——符合「共享 store 只读」纪律。

一句话拓扑：file-tree 是「文件相关能力的**宿主层**」——它提供图标知识（fileIcons）、提供目录浏览 UI（sidePanel），并作为菜单宿主把「对文件做点什么」的动作（fileActions）以 invoke 形式路由给动作提供者。它自己不发任何事件，是典型的「消费侧宿主」，不是「数据源」。

## 8 权限与安全

file-tree 的权限面收敛到一个颗粒：`fs:project`（`plugin.json:11-13`）。安全语义的完整闭环：

- **声明**：`PluginManifest.permissions` 含 `"fs:project"`。
- **门控**：`registry.assertPermission`（`registry.ts:413-418`）在 `fs-git.ts` 每个 handler 首行调用，未知插件/未声明权限抛错。
- **圈禁**：`assertProjectPath`（`fs-git.ts:23-32`）把路径锁死在 `sessionStore.getActiveCwd()` 内，`resolve` + 前缀检查防 `..` 逃逸，`~` 展开到 homeDir。
- **fail-closed**：无激活项目根 → 抛「无激活项目目录」→ renderer 侧 `load()` catch → 空树 + 空态（`FileTreeTab` 的 `!currentCwd` 分支 + `FileTree.load` 的清空三态）。越界 → 抛「越界」→ `runMutation` catch → 错误条。

两条被刻意挡住的越界路径：

- **`renamePath`/`copyPath` 双路径圈禁**（`fs-git.ts:77-84`）：`from` 和 `to` 各自 `assertProjectPath`，剪切/复制不能把文件搬出项目。
- **符号链接**：注释标注「演进：若插件传符号链分子目录，可用 realpath 进一步加固（当前 baseline 前缀检查）」——当前是前缀检查，symlink 指向项目外可逃逸，这是已知演进项，不是静默漏洞（代码里显式标注了）。

`openFile`/`revealPath` **不在 fs:project 里**：它们是 `IPC.misc.*`（`channel-contract.ts:99-102`），Host 壳能力，不声明权限、任何插件可调。但注意 `revealPath` 在 `node-host.ts:46` 是 `unsupported`（服务器宿主无 Electron），远程/服务器形态下降级。

## 9 主题与样式

`file-tree.css`（`packages/react/src/widgets/file-tree.css`）是「主题 token 映射层」，不是「配色文件」——它不写死任何颜色十六进制，全部消费主题 token：

- 加载顺序：`file-tree.tsx:27-29` 先 import 库的 `react-complex-tree/lib/style-modern.css`，再 import 本文件——同特异性下后加载者覆盖变量定义，无需 `!important`（`file-tree.css:13-14` 注释）。
- 为什么需要：库的 style-modern.css 把 hover/selected 写死 `#f0f2f5`(light)/`#373737`(dark)，按 `prefers-color-scheme` 二选一，与本项目 8 套主题 token 脱钩——暗主题下 hover 亮白、亮主题下选中死黑。
- 映射策略：背景 = 前景色稀释（`color-mix(in srgb, var(--color-fg) 7%, transparent)`），亮主题自动浅灰、暗主题自动提亮；文字 `inherit`（= `--color-fg`）天然反向，不需要主题各填两套色（`file-tree.css:8-12`）。
- 行气质收敛：`--rct-item-height: 24px`、图标 14px、`gap: 5px`、名称省略号，与侧栏行（`--sidebar-row-*`）同气质。

这印证了「token key 合规、token 值违规」：CSS 里出现的是 `var(--color-fg)`、`var(--color-primary)`、`var(--radius-sm)` 这些 key，值是主题插件贡献的，file-tree 一个十六进制都不持有（除了 manifest 里 fileIcons 的 `color`，那些是**文件图标的知识**，属于内容、属于 file-tree 的领域）。

## 10 QA

**Q1：为什么 file-tree 插件的 renderer 这么薄，逻辑全在 @my-harness-desktop/react 里？**

因为「目录树」是通用 UI 语义，不是 file-tree 的私货。`FileTree` 部件的注释写明了收编动机：「从 shell/renderer/components/file-tree.tsx 收编为共享部件，插件(file-tree)和壳都可能用，收进 @my-harness-desktop/react 避免各写一份」。任何想显示目录树的地方（file-preview、blind-review 的项目树、未来的其它面板）都能 import `FileTree` 而不复制逻辑。file-tree 插件只贡献「哪个 Tab、什么图标规则、什么文案」这些会变的内容。薄壳是刻意的：机制在发布面，内容在插件。

**Q2：file-tree 同时贡献又消费 fileIcons，会不会自己覆盖自己？**

不会，而且顺序是刻意设计的。`buildFileIconIndex` 按清单顺序构建、后写覆盖先写；`resolveFileIcon` 先查 `byName`（文件名精确匹配）再查 `byExt`（扩展名）。manifest 里 `lockfiles`/`docker`/`git-files` 等 filenames 规则排在 `json`/`lock` 等 extensions 规则之后，但 `yarn.lock`、`.gitignore`、`package-lock.json` 这类名字走 `byName` 精确匹配，优先级天然高于扩展名，根本不发生「ext 规则覆盖」的冲突。filename 优先于 extension 的优先级是写死在 `resolveFileIcon` 纯函数里的，不是靠 manifest 顺序凑巧。

**Q3：为什么 FileTree 部件绕过 usePluginContext 直接读 window.kernel.fs？**

因为它不是「插件组件」，是「发布面共享部件」。`usePluginContext()` 的 `fs` 子对象（`plugin-context.ts:114-124`）本质也是 `window.kernel.fs.*(pluginId, ...)` 的薄封装，pluginId 从 `usePluginId()` 注入。`FileTree` 直接 `usePluginId()` + `window.kernel.fs.readDirTree`，效果一样，但少一层 memo 封装，且它要同时服务「壳自己渲染文件树」的场景（那时没有 PluginContext 约束）。代价是它不经过 `usePluginContext` 的受控面，但 fs:project 的权限门控在 server 端 IPC 边界强制，绕不绕 `usePluginContext` 都逃不过 `assertPermission`。

**Q4：fs:project 的路径圈禁是前缀检查，符号链接能逃逸吗？**

能，且代码里显式标注了这是已知演进项。`assertProjectPath`（`fs-git.ts:23-32`）用的是 `resolve` + `rootAbs + sep` 前缀检查，防 `..` 逃逸，但不解析 symlink——如果项目内有个 symlink 指向项目外的目录，前缀检查会通过（路径字符串确实在项目内）。注释写「演进：若插件传符号链分子目录，可用 realpath 进一步加固（当前 baseline 前缀检查）」。这不是静默漏洞，是「显式标注的演进缺口」，符合「已知缺口显式标注演进，不藏」的纪律。

**Q5：为什么 walkDirTree 兜底限深 3，FileTree 部件却传 4？**

两者是不同层的职责。`walkDirTree`（`fs-tree.ts:26`）的 `maxDepth ?? 3` 和 `ReadDirTreeOptions` 注释的「默认 3」是**执行侧对『没传参数』的保守兜底**；`FileTree`（`file-tree.tsx:168,203`）的 `maxDepth ?? 4` 是**内容侧对『浏览项目要下钻几层』的显式决定**。file-tree 作为内容方把首屏深度定成 4（比 server 兜底多一层，token-stats 等 depth≥4 的目录能看到）。新消费方想要别的深度就传 `maxDepth`，别去改 server 兜底——那是「内容 vs 常量」的分界。

**Q6：file-tree 的 sidePanel 贡献为什么不声明 revealOn？**

因为 revealOn 的语义是「当 channel X 被 emit/invoke 时，框架展开右面板并激活**本** Tab」（`contributions.ts:91-94`）。file-tree 的「文件」Tab 没有「被某个事件叫醒」的场景——用户想看文件树就点右面板图标，没有别的插件需要「一键跳到文件树」。反观 sub-agent（`revealOn: "subagent:dialog"`）和 session-bookmarks（`revealOn: "bookmarks:addRequested"`）有这种语义（别的插件 emit 一个请求，把它们的对话/收藏 Tab 揭出来）。file-tree 参与的是另一个揭示机制——`invokeFileAction` 里的 `revealPluginSidePanel`，那个揭示的是**贡献者**的 Tab，不是它自己。

**Q7：file-tree 的删除是同步还是异步？**

删除是同步，其它写操作是异步，但这个差异被封在 server 端。`IPC.fs.removePath` handler（`fs-git.ts:51-55`）调的是 `fs-sync.ts` 的 `removePath`（`rmSync recursive:true, force:true`，同步）；`createFile`/`createDir`/`renamePath`/`copyPath` 调的是 `fs-ops.ts` 的 async 函数。`fs-sync.ts` 注释说明同步是刻意取舍：它同时服务 pi 会话存储层（会话文件大、写链路上锁原语需要同步语义）。renderer 侧无感——`window.kernel.fs.*` 全是 IPC 桥（`build-kernel.ts:183-193`），统一返回 Promise。

**Q8：第三方插件想给某个扩展名换图标，必须整批重声明 36 条吗？**

不必。`FileIconContribution` 钉了两层覆盖语义（`contributions.ts:324-327`）：同 `contribution.id` = 整规则替换（`ArraySlot.removeById`，`registry.ts:66-68`）；不同 id = 消费侧按 key 合并，后注册者（高优先级 source）在同 key 胜出。第三方贡献一条 `{ id: "my-ts", extensions: ["ts"], icon: "file-code", color: "#ff0000" }`，`buildFileIconIndex` 里它的 `byExt["ts"]` 会覆盖 file-tree 的 `ts` 规则（注册序 builtin → installed → user → project，后注册者胜），其它 35 条不受影响。这正是「无特权差异」的检验方式：复制 file-tree 到 user/project 目录，以更高 source 覆盖内置版。
