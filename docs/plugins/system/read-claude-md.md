# read-claude-md：会话启动自动加载全局与项目级 CLAUDE.md

read-claude-md 是系统域里唯一一个"无 renderer、无 locales、无 contributes"的壳插件——它只声明一个 `piExtension: "./pi-extension"` 字段，把一个 pi 内核扩展（TypeScript）随插件启停同步进内核，让内核在会话启动时自动发现并注入用户全局（`~/.claude/`）与项目级（cwd 逐级向上）的 CLAUDE.md 指令文件。它出的是能力不是 UI，它的"UI"是内核扩展钩子（`session_start`/`before_agent_start`）和一个内核命令（`claude-md`）。同一能力在 dsh 内核里的对称实现，不是靠本插件目录里的 `dsh-extension/`，而是被合并进了统一适配插件 `my-harness-fit-dsh-extension`（`src/server/kernel/dsh/extension/dsh-extension/index.mjs`）。

## 职责边界

read-claude-md 做一件事：**让会话启动时自动带上 CLAUDE.md 指令上下文**。它不渲染任何 UI，不订阅任何事件总线 channel，不读写壳的配置。它的全部逻辑住在内核扩展里，壳只负责一件事——生命周期同步（activate 时同步进内核、deactivate 时摘除）。这个"壳插件 + 内核扩展"的二分，正是 §7.7 四件套里"renderer + pi-extension/dsh-extension"的极端形态：一个功能可以没有 renderer，只有内核扩展。

- **为什么是内核扩展而不是壳直接读文件**。CLAUDE.md 要注入的是**内核会话的上下文**（system prompt 或隐藏消息），这是内核的内部行为。壳（`session-store`）只负责 spawn 内核进程、传 `BackendCreateOptions`（含 `systemPromptPaths`），不负责"发现哪些 CLAUDE.md、怎么拼进上下文"——那是内核侧的事。所以发现和注入逻辑写在内核扩展里，壳经 `piExtension`/`dshExtension` 字段声明"这个插件带着一个内核扩展"，框架同步。壳不读任何内核存储格式，也不读 CLAUDE.md 的发现规则。

## 目录结构

```
src/plugins/system/read-claude-md/
  plugin.json              manifest：只声明 piExtension 字段
  pi-extension/
    package.json           pi 扩展包元数据：name + pi.extensions=["./extension"]
    extension/
      index.ts             readClaudeMdExtension 导出默认函数，挂两个钩子 + 一个命令
```

没有 `renderer/`、没有 `locales/`、没有 `dsh-extension/` 目录。dsh 侧对称实现在别处（统一适配插件），这是本插件最特殊的一点——它的四件套被拆成了"pi-extension 在本目录 + dsh-extension 收敛到统一适配插件"，原因见下文"dsh 对称实现"一节。

## plugin.json 逐字段

```json
{
  "id": "read-claude-md",
  "version": "0.1.0",
  "tier": "official",
  "displayName": "CLAUDE.md 自动加载",
  "description": "内置底座扩展随插件启停同步：会话启动自动发现全局（~/.claude/）与项目级（cwd 逐级向上）CLAUDE.md 指令文件，以隐藏消息注入会话上下文；卸载即停止同步。",
  "tags": ["productivity"],
  "piExtension": "./pi-extension"
}
```

- **`piExtension` 字段**。这是 `PluginManifest` 契约里的一个可选字段（`packages/shared/src/domain/contributions.ts` 第 511 行）：`piExtension?: string`，插件目录内相对路径。声明后框架在 activate 时把它同步到 `~/.pi/agent/extensions/<pluginId>/`，deactivate/uninstall 时摘除。注释点明这是"内容插件私货的生命周期通道"，区别于 toolgate 等内核基础设施的 bootstrap 常驻同步。

- **`dshExtension` 字段的存在与缺位**。`PluginManifest` 第 517 行有对称的 `dshExtension?: string`（同步到 `~/.dsh/.my-harness-desktop-plugins/<pluginId>/` 并挂 cordis.yml 块），注释直接拿 read-claude-md 举例："读用户全局 CLAUDE.md 的能力，pi 侧走 piExtension（read-claude-md 内核扩展），dsh 侧走本字段（dsh cordis 插件）——同一能力在两个内核里的对称实现"。但**当前 read-claude-md 的 plugin.json 没有声明 `dshExtension`**——因为它的 dsh 侧已从"随插件携带"收敛成"统一适配插件常驻同步"（`assemble.ts` 第 164 行的 `DSH_FIT_EXTENSION_SOURCE`，合并 ask/goal/read-claude-md/skill-manager 四个插件随附的 dsh 插件为一块）。这是契约注释和当前实现的时差：契约字段支持对称携带，但 read-claude-md 走了"收敛进统一适配插件"这条后来的路。

- **`pi-extension/package.json`**（第 1–9 行）。`name: "pi-read-claude-md"`，`pi.extensions: ["./extension"]` 声明扩展入口目录。`pi` 字段是 pi 内核扩展包的分发标记，内核安装器据此识别扩展入口。

## pi 内核扩展（pi-extension/extension/index.ts）

`readClaudeMdExtension(pi)` 是默认导出（第 172 行），`pi` 是内核注入的 `ClaudeMdApi` 窄镜像。文件头注释（第 15–18 行）交代了一个关键纪律：**类型不 import 官方 `@earendil-works/pi-coding-agent`**（类型包在内核 node_modules，仓库 tsconfig 够不到），而是手写用到的窄结构 `ClaudeMdContext`（第 25–30 行）和 `ClaudeMdApi`（第 33–42 行），与 toolgate/llm-recorder 同纪律，保持本文件在仓库 typecheck 视野内。

### 发现规则（`discoverClaudeFiles`，第 106–142 行）

发现分三档，farthest-first（CSS cascade 序，后加载的更具体、优先级更高），按 resolved 路径去重。

- **global**（第 125–127 行）。`~/.claude/CLAUDE.md` + `~/.claude/rules/` 下全部 `.md`（`findMarkdownFiles` 递归，第 68–91 行，`readdirSync` with `withFileTypes`，按文件名字典序稳定排序）。`os.homedir()` 展开 `~`。

- **project**（第 129–139 行）。`collectDirsUpward(cwd)`（第 94–104 行）从 cwd 逐级向上到文件系统根，`reverse()` 后从最远祖先处理到 cwd——每级读 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/` 下全部 `.md`。farthest-first 让"越靠近 cwd 的文件后加载、优先级越高"。

- **local**（第 138 行）。每级 `CLAUDE.local.md`，scope 标 `local`，是用户本地的、不进版本控制的覆盖层。

### 注入策略（`before_agent_start`，第 190–211 行）

这是注入的核心钩子，三个决策值得展开。

- **注入隐藏消息而非改 system prompt**。`before_agent_start` 返回 `{ message: { customType: "claude-md-context", content: buildPromptSection(cachedFiles), display: false } }`（第 204–209 行）。`display: false` 是不在 UI 时间线显示，`customType: "claude-md-context"` 是消息类型标记。为什么不用 `--append-system-prompt` 改 system prompt：system prompt 跨 turn 保持稳定，Anthropic prompt cache 可持续命中；每次注入 CLAUDE.md 进 system prompt 会让 system prompt 变化、破坏 prompt cache。所以用"每会话注入一次的隐藏会话消息"，system prompt 不动。

- **只注入主交互会话（`ctx.hasUI` 过滤）**。第 194 行 `if (!ctx.hasUI) return;`。sub-agent 不需要 CLAUDE.md，注入既浪费 token，其 cwd 差异还会破坏 prompt cache 稳定性。`hasUI` 是 `ClaudeMdContext` 的窄镜像字段（第 27 行注释"主会话 true，sub-agent false"）。

- **每会话只注入一次（cwd 变化时刷新重注）**。`injected` 标志（第 202–203 行）+ `ctx.cwd !== cachedCwd` 时 `refresh`（第 195–197 行）。`refresh`（第 177–181 行）重算 `cachedCwd`/`cachedFiles` 并 `injected = false`。

### 会话启动通知与命令

- **`session_start`（第 183–188 行）**。`refresh(ctx.cwd)` + `cachedFiles.length > 0` 时 `ctx.ui.notify(\`Loaded ${n} CLAUDE.md file(s)\`, "info")`。这是启动时的一次性提示，让用户知道加载了几个文件。

- **`registerCommand("claude-md", ...)`（第 213–230 行）**。注册内核命令 `claude-md`，handler 展示当前已发现的文件清单（`📘 Loaded CLAUDE.md files:` + CWD + 每条 `[scope] path`），cwd 变化先 refresh。这是"用户在内核终端里查当前加载了哪些 CLAUDE.md"的调试入口。

### `buildPromptSection`（第 144–170 行）

把 `ClaudeFile[]` 拼成一段注入文本：`## Loaded CLAUDE.md Instructions` + 文件清单（`1. [global] /path`）+ 每个文件的 `### N. /path (scope)` 下的 ````` ```md ````` 代码块。文件按 global→project→local 的加载顺序排列，文本里明说"later entries take precedence"（后加载的更具体、优先级更高）。

## dsh 对称实现（统一适配插件）

dsh 侧的 CLAUDE.md 注入在 `src/server/kernel/dsh/extension/dsh-extension/index.mjs` 第 262–332 行 + 第 584–610 行。它不是 read-claude-md 目录里的东西，但它是"读用户全局 CLAUDE.md"这个能力在 dsh 内核的对称实现，必须讲清。

- **收敛原因**。`assemble.ts` 第 163–166 行注释：ask/goal/read-claude-md/skill-manager 四个插件原本各自携带 dsh cordis 插件，现收敛成一块 `my-harness-fit-dsh-extension`（`DSH_FIT_EXTENSION_SOURCE`），bootstrap 常驻同步、不随桌面插件启停。这是 skill-manager.md 里写明的"内核侧补面收进统一适配插件"变体——四个能力的 dsh 侧都收敛进一块插件，避免四个插件各带一份 dsh cordis 的重复。`extension.json`（`dsh-extension/extension.json`）的 description 写"合并原 ask/goal/read-claude-md/skill-manager 四个 dsh 扩展"。

- **钩子不对称：`agent/pre-step` vs `before_agent_start`**。pi 挂 `before_agent_start`/`session_start`，dsh 挂 `agent/pre-step`（第 586 行 `ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => ...)`）。这是内核能力形状差异——dsh 的 Cordis 生命周期钩子是 `agent/pre-step`，pi 的扩展钩子是 `before_agent_start`。语义对齐：都在"agent 开始前"注入指令。

- **scope 不对称：dsh 只做 global**。第 264–266 行注释点明："只做全局（`~/.claude/CLAUDE.md` + `~/.claude/rules/` 下全部 .md，递归）；project 级由 dsh 自带 agent-instructions 负责（已从 projectRoot 到 cwd 逐级读 AGENTS.md/CLAUDE.md），两边不重叠"。这是"适配器翻译 + 显式分工"的典型：dsh 内核**自带**项目级 CLAUDE.md/AGENTS.md 发现能力（agent-instructions 插件），所以桌面端的 dsh 扩展不重复做，只补 dsh 没有的**全局** `~/.claude` 部分。pi 内核没有这个自带能力，所以 pi 扩展把 global+project+local 全做。两边的"对称"是能力上的对称（都让会话带上 CLAUDE.md），不是实现上的逐行对称——各自按内核已有能力补缺。

- **`discoverGlobalClaudeFiles`（第 303–317 行）**。只扫 `~/.claude/CLAUDE.md` + `~/.claude/rules/` 递归 `.md`，按路径去重，scope 全标 `global`。`buildPromptSection`（第 319–325 行）与 pi 侧同构（同样的 `## Loaded CLAUDE.md Instructions` 格式）。

- **注入的 source 命名空间陷阱（第 591–606 行）**。这是 dsh 侧最重要的实现细节。注入的 message 用 `source: { kind: "plugin", plugin: "my-harness-fit-dsh-extension", form: "instructions" }`，并**严禁复用 dsh 的 agent-instructions 命名空间（尤其 `baseline: true`）**。原因在注释里写得很重：dsh 的 agent-instructions 插件会把 `baseline: true` 标记的消息当作"可见基线"反查，直接读 `changes` 字段——这里只注入全局 `~/.claude` 指令、从不带 `changes`/`baselineIdentity`，误用该标记会让 dsh 第二回合在 `visibleBaseline.changes.flatMap()` 处 `changes=undefined` 整回合崩溃（注释点明这是"dsh 不能发送第二条语句"的真正根因，本地源码裸 RPC 复现过）。改用独立 `kind: "plugin"` 让 dsh 不识别为基线（不再崩）、壳翻译器仍按非 user 丢弃（不进时间线气泡）、模型照常可见。

- **幂等注入（第 598–606 行）**。`sameContext(m, desired)`（第 328–332 行）逐字段比较 role + content + source（对齐 agent-instructions 的 `sameContextPayload`），`decision.messages.some(...)` 已存在就不重复注入；`cached` 缓存发现结果（`cached === undefined` 时才算一次）。`lastClaimedIndex`/`toSpliced` 把消息插到正确位置。

## 生命周期：随插件启停同步

read-claude-md 的壳侧唯一逻辑是生命周期同步，由 `assemble.ts` 的 `pluginPiExtensionEnsure` hooks 承担（第 352–360 行左右）。

- **activate**。`syncPluginPiExtension(pluginId, join(pluginPath, piExtension))` 把 `pi-extension/` 目录同步到 `~/.pi/agent/extensions/read-claude-md/`。`piExtensionEnsure` 是 `PluginLifecycleDeps` 的一个可选依赖，框架在插件 activate 时调 `onActivate`。

- **deactivate/uninstall**。摘除同步目录，内核下次会话不再加载该扩展。这就是 plugin.json description 里的"卸载即停止同步"。

- **受保护扩展**。`src/server/kernel/pi/extension/pi-extension-manager.ts` 第 17 行 `const PI_PROTECTED = ["read-claude-md", "tool-gate"]`——read-claude-md 在 pi 侧受保护名单里，不可关/不可卸（`disallowOff: true`）。`docs/core/extension-management.md` 第 82 行和第 463 行也列出它是受保护 extension（负责加载 CLAUDE.md 进上下文，禁用会导致 agent 行为异常）。这是内核机制判断（不是插件声明）：扩展管理器内部维护受保护名单，`disable()` 直接 return，UI 显示"受保护"标签不渲染 toggle。

## 贡献的槽

read-claude-md 不贡献任何槽——没有 `contributes` 字段。它的"贡献"是 `piExtension` 这个生命周期通道（`PluginManifest.piExtension`），不是槽位。这是它和其他六个系统域插件最大的不同：它是唯一的"纯内核扩展壳插件"，壳插件形态的边界样本——一个壳插件可以只有 `plugin.json` + `pi-extension/`，出能力不出 UI。

## 与其他插件交互

- **与 skill-manager 的并列关系**。skill-manager.md 里点明：ask/goal/read-claude-md/skill-manager 四个壳插件的 dsh 侧内核补面收敛成统一适配插件 `my-harness-fit-dsh-extension`，bootstrap 常驻同步。所以 read-claude-md 与 skill-manager 共享同一块 dsh 适配插件的同步生命周期，但各自的能力钩子（read-claude-md 的 `agent/pre-step`、skill-manager 的 fork skill-filesystem）在 index.mjs 里分节实现（第 262 节和第 334 节）。

- **与 goody-hao 的对比**。两者都往会话上下文注入内容，但机制不同：goody-hao 走 `systemPrompts` 槽（`--append-system-prompt` 注入 pi system prompt），read-claude-md 走内核扩展的 `before_agent_start` 钩子（隐藏会话消息注入）。前者是壳插件声明 + session-store 收集 + 内核工厂翻译；后者是内核扩展直接在内核里注入。一个是"壳往内核传提示"，一个是"内核自己发现并注入"。

- **与 i18n/timeline 无交互**。它没有 UI，不消费 i18n，不进 timeline。`customType: "claude-md-context"` + `display: false` 的隐藏消息不进时间线气泡（壳翻译器按非 user 丢弃）。

## 相关契约与类型落点

- `PluginManifest.piExtension`/`dshExtension`：`packages/shared/src/domain/contributions.ts:511/517`
- `BackendCreateOptions.systemPromptPaths`（对比用，goody-hao 的机制）：`packages/shared/src/domain/backend.ts:232`
- `PluginLifecycleDeps.piExtensionEnsure`：`src/server/application/lifecycle`（生命周期依赖）
- 统一适配插件源：`src/server/bootstrap/assemble.ts:163–166`（`DSH_FIT_EXTENSION_SOURCE`）
- pi 受保护名单：`src/server/kernel/pi/extension/pi-extension-manager.ts:17`

## QA

**Q：为什么 read-claude-md 目录里没有 `dsh-extension/`？**

A：因为它的 dsh 侧被收敛进了统一适配插件 `my-harness-fit-dsh-extension`（`src/server/kernel/dsh/extension/dsh-extension/index.mjs`），不再随插件携带。`assemble.ts` 第 163–166 行注释：ask/goal/read-claude-md/skill-manager 四个插件原本各带一份 dsh cordis 插件，收敛成一块后 bootstrap 常驻同步。这是"内核侧补面收进统一适配插件"的变体，避免四个插件各带一份 dsh cordis 的重复。契约 `PluginManifest.dshExtension` 字段仍支持对称携带（contributions.ts 第 517 行注释还拿 read-claude-md 举例），但 read-claude-md 走了后来的收敛路径，字段空置。

**Q：为什么 pi 侧做 global+project+local 三级发现，dsh 侧只做 global？**

A：因为 dsh 内核**自带**项目级发现能力。dsh 的 agent-instructions 插件已从 projectRoot 到 cwd 逐级读 AGENTS.md/CLAUDE.md，桌面端的 dsh 扩展不重复做，只补 dsh 没有的全局 `~/.claude` 部分（index.mjs 第 265–266 行注释）。pi 内核没有这个自带能力，所以 pi 扩展把三级全做。这是"适配器翻译 + 显式分工"——能力上的对称（都让会话带上 CLAUDE.md），不是逐行对称。两边按内核已有能力补缺，不重复发明。

**Q：为什么用隐藏消息注入而不是改 system prompt？**

A：为了 prompt cache 稳定性。system prompt 跨 turn 保持稳定，Anthropic prompt cache 可持续命中；把 CLAUDE.md 每次注入 system prompt 会让 system prompt 变化、破坏 cache。所以用"每会话注入一次的隐藏会话消息"（`customType: "claude-md-context"`, `display: false`），system prompt 不动。这是 `before_agent_start` 返回 message 而非改 prompt 的根本原因（pi-extension 第 10–11 行注释）。

**Q：dsh 侧注入的 message 为什么用 `kind: "plugin"` 而不是 agent-instructions 的 baseline 标记？**

A：这是踩过坑的。dsh 的 agent-instructions 插件把 `baseline: true` 标记的消息当"可见基线"反查，直接读 `changes` 字段——这里只注入全局 `~/.claude` 指令、从不带 `changes`/`baselineIdentity`，误用该标记会让 dsh 第二回合在 `visibleBaseline.changes.flatMap()` 处 `changes=undefined` 整回合崩溃（index.mjs 第 597–600 行注释，标注这是"dsh 不能发送第二条语句"的真正根因）。改用独立 `kind: "plugin"` 后 dsh 不识别为基线、壳翻译器按非 user 丢弃、模型照常可见。

**Q：sub-agent 会话会注入 CLAUDE.md 吗？**

A：不会。pi 侧 `before_agent_start` 里 `if (!ctx.hasUI) return`（pi-extension 第 194 行）——`hasUI` 为 false（sub-agent）直接跳过。sub-agent 不需要 CLAUDE.md，注入浪费 token，且其 cwd 差异会破坏 prompt cache 稳定性。dsh 侧的 sub-agent 语义由 dsh 内核自己处理，桌面端扩展不额外干预。

**Q：为什么 read-claude-md 在 pi 扩展管理器里不可关/不可卸？**

A：因为它在受保护名单里。`pi-extension-manager.ts` 第 17 行 `PI_PROTECTED = ["read-claude-md", "tool-gate"]`，扩展管理器对 `disallowOff: true` 的扩展在 `disable()` 直接 return。CLAUDE.md 加载是系统正常运行的前置（禁了 agent 就看不到用户指令），所以保护。这是内核机制判断（不是插件声明），UI 显示"受保护"标签不渲染 toggle。
