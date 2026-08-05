# 012 GoodyHao 插件设计：工程原则注入、工具观与 subagent 观

GoodyHao 是一个内置系统插件（`src/plugins/system/goody-hao/`），职责只有一件：把 pi-desktop 的工程原则作为系统 prompt，注入到每一个会话的底座里——spawn 时经 `--append-system-prompt` 传入底座。

它的价值不在代码量（全插件只有一个 `plugin.json` 加一个 `CLAUDE.md`），而在它示范了 pi-desktop 两条核心设计纪律在一个具体功能上的执行方式：一是机制与内容的分离（内核不内嵌原则文本，而由一个插件按槽位契约贡献），二是无特权差异（内置件可卸载、可覆盖，与第三方插件完全平等）。

本文先讲"怎么做的"（机制），再讲"为什么这么做"（设计哲学）。

## 1 插件结构与内容

GoodyHao 的代码量极小，因为它做的事不需要渲染界面，不需要 IPC 通信，不需要读写配置——它唯一要做的就是在 manifest 里声明一个 `systemPrompts` 贡献项，指向本插件的 `CLAUDE.md`。

### 1.1 manifest 声明

`src/plugins/system/goody-hao/plugin.json`：

```json
{
  "id": "goody-hao",
  "version": "0.1.0",
  "displayName": "GoodyHao",
  "description": "内置工程原则随会话注入:贡献 systemPrompts 槽,spawn 时经 --append-system-prompt 注入底座 system prompt。卸载即停止注入。",
  "tags": ["productivity"],
  "contributes": {
    "systemPrompts": [
      { "id": "engineering-principles", "file": "./CLAUDE.md", "order": 100 }
    ]
  }
}
```

`contributes.systemPrompts` 是一个数组，每条贡献项有三个字段：
- `id`：贡献项标识，在注册表里按此 id 做覆盖去重（`"engineering-principles"`）
- `file`：相对插件目录的文件路径（`"./CLAUDE.md"`）
- `order`：注入顺序，小的先拼进 `--append-system-prompt` 参数列表（`100`）

description 里一句"卸载即停止注入"概括了这条纪律的根本含义：原则文本是插件贡献的内容，不是内核的机制。插件在，原则才在。

### 1.2 CLAUDE.md：注入的工程原则

`src/plugins/system/goody-hao/CLAUDE.md`（96 行）承载了 pi-desktop 对 AI coding agent 的全部约束期望。它被注入到每个会话的 system prompt 尾部，agent 在每次推理时都能看到它。

内容结构：

- **关注点分离**：回调参数是责任边界模糊的气味（多个调用方传入大同小异的回调逻辑 → 该收进被调用方统一承担）。组装和调用分开（Assembler 管构造、Gateway 管执行，两侧独立演化）。

- **洋葱架构思维**：依赖只向内（圆心是稳定的业务本质，外层是会变的细节），把会变的推到外层，依赖倒置连通内外，新增功能先问归属哪层。

- **GitHub Remote 安全禁令**：禁止向 `github.com` remote push（`git remote set-url --push <name> no-push`）。clone GitHub 仓库后必须立即锁 push。允许 pull/fetch。

- **Worktree 操作禁令**：区分 `git worktree prune`（安全）和 `git worktree remove`（危险，需用户确认）。禁止在 checkout/fetch/merge 等操作中附带 worktree 清理。

- **八荣八耻**：以瞎猜接口为耻、以模糊执行为耻、以臆想业务为耻、以创造接口为耻、以跳过验证为耻、以破坏架构为耻、以假装理解为耻、以盲目修改为耻。

- **实现类回复格式要求**：回复涉及代码实现时必须追加"架构自检"和"修改文件清单"两个 section。

### 1.3 随插件分发的 skills

GoodyHao 的 `skills/` 目录下有两个 skills，随插件目录分发——底座在 skills 扫描路径覆盖到本插件目录时（取决于 `~/.pi/agent/settings.json` 的 `skills` 条目），它们和用户自己的 skills 处于同一发现机制中：

- **`arch-to-code`**（`skills/arch-to-code/SKILL.md`）：结合真实代码库写一份 3 万字架构文档、再按文档实现代码并复盘测试的全周期 skill。它强调"反 AI 味"——设计文档是给人读的论证，不是代码盘点。

- **`write-design-doc`**（`skills/write-design-doc/SKILL.md`）：四段式技术设计文档共创（对齐问题 → 起草 → 零上下文盲测 → QA 收尾），核心约束是写出来的文档"读起来像人写的"。

这两个 skills 和 CLAUDE.md 的原则是同源的——它们都在教 agent"怎么写好设计、怎么写人话"——区别在于 CLAUDE.md 是底线纪律（每次推理都可见），skills 是按需激活的工作流（用户说"写架构文档"时才触发）。

## 2 systemPrompts 槽位机制

GoodyHao 能不能生效，取决于内核的 `systemPrompts` 槽位机制是否正确运转。这套机制从圆心类型定义到 session spawn 的 argv 组装，全链路只涉及四个文件，没有条件分支、没有内置特殊对待。

### 2.1 圆心契约：`SystemPromptContribution`

`src/core/domain/contributions.ts:196-202` 定义了类型：

```typescript
export interface SystemPromptContribution {
  id: string;
  file: string;
  order?: number;
}
```

这个接口是圆心（`core/domain/`）拥有的稳定契约——零外部依赖。换掉 Electron、React、SQLite，它都不动。`SlotName` 联合（contributions.ts:205-223）里包含了 `"systemPrompts"`，`PluginContributes` 接口（contributions.ts:226-250）里声明了 `systemPrompts?: SystemPromptContribution[]`。

### 2.2 注册表：`ArraySlot` 通用容器

`src/core/application/loader/registry.ts` 用一个通用容器 `ArraySlot<SystemPromptContribution>`（registry.ts:84）管理注册：

```typescript
private systemPrompts = new ArraySlot<SystemPromptContribution>();
```

`ArraySlot` 是一个通用的数组类槽容器（registry.ts:46-63），`push` 前按 `contribution.id` 调用 `removeById` 清掉同 id 旧项。这意味着 bootstrap 按 `builtin → installed → user → project` 顺序注册时，后注册者（更高优先级的 source）自动覆盖同 id 的前注册者。覆盖判断只看 `id` 字符串相等——不识别来源是 builtin、user 还是 project。

`arraySlots` 映射表（registry.ts:89-101）包含了 `systemPrompts` 槽，所以 `registerOne` 和 `unregister` 的通用遍历逻辑自动覆盖了它——不需要为 systemPrompts 单独写注册/注销函数。

### 2.3 路径解析：`systemPromptPaths()`

`PluginRegistry.systemPromptPaths()`（registry.ts:284-294）是唯一从注册表提取 system prompt 文件路径的方法：

```typescript
systemPromptPaths(): string[] {
  return this.systemPrompts.all()
    .map((s) => {
      const plugin = this.byId.get(s.pluginId);
      if (!plugin?.path) return null;
      return { path: resolve(plugin.path, s.contribution.file), order: s.contribution.order ?? 100 };
    })
    .filter((s): s is { path: string; order: number } => s !== null)
    .sort((a, b) => a.order - b.order)
    .map((s) => s.path);
}
```

执行三件事：按 plugin 的实际磁盘路径 `resolve` 出贡献文件的绝对路径；按 `order` 升序排列（order 缺省 100）；插件路径不存在时（理论上的注册表脏数据）跳过该项。

如果 GoodyHao 被卸载（`unregister("goody-hao")`），`systemPrompts.all()` 里就不再有它的贡献项，`systemPromptPaths()` 返回的数组里就不含它的 CLAUDE.md 路径——注入即刻停止。

### 2.4 注入点：`SessionStore.createProc`

`src/core/application/sessions/session-store.ts:240-275` 的 `createProc` 是 spawn pi 进程前装配 argv 的唯一入口：

```typescript
private createProc(key: string, cwd: string, sessionPath: string | null): SessionProc {
  const args = sessionPath ? ["--session", sessionPath] : [];
  for (const p of this.getSystemPromptPaths()) args.push("--append-system-prompt", p);
  const adapter = this.factory.create({ cwd, args, cliPath: this.getCustomCliPath() });
  // ...
}
```

`getSystemPromptPaths` 是 `SessionStore` 构造函数注入的 lambda（session-store.ts:101、113-114）：

```typescript
private getSystemPromptPaths: () => string[];

constructor(
  factory: RpcAdapterFactory,
  agentDir: string,
  getSystemPromptPaths?: () => string[],
  // ...
) {
  this.getSystemPromptPaths = getSystemPromptPaths ?? (() => []);
}
```

如果构造函数没传 `getSystemPromptPaths`（降级为 `() => []`），或者传入的 lambda 返回空数组——没有任何 `--append-system-prompt` 参数拼进 argv，底座正常启动，会话功能不受任何影响。

bootstrap（`src/bootstrap/index.ts:112-116`）组装时把 `registry.systemPromptPaths` 注入进去：

```typescript
const sessionStore = new SessionStore(
  rpcAdapterFactory,
  PI_AGENT_DIR,
  () => registry.systemPromptPaths(),
  customCliPath,
);
```

`() => registry.systemPromptPaths()` 是一个箭头函数，不是 snapshot——每次 spawn 时现场求值。这意味着在应用运行期间，如果有插件被卸载（`unregister`），下一次 spawn 就会读到更新后的注册表，不再包含已卸载插件的贡献。

### 2.5 完整链路

```
plugin.json declares systemPrompts[{id, file, order}]
  → discoverPlugins 扫描插件目录
    → PluginRegistry.registerOne 写入 ArraySlot<SystemPromptContribution>
      → PluginRegistry.systemPromptPaths() resolve 绝对路径 + order 排序
        → SessionStore.createProc 拼 --append-system-prompt argv
          → pi 子进程启动，底座读取注入文件追加到 system prompt
```

卸载路径：

```
plugin-manager 触发 uninstall("goody-hao")
  → PluginRegistry.unregister 清除 systemPrompts 槽中的贡献项
    → 下一次 spawn 时 systemPromptPaths() 返回空
      → 新会话的 pi 进程不带 --append-system-prompt 参数
```

"卸载即停止注入"的执行是即时且可靠的——它不依赖任何缓存刷新、不依赖任何进程重启，因为 `getSystemPromptPaths` 在每次 spawn 时现场求值。

## 3 为什么是插件而不是硬编码资产

pi-desktop 的 README 里提到过一条替代路径："assets/CLAUDE.md —— 内置工程原则 prompt（镜像到 ~/.pi-desktop/claude.md，spawn 时按开关拼 argv 注入）"。这条路径在代码库中并未实现——`assets/` 目录里只有 `icons/` 和 `scripts/`，没有 `CLAUDE.md`。但它的存在（哪怕只是设计上的留白）正好用来对比两种模式的差异。

### 3.1 硬编码资产路径的问题

"assets 直接镜像到 ~/.pi-desktop/claude.md" 这条路意味着：
- CLAUDE.md 不在任何插件的 manifest 里声明，它是内核"知道"的一个特殊文件。
- 卸载不是走插件注册/注销流程，而是走一个独立的 prefs 开关（"是否启用内置指导"）。
- 覆盖无法走同 id 竞争的覆盖语义——它不是 contribution，没有 id，无法被第三方插件替换。
- 内核需要多一条代码路径："如果是内置 CLAUDE.md，就走 assets 镜像"。

这条路径的问题是它把"工程原则 prompt"从内容退化为机制——内核知道这个文件的存在，知道它的路径，知道它什么时候该注入。这违反了薄壳的两条铁律：内核零功能含量（原则文本是内容不是机制，内核不该认识它），以及无特权差异（内置件和第三方件该走同一套注入通道）。

### 3.2 GoodyHao 的对位设计

GoodyHao 把上面的四个问题逐个反过来解决：

- **机制与内容分离**：原则文本是插件贡献的内容，内核只知道"systemPrompts 槽里有一些文件需要注入"，不认识具体文件是什么、里面写了什么。去掉 GoodyHao，内核照样起、照样 spawn 会话——只是 prompt 短了一截。

- **卸载走统一路径**：卸载 GoodyHao 和其他任何插件没有差别——调 `plugins.uninstall("goody-hao")` 触发 `PluginRegistry.unregister`，systemPrompts 槽里不再有它的贡献项，下次 spawn 时 `systemPromptPaths()` 返回空。不需要单独的 prefs 开关。

- **覆盖语义可用**：如果用户写了一个自己的 `my-principles` 插件，声明同 id 的 `systemPrompts[].id: "engineering-principles"`，放到 `~/.pi-desktop/plugins/` 目录——bootstrap 的注册序（builtin → user）保证 user 目录的贡献覆盖同 id 的 builtin 贡献（`ArraySlot.removeById` 按 id 匹配，不认 source）。用户不需要删 GoodyHao，只要把同名贡献项放到更高优先级目录，内核自动选用户的版本。

- **零分支代码**：内核里没有"如果是内置 CLAUDE.md"的判断。`createProc` 里对 `getSystemPromptPaths()` 的调用是通用循环——有多少个路径就拼多少个 `--append-system-prompt`，不关心这些路径来自哪个插件、是什么文件、属于什么优先级。删 `if` 是架构纪律最诚实的表达。

### 3.3 "无特权差异"在 systemPrompts 上的检验

检验方式一：删掉 GoodyHao 插件（从 `src/plugins/system/goody-hao/` 移除），内核照常启动，会话照常 spawn，只是底座收不到工程原则——agent 的行为不受机制影响，只有内容缺失。

检验方式二：复制 GoodyHao 到 `~/.pi-desktop/plugins/` 并修改 CLAUDE.md 的第一行——内核在 spawn 时注入的是 user 目录下的版本，不是 builtin 目录里的原始版本。覆盖不是因为内核"选中"了 user 版本，而是 `removeById("engineering-principles")` 在 push 之前把 builtin 的项清掉了——覆盖是通用机制的自然结果，不是特权判断。

## 4 工具观：工具是 AI 能力的直接体现

以上讲的是 GoodyHao 的代码机制——它怎么把原则文本注入会话。但 GoodyHao 承载的不只是 CLAUDE.md 里的工程纪律，还有维护者关于"AI agent 该怎么被约束"的一组世界观。下面两节展开这两个世界观，并把它们和 pi-desktop 里让它们可执行的具体机制接上。

工具观的完整表述，来自维护者的原话：

> 工具是 AI 能力的直接体现。如果要一个只读权限的 session，就不应该给 bash 权限；如果要一个编排器的 session，那就应该只给编排工具，连 bash 或者 read 都不应该提供。

这句话有三层含义，逐层展开。

### 4.1 工具 = 能力边界

agent 能做什么，取决于它手里有什么工具。这不是一个声明式的权限概念（"声明了哪些 capability"），而是一个物理概念——agent 的工具列表就是它的能力清单，不多不少。没有 bash 工具的 agent 就是不能执行命令，不是"应该不执行"而是"做不到"。

这个观点推翻了"权限是写在文件里的规则、agent 自己遵守"的模型——它不信任 agent 的自觉，只信任工具的物理可用性。Agent 调不到的工具，不管 prompt 里怎么要求它调，它都调不了。软过滤（prompt 注入"请勿使用未列出的工具"）只是"请求"，硬过滤（底座扩展截断工具注册）才是"剥夺"。

### 4.2 最弱能力原则

> 如果要一个只读权限的 session，就不应该给 bash 权限

这对应 pi-desktop 的 `toolConfig` 机制。`docs/design/tool-manager-design.md` 第三章定义的 `toolConfig.enabledToolIds` 是一个工具 id 白名单，写在会话文件的 JSONL header 里。tool-gate 底座扩展（`packages/toolgate/index.ts`，由 `client/pi/toolgate-installer.ts` 在启动时同步到 `~/.pi/agent/extensions/tool-gate/`）在 `turn_start` 时读头行，调 `pi.setActiveTools` 硬过滤——agent 物理上拿不到未列出的工具。

一个只读分析型 session：`toolConfig: { mode: "custom", enabledToolIds: ["read", "find", "grep", "ls"] }`——没有 `write`、没有 `edit`、没有 `bash`、没有 `spawn`。你让 agent "重构这个文件"，它做不到——不是因为 prompt 告诉它别做，是因为它手里根本没有写文件和执行命令的工具。同理，纯对话 session 可以设 `enabledToolIds: []`——空数组意味着全禁，agent 只能说话，一个工具都调不了。

"最弱能力"不是一句安全建议，是物理配置。

### 4.3 编排器的最小工具集

> 如果要一个编排器的 session，那就应该只给编排工具，连 bash 或者 read 都不应该提供

这对应 subagent 调度中父 agent 的工具差异原则。`docs/design/subagent-scheduling.md` 第 4 节论证：一个负责编排的父 agent 不需要 read、write、bash——它的全部工作就是 `spawn_subagent`（派活）、`list_subagents`（查状态）、`send_to_subagent`（追加指令）、`abort_subagent`（中止）。

给编排器 bash 权限的后果是：它能直接干活，就会倾向于不拆活。拆活需要推理（"这个任务该拆成几个子任务"），直接干活只需要执行——LLM 是偷懒的，手里有榔头就敲，手里只有电话就打。工具集决定了 agent 的行为模式，不只是能力上限。

subagent 调度的 `toolConfig` 参数（subagent-scheduling.md §4.1）就是最弱能力原则的落地——父 spawn 子时传 `toolConfig` 限制子的工具集，tool-gate 在子进程里硬过滤。父子之间的权限差异不是角色枚举（"父级"、"子级"），而是工具清单的参数化配置。

### 4.4 这个哲学之所以可执行，是因为机制存在

上面三个场景（只读分析、纯编排、受限委托）之所以不是"设计愿望"而是"可执行的配置"，是因为 pi-desktop 有三样东西让它们变成了物理过滤：

- **tool-gate 底座扩展**：硬过滤，底座扩展 API `setActiveTools`。agent 的 tool 注册在 turn_start 被截断，未列出的工具物理不可调用。

- **会话级 toolConfig 持久化**：会话文件 JSONL header 的 `toolConfig` 字段，跟会话走。换一台机器打开同一个会话，tool 限制还在。

- **工具组抽象**：`tool-groups.json` 把一堆工具 id 归到一个组里（如"文件操作"组 = read/write/edit/find/grep/ls），用户切一个开关就关一组工具，不用逐个勾。

GoodyHao 和 tool-gate 的关系是：GoodyHao 注入原则，让 agent 知道"工具是能力边界的物理表达"；tool-gate 执行硬过滤，让 agent 切实受到这个约束。一个是认知层，一个是物理层，两者独立生效。

## 5 subagent 观：内核管单会话，desktop 管跨会话

subagent 观的完整表述，来自维护者的原话：

> pi 内核（或者说所有内核）只管好一个 session 之内的事情就行；跨 session 的编排是外部 desktop 的事 —— 由 desktop 去管理编排，做到 subagent。

这句话定义了 pi-desktop 与 pi 底座之间的职责边界，也定义了"什么是 subagent"的本质。

### 5.1 pi 的边界：单会话之内

pi 底座的核心是一个 session 一个进程——它启动后读一个会话文件（JSONL），RPC 驱动 agent 在**这个会话内部**完成一切：读文件、写文件、执行命令、调工具。它对"另一个会话的存在"一无所知，也不该知道。

这是 pi 的设计哲学：核心刻意收窄，不内置 sub-agents、不内置 MCP、不内置 plan mode——每一个"不做"的答案都是"要就自己去扩展"。这个哲学的价值不在功能少，在于核心小到可以完全理解。

`docs/design/session-bus.md` 第 1.1 节把这条边界概括为一句话：**pi 的边界是对的**。单会话之内的事归 pi，跨会话的事归壳。

### 5.2 壳的角色：跨会话编排

pi-desktop 的 session-store 是多进程调度器——它持有 `procs = Map<string, SessionProc>`，每个 SessionProc 绑一条 pi 子进程，多个会话同时活着互不干扰。它看得见每一个进程、能 spawn 新的、能停掉旧的——跨会话编排的物理基础全在。

但光有调度器不够。要让 agent 自主编排多会话，需要两样东西：**通信**（会话之间怎么对话）和**归属**（谁派了谁、谁跟谁的关系、谁死了清理谁）。

这两样东西的落点不同，泾渭分明：

- **通信归 Session Bus**（`docs/design/session-bus.md`）：IM 范式——每个会话是一个用户，channel 是房间，成员关系设好之后说话即传输。bus 是平的世界——地址 + 路由，不管父子。

- **归属归 sub-agent 插件**（`docs/design/subagent-scheduling.md`）：有向关系层——父 spawn 子、父死子清、资源闸、父 receive 子的完成信号。归属不进内核，由 renderer 侧插件串联 bus + session-store 实现。

这个分层是刻意的：bus 不知道什么是"父"什么是"子"——它只知道地址和路由；sub-agent 插件不知道什么是"传输"（它调 bus 的 `sessionCreate`、`tapStart`、`send` 原语）——它只知道七步编排和状态机。两层各自独立演化，互不污染。

### 5.3 THAT is sub-agent

维护者的原话里最后半句是关键：

> 由 desktop 去管理编排，做到 subagent。

subagent 不是一个功能模块——它是 bus + sub-agent 插件 + 展示三槽（messageRenderers/sessionGroupings/composerPolicies）的涌现结果。每一层的职责都是它自己最擅长的那件事，拼在一起就是"subagent"：

- bus 给通信——spawn 会话、传递完成信号、fan-out 房间消息。
- sub-agent 插件给归属——父 spawn 子的七步编排、父死子清、并发闸。
- 展示三槽给 UI——spawn 卡片、左侧栏缩进嵌套、子会话灰输入框。

没有一个叫 `SubagentManager` 的类，没有一段"如果是 subagent 就特殊对待"的 if 分支。subagent 是通用机制（bus + 插件体系 + 槽位）上的一种内容编排。

这也是为什么 subagent-scheduling.md 的落地路径（第 8 节）不需要改内核一行代码：bus 已有，session-store 已有，messageRenderers/sessionGroupings/composerPolicies 三槽已有，`appendJsonlLine` 已有——sub-agent 插件是三样新资产（桌面插件 + pi extension + 契约透传一行）对既有机制的串联，不是新机制。

### 5.4 回到 GoodyHao：插件贡献的工程原则

subagent 观和 GoodyHao 的关联在于：GoodyHao 注入的 CLAUDE.md（洋葱架构、关注点分离、组装与调用分开）正是让上述分层成立的底层纪律。

- "依赖只向内" — 内核不依赖插件（内核不知道 GoodyHao 的存在），插件依赖内核的契约（`SystemPromptContribution` 类型）。
- "把会变的推到外层" — 工程原则是会变的内容（明天可能加新原则、改规则措辞），把它从内核推出到插件，内核只留机制。
- "组装和调用分开" — 注册表管组装（`systemPromptPaths()` 拼路径列表），session-store 管调用（`createProc` 拼 argv），两侧独立演化。

GoodyHao 自己是这些原则的被注入者（它的 CLAUDE.md 正文里就包含了这些纪律），同时它自己也是这些原则的执行样本——一个微小的插件，用内核提供的通用槽位机制，做了一件内核不该硬编码去做的事。

## 6 设计决策

### 6.1 为什么是 system 插件而不是 user 插件

GoodyHao 放在 `src/plugins/system/` 目录下，归类为系统插件。不是因为内核对它"特殊对待"——加载器对它和对 `src/plugins/themes/theme/` 用的同一个 `discoverPlugins`、同一段 `registerOne` 逻辑。

选择 system 分组是因为它的语义：工程原则是随壳分发的默认内容，每个安装 pi-desktop 的用户都该自动获得。把它放到 `~/.pi-desktop/plugins/` 目录意味着用户必须手动安装——这不是"开箱即用"的体验。但它的 system 分组只是物理目录归类，不是架构地位的标记。

### 6.2 卸载语义

从 plugin-manager 界面卸载 GoodyHao 后：systemPrompts 槽里不再有 `"engineering-principles"` 贡献项，`systemPromptPaths()` 返回空数组（假设没有其他插件贡献 systemPrompts）。新 spawn 的会话不带 `--append-system-prompt` 参数。

但已经跑着的会话不受影响——pi 进程已经带着注入的 prompt 启动了，进程不停，prompt 不变。卸载只影响新会话。

如果用户只禁用（disable）而不卸载：插件模块不被 load，注册表里的贡献项被清掉（disable 走 unregister），效果和卸载一样——下次 spawn 时无注入。重新启用后贡献恢复，下次 spawn 重新注入。

### 6.3 与 `.claude/skills/` 镜像机制的关系

pi-desktop 有两个目录承载"外部注入的指令"：一是 GoodyHao 的 systemPrompts（走 `--append-system-prompt` 注入底座 system prompt），二是 `.claude/skills/`（镜像到 `~/.pi-desktop/skills/`，经 `~/.pi/agent/settings.json` 的 `skills` 条目被底座扫到）。

两者路径不同、机制不同、生命周期不同：

- systemPrompts 是 spawn 时的 argv 参数——在底座启动时一次性注入，session 运行期间不变，卸载后新进程不带。
- skills 是底座运行时按 `settings.json` 的 `skills` 条目扫目录发现的——底座每轮推理前检查，被扫到的 skills 按需激活。

两者的共性只有一条：它们都是插件贡献的内容（skills 由 `bundled-skills.ts` 从 `.claude/skills/` 镜像到受管目录），内核不认识具体内容、不假设什么文件该存在。

### 6.4 order 字段的语义

GoodyHao 声明 `order: 100`（缺省值）。如果有多个插件贡献 systemPrompts，按 order 升序拼进 argv——order 小的先注入。但底座的 `--append-system-prompt` 实际效果取决于底座的处理逻辑（是拼接还是独立读），所以 order 的精确语义受底座实现约束。

当前只有一个 systemPrompts 贡献者（就是 GoodyHao），order 的排序作用未激活——但留了这条参数，未来多插件贡献时可以精确控制注入顺序，不用改 manifest schema。
