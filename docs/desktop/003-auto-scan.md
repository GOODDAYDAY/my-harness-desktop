# 003 自动扫描：skills、tools、i18n 三套发现机制

pi-desktop 有三套独立的"自动发现"系统——skills 扫描、工具发现、i18n 语言资源收集。三者都在回答同一个问题："有哪些东西可用"。但发现方式、数据来源和执行时机完全不同。本文把三个系统并排讲清楚：各自从哪里发现、什么时候扫描、怎么注册生效、覆盖优先级如何。

先说结论：skills 是真正的文件系统扫描器（递归目录 + frontmatter 解析 + enabled 判定），最重；i18n 是启动期一次性的贡献项合并（插件声明 JSON 资源文件，合并器并集 + 冲突按优先级取高），中等；工具发现的权威在底座——桌面端不扫描文件系统，v4 起主通道是 tool-gate 底座扩展播报（扩展调 `pi.getAllTools()` 写侧车文件 `~/.pi/agent/desktop-known-tools.json`，桌面经 `kernel:knownTools` IPC 读取），插件里的硬编码清单和 `toolCallStart` 事件收集降为播报缺席时的兜底。

---

## 1 skills 扫描：四类来源 + 启用/禁用判定

### 1.1 发现来源

skills 扫描器（`src/core/application/skills/skill-scanner.ts:193`，`scanSkills` 函数）从三类固定目录 + settings.json 显式声明 + 插件约定目录中收集 SKILL.md：

**固定目录自动发现（`sourceType: "auto"`）**：

1. `~/.pi/agent/skills/` — user scope，`mode: "pi"`，递归找 SKILL.md，根目录裸 `.md` 也认（排除 README*）。
2. `~/.agents/skills/` — user scope，`mode: "agents"`，递归找 SKILL.md，根目录裸 `.md` 不认。
3. `<cwd>/.pi/skills/` — project scope，`mode: "pi"`。
4. `<cwd>/.agents/skills/` — project scope，`mode: "agents"`。
5. `<cwd>` 逐级向上的 `.agents/skills/`（到 `.git` 根止）— project scope，`mode: "agents"`。

**settings.json 显式声明（`sourceType: "settings"`）**：

6. `~/.pi/agent/settings.json` 的 `skills[]` 数组中不以 `!`/`+`/`-` 开头的普通条目 — user scope。每个条目 resolve 后，如果是目录则递归找 SKILL.md，如果是 `.md` 文件则直接当 skill。
7. `<cwd>/.pi/settings.json` 的 `skills[]` 数组普通条目 — project scope，同上。

**插件约定目录（`sourceType: "plugin"`）**：

8. 已注册插件的 `<pluginRoot>/skills/` 目录 — scope 跟插件 source 对齐：`project` 插件 → project scope，其余 → user scope。插件不需要在 `plugin.json` 里声明——目录存在即贡献。IPC 层的 `collectPluginSkillDirs`（`src/api/ipc/skills.ts:17`）遍历 `registry.allPlugins()`，逐个检查 `join(plugin.path, "skills")` 是否存在，收集成 `PluginSkillDir[]` 后注入 scanner。

**内置 skills（bundled）**：

9. 仓库顶级 `.claude/skills/` 随壳分发，启动时镜像到 `~/.pi-desktop/skills/`（强制覆盖），然后通过 `ensureBundledSkillsEntry`（`src/core/application/skills/bundled-skills.ts:43`）把该目录路径挂进 `~/.pi/agent/settings.json` 的 `skills[]`。内置 skills 不单独作为 scanner 的一个数据源——它经 settings.json → scanner 的标准路径被发现。

核心扫描逻辑是 `collectSkillEntries`（`skill-scanner.ts:67`），规则：
- 当前目录有 `SKILL.md` 即停止递归——该目录是一个独立 skill 单元。
- 否则遍历子目录：跳过 `.` 开头、跳过 `node_modules`、follow symlink。
- 刻意不读 `.gitignore` / `.ignore` / `.fdignore`——管理界面要展示"真实存在的全部技能"，与 pi 底座的加载策略解耦（方案 B，见 `skill-scanner.ts:7-11` 注释）。

### 1.2 扫描时机

skills 扫描不是持续运行的，而是按需触发，有三个入口：

- **IPC 请求**：renderer 调 `skills:list`（`src/api/ipc/skills.ts:31`），main 侧同步执行 `scanSkills()`，返回 `SkillInfo[]`。这是最常见路径——skill-manager 插件挂载时调一次。
- **文件监听（chokidar）**：renderer 调 `skills:watch`（`skills.ts:84`），main 侧用 chokidar 监听所有 sourcePath 目录 + 两个 settings.json 文件。监听到 `add`/`unlink`/`change`/`addDir`/`unlinkDir` 事件后去抖 300ms（`awaitWriteFinish` + 手动 debounce），然后往 renderer 推 `skills:changed` 事件。renderer 收到后重新调 `skills:list` 刷新 UI。watcher 生命周期跟随 cwd——切换项目时旧 watcher 关闭、新 watcher 创建。
- **项目切换**：renderer 的 `useEffect` 依赖 `currentCwd`，变化后重调 `skills:list`。

注意：文件监听实现的"热加载"只刷新 **UI 展示**。pi 底座不在扫描路径里——`scanner` 运行在 Electron main 进程，读的是同一份文件系统和 settings.json，但它不等同于"pi 底座实时感知变化"。pi 底座在下次启动新会话时读 settings.json 加载 skills；当前运行中的会话不受 scanner 影响。

### 1.3 注册与生效

scanner 的产出是 `SkillInfo[]`（`src/core/domain/skills.ts:10`），每个条目包含 `name`、`description`、`filePath`、`enabled`、`sourceType`、`scope`、`pluginId` 等字段。这个列表直接传给 renderer，不经过额外的"注册"步骤。

skills 的实际生效——即 pi 底座在会话中加载 skills——不归 scanner 管。生效路径是：

1. `scanSkills` 扫描文件系统 → 产出 `SkillInfo[]`（含 `enabled` 字段，由 `isEnabledByOverrides` 判定）。
2. skill-manager 插件调 `skills:toggle`（`src/api/ipc/skills.ts:41`） → `toggleSkill`（`src/core/application/skills/skill-toggle.ts:34`）往 settings.json 的 `skills[]` 数组写 `+{pattern}` 或 `-{pattern}` 条目。
3. pi 底座下次启动新会话时读 settings.json → `ResourceLoader.reload()` 加载 skills。

`enabled` 判定逻辑复刻 pi 底座的规则（`skill-scanner.ts:132`，`isEnabledByOverrides`）：
- 默认 `enabled = true`。
- `!pattern` 排除匹配的（`enabled = false`）。
- `+path` 强制启用（`enabled = true`，覆盖 `!`）。
- `-path` 强制禁用（`enabled = false`，最高优先级）。

### 1.4 覆盖与优先级

去重走 `realpathSync` + `seen` 集合（`skill-scanner.ts:199`）：同一个真实文件只保留先扫描到的。扫描顺序决定优先级——在 `scanSkills` 函数体内，数据源按固定顺序执行，先入 `seen` 的胜：

1. global settings `skills[]` 普通条目（user scope, `sourceType: "settings"`）
2. `~/.pi/agent/skills/`（`sourceType: "auto"`）
3. `~/.agents/skills/`（`sourceType: "auto"`）
4. `<cwd>/.pi/skills/`（`sourceType: "auto"`）
5. `<cwd>/.agents/skills/`（`sourceType: "auto"`）
6. ancestor `.agents/skills/`（`sourceType: "auto"`）
7. project settings `skills[]` 普通条目（project scope, `sourceType: "settings"`）
8. 插件 `skills/` 目录（`sourceType: "plugin"`，排最后）

注意：去重只认 **文件真实路径**（`realpathSync`），不按 skill name。两个不同路径的同名 SKILL.md 都会被收进列表，底座自己处理同名 skills 的加载优先级。

---

## 2 工具发现：tool-gate 播报（权威）+ 硬编码与事件收集（兜底）

### 2.1 发现来源

和 skills 不同，工具列表的"权威来源"是 pi 底座——底座在 spawn 时加载内置工具和扩展工具，决定 agent 能用哪些。pi-desktop **不扫描文件系统来发现工具**，没有桌面端的 tool scanner。v4 起工具发现有三个来源，权威优先、逐级兜底：

**tool-gate 播报（权威，v4 起）**：tool-gate 底座扩展（同时承担 §2.3 的硬过滤）在 `turn_start` 调底座扩展 API `pi.getAllTools()`，把全量工具清单（名称/描述/来源，sourceInfo 映射在扩展侧完成）写入 `~/.pi/agent/desktop-known-tools.json`，按 cwd 分桶；桌面经 `kernel:knownTools` IPC 读取。不挂 session_start——桌面扩展的 registerTool 门控在与 desktop 的握手之后，session_start 时集合未全，播报会把好桶回写成残缺集。播报走文件不走 RPC——底座 RPC 命令集至今没有 `get_tools`，与 v3 用 `setActiveTools` 替代 `set_tool_filter` RPC 同一思路。机制、文件契约、降级矩阵见 `docs/design/tool-manager-design.md` §4.4。

**硬编码已知工具清单（兜底底版）**（`src/plugins/manager/tool-manager/core/types.ts:45`，`BUILTIN_TOOLS`）：

```typescript
export const BUILTIN_TOOLS: KnownTool[] = [
  { id: "bash", name: "bash", description: "执行 shell 命令", source: "builtin" },
  { id: "read", name: "read", description: "读取文件内容", source: "builtin" },
  { id: "write", name: "write", description: "写入新文件", source: "builtin" },
  { id: "edit", name: "edit", description: "编辑文件", source: "builtin" },
  { id: "find", name: "find", description: "按模式搜索文件路径", source: "builtin" },
  { id: "grep", name: "grep", description: "搜索文件内容", source: "builtin" },
  { id: "ls", name: "ls", description: "列出目录内容", source: "builtin" },
];
```

七个条目覆盖 pi 底座内置工具。名称以底座注册名为准（`read`/`write`/`edit`/`bash`/`find`/`grep`/`ls`）。

**运行时事件收集（增量兜底）**（`src/plugins/manager/tool-manager/renderer/index.tsx:23`，`useDiscoveredTools`）：

```typescript
useEffect(() => {
  const off = ctx.sessions.onEvent((event) => {
    if (event.type === "toolCallStart" && event.toolName) {
      const name = event.toolName as string;
      if (!discoveredRef.current.has(name) && !BUILTIN_TOOLS.some((t) => t.id === name)) {
        discoveredRef.current.set(name, { id: name, name, description: "", source: "extension" });
        force((n) => n + 1);
      }
    }
  });
  return off;
}, [ctx]);
```

监听 `toolCallStart` 事件（底座 stdout 推的 `tool_execution_start`，经 `event-translator.ts:26` 翻译），把没见过的工具名记入内存 Map。这是事后补全——没跑过的工具发现不了；且是纯直播订阅（无回放、仅激活会话、组件挂载才订阅、内存态重启清零）。播报缺席时（tool-gate 未装、文件未写、该 cwd 无桶），最终工具列表落回 `BUILTIN_TOOLS + discoveredRef.current.values()` 的过渡形态。

**v4 落地**：`get_tools` RPC 不再是演进项——底座至今没有该命令，工具发现已由 tool-gate 播报接管（见上）。事件收集不删，作播报缺席时的增量兜底（`tool-manager-design.md` §4.3 的降级纪律：过渡期代码每一层都是上一层缺席时的兜底）。

### 2.2 扫描时机

工具发现不依赖定时扫描——它是事件驱动的：

- 播报文件在组件挂载、`system:sessionChanged`、cwd 变化时读取（`useDiscoveredTools` 经 `ctx.kernel.knownTools(cwd)`），不挂文件监听——工具清单不是秒级时效数据，新 spawn 必然伴随一次 sessionChanged。
- 硬编码清单在 tool-manager 插件的 `core/types.ts` 中静态定义，模块加载即存在。
- 事件收集在 tool-manager 插件的 renderer 组件挂载时启动（`useDiscoveredTools` hook 里的 `useEffect`），监听 `toolCallStart` 事件。
- 工具列表的变化（扩展启用/禁用）在下次 spawn 后的首个 turn 由 tool-gate 播报自动反映——pi loader 只在 spawn 时扫扩展目录，新进程 turn_start 播报新集合，与过滤的生效粒度同频。

### 2.3 注册与生效

工具不经过"注册"——发现列表直接用于 UI 渲染和管理。

工具的过滤生效机制分两条路径：

**硬过滤（tool-gate 底座扩展）**：`src/client/pi/toolgate-installer.ts` 在 desktop 启动时把 `packages/toolgate/index.ts` 同步到 `~/.pi/agent/extensions/tool-gate/`。该扩展挂 `session_start` + `turn_start` 钩子，读会话文件 header 的 `toolConfig.enabledToolIds`，调 `pi.setActiveTools` 强制过滤。LLM 试图调用未列出工具时底座直接拒绝。

**软过滤（prompt 注入）**：tool-gate 未装时，timeline 插件发送消息前，在用户消息前拼一条系统指令列出可用工具（`[System] 本次会话已限制可用工具。可用工具: read, write, edit...`）。LLM 可能不遵守，UI 上显式标注"软过滤"。

两种路径由 `toolgateAvailable()`（`toolgate-installer.ts:56`）探测切换——检查扩展文件是否存在于底座目录。探测点在两处：timeline 发送路径每次发送前探一次（决定要不要拼软注入指令），tool-manager 右面板挂载时探一次（决定显不显示降级提示）。

### 2.4 覆盖与优先级

工具没覆盖语义，因为工具列表是**集合**——三个来源并集合并；同名冲突以播报文件为准（它带真描述与真来源），播报缺席时硬编码清单打底、事件收集增量补全同名跳过。

工具组（`ToolGroup`）经插件统一配置通道 `ctx.config` 读写（key 为 `groups`），物理落盘 `<cwd>/.pi-desktop/config/tool-manager.json`（项目级，`~/.pi-desktop/config/tool-manager.json` 全局兜底）；会话级过滤配置存储在会话 JSONL header 的 `toolConfig` 字段。工具组是 UI 层的组织抽象——不影响工具本身的可用性，只影响用户在右面板里怎么选。

---

## 3 i18n 语言资源：插件贡献声明 + 启动期合并

### 3.1 发现来源

i18n 语言资源只有一个来源：插件在 `plugin.json` 的 `contributes.languages` 里声明 JSON 资源文件路径。没有文件系统自动扫描，没有目录约定——纯粹是 manifest 驱动的声明式机制。

以 i18n 内置插件为例（`src/plugins/system/i18n/plugin.json`），声明 48 个资源文件（4 语言 × 12 命名空间），如：

```json
{
  "contributes": {
    "languages": [
      { "id": "zh-CN-common", "locale": "zh-CN", "resources": "locales/zh-CN/common.json" },
      { "id": "en-settings", "locale": "en", "resources": "locales/en/settings.json" }
    ]
  }
}
```

每个贡献项有 `id`、`locale` 和 `resources`（JSON 文件相对于插件根目录的路径）。

资源文件的收集不在 scanner 里，也不在 IPC 层。它在 bootstrap 阶段直接发生：

```typescript
// src/bootstrap/index.ts:95-96
const languageContributions = registry.languageContributions();
const i18nResources = mergeLanguageContributions(languageContributions);
```

`registry.languageContributions()` 遍历所有已注册插件的 manifest，收集 `contributes.languages` 数组，带上 `pluginId`、`source`（`builtin`/`user`/`installed`/`project`）、`pluginPath`（用于解析相对 resources 路径）元信息。

### 3.2 扫描时机

i18n 资源的"发现"只在 **启动期执行一次**——bootstrap 在构造所有依赖之后、打开窗口之前，调用 `mergeLanguageContributions`。没有热加载、没有文件监听、没有按需扫描。

语言切换不触发重新扫描——`changeLocale`（`src/core/application/i18n/translator.ts:76`）只是让 i18next 换当前语言，资源集不变。

这意味着：如果运行时新增了一个带 `languages` 贡献的插件，它的资源不会自动进入 i18next。需要重启应用。

### 3.3 注册与生效：合并

`mergeLanguageContributions`（`src/core/application/i18n/merge.ts:77`）是核心合并函数，逻辑分两步：

**Step 1：按 locale 分组，做 key 级 union**。

- 每个 `resources` JSON 文件被读入为扁平的 `Record<string, string>`。
- key 的第一个 `.` 之前是 namespace（无 `.` 走 `common`）。
- 相同的 `{namespace}:{key}` 冲突时按 source priority 取高：
  - `project: 4` > `user: 3` > `installed: 2` > `builtin: 1`
  - 同优先级先处理者胜（注册表按 source 分组注册的顺序：`project` → `user` → `installed` → `builtin`，每组内按插件目录遍历序）。
- 不冲突的 key 全保留——这是字典 union 不是贡献项级二选一。

**Step 2：聚合成 i18next resources 结构**。

- 输出是 `{ locale: { namespace: 嵌套 key 树 } }`。
- namespace 内按剩余 `.` 逐层嵌套（i18next `keySeparator: "."` 以此分层查找）。

合并结果在 `bootstrap/index.ts` 构造 MainContext 时注入：

```typescript
// bootstrap/index.ts:194-198
i18n: {
  resources: i18nResources,
  namespaces: collectNamespaces(i18nResources),
  supportedLngs: collectSupportedLngs(languageContributions),
  localeList: collectLocaleList(...),
},
```

renderer 侧从 MainContext 拿到这些值后，调用 `initTranslator`（`translator.ts:49`）初始化自己的 i18next 实例（main 和 renderer 各持独立实例，跨堆不能共享）。

### 3.4 覆盖与优先级

优先级表钉死在 `mergeLanguageContributions` 里（`merge.ts:21`）：

```
project: 4 > user: 3 > installed: 2 > builtin: 1
```

高值胜。第三方插件（user/project 级）可以覆盖内置 i18n 插件的任意 key——因为内置是 `builtin`，优先级最低。这和 skills 的去重机制不同：skills 去重是"先到先得"（文件真实路径首次入 `seen`），i18n 冲突是"高值覆盖低值"（按 source priority 取高）。

关键差异：skills 的数据源顺序是 scanner 内部的实现选择（可以通过调整 `addEntries` 调用顺序改变），i18n 的优先级是显式静态表——它不依赖扫描顺序，source priority 数值本身决定了谁覆盖谁。

---

## 4 三套机制对比

| 维度 | skills 扫描 | 工具发现 | i18n 语言资源 |
|------|-----------|---------|-------------|
| 发现方式 | 文件系统递归扫描（`collectSkillEntries`） | 硬编码清单 + 运行时事件收集 | 插件 manifest 声明 + 启动期合并 |
| 数据源 | 固定目录 + settings.json + 插件约定目录 + 内置镜像 | 硬编码 `BUILTIN_TOOLS` + `toolCallStart` 事件被动补全 | `contributes.languages` 声明（`plugin.json`） |
| 是否有独立的 scanner | 有，`src/core/application/skills/skill-scanner.ts`，完整实现 | 没有——没有扫描器，没有文件系统遍历。`useDiscoveredTools` hook 只是合并两个数组 | 没有——`mergeLanguageContributions` 是合并器不是扫描器，读文件但不去"发现"文件 |
| 执行时机 | IPC 请求 + chokidar 监听 + 项目切换 | 插件挂载时启动事件监听 | 启动期一次（bootstrap） |
| 是否支持热加载 | UI 热加载（文件变化刷新列表），但 pi 底座下次会话才感知 | 事件驱动的增量补全 | 不支持——新增插件资源需要重启应用 |
| 去重/冲突 | `realpathSync` + `seen` set，先到先得 | 同名工具跳过，不覆盖 | 字典 union，冲突按 source priority 取高值 |
| 代码重量 | 重——324 行 scanner + 168 行 toggle + 130 行 IPC | 薄——80 行 types + hook 里 ~20 行事件监听 | 中——173 行 merge + 94 行 translator |
| 生效目标 | pi 底座 settings.json `skills[]` | tool-gate 扩展硬过滤 / timeline prompt 软注入 | i18next 实例（所有插件 `t()` 共用） |

### 4.1 共性

三套机制有三个共同基因：

**约定优于配置**。skills 的 `skills/` 子目录（插件贡献）和 `SKILL.md` 文件名都是约定，不用 manifest 声明；i18n 虽然走声明式，但资源文件的 `locales/{locale}/{namespace}.json` 目录结构是约定；工具发现虽然最薄，内置工具组（PRESET_GROUPS）也遵循命名约定。

**优先级分层**。skills 靠扫描顺序（先入 `seen` 者胜），i18n 靠显式 source priority 数值表，工具无冲突语义——但三者在"不同来源有不同的权重"这一点上一致。插件贡献的 skills 排在所有固定目录之后（最低优先级），内置 i18n 插件的文案可被任何第三方覆盖。

**扫描结果 = 展示列表**。三者的产出都是直接给 renderer 消费的数组/字典，不经过额外的中间注册步骤。skills 产出 `SkillInfo[]`，工具产出 `KnownTool[]`，i18n 产出 `I18nResource`。

### 4.2 差异：为什么工具发现的代码最薄

根源在于"工具是谁的"。pi 底座拥有工具——它加载内置工具、加载 extension 贡献的工具、决定 agent 的可用工具集。`toolCallStart` / `toolCallUpdate` / `toolCallEnd` 事件从底座推过来，桌面端是被动消费者。

pi-desktop 不扫描文件系统来找工具，因为这不存在于文件系统里——工具是底座运行时的内存状态。桌面端唯一能做的是两件事：
1. 在插件里维护一份硬编码清单（覆盖底座内置工具），因为底座内置工具是已知的、稳定的。
2. 从事件流里被动收集跑过的工具名，补全硬编码清单的缺口。

这个薄实现不是偷工减料——是"消费而非翻译"（DESIGN.md §3.1）的直接体现：底座吐出工具事件，桌面消费，不试图去"扫描"一个不存在的文件系统。真正的解决方案是底座补 `get_tools` RPC——那时硬编码清单和事件收集都可以删掉，换成一次 RPC 调用。在那之前，这个薄实现是诚实的现状。

### 4.3 差异：为什么 i18n 没有文件监听

i18n 的资源文件不在用户频繁改动的路径下——它们随插件分发，正常情况下不会在运行时被编辑。skills 目录不同——用户在 `~/.claude/skills/` 里加一个 skill 目录是日常操作，所以需要 chokidar 监听。

i18n 的启动期一次性合并还有一个隐含好处：合并结果在整个应用生命周期内不变，i18next 实例稳定，所有 `t()` 调用不需要处理"资源中途变化"的竞态。如果未来需要支持运行时加载新语言插件（装一个第三方语言包即生效），需要在 bootstrap 的重启协调里加一步：新插件注册 → 重新合并 → `i18next.addResourceBundle` 增量注入。当前不支持不是设计遗漏，是这个场景还没有需求驱动。

---

## 5 相关代码索引

| 文件 | 职责 |
|------|------|
| `src/core/domain/skills.ts` | `SkillInfo`、`ScanOptions`、`PluginSkillDir` 契约 |
| `src/core/application/skills/skill-scanner.ts` | 全量扫描器：`scanSkills`、`collectSkillEntries`、`isEnabledByOverrides` |
| `src/core/application/skills/skill-toggle.ts` | `toggleSkill`/`addSkillPath`/`removeSkillPath`/`toggleForceInvocation` |
| `src/core/application/skills/skill-paths.ts` | `toPosixPath`/`resolvePath`/`isOverridePattern` 共享 helper |
| `src/core/application/skills/bundled-skills.ts` | 内置 skills 镜像 + `ensureBundledSkillsEntry`/`ensurePluginSkillsEntry` |
| `src/api/ipc/skills.ts` | skills IPC handler（list/toggle/addPath/removePath/watch/unwatch）+ chokidar |
| `src/plugins/manager/skill-manager/` | skills 管理 UI 插件 |
| `src/plugins/manager/tool-manager/core/types.ts` | `BUILTIN_TOOLS` 硬编码清单 + `PRESET_GROUPS` + `ToolGroup` 类型 |
| `src/plugins/manager/tool-manager/renderer/index.tsx` | `useDiscoveredTools`：事件驱动的工具发现 hook |
| `src/client/pi/toolgate-installer.ts` | tool-gate 底座扩展同步 + `toolgateAvailable` 探测 |
| `src/core/application/i18n/merge.ts` | `mergeLanguageContributions`：key 级 union，source priority 冲突解决 |
| `src/core/application/i18n/translator.ts` | `initTranslator` / `changeLocale` / `detectLocale`：i18next 单例管理 |
| `src/bootstrap/index.ts` | 启动期 i18n 合并入口（第 93-96 行） |
| `src/core/domain/contributions.ts` | `LanguageContribution` 槽位契约 |
