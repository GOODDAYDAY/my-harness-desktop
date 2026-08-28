# git-review

git-review 是挂在右面板 `sidePanel` 槽上的 Git 改动审查插件，回答三个递进的问题：**这一轮 agent 改了哪些文件**、**这个对话累计改了哪些文件**、**工作区现在的完整 diff 是什么**，并在最后一个视角上补一个最小提交出口——勾选文件、手写或 AI 生成 commit message、commit、push，全程不切终端。

定位由用户拍板，先于一切实现：**只读审查为主，写口只开 commit + push**。这条定位直接划掉了整片不做清单：不做 stage/unstage 独立管理（勾选即隐式 add，不引入 index 状态机）、不做分支切换/新建/删除、不做 stash、不做历史图、不做 cherry-pick / merge 冲突编辑器 / PR 管理、不做 git-flow 工作流、不做 hunk 级 accept/reject、不做 checkpoint/rewind。完整取舍与主流工具对照见 `docs/design/git-review-turn-diff-commit.md`。

一个语义边界必须从一开始就讲清，因为它决定了"本轮/本对话"两个页签的真实含义：git-review 展示的 diff 是**"该轮触碰的文件的当前工作区 diff"**，不是"该轮的改动"。文件若在会话开始前已脏，`git diff HEAD` 会把会话前改动一并显示；agent 用 bash（`rm`/`mv`/`cp`/重定向）改的文件追踪不到——toolCall 的 `args` 里没有可靠路径。这两条边界没有藏起来，而是如实写在轮次页签页脚（`locales/*/review.json` 的 `review.turnDiffNote`），并逐条落到实现里。

## 1 目录与 manifest 全貌

插件目录只有两个实体：一个 manifest、一个渲染器文件、一个 locales 目录。

```
src/plugins/project/git-review/
  plugin.json            # 声明：槽位贡献 + 三个权限 + 三命名空间四语言
  renderer/index.tsx     # 704 行，全部 UI 与轮次推导逻辑
  locales/
    zh-CN/ zh-TW/ en/ de/   # 每个 locale 三个命名空间：system.json / review.json / plugin.json
```

`plugin.json` 的关键字段逐一落位：

- `id: "git-review"`，`version: "0.4.9"`，`tier: "official"`，`renderer: "./renderer/index.tsx"`。
- `permissions: ["git:read", "git:write", "llm:oneshot"]`——三个声明能力，分别对应三个数据/动作通道，缺任何一个都会在 IPC 边界被 `registry.assertPermission` 拒绝（§4）。
- `contributes.sidePanel` 只贡献一项：`{ id: "review", label: "Review", icon: "git-compare", component: "GitReviewTab", order: 10 }`。注意它**没有声明 `revealOn`**——这是本插件与其他 sidePanel 插件（sub-agent、session-bookmarks）的关键差异，专节讲（§6.2）。
- `contributes.languages` 贡献三个命名空间 × 四个 locale 共 12 份字典：`git-review.system`（子页签名）、`git-review.review`（全部交互文案与 prompt 模板）、`git-review.plugin`（插件名与描述）。命名空间由贡献项的 `id` 字段声明，资源指向相对路径的 JSON。

manifest 没有 `main` 字段、没有 `configFile`、没有 `dependsOn`、没有 `piExtension`/`dshExtension`——它是一个纯 renderer 形态的壳插件，只 import `@my-harness-desktop/shared` 和 `@my-harness-desktop/react`，不携带任何内核扩展（§9 说明为什么它不需要）。

## 2 它消费的圆心契约

git-review 的 renderer 只 import 两个包。这两个包里它实际用到的每一个类型、每一个纯函数，都有唯一来源——圆心 `packages/shared/src/domain/`。契约单源（§1.3 纪律）意味着这些概念不是插件自己定义的"本地版"，插件只做 re-export 之后的 import。

### 2.1 类型：git 与消息的中性形状

- `GitChangedFile`（`packages/shared/src/domain/sessions.ts:438`）：`{ path, index, worktree }` 三个字段。`index` 是 staged 区状态码，`worktree` 是工作区状态码——simple-git 的 `status()` 原生就有这两个字段，历史上曾把它们压成一个字母丢掉了 staged 信息，本轮演进改回双码（有意破坏性变更，全仓唯一消费者就是本插件，同步改，不留兼容层）。未跟踪文件两码皆 `"?"`。
- `GitStatusResult`（`sessions.ts:445`）：`{ isRepo, branch, ahead, behind, files }`。分支名、ahead/behind 随 status 一并返回，零额外调用。
- `GitLogEntry`（`sessions.ts:454`）：`{ hash, message, author, timestamp }`，commit 后确认落点的只读数据。
- `NeutralMessage`：从 `@my-harness-desktop/react` 透传的会话消息中性形状，`content` 是内容块数组或字符串。
- `ToolCallBlock`（`packages/shared/src/domain/events/session-state.ts:361`）：`{ id?, name, args?, state?, result?, isError? }`，中性工具调用块。

### 2.2 纯函数：轮次推导的两块地基

- `toolCallsOf(content)`（`session-state.ts:372`）：从消息 `content` 数组提取所有 `type === "toolCall"` 的块，字段名 `name`/`args` 只有这一份解析。这是 git-review 轮次追踪和 timeline 工具卡渲染的**共同唯一实现**——timeline 曾在本地各写一份，已收敛到圆心。插件不再手写 `Array.isArray(content) && content.filter(...)` 这套解析。
- `messageContentText(content)`（`packages/shared/src/domain/text.ts:36`）：从内容块拼接纯文本，`deriveTurns` 用它取 user 消息首行做轮次标题。

### 2.3 能力接口：三个可缺面 API

`PluginContext`（`packages/shared/src/domain/context.ts:278`）上，git-review 只碰三个**可缺面**（带 `?` 的）能力对象，它们按 manifest 声明注入：

- `git?: GitReadApi`（`sessions.ts:462`）：`status(cwd)` / `fileDiff(cwd, path)` / `fileContent(cwd, path)` / `log(cwd, limit)`。
- `gitWrite?: GitWriteApi`（`sessions.ts:472`）：收敛面只有两个口子——`commit(cwd, message, files)` 和 `push(cwd)`。
- `llm?: LlmOneshotApi`（`sessions.ts:479`）：`oneshot(prompt)`，一次性问内核。

插件代码里处处用 `ctx.git!` / `ctx.gitWrite!` / `ctx.llm!` 的非空断言，因为 manifest 已声明了这三个权限，框架保证注入。这三个接口为什么是"可缺面"，以及缺面时会发生什么，见 §9。

## 3 槽位贡献与组件自动匹配

git-review 的 sidePanel 贡献项声明 `component: "GitReviewTab"`，但插件代码里**没有一行** `registerSidePanelComponent("GitReviewTab", ...)`。这是壳的组件自动匹配纪律（§7.4）：

- 框架加载 renderer module 后，读 manifest 的 `contributes.sidePanel[].component` 字段，在 module exports 里找同名导出，经 `asReactComponent`（`packages/react/src/plugin-modules.ts:13`，识别函数组件与 `memo`/`forwardRef` 等 exotic 组件）判定后写进 `sidePanelComponents` 注册表（`packages/react/src/index.ts:455`）。
- 渲染时右面板经 `getSidePanelComponent("GitReviewTab")`（`index.ts:463`）查组件，包一层 `PluginIdContext.Provider`（注入 `git-review` 这个 pluginId）后渲染，并把槽可见性以 `isActive` prop 传进去（`src/web/components/right-panel.tsx:497-499`）。

所以 `GitReviewTab` 的 props 契约只有 `{ isActive: boolean }`——`renderer/index.tsx:147` 的签名就是这份契约的直接落地。`isActive` 不是装饰：它驱动了所有"不可见时不刷新"的节能逻辑（§7），避免了后端子页签空跑 git 命令。

## 4 三个能力的完整链路

从插件的 `ctx.git.status()` 一行调用，到 simple-git 真正执行 `git status`，中间经过四层，每一层都有明确的文件与函数。

### 4.1 git:read —— 四个只读口

链路：renderer `ctx.git.*` → `window.kernel.git.*` → `controllers/fs-git.ts` 的 `gateway.register(IPC.git.*)` → `client/git/git-status.ts` 的实现函数。

- **`repoStatus(cwd)`**（`git-status.ts:10`）：`simpleGit(cwd).status()` 后把 `files` 逐条映射成 `GitChangedFile`（`index: f.index`、`worktree: f.working_dir`），连同 `branch: s.current`、`ahead`、`behind` 组装成 `GitStatusResult`。非 repo 时 simple-git 抛错，由 controller 捕获后返回 `{ isRepo: false, branch: null, ahead: 0, behind: 0, files: [] }`——所以"不是 git 仓库"这个空态是 controller 兜的，不是插件兜的。
- **`fileDiff(cwd, path)`**（`git-status.ts:21`）：`git.diff(["HEAD", "--", path])`——相对 HEAD 的 unified diff，staged + unstaged 合并。未跟踪文件返回空串。
- **`recentCommits(cwd, limit)`**（`git-status.ts:27`）：`git.log({ maxCount })`，limit 被夹在 `[1, 100]`。
- **`fileContent(cwd, path)`**（`git-status.ts:38`）：读未跟踪文件全文（新建文件无 diff 可显示）。这里有第一道安全收敛——`normalize(join(cwd, path))` 后 `startsWith(normalize(cwd) + sep)` 前缀校验防 `..` 路径逃逸，再加 200KB 上限。

controller 侧（`controllers/fs-git.ts`）四个 `gateway.register` 都先 `assertPermission(pluginId, "git:read")`，再 try/catch 包裹实现，catch 后返回空态而非抛错——读操作失败永远不炸插件，只落一个空态/空串/空列表。这条"fail-soft 读、fail-explicit 写"的分工是本插件错误处理的地基。

### 4.2 git:write —— 两个收敛写口

链路：renderer `ctx.gitWrite.*` → `window.kernel.gitWrite.*` → `controllers/fs-git.ts` 的 `IPC.git.commit`/`IPC.git.push` → `client/git/git-write.ts`。

- **`commitFiles(cwd, message, files)`**（`git-write.ts:19`）：先 `assertRelativePaths` 校验 `files` 每个元素 normalize 后仍落在 cwd 子树内（防路径逃逸），再 `git.add(files)`，最后 `git.commit(message, files)`——**pathspec 限定 commit**，只提交勾选集，不卷入此前已手动 `git add` 的其他文件。`message` 只作为 simple-git 参数数组元素传递，永不拼进 shell 字符串（simple-git 参数数组天然免疫注入）。空 message、空 files 直接拒绝（抛错，被 try/catch 转成 `{ ok: false, error }`）。返回 `{ ok: true, hash }` 或 `{ ok: false, error }`。
- **`pushCurrent(cwd)`**（`git-write.ts:37`）：`git.push()` 无参——simple-git 默认推当前分支到已配置 upstream。**无任何用户可控参数**，从 API 形状上封死 force push 和任意 refspec。无 upstream 时 simple-git 报错原样返回，不自动 `push -u`（自动建远端跟踪分支超出"最小出口"定位）。

写操作和读操作的错误策略相反：写操作**不吞错**，`{ ok: false, error }` 一路传回插件，由插件在 commit 区底部渲染 `actionError`（`renderer/index.tsx:502`）——simple-git 的原文（如 `no upstream configured`）直接显示给用户，不静默、不伪造成功。

### 4.3 llm:oneshot —— AI 生成 commit message

链路：renderer `ctx.llm.oneshot(prompt)` → `window.kernel.llm.oneshot` → `controllers/kernel.ts:164` 的 `IPC.llm.oneshot`（`assertPermission(pluginId, "llm:oneshot")`）→ `llmOneshot(prompt)`。

`llmOneshot` 在 `bootstrap/assemble.ts` 组装：`runPiOneshot(prompt, { cwd: sessionStore.getActiveCwd() ?? undefined, cliPath: customCliPath() })`。实现 `runPiOneshot` 在 `src/server/kernel/pi/extension/pi-oneshot.ts:26`：

- spawn `pi -p --no-session --no-tools <prompt>`——`-p/--print` 非交互一次退出、`--no-session` 不落会话文件、`--no-tools` 禁用全部工具。provider/key 走 pi 内核自己的 models.json，内核零感知"commit message"这个概念。
- 三道收敛：prompt 硬上限 `ONESHOT_PROMPT_MAX_BYTES = 256KB`、stdout 上限 `STDOUT_MAX_BYTES = 1MB`、默认 60s 超时 SIGKILL。

**这是 pi 专属能力**：`runPiOneshot` 始终 spawn pi CLI，与当前活跃内核无关。这个事实在 §9 的多内核讨论里是关键点——AI 生成 commit message 在 dsh 内核下仍然走 pi，而 git 读/写本身是完全内核无关的。

## 5 渲染器逐层拆解

`renderer/index.tsx` 全部逻辑分四块：轮次推导（纯函数）、工作区状态 hook、三个子页签、共享的 diff/树组件。文件顶部注释是精确的地图：`deriveTurns` 从 messages 纯推导，diff 走 `ctx.git`，commit/push 走 `ctx.gitWrite`，AI message 走 `ctx.llm.oneshot`。

### 5.1 deriveTurns —— 轮次追踪零内核改动

`deriveTurns(messages: NeutralMessage[]): TurnEntry[]`（`index.tsx:29`）是本插件最核心的算法，也是"消费而非翻译"原则的教科书落地：

- 遍历 messages，`m.role === "user"` 是天然轮次边界，开一轮（`current = { index: turns.length + 1, label, files: [] }`），`label` 取 user 消息首行（`messageContentText(m.content).split("\n")[0]`）。
- 非 user 的 assistant 消息里，`toolCallsOf(m.content)` 取工具调用块，只收 `tc.name === "write"` 或 `"edit"` 的 `args.path`（字符串、非空、去重）。
- 最后 `filter((t) => t.files.length > 0)`——没有文件改动的空轮次直接丢弃，所以"本轮"页签显示的"最近一个有文件改动的轮次"是这个 filter 的直接结果。

为什么不用内核提供的 turn 元数据？设计文档复查后发现它不需要：`useSessionStore().messages` 里 user 消息天然切轮，assistant 内容块的 toolCall 带 `name`/`args`——timeline 已经在用同一个 `toolCallsOf` 解析。于是 turn→files 映射**插件侧纯推导，零内核改动**。代价是 §开头讲的两条语义边界（bash 盲区、脏文件语义），它们不是实现缺陷，是"不引入 checkpoint 快照机制"这一取舍的必然结果，如实标注不藏。

### 5.2 useWorkspace —— 工作区状态三视图共用

`useWorkspace(cwd, visible)`（`index.tsx:51`）维护 `{ isRepo, branch, ahead, behind, files, refresh }` 六个值，被 `WorkspaceView` 直接消费。核心是 `refresh()`：`ctx.git!.status(cwd)` 一次调用拿回全部五个字段，分发进 state。

两个刷新时机值得单独指出，因为它们体现事件驱动纪律：

- **可见性 + cwd 变化**（`index.tsx:78`）：`visible`（即 `isActive`）或 `cwd` 变即刷。
- **streaming 收尾**（`index.tsx:83`）：用 `prevStreaming` ref 记录上一帧 `streaming`，检测到 `prevStreaming.current && !streaming`（true→false 翻转）时刷——agent 收尾了，工作区大概率落了新文件。这是事件驱动而非轮询：不 sleep、不 setInterval，靠 store 的 streaming 状态翻转做信号。

### 5.3 三个子页签

`GitReviewTab`（`index.tsx:147`）用 Radix Tabs 切三个子页签，`subTab` 默认 `"workspace"`：

- **本轮 `TurnView`**（`index.tsx:179`）：`deriveTurns` 取最后一个（`turns[turns.length - 1]`），标题显示 `#N label`，下面 `FilesDiffPanel` + `TurnNote`（`review.turnDiffNote` 语义边界）。两个空态：无 `currentCwd` → "先打开文件夹"；无轮次 → "本轮 agent 未改动文件"。
- **本对话 `SessionView`**（`index.tsx:201`）：轮次折叠列表（点击切换 `openTurn`，`effectiveOpen` 兜底到最后一轮），右侧 `FilesDiffPanel`。列表项显示 `#N label` + 该轮文件数。
- **Git 工作区 `WorkspaceView`**（`index.tsx:301`）：最复杂，见 §5.5。

三个子页签的空态全部复用 `EmptyState` 组件（`@my-harness-desktop/react` 导出），不自己画空态布局——这是框架管通用、插件管特化的分工。

### 5.4 FilesDiffPanel 与 DiffView —— 轮次视图的共用体

`FilesDiffPanel`（`index.tsx:245`）是"本轮/本对话"共用的左列表 + 右 diff 布局：

- 左：`files` 平铺列表，每项 `StatusBadge` + 文件 basename，点选 `setSelected`。
- 右：选中文件的 `DiffView`，顶部 mono 字体显示完整路径。
- `refreshStatus`（`index.tsx:253`）：`ctx.git.status(cwd)` 后把 `files` 映射成 `Map<path, status码>`，status 码的取值逻辑 `f.index === "?" ? "?" : f.index.trim() || f.worktree.trim() || "M"`——优先 staged 码，空则 worktree 码，再空兜底 `M`。同样的逻辑在 `WorkspaceView.statusOf` 里写了一遍（`index.tsx:319`），这是插件内部唯一一处小重复，语义相同但分属两个组件闭包。

`DiffView`（`index.tsx:612`）按 status 分叉：

- `status === "?"`（未跟踪）：`ctx.git.fileContent` 读全文，`pre` 纯文本预览，标题"新文件（未跟踪）"。
- 其他：`ctx.git.fileDiff` 拿 unified diff，`parseDiff(diffText)` 后交给 `react-diff-view` 的 `<Diff viewType="unified" diffType={file.type} hunks={file.hunks}>` + `<Hunk>` 渲染。
- `key={effective}` / `key={selected}` 强制切文件时重挂载，配合 `useEffect` 里的 `setDiffText(null)` 清空，避免上一个文件的 diff 残影。

`react-diff-view` 全仓只有本插件 import——它是唯一做 diff 可视化渲染的插件，timeline 只渲染工具卡不做 diff（§6.3）。

### 5.5 WorkspaceView —— 最小提交出口

`WorkspaceView` 是写操作的唯一入口，结构自上而下：

- **分支条**（`index.tsx:420`）：分支名 + `↑ahead`/`↓behind` + 刷新按钮 + push 按钮。push 按钮 `disabled={writeDisabled || ahead === 0}`——ahead 为 0 时没有可推的提交。
- **三组勾选列表**（`index.tsx:447`）：`staged`/`unstaged`/`untracked` 三个派生数组喂给三个 `CheckGroup`。派生规则直出 simple-git 双码：`index !== " " && index !== "?"` 进已暂存组、`worktree !== " " && index !== "?"` 进更改组、`index === "?"` 进未跟踪组。同一文件可同时出现在已暂存和更改两组（部分暂存的真实状态），与 VSCode SCM 行为一致。
- **最近提交**（`index.tsx:454`）：折叠区，`ctx.git.log(cwd, 10)` 拉最近 10 条，显示 7 位 hash 缩写 + 首行 message。
- **commit 区**（`index.tsx:476`）：message textarea + "AI 生成"按钮 + "提交 (N)"按钮 + 错误行。`checked` 集合初始为空集——**提交范围永远由用户显式勾选决定**，没有任何默认勾选。

三个写动作：

- `generateMessage`（`index.tsx:356`）：`DIFF_BUDGET = 48_000` 字节预算，按勾选排序逐文件拼 diff 串（未跟踪用 `fileContent` 前缀 `--- new file: ...`，其余用 `fileDiff` 前缀 `--- path ---`），超预算截断并追加 `review.truncatedNote`。把拼好的 diff 塞进 `review.commitPrompt` 模板的 `{{diff}}` 占位（模板要求"一行、≤72 字符、祈使句、只输出 message"），`ctx.llm.oneshot(prompt)` 后取结果第一行、去掉首尾引号。prompt 模板是内容，住在 locales 里，改文案不改代码——机制与内容分离。
- `doCommit`（`index.tsx:384`）：`ctx.gitWrite.commit(cwd, message.trim(), [...checked].sort())`，成功后清 message 和 checked，`refresh()` + `refreshLog()`。
- `doPush`（`index.tsx:400`）：`ctx.gitWrite.push(cwd)`，成功后 `refresh()`。

写操作门控（`index.tsx:416`）：`writeDisabled = streaming || busy !== null`——agent 流式生成中（streaming）或已有写操作在途（busy）时，commit/push/generate 三个按钮全禁用。streaming 中提交半成品是用户级事故，这条门控是它在实现层的直接落地，不做文件锁（git 本身最后写入赢）。

### 5.6 buildTree 与 CheckTreeRow —— 文件树

`buildTree(files)`（`index.tsx:106`）：平铺路径 → 目录树，两个后处理：`compress` 把单链子目录压缩成 `a/b` 一段（减少一层层单目录嵌套），`sortNodes` 目录优先 + 名字 localeCompare。`countLeaves` 统计叶子数做目录角标。`CheckTreeRow`（`index.tsx:556`）递归渲染，文件夹显示折叠箭头 + 叶子数，文件行是 checkbox + `StatusBadge` + 名字；checkbox 的 `onClick` 里 `e.stopPropagation()` 阻止冒泡到文件选择，`onChange` 才 toggle 勾选——选择（看 diff）和勾选（决定 commit 范围）是两个正交的交互，互不干扰。

### 5.7 StatusBadge 与样式

`StatusBadge`（`index.tsx:653`）把双码状态码映射成颜色：`?`/`A` → 成功色、`D` → 错误色、其余 → 警告色；显示标签 `?` 归一成 `A`。颜色用主题 token（`var(--color-accent-success)` 等），不是写死色值——key 合规、值违规的纪律在这里的落地是：代码里只有 token key 查询，没有十六进制颜色值。

样式对象（`subTabStyle`/`iconBtnStyle`/`textBtnStyle`/`iconTextBtnStyle`/`messageInputStyle`，`index.tsx:671-704`）全部用 `var(--...)` 主题 token，无一处硬编码颜色/字号/间距。

## 6 与其他插件交互

这是本文必须专节讲的部分。git-review 的交互模式一句话概括：**它是一个纯消费者，不 emit 任何 channel，没有其他插件依赖它的输出**。它与其他插件的关系全部通过"共享 store 只读 + 共享纯函数"建立，没有一条事件总线链路。

### 6.1 sidePanel Tab：一个常驻、无揭示触发器的页签

git-review 的 sidePanel 贡献项没有 `revealOn` 字段，因此它在右面板里是一个**常驻 Tab**——从壳启动起就在 icon 条上，用户手动点击才展开。对比之下，`sub-agent` 插件声明 `revealOn: "subagent:dialog"`（`src/plugins/sessions/sub-agent/plugin.json:37`），`session-bookmarks` 声明 `revealOn: "bookmarks:addRequested"`（`src/plugins/sessions/session-bookmarks/plugin.json:26`）——它们是被外部事件"揭示"出来的 Tab，git-review 不是。

为什么 git-review 不需要 revealOn？机制上的答案在 `SidePanelContribution.revealOn` 的契约注释（`packages/shared/src/domain/contributions.ts:91`）：revealOn 的语义是"该 channel 被 emit/invoke 时，框架展开右面板并激活本 Tab"。它适用于"某个别处的动作触发了本 Tab 的展示需求"——sub-agent 是 dialog 打开时、bookmarks 是 timeline 一击收藏时。而 git-review 没有这样一个外部触发源：它的数据（工作区 diff、轮次文件）不来自任何插件的动作，而是来自会话流自然推进（streaming 收尾）+ 用户手动查看的意图。给它加 revealOn 意味着要发明一个"该看 diff 了"的事件，这个事件不存在，也不该由别的插件来宣告。

`revealOn` 机制的实现方在 `src/web/components/right-panel.tsx:120-130`：`SidePanelStrip` 建 `byChannel: Map<channel, tabId>`，`eventBus.tap((channel) => ...)` 侦听所有事件派发，命中即 `activateSidePanelTab(tabId)`。这个 tap 是幂等的（已激活仅展开面板，不重复激活）。git-review 不参与这条链路，它的 Tab 激活只走用户点击 `toggleSidePanelTab`。

### 6.2 与 timeline 的 diff 展示交互：同源不同形

这是最容易被问"是不是重复造轮子"的地方——timeline 也渲染 toolCall，git-review 也展示文件改动，两者什么关系？

**它们共享数据源，但渲染目标不同，且之间没有事件通道。**

- **同源**：两者都读 `useSessionStore().messages`（`NeutralMessage[]`）和 `useSessionStore().streaming`。timeline 在 `src/plugins/sessions/timeline/renderer/blocks.ts` 用 `toolCallsOf(message.content)` 分解出 `{ type: "toolCall", toolCall }` 块（`blocks.ts:45`），git-review 在 `deriveTurns` 用同一个 `toolCallsOf` 取 `write`/`edit` 的 `args.path`。轮次标题两者也都走 `messageContentText`。这三个共享点不是巧合，是契约单源的强制结果：`toolCallsOf` 和 `messageContentText` 的唯一实现在圆心，谁都不许本地重写一份。

- **不同形**：timeline 把 write/edit 工具调用渲染成**会话流里的工具卡**（一行"用了 write 工具"的折叠卡片，属 `blockRenderers` 槽的 toolCall 块），回答"这个动作发生在对话的哪个位置"；git-review 把同一个 toolCall 的 `args.path` 聚合起来，跨轮次归组，再经 `ctx.git.fileDiff` 拿**真实的 unified diff** 用 `react-diff-view` 渲染，回答"这些文件到底改了什么"。前者是时间轴上的事件卡片，后者是空间上的 diff 视图。timeline 不 import `react-diff-view`，git-review 不渲染工具卡——各画各的，互不越界。

- **无通道**：两者之间没有任何 `ctx.events` 链路。git-review 不 emit "我显示了 diff" 之类的事件给 timeline，timeline 也不 invoke git-review。唯一的间接耦合是 `streaming`——timeline 驱动的会话活动（发消息、收流）翻转 `useSessionStore().streaming`，git-review 订阅这个翻转做 commit/push 门控和收尾自动刷新（§5.2）。这是"共享 store 只读"纪律的合法形态：读别人的状态可以，改别人的状态或直调别人的能力不可以。

### 6.3 与 projects 的 cwd 交互：被动跟随

git-review 读 `useUiStore().currentCwd` 作为 git 操作的根目录，但**不设置它**。`currentCwd` 的唯一写入口在 `src/plugins/project/projects/renderer/index.tsx`：`switchCwd`（`setCurrentCwd(dir)` + `startNewChat`）、`openDirectory`（dialog 选目录后 `switchCwd`）、`removeCwd`（摘当前目录时清 `setCurrentCwd("")`）。git-review 只在其 `useEffect` 依赖 `cwd` 变化时被动重刷——projects 切目录，git-review 跟着刷新工作区状态和 diff。这是"共享 store 只读"的另一个实例：插件可以订阅 `useUiStore` 的框架状态做被动响应，但不碰 setter。

### 6.4 事件总线：本插件零 channel

git-review 的 `renderer/index.tsx` 没有 `export const channels`，也没有任何 `ctx.events.emit/on/invoke` 调用（grep 结果为空）。这意味着：

- 它不发布任何可回放的状态（不需要 `emit` + `replayLast`）。
- 它不接收任何别插件的定向命令（不需要 `on` + `dependsOn`）。
- 它不调任何别插件的 channel（不需要 `invoke`）。

一个插件完全不参与事件总线是合法的，也是本插件"纯消费者"定位的自然结果——它消费的是内核吐出的 git 能力和会话投影，不消费别的插件的输出，也不产出别的插件要消费的中间态。

## 7 权限与安全

git-review 的完整安全面分布在三层，逐层收敛：

- **权限门控（声明 vs 注入）**：manifest 声明 `git:read`/`git:write`/`llm:oneshot`，`usePluginContext()` 据此注入 `ctx.git`/`ctx.gitWrite`/`ctx.llm`。真正的强制执行在 IPC 边界——`controllers/fs-git.ts` 的 `assertPermission`（`registry.assertPermission(pluginId, permission)`）和 `controllers/kernel.ts:165` 的 `assertPermission(pluginId, "llm:oneshot")`。未声明权限的插件调用即抛错，插件收到错误自己决定呈现（本插件在 actionError 行显示）。
- **路径圈禁（写面）**：`client/git/git-write.ts` 的 `assertRelativePaths` 逐个校验 files 落在 cwd 子树内，防 `..` 逃逸；`client/git/git-status.ts` 的 `fileContent` 同样前缀校验 + 200KB 上限。fs 能力另有 `assertProjectPath`（圈禁到项目根），git 能力的圈禁收在 client 层而非 controller 层——因为 git 的 cwd 由调用方显式传，不是项目根。
- **注入面（写面）**：`message` 永不拼 shell 字符串（simple-git 参数数组），`push` 无参数（封死 force/refspec），`commit` 无 `--amend`/`--no-verify`。这三条把写操作的用户可控输入面压到最小。

## 8 刷新策略：事件驱动，不轮询

git-review 的刷新时机集合，全部门控在"状态翻转"而非定时器：

- 页签可见性翻转：`visible`（isActive）变 true 时刷。
- cwd 变化：projects 切目录时刷。
- streaming true→false：agent 收尾时刷工作区状态和文件状态徽标。
- 手动：刷新按钮（`refresh` + `refreshLog`）。
- 写操作成功：commit/push 成功后 `refresh` + `refreshLog` 确认落点。

轮次推导（`deriveTurns`）不走手动刷新——它包在 `useMemo(() => deriveTurns(messages), [messages])` 里，messages 变化（流式追加、重试、fork）时自动重算。工作区不因切会话而刷（工作区文件不因切会话而变），但轮次推导随 messages 变——两个数据源的生命周期不同，刷新策略也不同，这个区分落在"哪份数据依赖什么 store"上。

## 9 多内核视角

git-review 的三个能力里，两个内核无关、一个 pi 专属：

- **git:read / git:write 内核无关**：git 是被壳管理的资源（与内核并列的 `src/server/client/git/`），`simpleGit(cwd)` 操作的是文件系统上的 git 仓库，与当前活跃内核是 pi 还是 dsh 无关。`currentCwd` 是 projects 插件维护的路径，`messages` 是会话投影——两者都已被适配器投成中性形状。因此 git-review 的渲染逻辑里**没有任何内核身份分支**（`if (kernel === "pi")` 之类），符合壳插件渲染纯函数纪律。

- **llm:oneshot pi 专属**：`llmOneshot` 在 `assemble.ts` 里恒绑定 `runPiOneshot`——spawn pi CLI。这意味着即使用户当前在 dsh 内核会话里，点"AI 生成"commit message 仍然走 pi 内核的一次性进程。这是一个**已知的、未降级的 pi 专属面**：`llm:oneshot` 契约注释（`sessions.ts:477`）就写着"spawn `pi -p --no-session --no-tools`"，`main-context.ts:127` 写着"pi 专属"。它没有做能力探测降级（dsh 下不隐藏"AI 生成"按钮），也没有给 dsh 补面（写 cordis 插件实现 oneshot）。这是本插件在当前架构下的一个真实边界——AI 生成是增强不是门槛，手写 message 永远可用，所以这个 pi 专属面不阻塞功能，但它不是"内核无关"的完整形态。

## 10 QA

**Q：为什么 Review 页签不声明 `revealOn`，而 sub-agent / session-bookmarks 声明了？**

因为 revealOn 的语义是"某 channel 被 emit/invoke 时揭示本 Tab"，它需要一个外部触发源。sub-agent 有"dialog 打开"这个事件、bookmarks 有"timeline 一击收藏"这个事件，git-review 没有——它的数据来自会话流自然推进和用户手动查看意图，不存在一个"该看 diff 了"的通道。给它发明一个事件是反模式。git-review 是常驻 Tab，用户点击即激活（`toggleSidePanelTab`），不经过 revealOn 的 `eventBus.tap` 链路（`right-panel.tsx:120`）。

**Q：commit 会把之前手动 `git add` 过的文件也卷进去吗？**

不会。`commitFiles` 走 pathspec 限定 commit（`git.commit(message, files)`，simple-git 展开为 `git commit -m msg -- <files>`），只提交勾选集；此前已手动 add 的未勾选文件原样留在暂存区。这是设计文档实现期发现并实测验证的真实语义问题。

**Q：一个部分暂存的文件会出现在两组里吗？**

会。`staged` 组判据是 `index !== " "`，`unstaged` 组判据是 `worktree !== " " && index !== "?"`——一个文件 `index = "M"` 且 `worktree = "M"`（部分暂存）时同时命中两组。这与 VSCode SCM 行为一致，是 git 双码语义的真实呈现，不是 bug。

**Q：AI 生成 commit message 在 dsh 内核下还能用吗？**

能用，但它走的是 pi 内核。`llm:oneshot` 恒绑定 `runPiOneshot`（`assemble.ts` 的 `llmOneshot`），spawn `pi -p --no-session --no-tools`，与当前活跃内核无关。这是一个 pi 专属面，未做能力探测降级也未给 dsh 补面；AI 生成是增强不是门槛，手写 message 永远可用，所以不阻塞。

**Q：agent 用 bash 改的文件为什么追踪不到？**

因为轮次追踪只从 toolCall 的 `args.path` 取路径，而 bash 工具调用只有命令字符串，没有结构化的"改了哪些路径"字段。`rm`/`mv`/`cp`/重定向改的文件对 git-review 不可见。这条边界如实标注在 `review.turnDiffNote` 文案里，Claude Code 的 checkpoint 有完全相同的盲区，属行业级限制而非偷懒。

**Q：diff 很大（几千行）会卡吗？**

会。`react-diff-view` 全量渲染，不做虚拟滚动。大 diff 可能卡，属已知缺口（演进）。这不会触发内核或插件崩溃，只是渲染慢。

**Q：未跟踪的新文件没有 diff，怎么预览？**

退 `ctx.git.fileContent` 读全文，`pre` 纯文本预览，标题"新文件（未跟踪）"。这是 `DiffView` 里 `status === "?"` 分支的直接逻辑。fileContent 在 main 侧有 200KB 上限和路径圈禁，超限抛错被 controller 转成"读取失败: ..."字符串。

**Q：streaming 时为什么禁 commit/push？**

agent 流式生成中可能正在写文件，此时提交半成品是用户级事故。`writeDisabled = streaming || busy !== null` 直接禁用 commit/push/generate 三个按钮。不做文件锁——git 本身最后写入赢，残余风险与终端场景相同。
