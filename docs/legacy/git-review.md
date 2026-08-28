# git-review

## 1 这个插件解决什么问题

用户在 AI 对话时需要看 AI 改了什么——这一轮动了哪些文件、这个对话累计动了哪些文件、工作区现在是什么 diff。看完之后想提交，不用再切终端：勾选文件、生成或手写 message、commit、push，都在右面板完成。

定位是**只读审查为主，写口只开 commit + push**（用户拍板）：不做 stage 管理、分支操作、stash、历史图、merge 冲突、PR、git-flow、hunk accept/reject、checkpoint/rewind。完整取舍与主流对照见 [docs/design/git-review-turn-diff-commit.md](../design/git-review-turn-diff-commit.md)。

## 2 设计决策

### 2.1 为什么是插件而不是内核

Git status 的渲染会变——diff 视图会换、分组方式会调。但"能读 Git 状态"（git:read）和"能提交推送"（git:write）这两个能力不会变，留在内核。渲染和 prompt 模板是内容，推给插件——commit message 的 prompt 模板在本插件的 locales 里，内核的 `llm:oneshot` 机制不知道什么叫 commit message。

### 2.2 选了什么机制

贡献 `sidePanel` 槽位，`order: 10`。声明三个权限：`git:read`（status/diff/content/log）、`git:write`（commit/push）、`llm:oneshot`（AI 生成 commit message）。三个子页签：

- **本轮**：最近一个有文件改动的轮次，文件列表 + diff。
- **本对话**：轮次分组的可折叠列表，选轮看该轮文件 diff。
- **Git 工作区**：分支条（分支名 + ahead/behind + push 按钮）+ staged/更改/未跟踪三组勾选列表 + commit 区（message 输入 + AI 生成 + 提交）+ 最近提交（折叠）。

### 2.3 turn 追踪：从 messages 纯推导，不等底座

旧版判断"turn 级追踪需要底座提供元数据"——过时。`useSessionStore` 的 messages 里，user 消息是天然轮次边界，assistant 内容块的 toolCall 带 `name` 和 `args.path`（解析走 domain 的 `toolCallsOf`，与 timeline 共用唯一实现）。插件遍历 messages：user 切轮，收集该轮 `write`/`edit` 的 path，即轮次→文件集映射。**零内核改动**。

两个如实标注的语义边界（显示在轮次页签页脚）：

- **bash 盲区**：agent 用 bash（rm/mv/cp/重定向）改的文件追踪不到——toolCall args 里没有可靠路径。Claude Code checkpoint 有完全相同的盲区。
- **脏文件语义**：文件在会话前已有未提交改动时，`git diff HEAD` 会把会话前改动一并显示。轮次页签的语义是"该轮触碰的文件的当前工作区 diff"，不是"该轮的改动"（快照隔离是 checkpoint 机制，属演进方向）。

### 2.4 写面收敛：勾选即提交，不卷入他人

- `ctx.gitWrite.commit(cwd, message, files)`：main 侧先 `git add`（未跟踪文件必须 add 才能进 pathspec commit），再 **pathspec 限定 commit**（`git commit -m msg -- <files>`）——只提交勾选文件，此前已暂存的其他文件原样留在暂存区。files 逐个校验为 cwd 内相对路径，空 files/空 message 拒绝，无 `--amend`/`--no-verify`。
- `ctx.gitWrite.push(cwd)`：无参 push（当前分支到已配置 upstream），从 API 形状上封死 force 和任意 refspec。无 upstream 报错原样显示，不自动 publish。
- `ctx.llm.oneshot(prompt)`：spawn `pi -p --no-session --no-tools`，不落会话文件、不带工具、provider/key 走底座自己的 models.json。插件拼装 prompt（locales 模板 + 勾选文件的 diff，超 48KB 截断并标注），生成结果取第一行、去引号，可手改后再提交。

### 2.5 和框架的分工

框架管：组件注册（manifest component 名自动匹配 export）、`useUiStore`/`useSessionStore` 全局状态、`EmptyState` 空态组件、IPC 权限门控、toolCall 块解析（domain `toolCallsOf`）。插件管：轮次推导（`deriveTurns`）、diff 渲染（react-diff-view）、勾选/commit/push 交互、prompt 模板与全部文案（locales 四语言）。

### 2.6 是否修改了内核

改了（本次演进是内核 + 插件的联动，设计文档先行）：

- 圆心契约：`GitChangedFile` 从单字母 `status` 改为 `index`/`worktree` 双码（**有意破坏性变更**，本插件是唯一消费者，同步改）；`GitStatusResult` 新增 branch/ahead/behind；新增 `GitLogEntry`、`GitWriteApi`、`LlmOneshotApi`；`PluginContext` 挂 `gitWrite?`、`llm?`。
- client：`client/git/git-write.ts`（新，收敛写面）、`client/pi/pi-oneshot.ts`（新，一次性问底座）、`subprocess-lifecycle.ts` 提取 `resolvePiCli`（rpc 会话进程与一次性进程共用定位）。
- IPC/preload：`git:log`、`git:commit`、`git:push`、`llm:oneshot` 四个通道；`registry.assertPermission` 收敛（原 fs-git.ts 本地闭包上收）。
- 顺带的收敛：timeline 本地的 `toolCallsOf`/`ToolCallItem` 上收到 domain（`ToolCallBlock` + `toolCallsOf`），timeline 改为从 `@my-harness-desktop/react` 引用。

删掉这个插件，内核照常运行：`git:*`/`llm:oneshot` 能力持续可用，第三方插件声明同权限即可提供等价或更强的 Git 功能。

## 3 怎么通信

### 3.1 和内核通信

`usePluginContext()` 拿绑定上下文。`ctx.git.status/log/fileDiff/fileContent`（git:read），`ctx.gitWrite.commit/push`（git:write），`ctx.llm.oneshot`（llm:oneshot）。三个权限都声明在 manifest，IPC 边界校验。

### 3.2 和其他插件通信

纯消费者：`useUiStore.currentCwd`（projects 切目录时被动重刷）、`useSessionStore.messages/streaming`（timeline 所在会话域的事件增量，插件只读）。不 emit 任何 channel，没有其他插件依赖 git-review 的输出。

### 3.3 streaming 门控

agent 流式生成中（streaming=true）禁用 commit/push/generate 按钮——agent 正在写文件时提交半成品是用户级事故。streaming 从 true 翻 false（agent 收尾）时自动重刷工作区状态和文件状态徽标——事件驱动，不轮询。

## 4 怎么处理

### 4.1 数据流

刷新时机：页签变可见 / cwd 变 / streaming 收尾 / 手动刷新 / commit、push 成功后。切会话不刷工作区（工作区文件不因切会话而变）；轮次推导随 messages 变化自动重算（useMemo）。

### 4.2 工作区分组

simple-git status 的双码直出：`index !== " " && index !== "?"` 进"已暂存"组（徽标显示 index 码），`worktree !== " " && index !== "?"` 进"更改"组（徽标显示 worktree 码），`index === "?"` 进"未跟踪"组。同一文件可同时出现在已暂存和更改两组（部分暂存的真实状态），与 VSCode 行为一致。勾选默认空集——提交范围永远由用户显式勾选决定。

### 4.3 diff 渲染

`react-diff-view` 渲染 unified diff；未跟踪文件（`?`）无 diff，退 `fileContent` 纯文本预览（200KB 上限，main 侧圈禁）。轮次页签的 diff 复用同一组件，文件状态从工作区 status 地图查，查不到按 `M` 处理。

## 5 怎么保证

### 5.1 路径与注入安全

files 在 client/git-write 逐个校验为 cwd 内相对路径（防 `..` 逃逸）；message 只作为 simple-git 参数数组元素传递，永不拼进 shell 字符串；push 无参，无用户可控输入。

### 5.2 非 repo / 空态

非 git 目录显示"不是 Git 仓库"；工作区干净显示"工作区干净"；轮次无改动显示对应空态。全部复用 `EmptyState`。

### 5.3 失败兜底

AI 生成失败（无模型配置/网络/超时 60s）→ 错误行显示原因，message 框保持可手写；commit/push 失败 → simple-git 错误原文显示。AI 生成是增强不是门槛。

## 6 如果没有这个插件，整个系统会有什么影响

内核不崩溃。侧面板失去"Review"页签，用户无法在 my-harness-desktop 内审查和提交 Git 改动——切回终端跑 `git status` / `git diff` / `git commit`。其他插件不受影响。内核的 `ctx.git.*` / `ctx.gitWrite.*` / `ctx.llm.oneshot` 能力持续可用——`llm:oneshot` 是通用机制（任何插件声明权限后可"问一次底座"），不因本插件存在与否而改变。

## 7 QA

**Q：commit 会把之前手动 `git add` 过的文件也卷进去吗？**
不会。commit 走 pathspec 限定（`git commit -m msg -- <勾选文件>`），只提交勾选集；此前已暂存的未勾选文件原样留在暂存区（已用临时仓库实测验证）。

**Q：勾选文件里有已暂存的，重复 add 有问题吗？**
没有。`git add` 幂等；pathspec commit 提交的是这些路径的工作区内容，与暂存区状态无关。

**Q：diff 很大时会卡吗？**
`react-diff-view` 全量渲染，不做虚拟滚动。大 diff（几千行）可能卡。沿用旧版标注：演进。

**Q：AI 生成的 message 不准怎么办？**
生成结果填入输入框而非直接提交，必须经用户过目（可改）后点提交。prompt 模板在 locales 里（`review.commitPrompt`），改文案不改代码。

**Q：为什么 push 不支持推送到指定 remote/branch？**
定位就是"最小出口"——只推当前分支到已配置 upstream。要建跟踪分支、推别的远端，去终端（git-flow 类操作明确不做）。
