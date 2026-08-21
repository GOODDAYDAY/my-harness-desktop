# 核心规范（术语 · 数据结构 · 数据目录）

> 本文是**单一真相源**：把散在 CLAUDE.md 术语表、`core/domain/` 类型、`bootstrap/` 路径常量
> 三处的东西收敛成一份可检验的规范。术语定名、数据结构定形、数据目录定址。
> 依赖方向只向内（洋葱）：圆心 `core/domain/` 零依赖，外层向圆心依赖，内层绝不 import 外层。

---

## 1 核心术语（定名）

### 1.1 现行术语（唯一口径）

| 术语 | 定义 | 物理落点 |
|---|---|---|
| **内核**（kernel） | 自洽的 AI agent 运行时，自带插件树、会话模型、能力集。pi 和 dsh 各是一个，**同级**，谁也不比谁更内建 | 被壳管理的子进程；接入物 = spawn 命令 + 适配器 + 会话模型映射 |
| **壳**（shell） | my-harness-desktop 的薄壳：只提供机制（加载器/槽位契约/适配器装配/配置读写/权限沙箱） | `src/core/` + `src/client/` + `src/api/` + `src/bootstrap/` |
| **壳插件**（shell plugin） | 挂壳槽位的 UI 插件，只 import `@my-harness-desktop/contract` + `@my-harness-desktop/react` | `plugins/`（内置）+ 用户目录（第三方） |
| **内核插件**（kernel plugin） | 内核自己的能力来源 | pi = 装进进程的 TS 扩展；dsh = Cordis 插件树 |
| **中立契约**（contract） | 壳需要内核提供的最小意图集合，落成 `BaseBackend` 接口 | `core/domain/backend.ts` |
| **适配器**（adapter） | 内核专属形状 ↔ 中立契约的翻译层，每内核一个 | `PiBackend` / `DshBackend` |
| **圆心**（core） | 壳最里面一层，只有类型定义和纯函数，零依赖 | `core/domain/` |
| **中性**（neutral） | 不依赖任何框架/库/运行时/内核。中性类型是纯 TS 类型，中性事件去掉内核细节 | 圆心内的一切 |
| **lineage** | 会话里的一条线性历史。根 lineage 最早，fork 分支各一条。pi 的 parentId 树与 dsh 的 session forest 是同一棵 lineage 树的两种存储 | `core/domain/backend.ts` `LineageTree` |
| **槽位**（slot） | 壳预定的挂载点，壳只认槽位契约不认具体插件 | `core/domain/contributions.ts` `SlotName` |
| **PluginContext** | 壳插件能拿到的唯一 API 对象，经 `usePluginContext()` | `core/domain/context.ts` |
| **事件总线** | renderer 侧插件间事件通道，channel 代码级声明、框架自动注册 | `packages/react/src/event-bus.ts` |
| **JSONL** | JSON Lines，每行一个 JSON 对象。**传输细节**，不是语义契约 | pi 会话文件 / pi 传输 |
| **缺面 / 补面 / 降级** | 多内核能力三分法：缺面 = 内核没有某能力；补面 = 给缺能力的内核补实现；降级 = 壳收到"不支持"后隐藏入口 | §7.6 |

### 1.2 废弃术语（不再使用）

| 废弃 | 原因 | 现行替代 |
|---|---|---|
| **底座**（pi 底座） | 暗示"被管理资源"又暗含"pi 那一套"，两个意思混一词 | **内核** |
| 旧"内核" = 壳机制（`docs/DESIGN.md` 口径） | 与"pi/dsh 各是一个内核"冲突 | **壳** |

> ⚠ `docs/DESIGN.md` 仍沿用旧术语（"pi 底座"、"内核"指壳机制），是历史稿，以本文 + CLAUDE.md 为准。
> 新代码不得再写"底座"。

---

## 2 数据结构（定形）

### 2.1 单源规则

一个概念只有一份定义。全部类型从圆心 `core/domain/` 发出，外层 `import type` 或 re-export，
不写"本地版"。`"pi" | "dsh"` 字面量只允许出现在 `core/domain/kernel.ts` 一处。

### 2.2 核心契约（详列，圆心原子）

**内核身份** —— `core/domain/kernel.ts`

```ts
type KernelId = "pi" | "dsh";
const KERNEL_IDS = ["pi", "dsh"] as const;
```

**lineage 坐标系** —— `core/domain/backend.ts`

| 类型 | 形状 | 不变量 |
|---|---|---|
| `BoundaryRef` | `string`（不透明） | pi=entryId，dsh=seq 字符串化；总指向父 lineage 一个**完整回合之后**的位置 |
| `LineageFork` | `{ parentLineageId; boundary }` | 根 lineage 无此结构 |
| `Lineage` | `{ id; fork: LineageFork \| null }` | id 后端自留、壳当不透明 |
| `LineageTree` | `{ rootId; lineages: Lineage[] }` | 父子关系由 fork.parentLineageId 导出 |
| `Anchor` | `NeutralAnchor`（re-export） | 天然按内核划界：本内核建的锚点只能本内核 resume |

`projectLineageTree(roots): LineageTree` 是入口树 → lineage 树的纯函数投影（首子延续主线、其余子开分支）。

**中立会话坐标系** —— `core/domain/session-neutral.ts`

| 类型 | 形状 |
|---|---|
| `NeutralSessionId` | `{ value: string }`（壳生成 UUID，跨内核稳定主键） |
| `KernelSessionBinding` | `{ kernel; neutralSessionId; kernelPrivateId; boundAt }`（pi=JSONL 路径，dsh=session id） |
| `NeutralAnchor` | `{ lineageId; entryId }`（完全内核无关） |
| `NeutralSession` | `{ neutralSessionId; header; lineages: NeutralLineage[] }` |
| `NeutralSessionHeader` | `{ kernel; cwd; createdAt }` |
| `NeutralLineage` | `{ lineageId; fork: { parentLineageId; boundaryEntryId } \| null; entries: NeutralEntry[] }` |
| `NeutralEntry` | `{ neutralEntryId; kernelEntryId?; message: NeutralMessage }` |
| `NeutralModelRef` | `{ ref; effort? }`（壳自己的模型语义，非内核 provider/model） |
| `neutralEntryId()` | `${lineageId}:${seq}`（seq = 所属 lineage 内 0-based 序号） |

**中立契约 `BaseBackend`** —— `core/domain/backend.ts`（15 必实现 + 2 可缺面）

| 方法 | 语义 |
|---|---|
| `kernel` / `alive` | 内核身份 / 子进程存活 |
| `start` / `stop` | 起 / 停底座子进程 |
| `onEvent` | 订阅中性事件流（返回取消函数） |
| `fork(parentLineageId, boundary?)` | 从 boundary 切新 lineage，返回新 lineage id |
| `getTree` / `getEntries` | 读全部 lineage / 读一条 lineage 线性消息 |
| `bookmark` / `resume` / `deleteBookmark` | 持久化锚点 / 从锚点重启 / 删锚点 |
| `sendMessage` / `abort` / `setModel` | 发消息 / 中断 / 切模型 |
| `seed(session)` | 中立会话树 → 新内核会话标识（跨内核切换） |
| `listTools?` | 工具清单；null = 不支持（缺面默认） |
| `answerQuestion?` | 交互提问回填；不支持抛错（缺面默认） |

**工厂与选项** —— `core/domain/backend.ts`

- `BackendCreateOptions`：中性创建入参 `{ cwd; agentDir; kernel; provider?; model?; sessionId?; systemPromptPaths?; systemPromptTexts?; ephemeral?; maxTokens? }`。内核专属 spawn 参数（cliPath/cordisConfig/env）**不进本契约**。
- `BackendFactory`：`{ create(opts): BaseBackend }`。
- `SessionCatalog`（与 `BaseBackend` 正交）：跨会话存储 CRUD（list/open/rename/updateHeader/deleteSessions/copy/readToolConfig/readCustom/contextProbeTokens/newSessionId/projectStats/getTree/bookmark/deleteBookmark）。
- `SessionCatalogFactory`：`{ create(kernel): SessionCatalog }`。
- `KernelModelSource`：`{ listModels(): ModelInfo[] }`。

**内核版本管理** —— `core/domain/kernel-manager.ts`

- `KernelSpec`：`{ pkg; distTag?; pkgJsonPath; extraPackages?; cliWithinPkg; srcCli; srcPkgJson; cliJsLabel }`。
- `RegistryVersions` / `CustomCliResolution` / `InstalledVersionStatus`（+ `KernelStatusView` in `context.ts`）。

### 2.3 中性事件

`core/domain/events/session-state.ts`

- `SessionEvent`：判别联合（`ToolCallStart/Update/End`、`AgentStart/End/Settled`、`MessageStart/Update/End`、`EntryAppended`、`SessionStart`、`ModelSelect`、`CompactionStart/End`、`QueueUpdate`、`AutoRetryStart/End`、`TurnStart/End`、`SessionInfoChanged`、`ThinkingLevelChanged/Select` + 兜底 `{ type; [k]: unknown }`）。
- `NeutralMessage`：`{ role; content?; timestamp?; startedAt?; id?; pending?; stopped?; error?; [k]: unknown }`。
- `ModelInfo`：`{ kernel; provider; id; name; reasoning?; contextWindow?; maxTokens?; input? }`（`kernel` 由扫描来源赋值，**不进配置**）。
- `TokenUsage` / `ContextUsage` / `TurnUsage` / `SessionStats` / `ProjectStats`：token/上下文/轮次统计。
- `TreeNode` / `MessageEntry` / `SyncSnapshot`：入口树 / 消息条目 / resync 快照。

`core/domain/events/kernel-event.ts`：`KernelEvent`（`SessionMessageEvent` / `ExtensionUIRequestEvent` / `ProcessExitEvent` / `RpcErrorEvent`）+ `ExtensionUIResponse`。
`core/domain/events/session-bus.ts`：`SessionBusMessage` / `BusTap` / `BusApi` / `SessionDonePayload`。

### 2.4 会话与配置类型

`core/domain/sessions.ts`：`SessionInfo` / `SessionDetail` / `ImageInput` / `SessionToolConfig` / `SessionRole`（+`roleToPrompt`）/ `HeaderPatch` / `SessionModelPrefs` / `KnownToolInfo` / `ModelConfig` / `ProviderConfig` / `ModelsConfig` / `BashResult` / `SessionsApi` / `FsApi` / `GitReadApi` / `GitWriteApi` / `LlmOneshotApi` / `DialogApi` 等。纯函数：`cwdToBucketName` / `truncateSessionName` / `messageContentText` / `deriveSessionTitle` / `mergeModelsConfig` / `firstModelOf`。

### 2.5 槽位与插件契约

`core/domain/contributions.ts`：`SlotName`（已实现 20 槽：languages/themes/sidePanel/sidebar/mainView/titlebar/messageRenderers/fileActions/fileIcons/sessionGroupings/composerPolicies/composerAttachments/composerActions/messageActions/blockRenderers/codeBlockRenderers/settings/settingsGroups/fontPresets/systemPrompts + 预留 4 名：management/cardRenderers/viewers/commands）+ 各 `*Contribution` + `PluginContributes` + `PluginManifest` + `PluginTier`/`PluginState`/`PluginListItem`。

### 2.6 插件上下文与扩展

`core/domain/context.ts`：`PluginContext`（三层：pluginId 绑定层 config/fs/git/bash；系统级 prefs/themes/kernel/sessions 等；事件层 events）+ `PluginConfigApi` / `I18nApi` / `PluginEventsApi` / `AppInfo` / `KernelStatusView` / `DshModelSpec` / `DSH_OFFICIAL_PROVIDER`。
`core/domain/extensions.ts`：`ExtensionSource` / `ExtensionInfo`。

### 2.7 纯函数域

`working-phase.ts`（`WorkingPhase`）、`restart.ts`（`RestartState`/`RestartCoordinator`）、`file-icons.ts`（`FileIconIndex`）、`channel-meta.ts`（`ChannelMeta`/`ChannelInfo`）、`path-utils.ts`、`custom-order.ts`、`layout.ts`。

---

## 3 数据目录（定址）

### 3.1 桌面数据根（分流）

- 单源：`client/paths.ts` `resolveMyHarnessDesktopDir()`。
- 打包态 `~/.my-harness-desktop`；dev 态 `~/.my-harness-desktop-dev`。
- **逻辑前缀契约**：插件 manifest/renderer 里写的 `~/.my-harness-desktop/...` 是逻辑前缀，
  经 `expandDesktopPath` 映射到当前数据根——契约不变，物理落点随打包态分流。

### 3.2 数据根内的目录树

| 路径（相对数据根） | 内容 | 归属 |
|---|---|---|
| `config/` | `general.json` + electron-store prefs + 全局插件配置 `{pluginId}.json` | 壳配置 |
| `sessions/` | 中立会话存储（`NeutralSessionStore`）+ 会话绑定表（`SessionBindingStore`） | 壳会话层 |
| `pi/` | pi 内核 npm 安装目录（`PI_INSTALL_DIR`） | 内核版本管理 |
| `dsh/` | dsh 内核 npm 安装目录（`DSH_INSTALL_DIR`，含 cordis 插件 node_modules） | 内核版本管理 |
| `plugins/` | 用户级壳插件（`user` tier） | 插件加载器 |
| `installed/` | 已安装壳插件（`installed` tier，经插件管理器装） | 插件加载器 |
| `skills/` | 内置 skills 镜像（受管目录，启动时强制覆盖） | 壳技能层 |
| `stickers/bundled/` | 内置表情包镜像（受管目录） | 壳内容层 |

### 3.3 数据根之外（内核自有标准目录）

| 路径 | 内容 | 说明 |
|---|---|---|
| `~/.pi/agent/` | pi 底座标准目录（**不分流**，两版共享） | 非桌面数据根 |
| `~/.pi/agent/sessions/{bucket}/{ts}_{uuid}.jsonl` | pi 会话文件（JSONL + parentId 树） | pi 会话真相源 |
| `~/.pi/agent/settings.json` | pi 底座 settings（skills[] / packages 开关） | pi-settings 插件读写 |
| `~/.pi/agent/models.json` | pi 模型配置 | ModelsStore 读写 |
| `~/.pi/agent/extensions/` | pi TS 扩展（toolgate/subagent/bus/context-probe） | pi 扩展安装器 |
| `~/.dsh/cordis.yml` | dsh Cordis 配置（插件组成 + base） | `DSH_CORDIS_PATH`，env `DSH_CORDIS_CONFIG` 可覆盖 |
| `~/.dsh/settings.yaml` | dsh 用户覆盖 namespace | 解析链 = schema 默认 → cordis base → 用户分节 |
| `DSH_SESSION_ROOT`（env） | dsh 会话根；ephemeral 时指向临时目录（stop 清理） | dsh 会话真相源 |

### 3.4 项目级（跟 cwd 走）

| 路径 | 内容 |
|---|---|
| `<cwd>/.my-harness-desktop/config/{pluginId}.json` | 项目级插件配置（全局兜底） |
| `<cwd>/.my-harness-desktop/plugins/` | 项目级壳插件（`project` tier；打包态无"当前项目"，降级为另一用户级，M8 演进） |

### 3.5 随壳分发（resources，打包态）

| 路径 | 内容 |
|---|---|
| `resources/my-harness-desktop-builtin` | 内置壳插件（dev 态 = `src/plugins`） |
| `resources/my-harness-desktop-skills` | 内置 skills（dev 态 = `.claude/skills`） |
| `resources/my-harness-desktop-stickers` | 内置表情包（dev 态 = `assets/stickers`） |

### 3.6 路径纪律

1. **路径单源**：每个目录一处定义（`client/paths.ts` 数据根、`bootstrap/index.ts` 各常量），
   application 层不直读 `process.cwd()`/`process.env.HOME`，由 bootstrap 注入。
2. **内核专属路径不进契约**：`cliPath`/`cordisConfig`/`env`/`agentDir`(⚠ 见下) 是 spawn 细节，
   工厂闭包捕获，不进 `BackendCreateOptions`。
3. **已知偏离**：`BackendCreateOptions.agentDir` 名义中性、实际 dsh 忽略（pi 泄漏），
   终态应下沉到 `PiFactoryOptions`。

---

## 4 可检验清单

- [ ] 术语只用本文 §1.1 口径，"底座"/旧"内核"不再出现。
- [ ] 全仓 `"pi" | "dsh"` 字面量只在 `core/domain/kernel.ts` 一处。
- [ ] `core/domain/` 零外部 import；`core/application` 对 `client/` 零非 type-only import。
- [ ] 每个目录一处定义，无散落的 `join(HOME_DIR, ...)` 副本。
- [ ] 壳只认中性事件与 `LineageTree`，不读任何内核存储格式。
