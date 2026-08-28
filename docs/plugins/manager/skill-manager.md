# skill-manager：技能管理的壳插件与双内核聚合

## 1 这个插件是什么，以及它刻意不做什么

`src/plugins/manager/skill-manager/` 是技能（skill）管理功能的壳插件。它挂在壳的两个槽位上：`settings` 槽（贡献「技能」设置页）和 `blockRenderers` 槽（贡献 `auxBlock/skill` 结构化块的解析器与引用条渲染器），再通过 `languages` 槽贡献四个 locale 的文案。它的 `plugin.json` 里 `tier` 是 `"official"`、`id` 是 `"skill-manager"`、`version` 是 `0.4.9`、`renderer` 指向 `./renderer/index.tsx`。

但「它是壳插件」这句话同时划定了它不能做什么。按 CLAUDE.md 的「出 UI 的是壳插件，出能力的是内核」这条边界，skill-manager 只负责把内核回报的技能列表画出来、把用户的开关意图转发回去，它自己不做任何扫描、不解析任何 frontmatter、不读任何内核的配置文件。这个定位不是本文事后总结出来的，而是刻在圆心契约的注释里：`packages/shared/src/domain/skills.ts` 开篇即写「壳只认 SkillProvider 接口 + 中性 SkillInfo，不读任何内核存储。扫目录/读配置/解析 frontmatter 全是内核侧的事」。这一节先把这条边界摊开，后面每一节都在验证它。

**这个插件历史上是「壳自己扫目录」的重灾区，现在是收敛后的形态。** `docs/design/skills-layering.md` 记录了这条演化路径：最早一版为了在 GUI 里管理 pi 的技能，在壳的用例编排层放了一个 `skill-scanner.ts`，它读 `~/.pi/agent/settings.json`、扫技能目录、解析 SKILL.md 的 frontmatter，自己复刻 pi 的 `+/-` pattern 判定逻辑。这踩了两条线：壳读了内核存储（违反「壳不读任何内核存储」），以及语义漂移（壳复刻的判定逻辑和内核真正跑的那份是两份代码读同一份文件，任何一边改规则另一边就漂）。接 dsh 之后更糟，一个文件里同时装着 pi 和 dsh 两套持久化细节。重构的结论一句话：**壳只负责把技能路径传给内核、把开关意图转发给内核，内核自己扫、自己解析、自己判定、把完整列表（含禁用）回报给壳，壳再按能力标志渲染开关**。skill-manager 这个壳插件就是这条结论在 UI 层的落点。

- **`plugin.json` 的 `contributes.settings` 项**：`id: "skills"`、`component: "SkillManagerPage"`、`saveMode: "manual"`、`order: 3`。`saveMode: "manual"` 值得单独说明——这个设置页不声明 `configFile`，它的「改动」不是「改一个 JSON 文件然后框架弹保存浮层」，而是每点一次开关就立刻经 `ctx.skills` 发一条 IPC 到后端、由后端聚合器路由到对应内核的 `SkillProvider` 写内核存储。所以它走的是「立即持久化 + 乐观更新 + 失败回滚」的模式，不是框架的 save/dirty/reset 通用配置通道。

- **`plugin.json` 的 `contributes.blockRenderers` 项**：`id: "skill-aux"`、`block: "auxBlock"`、`names: ["skill"]`、`component: "SkillAuxBlock"`、`order: 100`。这一项贡献的是结构化块 `auxBlock` 的 `skill` 子类型渲染器，由 `renderer/skill-aux.tsx` 里的 `SkillAuxBlock` 组件实现，它和同文件的 `auxParsers` 解析器是一对——一个管「从消息文本里把 `<skill>…</skill>` 块抠出来」，一个管「把抠出来的块画成引用条」。

- **`plugin.json` 的 `contributes.languages` 项**：八个条目，四个 locale（zh-CN / zh-TW / en / de）× 两个 namespace（`skill-manager.settings` 与 `skill-manager.plugin`），分别指向 `locales/<locale>/settings.json` 和 `locales/<locale>/plugin.json`。`settings.json` 是设置页的全部文案（包括 `skill-blocks.skillRef` 这个 skill 块引用条文案），`plugin.json` 只有 `displayName` 和 `description` 两条。

**目录里刻意没有 `pi-extension/` 和 `dsh-extension/` 两个四件套目录。** CLAUDE.md §7.7 讲「一个功能收进同一个壳插件目录，内部按需四件（locales/renderer/pi-extension/dsh-extension）」，但 skill-manager 是这条规则的一个例外变体——它的内核侧补面不放在插件目录里，而是收进了两个「统一适配插件」：pi 侧是 `packages/my-harness-fit-pi-extension/`（含 `skills.ts` 和 `scanner.ts`），dsh 侧是 `src/server/kernel/dsh/extension/dsh-extension/index.mjs`（其第四块能力就是 skill）。原因在 `src/server/bootstrap/assemble.ts` 第 161-176 行的注释里写得很清楚：ask / goal / read-claude-md / skill-manager 四个插件原本各自携带 dsh cordis 插件，现在收敛成一块 `my-harness-fit-dsh-extension`，bootstrap 常驻同步、不随桌面插件启停。所以 skill-manager 这个壳插件本身只出 UI，内核侧的扫描和播报逻辑住在统一适配插件里，这一层归属关系是理解整个技能链路的第一张地图。

## 2 圆心契约：`packages/shared/src/domain/skills.ts`

圆心是「拿掉所有会变的东西之后还剩什么」。技能域的圆心只有一个文件，零依赖、纯类型 + 纯注释，不含任何内核身份字面量、不含任何 `.pi`/`.dsh` 路径字面量。它定义了三样东西：`SkillCapabilities`（能力标志）、`SkillInfo`（中性技能）、`SkillProvider`（技能域的中立契约接口）。

**`SkillInfo` 是「归一成正向布尔 + 来源透传」的中性技能。** 逐字段看它的语义，每个字段都是一个「内核翻译之后的行为结论」，而不是「内核存储的痕迹」：

- `name: string` —— 技能名，frontmatter 的 `name`，内核解析后回报。契约注释强调「内核解析后回报」，意思是壳不自己从文件路径猜名字。
- `description: string` —— frontmatter 的 `description`，展示用。
- `scope: "user" | "project"` —— 作用域，全局还是当前项目。这是壳分区用的维度，决定这条技能进「全局」还是「当前项目」两区；由内核适配器在翻译时填，壳只消费。
- `enabled: boolean` —— 加载与否。pi 的 `+/-` pattern、dsh 的 disabled 名单，都归一成这一个正向布尔。
- `modelInvocable: boolean` —— 模型可否自动调用，即 frontmatter `disable-model-invocation` 的反值。
- `source?: string` —— 来源标签，内核适配器翻译时填入，壳原样显示、不写死。
- `filePath?: string` —— SKILL.md 绝对路径，开关操作定位用（改 frontmatter 要落在哪个文件上）。
- `sourceDir?: string` —— 技能来源根目录，内核扫描时的根目录（如 `~/.pi/agent/skills`、`{cwd}/.agents/skills`），壳按此分组展示、不反推路径。

这里有一个和设计文档的**已知偏离**要如实记录：`docs/design/skills-layering.md` §3 设计的是三根轴（`enabled` / `modelInvocable` / `userInvocable`），`SkillInfo` 里带 `userInvocable` 字段、`SkillCapabilities` 里带 `toggleUserInvocable`。但**当前圆心契约实际落地的是两根轴**——`SkillInfo` 没有 `userInvocable` 字段，`SkillCapabilities` 只有 `toggleEnabled` 和 `toggleModelInvocable` 两个布尔。也就是说，pi 的「用户可 `/skill` 调用」这轴在设计里是「pi 恒 true、能力标志报 false（不提供开关）」的显式降级，在实现里直接整个没进契约。这是「设计文档终态 vs 实现中间态」的差异，本文以圆心契约的**实际代码**为准。

**`SkillCapabilities` 是「这个内核支持哪几根开关轴」的能力标志，不是内核身份。** 两个布尔：`toggleEnabled`（是否支持加载/卸载轴）、`toggleModelInvocable`（是否支持模型可自动调用轴）。它的作用在契约注释里写死了：「壳据此渲染开关、不硬编码内核身份」。这是「多内核默认」和「无特权差异」在技能域的直接执行——壳渲染几个开关，读的是实现自己声明的数据，不写 `if (kernel === "pi")`。

**`SkillProvider` 是技能域的中立契约接口，和 `BaseBackend` 同构。** 它只有五样东西：

- `readonly capabilities: SkillCapabilities` —— 本内核支持哪几根开关轴。
- `listSkills(cwd: string): Promise<SkillInfo[]>` —— 读完整技能列表（含禁用），供管理页展示。
- `setEnabled(skill: SkillInfo, enabled: boolean): Promise<void>` —— 加载/卸载（对应 `enabled` 轴）。
- `setModelInvocable(skill: SkillInfo, value: boolean): Promise<void>` —— 模型可自动调用（对应 `modelInvocable` 轴）。
- `watch(cwd: string, onChanged: () => void): () => void` —— 订阅技能变化，内核回报，壳重拉列表；返回清理函数。

为什么接口方法都收整个 `SkillInfo` 而不是单独传 `name` 或 `filePath`？设计文档 §3.2 讲了理由：开关操作需要「定位到这个技能」和「知道它当前状态」两样信息，`SkillInfo` 一次带全——`setEnabled` 需要 `filePath`（pi 写 `+/-` pattern 定位）和 `name`（dsh 写 disabled 名单）；`setModelInvocable` 需要 `filePath`（改 frontmatter）。传整个对象避免调用方拆字段，也避免「传 name 但实现里不知道 filePath」的二次查询。这是「构造在内」——壳把完整上下文交给内核，内核自己拆。

## 3 壳后端聚合：`skill-aggregator.ts`

`src/server/application/skills/skill-aggregator.ts` 是壳后端技能域的用例编排层，文件头注释一句话点题：「壳侧技能聚合器（只依赖 SkillProvider 接口，不读任何内核存储）」。它的构造器只吃一个 `providers: SkillProvider[]`，除此之外对内核一无所知。这个类是「加第三个内核 = 加一个 SkillProvider 实现，壳一行不改」这句话的执行者。

**`capabilities` getter 是「任一 provider 支持即暴露」的合并。** 它返回 `{ toggleEnabled: providers.some(p => p.capabilities.toggleEnabled), toggleModelInvocable: providers.some(p => p.capabilities.toggleModelInvocable) }`。语义是：合并视图只要有一个内核支持某根轴，就向 UI 暴露这根轴的开关。当前 pi 和 dsh 的 provider 都报两根轴全 true，所以合并视图两根轴都开。

**`listSkills(cwd)` 是「拼接 + 去重 + 排序」的合并。** 它遍历所有 provider，把每个 provider 的 `listSkills(cwd)` 结果 `push` 进一个数组，然后按 `filePath ?? name:scope` 做 key 去重，最后按 `name.localeCompare` 排序返回。去重 key 的取值逻辑值得注意：优先用 `filePath`（绝对路径天然唯一），没有 `filePath` 时才退到 `name:scope` 组合——因为同名技能可能出现在全局和项目两个作用域，只按 `name` 去重会把两条不同物理路径的同名技能误并成一条。

**`route(enabled)` 是「开关路由回来源内核」的关键，但当前是简化版。** 它 `find` 第一个 `capabilities[enabled]` 为真的 provider，`setEnabled`/`setModelInvocable` 都经它路由到那个 provider 执行。文件头注释明确标了这个简化的已知缺口：精确意图是「每个技能行按它来源内核的能力标志渲染、开关路由回来源内核」，但 `SkillInfo` 契约没有 provider 归属字段（避免内核身份泄漏），所以当前只能「路由到支持该轴的第一个 provider」。因为现在 dsh 降级为空列表、只有 pi 有数据，所以「路由到支持该轴的 provider」是安全的；将来 dsh 补齐时，需要在 `SkillInfo` 加 provider 归属或按 provider 分组。这个注释本身就是「能力拉平三分法」里「显式降级 + 已知缺口显式标注」的示范——不把「将来要改」藏起来，而是写清楚「现在为什么安全、将来要补什么」。

**`watch(cwd, onChanged)` 是「map 到所有 provider + 合并 cleanup」。** 它把 `onChanged` 透传给每个 provider 的 `watch`，收集所有返回的 cleanup 函数，返回一个「遍历调用所有 cleanup」的合并清理函数。这样壳侧订阅一次，内核侧每个 provider 各自监听自己的存储，变化统一走 `onChanged` 回报。

## 4 双内核的 SkillProvider 实现

两个内核各交一个 `SkillProvider` 实现，物理上分别住在 `src/server/kernel/pi/extension/pi-skill-provider.ts` 和 `src/server/kernel/dsh/extension/dsh-skill-provider.ts`。它们是对称的消费端，但读写的存储各不相同——这正是「内核适配器读/写自己的存储，合法；壳不碰」这条纪律在技能域的物化。

### 4.1 `pi-skill-provider.ts`：读播报文件，写 settings.json 和 frontmatter

文件头注释说它是「pi 内核的技能适配器（实现中立契约 SkillProvider）」，身份是「『内核负责读』的 pi 侧消费端」——读 pi 扩展播报的完整列表（`desktop-skills.json`），把内置目录的技能标 `source: "builtin"`，实现两根轴。

**它读什么、写什么，边界很干净：**

- 读：`listSkills()` 读 `skillsBroadcastFile()`（即 `~/.pi/agent/desktop-skills.json`，路径由 `my-harness-fit-pi-extension-installer.ts` 第 122-124 行的 `skillsBroadcastFile()` 提供），`JSON.parse` 失败或非数组时降级返回空列表 `[]`，不炸。
- 标 builtin：拿到原始列表后，`map` 每个技能，若 `s.filePath` 以 `builtinSkillsDir`（构造时注入的 `BUNDLED_SKILLS_DIR`）开头，就 `{ ...s, source: "builtin" }` 覆盖来源标签。注释点明：「pi 适配器知道内置目录，这是它在内核层的知识」——「是否内置」这个判定待在内核适配器，不待壳，壳只透传 `source`。

**`setEnabled` 写 pi 的 `settings.json` 的 `skills[]` 的 `+/-` 条目。** 落点路径按作用域二分：`scope === "project"` 时写 `join(getCwd(), ".pi", "settings.json")`（项目级），否则写 `join(agentDir, "settings.json")`（全局 `~/.pi/agent/settings.json`）。写之前先 `readSettings` 读出现有的 `skills` 数组，`filter` 掉「stripPrefix 之后等于当前技能绝对路径」的旧条目（避免同一个技能反复 toggle 时累积多条 `+/-`），再 `push` 一条 `${enabled ? "+" : "-"}${absPattern}`，最后 `writeJsonFile(settingsPath, { skills: filtered }, "deep")`。注意这里的 `absPattern` 是 `toPosix(skill.filePath)`——把 Windows 反斜杠统一成正斜杠再写进 pattern，这是设计文档取舍五「继续写绝对路径 pattern」的执行。

**`setModelInvocable` 改 frontmatter，走锁 + 纯函数改写。** 它先 `withDirLock(dirname(skill.filePath))` 拿目录锁，锁内读文件、调 `setFrontmatterField(content, "disable-model-invocation", String(!value))`、写回。`String(!value)` 这个反值是关键——契约的正向布尔 `modelInvocable` 在内核落地时反转成存储痕迹 `disable-model-invocation`，反转点在内核适配器，不在契约、不在壳。

**`watch` 是 no-op。** 注释说明：真正的变化由 `settings:changed` 广播兜底（skill-manager 页面自身订阅 settings 变化重拉），播报文件的 mtime 监听留给后续，这里返回 no-op cleanup、契约不破坏。

### 4.2 `dsh-skill-provider.ts`：读播报文件，写 disabled 名单和 frontmatter

文件头注释说它「与 pi-skill-provider 对称的消费端」：dsh 侧 fork 插件扫描目录、维护 disabled 名单、把完整列表（含禁用）写播报文件 `~/.dsh/desktop-skills.json`，这里读播报文件、转发开关意图。

**它有两个私有路径 getter：** `broadcastFile`（`~/.dsh/desktop-skills.json`，dsh 侧 fork 插件写的完整列表）和 `disabledFile`（`~/.dsh/.my-harness-desktop-disabled-skills.json`，disabled 名单）。`listSkills()` 读 `broadcastFile`，缺失/损坏降级空列表。`readDisabled()` 读 `disabledFile` 的 `skills` 数组成一个 `Set<string>`，缺失/损坏回空集合。

**`setEnabled` 写 disabled 名单，语义和 pi 完全相反。** pi 的 `enabled` 轴是「写 `+/-` pattern 到 settings.json」，dsh 的 `enabled` 轴是「维护一张『被禁用的技能名』名单」——`enabled` 时 `disabled.delete(skill.name)`，否则 `disabled.add(skill.name)`，然后 `writeJsonFile(disabledFile, { skills: [...disabled] }, "deep")`。注释点明这个落法：「enabled 轴落地 = disabled 名单（壳写、dsh fork 插件读 + 发现阶段过滤）」。为什么是技能名而不是文件路径？因为 dsh 的 `SkillRegistry` 合并规则按「同名技能」裁决，禁用一个技能就是禁掉这个名字，不管它来自哪个发现根。

**`setModelInvocable` 和 pi 完全同款。** 同样 `withDirLock` + `setFrontmatterField(content, "disable-model-invocation", String(!value))` + 写回。这恰恰说明 `skill-frontmatter.ts` 抽成共享纯函数是对的——两个内核的「固定到上下文」轴落地到同一个 frontmatter 字段，逻辑一字不差，抽出来一处维护（详见 §4.3）。

**`watch` 同样是 no-op。** 注释说明：播报文件/disabled 名单变化由 `controllers/skills.ts` 的 chokidar 统一监听（与 pi 对称），真正的刷新走 `skills:changed` 广播 → 壳重拉 `listSkills`。

### 4.3 `skill-frontmatter.ts`：两个内核共享的前端改写纯函数

`src/server/application/skills/skill-frontmatter.ts` 只有 29 行，但它的存在理由写在头注释里：「`setModelInvocable` 轴在两个内核都是『改 frontmatter 的 disable-model-invocation 字段』，这段纯函数从 pi-skill-provider 抽出共享（§1.1 气味三：同一逻辑多个入口各写一遍是违规）」。这是「构造与执行分开」和「框架管通用、特化归外层」的落地——同一个「改 frontmatter 单字段」的构造逻辑，两个内核都用，抽成一处，调用方只传 `key` 和 `value`。

`setFrontmatterField(content, key, value)` 做的是「手术式单字段改写」，它的关键行为：

- 识别换行符风格（`\r\n` vs `\n`），保留原有风格不混入。
- 内容不以 `---` 开头（没有 frontmatter）时，前置补一个 `---\n<key>: <value>\n---\n\n`。
- 有 frontmatter 但找不到闭合 `\n---` 时，同样前置补（退化路径）。
- 找到闭合后，用正则 `(^|\n)([ \t]*key[ \t]*:[^\n\r]*)` 在 frontmatter 块里找该字段，找到就只替换冒号后的值部分（`replace(/:.*/u, ": ${value}")`），保留字段前的缩进、字段名、字段顺序、块里其他注释和 body 空白；找不到就在闭合 `---` 前追加一行 `key: value`。

「不整体重排 YAML」是刻意选择——frontmatter 是用户可读的内容，整体重写会丢注释和字段顺序。这段纯函数物理上住在 `src/server/application/skills/`（壳后端用例编排层），但它不读任何内核存储、不 import 任何内核，只是被两个内核的 provider import 过去用。依赖方向是「内核 provider → 壳后端纯函数」，符合「外层依赖内层」——这里的内层是这段零依赖的纯函数，外层是 pi/dsh 两个 provider。

## 5 技能如何经 pi/dsh 双内核聚合（专节）

这一节是整个文档的核心，回答任务指定的「技能如何经 pi/dsh 双内核聚合」。一句话先给结论，再拆数据流：**壳从不读任何内核的存储，它只经 `SkillAggregator` 聚合两个 `SkillProvider` 的回报；而每个 `SkillProvider` 的数据又来自各自内核进程内的一段扫描代码写出的「播报文件」。** 所以聚合发生在两个层面——壳后端 `SkillAggregator` 把两个 provider 的列表合并成一份，而每个 provider 的列表又是它那个内核「进程内扫描 → 写播报文件 → 适配器读」这条链路的下游。

### 5.1 全链路数据流：谁在扫、谁在读、谁在写

先看 pi 侧。pi 进程内的扩展 `packages/my-harness-fit-pi-extension/skills.ts` 的 `setupSkills(pi)` 在 `session_start` 事件时调用 `scanPiSkills(process.cwd())`，扫描 pi 自己的全部技能来源，产出中性 `SkillInfo[]`（含禁用），写到 `~/.pi/agent/desktop-skills.json`。`scanPiSkills`（`scanner.ts`）读的是 pi 自己的存储：`~/.pi/agent/settings.json` 的 `skills[]`（分普通条目和 `+/-`/`!` 模式条目）、`~/.pi/agent/skills`、`~/.agents/skills`、`<cwd>/.pi/skills`、`<cwd>/.agents/skills` 以及从 cwd 逐级向上的祖先 `.agents/skills`。它算 `enabled` 用的是 `isEnabledByOverrides`（复刻 pi 内部的 `+/-`/`!` 判定），算 `modelInvocable` 用的是 frontmatter `disable-model-invocation` 的反值。然后 `pi-skill-provider.ts` 读这个播报文件、把落在内置目录下的标 `source: "builtin"`、回报给聚合器。

再看 dsh 侧。dsh 进程内的统一适配插件 `src/server/kernel/dsh/extension/dsh-extension/index.mjs` 的第四块能力就是 skill。它 fork 了一份 `FileSystemSkillProvider`（`@deepseek-ai/dsh-skill-filesystem`），注册 provider 时在 `list` 里过滤掉 disabled 名单里的技能名（`candidates.filter((c) => !disabled.has(c.name))`），并把完整列表（含禁用、带 `enabled` 标志）经 `toSkillInfo` 翻译成中性 `SkillInfo`、`writeBroadcast` 写到 `~/.dsh/desktop-skills.json`。然后 `dsh-skill-provider.ts` 读这个播报文件回报给聚合器。

**两边都把「扫描」和「播报」放进内核进程，壳只面对一个 JSON 文件。** 播报文件是「内核回报」的传输细节，不是语义契约——语义契约是 `SkillProvider` 接口和中性 `SkillInfo`。这个设计绕开了设计文档里「pi 扩展暴露 `list_skills` RPC」的原始方案，改用文件播报：pi 扩展在 `session_start` 扫一次写文件，dsh fork 插件在 `skills/change` 事件和启动时写文件，壳的 provider 读文件。文件是双方约定共享的中间态，但它归内核侧拥有（壳不写它、只读）。

### 5.2 两根轴在两个内核的存储落点完全不同

聚合器把两根轴（`enabled` / `modelInvocable`）合并暴露给 UI，但这两根轴在 pi 和 dsh 上落到完全不同的存储：

- **`enabled` 轴（加载/卸载）**：pi 落到 `settings.json` 的 `skills[]` 里的 `+/-` pattern（`-` 关、`+` 强开）；dsh 落到 `~/.dsh/.my-harness-desktop-disabled-skills.json` 的 disabled 名单（`{ skills: [...] }`，技能名集合）。pi 是「写开关条目到配置」，dsh 是「维护一张禁名单」。两者的共同点是「下次会话生效」——pi 读 `settings.json` 在新会话启动时，dsh 的 fork provider 在发现阶段读 disabled 名单过滤。
- **`modelInvocable` 轴（模型可自动调用）**：两个内核落到**同一个** frontmatter 字段 `disable-model-invocation`，都改 SKILL.md 文件内容，都经共享纯函数 `setFrontmatterField` 手术式改写。这是唯一一根「两边存储落点重叠」的轴。

**聚合器不知道、也不需要知道这些落点差异。** 它只看到「两个 provider 都实现了 `setEnabled` 和 `setModelInvocable`、都报了 `toggleEnabled=true` 和 `toggleModelInvocable=true`」。写哪个文件、写什么格式，是每个 provider 内部的事。这正是「能力拉平三分法」里「适配器翻译」和「内核补面」的成果——pi 的 `+/-` 和 dsh 的 disabled 名单是「同一语义（加载/卸载）、不同形状」，各自在内核适配器里翻译成中性 `enabled` 布尔；dsh 的「关闭」能力缺失由 fork 插件在发现阶段过滤补上。

### 5.3 壳不读内核存储，这件事的 grep 级验证

「壳不读内核存储」不是口号，是物理可验证的。看依赖方向：`SkillAggregator` 只 import `@my-harness-desktop/shared` 的类型；两个 provider 住在 `src/server/kernel/{pi,dsh}/extension/`（内核层），它们 import `node:fs` 和 `config-file` 读自己的存储，合法；`controllers/skills.ts`（壳后端网关）只调 `skillAggregator`，不碰 `.pi`/`.dsh` 路径；`skill-manager` 壳插件只调 `ctx.skills`，不碰任何文件。扫目录、读 `settings.json`、读 `settings.yaml`、解析 frontmatter，这些动作全部住在内核进程（pi 的 `scanner.ts`）或内核适配器（两个 provider）里，壳的用例编排层和 UI 层一行都没有。

**这个「谁读存储」的边界还体现在 `bundled-skills.ts` 的下沉上。** `src/server/application/skills/bundled-skills.ts` 现在只剩一行 re-export：`export { mirrorManagedDir as mirrorBundledSkills } from "../bundled/mirror"`，头注释说「挂/摘 pi settings.json skills[] 的 pi 专属逻辑已下沉 client/pi（pi-bundled-skills），壳不再碰 pi 存储格式」。这个下沉把「内置技能目录怎么挂进 pi 的 settings.json」这件事从壳层挪到了 `src/server/kernel/pi/extension/pi-bundled-skills.ts`（`ensureBundledSkillsEntry` / `ensurePluginSkillsEntry` / `migrateLegacySkillPatterns`），壳的 `assemble.ts` 只经一个 `ensureBundledSkills` 闭包调用它。这是「依赖只向内」在技能域的第二个显性样本。

### 5.4 能力标志取代内核身份分支

聚合器暴露 `capabilities` 给 UI，UI 据此渲染开关，这是「壳对内核无感」的关键。`SkillManagerPage` 里渲染开关的代码是：

- `capabilities.toggleEnabled && <Toggle … />` —— 能力标志真才画「启用/禁用」开关。
- `capabilities.toggleModelInvocable && <PinBox … />` —— 能力标志真才画「固定到上下文」开关。

整份 `renderer/index.tsx` 里没有一处 `if (kernel === "pi")`，也没有任何 `.pi`/`.dsh` 字面量——`SkillInfo` 的 `scope` 只区分 `user`/`project`，`source` 只透传，`sourceDir` 只当字符串分组。加第三个内核，就是第三个 provider 各报各的标志，壳插件一行不改。这是「多内核默认」和「无特权差异」在 UI 层的直接验证：pi 和 dsh 谁也没有特权，谁贡献了哪根轴就画哪根轴的开关。

## 6 与内核插件的协作：pi 扩展与 dsh fork 插件

技能链路的「内核负责读」这一半，物理上不住在 skill-manager 插件里，而住在两个内核插件里。这一节把它们和 skill-manager 的关系讲清楚。

**pi 侧：`packages/my-harness-fit-pi-extension/` 的 `skills.ts` + `scanner.ts`。** `setupSkills(pi)` 挂 `session_start` 事件，用一个 `broadcast` 标志位保证一次会话只扫一次（`if (broadcast) return; broadcast = true`），然后 `scanPiSkills(process.cwd())`、`mkdirSync` + `writeFileSync` 写播报文件。`scanner.ts` 的 `scanPiSkills` 是「内核负责读」的 pi 侧实现，它读 pi 自己的存储、产出中性 `SkillInfo`。这里有个技术细节值得记：`parseFrontmatter` 是手写的标量解析器，注释说明原因——「本扩展以裸 .ts 交付到 `~/.pi/agent/extensions`（无 package.json / node_modules），pi loader 从扩展目录解析 require，任何 npm 包（含 yaml）都解析不到 → 只能用手写标量解析」。字段消费面只有 name/description/disable-model-invocation 三个标量，手写足够。

**dsh 侧：`dsh-extension/index.mjs` 的第四块能力（skill-manager）。** 这段是「内核补面」的教科书案例。它面对的核心约束是 dsh 的 `SkillRegistry` 只有「往里加」没有「往外删」——要「关闭」某个技能，只能在发现阶段过滤。于是它 fork 了一份 `FileSystemSkillProvider`：`ctx.skills.registerProvider((control) => { inner = new FileSystemSkillProvider(...); return { name, list(options) { 过滤 disabled }, get } })`。`list` 里 `candidates.filter((c) => !disabled.has(c.name))` 就是「发现阶段过滤」的落点。它同时维护两张文件：`DISABLED_FILE`（读）和 `BROADCAST_FILE`（写），并挂 `ctx.on("skills/change", ...)` 和 `watchFile(DISABLED_FILE, ...)` 保证 disabled 名单变化时 `controlRef.invalidate()` 让 provider 重新发现。

**两个 providerName 的坑是「内核补面」要避开的雷。** `index.mjs` 第 617-622 行的注释记录了一个真实 bug：`providerName` 必须避开 agent-core 经 `ctx.plugin(SkillFileSystem)` 已全局注册的默认名 `"filesystem"`，因为新 scoped 注册表对同层重名直接抛错、会让 dsh 进程 boot 崩。所以用桌面专属名 `desktop-filesystem`。这是「给缺能力的内核补插件」时「不抢核心命名空间」的具体教训，和 skill-manager 壳插件的关系是：壳插件不管这些，它只知道「dsh 有个 provider 会吐播报文件」。

**随壳分发的通道。** pi 扩展经 `my-harness-fit-pi-extension-installer.ts` 的 `installFitPiExtension` 同步到 `~/.pi/agent/extensions/my-harness-fit-pi-extension/`（`skills.ts`/`scanner.ts` 都在 `TOP_FILES` 里），并把 `skills/` 目录镜像到 `~/.pi/agent/skills/bus-extension/`（`<name>.md` → `<name>/SKILL.md`）。dsh 插件经 `assemble.ts` 的 `syncFitDshExtension` 同步到 dsh 插件目录、经 cordis.yml 挂载。这些都是内核侧的装入口，不进壳插件加载器。

## 7 前端 renderer：`index.tsx` 与 `skill-aux.tsx`

### 7.1 `index.tsx`：设置页的状态机

`SkillManagerPage`（`SettingsComponentProps` 形参解构出 `refreshSignal`）是 `settings` 槽 `skills` 项的组件。它的状态有九块：`skills`（列表）、`capabilities`（能力标志）、`loading`、`filter`（all/enabled/disabled）、`search`、`toast`、`error`、`excludedPaths`（被排除的路径集合）、`pathOpen`（路径筛选器展开状态）。

**数据获取是「list + capabilities 并行拉取」。** `refresh` 回调里 `Promise.all([ctx.skills.list(cwd), ctx.skills.getCapabilities()])`，`cwd` 取 `useUiStore((s) => s.currentCwd) || ""`。两个 `useEffect` 驱动刷新：一个 `[refresh, refreshSignal]` 依赖（`refreshSignal` 是框架传的刷新信号，外部触发重拉），一个 `[ctx, currentCwd, refresh]` 依赖里调 `ctx.skills.watch(currentCwd, refresh)` 并返回清理函数（`unwatch`）。所以列表刷新有两条路：框架的 `refreshSignal`（如 settings 页被重新打开、或 `skills:changed` 广播触发）和 `watch` 回调（内核侧文件变化触发）。

**路径筛选是「存排除集合」而非「存选中集合」。** `excludedPaths` 初始是空 `Set`，空集合 = 全部路径全部选中（默认全选）。`sourcePaths` 用 `useMemo` 从 `skills` 聚合：按 `sourceDir || __${scope}__` 做 key 建 Map，统计每个路径的 `count` 和 `scope`，然后按「user 在前、project 在后，同 scope 按路径字典序」排序。这里有个细节：`key = s.sourceDir || \`__${s.scope}__\``——没有 `sourceDir` 的技能（理论上内核没报来源根）用 `__scope__` 占位 key 兜底，不丢技能。第一层过滤 `pathFiltered` 是「排除集合非空时 filter 掉 `excludedPaths` 里的路径」。失效路径清理：一个 `useEffect` 在 `sourcePaths` 变化时把「已排除但已不存在的 key」从集合里清掉，注释说「已排除项若不再存在（项目切换/目录消失），清掉失效 key，不静默保留」。

**第二层筛选 + 搜索 + 排序。** `visibleSkills` 在 `pathFiltered` 上叠加启用/禁用筛选（`filter === "enabled"` 滤 `s.enabled`，`"disabled"` 滤 `!s.enabled`）和文本搜索（`name`/`description`/`sourceDir`/`filePath` 小写 `includes`），最后排序：user scope 在前（`sa === "user" ? 0 : 1`）、同 scope 按 `sourceDir` 字典序、再按 `name` 字典序。这个排序逻辑和设计文档 §6.1 的「全局在前、项目在后，同作用域按 sourceDir、再按名字」完全一致。

**开关动作是「乐观更新 + 失败回滚」。** `mutate(filePath, patch)` 用 `setSkills(prev => prev.map(...))` 乐观改本地 state。`handleSetEnabled` 先 `mutate(skill.filePath, { enabled: next })`，再 `await ctx.skills.setEnabled(skill, next)`，成功 `setToast("变更将在下次会话生效")`，失败 `mutate(skill.filePath, { enabled: !next })` 回滚 + `setError`。`handleSetModelInvocable` 同构，只是字段换成 `modelInvocable`、IPC 换成 `setModelInvocable`。这个「乐观更新 + 回滚」模式和设计文档 §5.2 说的「为了交互即时性，壳可以乐观更新本地列表，等内核回报后再校正」一致。

**`SkillRow` 按能力标志渲染开关。** 每行左边是可点击展开的 `name` + `source` 徽标 + `scope` 徽标 + `filePath` 副行 + `description`（展开时 maxHeight 200，否则单行省略）；右边是 `capabilities.toggleEnabled && <Toggle …/>`、`capabilities.toggleModelInvocable && <PinBox …/>`，以及一个常驻的 `FolderOpen` 按钮（`ctx.openFile(skill.filePath.slice(0, lastIndexOf("/")))` 打开所在文件夹）。禁用项整行 `opacity: 0.45`（`<ListItem style={{ opacity: skill.enabled ? 1 : 0.45 }}>`）。`PinBox` 的语义是「固定到上下文」，选中时 `background: var(--color-primary)`，title 文案是 `settings.skillToggleForce`（「固定后 skill 进入 system prompt，模型可自动调用；不固定则只能手动 /skill 触发」）。

**分页。** `SkillList` 用 `usePagination(skills, PAGE_SIZE)`（`PAGE_SIZE = 20`），超过一页渲染 `<Pagination>`。`FilterButton`/`Toggle`/`PinBox`/`inputStyle` 都是页面内私有纯组件，样式全用 CSS 变量（`var(--color-*)`/`var(--spacing-*)`），零硬编码色值——这符合「token key 合规，token 值违规」。

**一个值得注意的细节：`export { auxParsers, SkillAuxBlock } from "./skill-aux"` 必须在入口 re-export。** `index.tsx` 第 20 行注释写明：`auxParsers` 是代码级声明（plugins-host 加载 module 时收集注册），`SkillAuxBlock` 是 manifest `blockRenderers` 按名自动匹配，所以两者都必须在入口 re-export 才能被框架看到。这是「组件自动匹配」+「代码级 channel/parser 注册」两条注册路径在同一个插件的并存。

### 7.2 `skill-aux.tsx`：结构化块的解析器与引用条渲染器

文件头注释点明它依据 `docs/design/aux-block-mechanism.md §4`，处理的是「内核 `_expandSkillCommand` 把 `/skill:name args` 展开成 `<skill name="…" location="…">\n…\n</skill>\n\nargs` 成为用户消息 content」这件事。

**`SKILL_BLOCK_RE` 是「去锚定 + matchAll + 非贪婪 args + 前瞻」。** 正则 `/<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+?))?(?=\n<|$)/g`。四个设计点：

- 去 `^`/`$` 锚定、`g` 标志 + `matchAll` 扫全文，每个匹配的 `m.index` 直接填 `start`/`end`——块出现在消息任意位置（组合场景、重试后结构变动）都能识别。
- args 非贪婪 `([\s\S]+?)` + 前瞻 `(?=\n<|$)`：args 从双换行后开始、非贪婪增长，停在「第一个满足 `\n<` 的位置之前」——单 skill 消息时 args 一路收到串尾，组合场景（评论篮 review 块被并进 args 尾部）时 args 在 `<pi-review>` 前停住，review 块留给 review parser 独立提取，skill 条的 args 摘要不被污染。
- 前瞻保持宽匹配 `\n<`、不收紧成「只认已知块标签」——收紧意味着 skill parser 的正则要引用 review 的标签名，内容插件之间互相感知格式，是横向耦合（设计 §4.1 明确否掉）。
- `data = { name, location, content, args }`；`location` 是内核注入的机器信息，不渲染（Windows 反斜杠路径是噪声）。

**`auxParsers` 是 `AuxBlockParser[]`，id 为 `"skill"`。** `parse(text)` 返回 `blocks.length > 0 ? { blocks } : null`。这个 parser 经 `packages/react/src/aux-block-parsers.ts` 的 `registerAuxParsers` 注册进 renderer 侧的全局注册表，`plugins-host.ts` 加载 module 时收集 `mod.auxParsers` 调用注册（`registerAuxParsers(auxParsers)` + `pluginAuxParserIds.set(pluginId, ...)`），卸载时 `unregisterAuxParsers`。timeline 的 `blocks.ts` 经 `getAuxParsers()` 拿全部解析器喂给 `parseUserBlocks` 做结构化块识别。

**`SkillAuxBlock` 是引用条渲染器。** 它吃 `{ aux }: { aux: AuxBlock }`，把 `aux.data as SkillAuxData`（`{ name, location, content, args? }`）渲染成一行摘要：`<Sparkles>` 图标 + `t("skill-blocks.skillRef", { name })`（「已引用技能 {{name}}」）+ `args` 首行（`data.args?.split("\n")[0]?.trim()`）。点击展开 SKILL.md 正文（`data.content`，`max-h-64 overflow-y-auto whitespace-pre-wrap`），location 不渲染、无点击跳转（注释说「skill 引用的是技能不是消息片段」）。这符合设计 §8.3「skill 引用条：一行摘要 + 正文点开」。

## 8 与其他插件交互（专节）

这一节回答任务指定的「与其他插件交互」。skill-manager 通过四条途径和其他插件/框架交互：`blockRenderers` 槽（被 timeline 消费）、`languages` 槽（i18n 合并）、事件总线（`skills:changed`）、以及「其他插件携带 skills 目录」的挂载通道。

**与 timeline 插件的交互：`auxBlock` 槽的贡献与消费。** skill-manager 贡献 `blockRenderers` 槽的 `auxBlock/skill` 项（`component: "SkillAuxBlock"`），而 `auxBlock` 这个 block 类型由 timeline 的渲染链路消费——timeline 的 `blocks.ts` 先经 `getAuxParsers()` 拿全部解析器（其中就有 skill-manager 的 `auxParsers`）识别结构化块，再按 block 的 `type`/`names` 找 `blockRenderers` 槽里匹配的组件渲染。所以 skill-manager 和 timeline 之间是「槽位提供方 vs 槽位消费方」的关系：skill-manager 出内容（parser + 渲染器 + 文案），timeline 出机制（识别派发 + 消息流渲染）。历史上 skill parser 曾住在 timeline 插件内部（`timeline/renderer/skill-aux.tsx`），这是「提供槽位的插件同时贡献了槽上内容」的机制-内容分离破口，`docs/design/aux-block-mechanism.md §4` 记录了归位到 skill-manager 的过程——归位后 skill-manager 与 review 插件同形（parser、渲染器、交互全在自己插件里）。第三方可用同 contribution id 整规则替换覆盖 skill 块渲染；删掉 skill-manager，skill 块按正文裸显，机制不受影响，是天然降级路径。

**与 i18n 框架的交互：`languages` 槽的 namespace 合并。** skill-manager 贡献两个 namespace 的四个 locale 文案，框架 i18n 在启动时把这些资源合并进全局资源表（`assemble.ts` 的 `i18n: { resources: i18nResources, ... }` 收集所有语言贡献）。页面内 `useTranslation()` 拿到的 `t` 就能命中 `settings.*` 和 `skill-blocks.*` 的 key。这里有个「文案跟内容走」的纪律样本：`skill-blocks.skillRef` 这个 skill 块引用条文案，历史上是 `timeline.skillRef`（在 timeline 的 locales 里），归位时随 parser/渲染器一起迁到 skill-manager 的 locales，因为「skill 内容在 skill-manager，文案就不该横跨到 timeline 的包里」。

**与事件总线的交互：`skills:changed` 是唯一的刷新广播。** skill-manager 页面自己不直接 emit 事件，它订阅的是框架/后端广播的 `skills:changed`（`packages/shared/src/channel/channel-contract.ts` 里 `skills.changed = "skills:changed"`）。后端 `controllers/skills.ts` 在 `setModelInvocable` 后 `gateway.broadcast("skills:changed")`、在 `setEnabled` 后 `broadcastSettingsChanged(gateway)`，chokidar 监听到文件变化去抖后也 `gateway.broadcast("skills:changed")`。skill-manager 页面经 `ctx.skills.watch`（renderer 侧 `watch` 订阅后端推的 `skills:changed`）触发 `refresh`。这是「事件驱动、不轮询不 sleep」的落地——列表刷新靠事件推，不靠定时器猜。

**与其他壳插件「携带 skills 目录」的交互：plugin-skills 挂载。** 一个壳插件可以在自己的目录里带一个 `skills/` 目录（`<pluginPath>/skills`），壳在插件 activate/deactivate 时经 `ensurePluginSkillsEntry`（`pi-bundled-skills.ts`）把它挂/摘进 pi 的 `settings.json skills[]`。`assemble.ts` 第 337-359 行定义了 `pluginSkillsEnsure`（`PluginLifecycleDeps["skillsEnsure"]`），activate 时 `join(pluginPath, "skills")` 存在且非空就 `ensurePluginSkillsEntry({ settingsPath, skillsDir, active: true, homeDir })`，deactivate 时 `active: false`。这是 skill-manager 作为「技能管理 UI」间接感知的：其他插件贡献的技能会出现在它的列表里（经 pi 扩展扫描播报），skill-manager 不直接和那些插件对话，它只看到内核回报的列表多了几行 `source` 为 `local` 的技能。

**依赖方向总结。** skill-manager 只 import `@my-harness-desktop/shared` 和 `@my-harness-desktop/react`（以及 `react`/`react-i18next`/`lucide-react` 这些纯 UI 库），它不 import 任何 `@/server`/`@/core`/`@/client` 的东西。它拿数据只经 `ctx.skills`（`usePluginContext()` 注入，底层是 `window.kernel.skills`，再底层是 HTTP/WS transport → 壳后端 `controllers/skills.ts` → `SkillAggregator` → 两个 `SkillProvider`）。它发刷新信号只经 `watch` 订阅 `skills:changed`。它和其他插件之间没有共享 store 互读写、没有直调对方能力，唯一合法通道是事件和槽位。

## 9 IPC 网关层与 bootstrap 组装

这两层把「聚合器」和「UI」接起来，是技能链路「传输 + 组装」的一半。

**`src/server/controllers/skills.ts`：`registerSkills(gateway, ctx)` 注册八个 IPC handler。** 解构 `ctx` 的 `{ prefsStore, paths, skillAggregator, ensureBundledSkills }`，然后：

- `IPC.skills.list` → `skillAggregator.listSkills(cwd || process.cwd())`。
- `IPC.skills.getCapabilities` → `skillAggregator.capabilities`。
- `IPC.skills.setEnabled` → `skillAggregator.setEnabled` + `broadcastSettingsChanged(gateway)`（写 settings.json 所以广播 settings 变化）。
- `IPC.skills.setModelInvocable` → `skillAggregator.setModelInvocable` + `gateway.broadcast("skills:changed")`（改 frontmatter，广播技能变化）。
- `IPC.skills.getBundled` → `{ path: paths.bundledSkillsDir, enabled: prefsStore.get("bundledSkillsEnabled") }`。
- `IPC.skills.setBundledEnabled` → `prefsStore.set("bundledSkillsEnabled", enabled)` + `ensureBundledSkills(enabled)`，`changed` 时 `broadcastSettingsChanged`，最后 `gateway.broadcast("skills:changed")`。
- `IPC.skills.watch` → 用 chokidar 监听三个路径（`~/.pi/agent/settings.json`、`<cwd>/.pi/settings.json`、`~/.pi/agent/desktop-skills.json`），任何 `add/unlink/change/addDir/unlinkDir` 事件去抖 300ms 后 `gateway.broadcast("skills:changed")`；按 cwd 建 `skillWatchers` Map 管理 watcher 生命周期，重复 watch 先 close 旧的。
- `IPC.skills.unwatch` → close 对应 cwd 的 watcher 并删除。

**两个广播的语义区分值得注意：** `setEnabled`（写 `settings.json` 的 `+/-` 或 disabled 名单）走 `broadcastSettingsChanged`，因为 pi 的 `settings.json` 是壳 settings 域的一部分；`setModelInvocable`（改 frontmatter 文件）走 `skills:changed`。这个区分让「设置变了」和「技能变了」是两个事件，下游订阅方各取所需。

**`src/server/bootstrap/assemble.ts`：组装聚合器与内置技能。** 第 454-464 行构造 `skillAggregator`：

```
const skillAggregator = new SkillAggregator([
  new PiSkillProvider({ agentDir: PI_AGENT_DIR, homeDir: HOME_DIR, builtinSkillsDir: BUNDLED_SKILLS_DIR, getCwd: () => sessionStore.getActiveCwd() }),
  new DshSkillProvider({ dshHome: join(HOME_DIR, ".dsh") }),
]);
```

这里 `PiSkillProvider` 的 `getCwd` 是一个闭包 `() => sessionStore.getActiveCwd()`——不直读 `process.cwd()`，由 session-store 提供当前活动项目，符合「内层不读环境信息、由外层注入」。`builtinSkillsDir: BUNDLED_SKILLS_DIR`（`~/.my-harness-desktop/skills`）让 pi provider 能把内置目录的技能标 `builtin`。`DshSkillProvider` 只注入 `dshHome`，其余路径由它内部推导。

**内置技能镜像与挂摘。** `BUNDLED_SKILLS_DIR` 是 `join(MY_HARNESS_DESKTOP_DIR, "skills")`，源是 `.claude/skills`（dev）或 `process.resourcesPath/my-harness-desktop-skills`（pkg）。启动时 `mirrorBundledSkills(bundledSkillsSource, BUNDLED_SKILLS_DIR)`（即 `mirrorManagedDir`）把内置技能强制覆盖镜像到受管目录，再 `ensureBundledSkillsEntry({ enabled: prefsStore.get("bundledSkillsEnabled") })` 按偏好挂/摘 pi 的 `settings.json skills[]` 条目。`ensureBundledSkills` 闭包（第 330-331 行）把它包成 `(enabled) => Promise<boolean>` 注入 `MainContext`，供 `controllers/skills.ts` 的 `setBundledEnabled` 调用。`ctx` 里还注入了 `skillAggregator` 和 `pluginSkillsEnsure`（第 494、503 行），最后 `registerSkills(gateway, ctx)` 注册 handler（第 522 行）。

## 10 依赖方向与纪律检验

把整条链路的依赖方向画出来，验证它不破「依赖只向内」：

```
packages/shared/src/domain/skills.ts        ← 圆心契约(SkillInfo/SkillCapabilities/SkillProvider)，零依赖
        ▲ implements
src/server/kernel/pi/extension/pi-skill-provider.ts     ← pi 内核适配器
src/server/kernel/dsh/extension/dsh-skill-provider.ts   ← dsh 内核适配器
        ▲ 聚合(构造注入)
src/server/application/skills/skill-aggregator.ts        ← 壳后端用例编排(只依赖 SkillProvider 接口)
        ▲ 注入 ctx
src/server/controllers/skills.ts                          ← 网关 handler
        ▲ transport
src/plugins/manager/skill-manager/renderer/*.tsx          ← 壳插件(只 import shared + react)
```

- 圆心 `skills.ts` 零依赖、不含内核字面量——「契约单源」和「中性」成立。
- `skill-aggregator.ts` 只 import `@my-harness-desktop/shared` 的类型——「application 不 import 内核实现」成立。
- 两个 provider 住在 `src/server/kernel/{pi,dsh}/extension/`——「内核适配器读/写自己的存储，合法」成立。
- `skill-manager` 壳插件只 import `shared` + `react`——「壳插件不跨层 import」成立。
- `assemble.ts` 做组装（把 provider 注入聚合器、注入 ctx）——「组装归 bootstrap」成立。

grep 级的验证点：`SkillAggregator` 的调用方看不到任何内核身份字面量；壳后端的 `skills.ts`/`skill-aggregator.ts`/`controllers/skills.ts` 里对 `settings.json`/`settings.yaml`/`.pi/skills`/`.dsh/skills` 的扫描引用归零（这些字面量只出现在两个内核 provider 和两个内核插件里）；`renderer/index.tsx` 里无 `if (kernel)`、无 `.pi`/`.dsh` 路径字面量。

## 11 QA

**Q：skill-manager 的开关点下去，为什么提示「下次会话生效」，而不是立刻生效？**

因为两根轴的落点都是「下次会话读」的存储。`enabled` 轴 pi 写 `settings.json` 的 `+/-`、dsh 写 disabled 名单，这些都在新会话启动/重新发现时读；`modelInvocable` 轴改 SKILL.md 的 frontmatter，pi 也是下次加载时读（dsh 的 watcher 可能下一轮 step 反映，但壳不承诺实时）。UI 的即时刷新来自 `watch` 回报变化后重拉列表，但内核真正按新状态加载要等下次会话。这是内核的加载时机决定的，不是壳能改的，所以文案 `settings.skillNextSession` 如实提示。

**Q：同名技能同时出现在全局和项目目录，列表怎么处理？**

都显示，不合并。`SkillAggregator.listSkills` 的去重 key 是 `filePath ?? name:scope`——两个不同物理路径的同名技能有不同 `filePath`，是两条独立记录，`enabled`/`modelInvocable` 各自独立。同名冲突的加载优先级由内核自己裁决（pi 是后加载覆盖、dsh 是 rank + 最近层优先），壳不干预，只如实列出。

**Q：skill-manager 页面为什么没有「添加技能路径」的入口？**

因为路径是只读的。设计文档 §5.1 定了「路径表是只读的：壳不提供运行时增删路径的 UI」。当前实现里路径来自内核扫描回报（`sourceDir`），页面只做「来源路径多选筛选」——透传展示 + 相等过滤，不反推、不写死。locale 里残留的 `settings.skillAddSource`/`settings.skillAddSourceHint`/`settings.skillAdd` 三条 key（写 `~/.pi/agent/settings.json` 和 `{cwd}/.pi/settings.json`）在 `renderer/index.tsx` 里没有被引用，是历史文案残留——这印证了「路径只读」已经落地、增删路径的 UI 已移除。

**Q：`setEnabled` 在 pi 和 dsh 上语义完全等价吗？**

基本等价，但有一个知情差异。pi 的 `-pattern` 让技能完全不进加载列表；dsh 的 disabled 名单让技能在 fork provider 的 `list` 阶段被过滤、不进 catalog。两者对用户和模型可见面都是「这个技能不存在」，等价。差异在于 dsh 的受信 `ctx.skills.get()` 理论上仍可能读到被过滤技能的定义（如果实现没在 get 层也过滤）——这个差异只对写 dsh 编排代码的人可见，对桌面用户不可感知，壳不区分呈现。

**Q：内置技能被禁用后，app 升级会丢状态吗？**

分轴看。`enabled` 轴的禁用状态落在 `settings.json` 的 `+/-` 或 dsh 的 disabled 名单——这些是配置，不在受管目录里，升级覆盖不到，能跨升级持久。`modelInvocable` 轴落在 SKILL.md 的 frontmatter，而内置目录是受管目录、`mirrorManagedDir` 启动时强制覆盖镜像，会把 frontmatter 改回源、丢状态。所以「固定到上下文」这轴对内置技能有「升级覆盖丢状态」的边界，`enabled` 轴没有。

**Q：为什么 skill 块解析器 `auxParsers` 和渲染器 `SkillAuxBlock` 都要在 `renderer/index.tsx` 里 re-export？**

因为它们走两条不同的注册路径。`auxParsers` 是代码级声明——`plugins-host.ts` 加载 module 时读 `mod.auxParsers` 调 `registerAuxParsers`，只有从入口 export 出来才挂得到 module 的 exports 上。`SkillAuxBlock` 是 manifest 组件自动匹配——`plugin.json` 的 `blockRenderers` 声明 `component: "SkillAuxBlock"`，框架在 module 的 exports 里找同名组件。两条路径都依赖「入口 re-export」这一个动作，缺一条就断一条。这是「组件自动匹配」+「代码级 parser 注册」并存时的一个具体约束。

**Q：skill-manager 自己不带 `pi-extension/` 和 `dsh-extension/` 目录，内核侧的扫描和播报逻辑在哪？**

在统一适配插件里。pi 侧是 `packages/my-harness-fit-pi-extension/`（`skills.ts` 挂 `session_start` 写播报文件、`scanner.ts` 扫 pi 存储），dsh 侧是 `src/server/kernel/dsh/extension/dsh-extension/index.mjs`（fork `FileSystemSkillProvider` 过滤 disabled + 写播报文件）。这两个是「内核插件」（跑在内核进程里），不是「壳插件」，不进壳插件加载器。skill-manager 这个壳插件只出 UI，四件套里的 `pi-extension`/`dsh-extension` 两件被「收敛成统一适配插件、bootstrap 常驻同步」替代了。
