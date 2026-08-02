# git-review 演进：turn 级 diff 视图 + 最小提交出口

git-review 从一个"只读工作区查看器"演进为"AI 改动审查器 + 最小提交出口"：三个空态/半成品的子页签全部接上真数据，写能力只开 commit 和 push 两个口子，其余 Git 管理功能明确不做。

## 1 问题与定位

### 1.1 现状：一个半成品的只读查看器

- 内核 git 能力是三个只读方法（`status` / `fileDiff` / `fileContent`，`git:read` 权限门控），`client/git/git-status.ts` 用 simple-git 包装。写操作为零——没有 `git:write`。
- git-review 插件三个子页签："本轮""本对话"是空态占位（文档标注"等底座提供 turn 元数据"），只有"Git 工作区"有真数据。
- 用户想提交 AI 的改动，得切回终端跑 `git add && git commit && git push`。

### 1.2 定位（用户拍板，先于一切设计）

**只读查看为主，写能力最多开 commit + push。** 这条直接决定不做清单：

- 不做 stage/unstage 独立管理（commit 勾选即隐式 add，不引入 index 状态机）。
- 不做分支切换/新建/删除、stash、历史图、cherry-pick、merge 冲突编辑器、PR 管理。
- 不做 git-flow 工作流（feature/release/hotfix 分支模型操作）——主流工具里也只有 GitKraken/SourceTree/Lazygit 内置，VSCode 都不内置，对 AI coding 壳是边缘需求。
- 不做 hunk 级 accept/reject、checkpoint/rewind——属于"修改向"能力，超出定位（见 §6 演进方向）。

### 1.3 主流对照后的结论

通用 Git GUI（VSCode SCM/GitLens/GitHub Desktop）的核心是 stage 两栏 + 分支图 + 远端同步，超出本次定位。AI coding 工具（Claude Code/Cursor/Copilot）的差异化在**"AI 每轮改了什么"可见**——这正是"本轮/本对话"两个空态页签的位置，且它是纯只读的，完全落在定位内。本次演进把差异化做掉，把最小提交出口补上，其余一律不碰。

## 2 三个关键设计判断

### 2.1 turn 追踪不用等底座——从 messages 纯推导

git-review 旧文档的判断是"turn 级追踪需要底座提供元数据，底座当前不提供"。复查后这个判断过时了：

- 中性事件联合里已有 `TurnStartEvent` / `TurnEndEvent`，`toolCallStart` 携带 `toolName` + `args`（`core/domain/events/session-state.ts:153-167,198-199`），event-translator 已在翻译这些事件。
- 更直接的数据源是 `useSessionStore` 的 `messages`：`role === "user"` 的消息天然是轮次边界，assistant 消息的内容块数组里 `type === "toolCall"` 的块带 `name` 和 `args`——timeline 插件已在用同一个解析模式（`timeline/renderer/index.tsx:79-93` 的 `toolCallsOf`）。

因此 turn→files 映射可以**插件侧纯推导，零内核改动**：遍历 messages，user 消息切开一轮，收集该轮 assistant 消息里 `name ∈ {write, edit}` 的 toolCall 的 `args.path`，即为该轮触碰的文件集。diff 展示复用现有 `ctx.git.fileDiff`。

两个如实标注的语义边界（写进插件文案，不藏）：

- **bash 盲区**：agent 用 bash（`rm`/`mv`/`cp`/重定向）改的文件追踪不到——toolCall args 里没有可靠路径。Claude Code 的 checkpoint 有完全相同的盲区，属行业级限制，不是本设计的偷懒。
- **脏文件语义**：文件在会话开始前已有未提交改动时，`git diff HEAD` 会把会话前改动一并显示。本设计不做快照隔离（那是 checkpoint 机制，§6），"本轮/本对话"页的语义如实为"**该轮触碰的文件的当前工作区 diff**"。

### 2.2 写面收敛：GitWriteApi 两个方法 + git:write 权限

不扩大 `GitReadApi`——读写分离，权限各自声明，只读插件（如未来第三方 diff 查看器）不需要背写权限：

```typescript
/** git 工作区写操作(permissions: "git:write")。收敛面:只有 commit 和 push。 */
export interface GitWriteApi {
  /** add 指定文件 + commit。files 为空数组即拒绝;不支持 --amend/--no-verify。 */
  commit(cwd: string, message: string, files: string[]): Promise<{ ok: boolean; hash?: string; error?: string }>;
  /** push 当前分支到已配置的 upstream。无 force、无 remote/branch 参数;无 upstream 报错,不自动 publish。 */
  push(cwd: string): Promise<{ ok: boolean; error?: string }>;
}
```

main 侧安全收敛（`client/git/git-write.ts`，simple-git 实现）：

- `commit`：先 `git add -- <files>`（files 逐个校验为 cwd 内相对路径，防路径逃逸，复用 `fileContent` 的圈禁模式），再 `git commit -m <message>`。message 只作为 `-m` 值传递，永不进 shell 字符串拼接（simple-git 参数数组天然免疫注入）。
- `push`：`git.push()` 无参——simple-git 默认推当前分支到 upstream。不传任何用户可控参数，从 API 形状上封死 force push 和任意 refspec。
- `PluginContext` 上挂 `ctx.gitWrite?: GitWriteApi`，与 `ctx.git` 并列，按 manifest 的 `git:write` 声明注入。

### 2.3 AI commit message 走底座的一次性模式

对比过三条路：

- **`messaging.prompt` 复用当前会话**（blind-review 的机制）：prompt 和回复都进当前对话上下文。盲审接受这个代价（审查本来就是对话内容），commit message 不接受——每次提交都往编码会话里塞一段无关对话，污染上下文。
- **main 进程直调 provider API**：要读 modelsConfig 的 key、适配 Anthropic/OpenAI 各自的请求形状——内核开始懂 LLM provider，双份适配债，方向违规（把会变的细节往内核引）。
- **底座自带一次性模式**（选定）：复查 pi CLI 帮助发现三个现成开关——`--print/-p`（非交互，处理完退出）、`--no-session`（ephemeral，不落会话文件）、`--no-tools`（禁用全部工具）。spawn `pi -p --no-session --no-tools <prompt>` 即得一次性 completion：provider/key 走底座自己的 modelsConfig（内核零感知），不污染任何会话，无工具不可能乱动文件。

落地为**通用机制**而非 git 专用 IPC：`ctx.llm.oneshot(prompt)` + `llm:oneshot` 声明能力（LLM 调用烧 token，需要权限门控 + 用户点击触发，与 dialog 的用户手势原则一致）。prompt 模板是内容，留在 git-review 的 locales 里由插件拼装——内核只提供"问一次底座"的机制，不知道什么叫 commit message（机制与内容分离）。

实现件：`client/pi/pi-oneshot.ts`，spawn 收敛——60s 超时、stdout 大小上限、prompt 超长时截断 diff 并在 prompt 内标注（commit message 不需要全量 diff，截断是功能内取舍不是缺陷）。

## 3 契约变化（圆心 `core/domain/sessions.ts`）

```typescript
// ---- GitReadApi 增强(向后兼容:字段新增,不改签名) ----
export interface GitChangedFile {
  path: string;
  index: string;     // staged 状态码(" "/"M"/"A"/"D"/"R"/"?")
  worktree: string;  // 工作区状态码
}
status(cwd) → Promise<{
  isRepo: boolean;
  branch: string | null;   // simple-git status 自带 current,零额外成本
  ahead: number; behind: number;
  files: GitChangedFile[];
}>
log(cwd: string, limit: number) → Promise<{ hash: string; message: string; author: string; timestamp: number }[]>
```

`GitChangedFile` 从单字母 `status` 改为 `index`/`worktree` 双码——simple-git 本来就有这两个字段，现状是压成一个字母丢掉了 staged 信息。这是**破坏性变更**：`status` 字段删除，`index`/`worktree` 新增。全仓库只有 git-review 一个消费者，同步改掉，不留兼容层（契约单源，不留"宽松版"漂移）。

## 4 分层落点

| 层 | 文件 | 改动 |
|---|---|---|
| 圆心 | `core/domain/sessions.ts` | `GitChangedFile` 双码化、`GitLogEntry`、`GitWriteApi`、`LlmOneshotApi`、`PluginContext` 挂 `gitWrite?` / `llm?` |
| client | `client/git/git-status.ts` | status 返回 branch/ahead/behind + 双码；新增 `log()` |
| client | `client/git/git-write.ts`（新） | `commitFiles` / `pushCurrent`，参数白名单 |
| client | `client/pi/pi-oneshot.ts`（新） | spawn `pi -p --no-session --no-tools`，超时/上限收敛 |
| api | `api/ipc/fs-git.ts` | git:write 两个 handler（assertPermission + 路径圈禁）；status/log 适配新返回 |
| api | `api/ipc/kernel.ts` | `llm:oneshot` handler（归 models/kernel 能力域） |
| api | `api/preload/` | window.pi 暴露 `gitWrite.*`、`llm.oneshot` |
| 发布面 | `packages/contract`、`packages/react` | 类型 re-export |
| 插件 | `plugins/project/git-review` | manifest 加 `git:write` + `llm:oneshot`；renderer 大改（见 §5）；locales 四语言补 key |

## 5 git-review 插件 UI

### 5.1 "Git 工作区"页签（改造）

- **分支条**（顶部）：`分支名 ↑ahead ↓behind`，push 按钮（`ahead > 0` 可点，带计数徽标）。
- **改动文件列表**：staged/unstaged 分组显示（纯展示分组，无 stage 按钮）+ 每文件 checkbox。树结构保留现有单链压缩。
- **commit 区**（底部）：message 输入框 + ✨生成按钮（`ctx.llm.oneshot`，prompt = 插件 locales 模板 + 勾选文件的 diff）+ 提交按钮。message 可手改。
- **最近提交**（折叠区）：`log(cwd, 10)` 只读列表，commit 后能看到落点。
- **streaming 时 commit/push 禁用**：agent 正在写文件时提交半成品是用户级事故，从 `useSessionStore` 读 streaming 态直接禁用两按钮（文档明示，不做文件锁）。

### 5.2 "本轮"页签（接真数据）

当前轮（最后一条 user 消息起的 assistant 序列）触碰的文件列表 + 点选看 `fileDiff`。空态：本轮 agent 未动文件。

### 5.3 "本对话"页签（接真数据）

按轮分组的可折叠列表：每轮显示 user 消息首行作标题 + 该轮触碰文件集，点文件看 diff。这就是"AI 改动审查器"的完整形态——回答"这几轮下来 agent 一共碰了哪些文件、各是什么 diff"。

### 5.4 刷新策略

沿用现有三档（可见/cwd/手动），追加一档：`toolCallEnd` 事件（write/edit）时重刷 turn 映射——事件驱动，不轮询（呼应"事件驱动，不轮询不 sleep"）。

## 6 演进方向（本期明确不做）

- **hunk 级 accept/reject + 拒绝回喂**：diff gutter 上加 Stage/Revert，拒绝的 hunk 经 `events.emit` 回喂 agent 重改（claude-diff-review 模式）。需要 `git:write` 扩大（`checkout -p` 式回滚）+ 事件契约设计。
- **checkpoint/rewind**：turn 前对 toolCall 触碰文件做快照（client/fs 落点，不走 git stash），恢复即写回。消除 §2.1 的脏文件语义边界。
- **bash 盲区消除**：需要底座在 toolCall 元数据里标注 bash 触碰的路径，属底座侧演进。

## 7 QA

**Q：commit 到一半 agent 还在改文件怎么办？**
streaming 中禁用 commit/push 按钮（§5.1）。用户手动绕过（快速点击）的残余风险与终端场景相同——git 本身是最后写入赢，不引入文件锁，文档明示。

**Q：oneshot 生成失败（无模型配置/网络/超时）？**
toast 报错 + message 框保持可手写。AI 生成是增强不是门槛，手写永远可用。

**Q：push 没有 upstream？**
simple-git 报错原文显示（如 `no upstream configured`），不自动 `push -u`——自动建远端跟踪分支超出"最小出口"定位。

**Q：diff 超大时 oneshot 怎么办？**
pi-oneshot 截断 diff（保留文件清单 + 前 N KB）并在 prompt 内标注"diff 已截断"。commit message 是摘要任务，截断不损核心能力。

**Q：`GitChangedFile` 双码化是破坏性变更，兼容怎么办？**
全仓库唯一消费者是 git-review，同步改。第三方插件若用了 `status` 字段会编译报错——这是契约演进的有意破坏性，比留两份定义漂移好（契约单源）。
