# goody-hao：内置工程原则注入 + 内置 skills

goody-hao 是系统域里"内容含量最高、机制最简"的一个壳插件。它做两件事，对应目录里的两样东西：一是经 `systemPrompts` 槽贡献一份 `CLAUDE.md`（工程原则），spawn 时注入内核 system prompt；二是随插件携带一个 `skills/` 目录（`write-design-doc` 和 `arch-to-code` 两个 skill），由壳的插件 skills 挂载机制同步进 pi 内核的 skills 源路径。它没有 renderer、没有 locales、没有 pi-extension/dsh-extension 目录——它的"能力"通过两个声明式通道（systemPrompts 槽 + skills 目录）外挂，插件本体零代码。

## 职责边界

goody-hao 的职责是**给会话注入工程原则**和**给内核提供两个内置 skill**，两半走不同的机制，边界要分清楚。

- **systemPrompts 槽：注入工程原则**。`plugin.json` 的 `contributes.systemPrompts` 声明 `{ id: "engineering-principles", file: "./CLAUDE.md", order: 100 }`，`CLAUDE.md` 内容是一份工程原则（关注点分离、组装调用分开、洋葱架构思维、worktree 操作禁令、八荣八耻、实现类回复格式要求）。这是"内容全部外挂"的活样本：工程原则是会变的内容，不该焊进壳或内核，做成一个插件的 `CLAUDE.md` 经 systemPrompts 槽注入，改原则只改这份文件。

- **skills 目录：两个内置 skill**。`skills/write-design-doc/` 和 `skills/arch-to-code/` 是两个完整的 SKILL.md + 参考资料，经壳的插件 skills 挂载机制（`assemble.ts` 的 `pluginSkillsEnsure.onActivate`）在插件 activate 时把 `skills/` 目录挂进 pi 内核的 `settings.json` skills[] 源路径，内核扫描后作为可调 skill 暴露给模型。这是"技能也是内容"的体现——skill 的写法、反 AI 味原则、工作流都是内容，随插件分发。

## 目录结构

```
src/plugins/system/goody-hao/
  plugin.json           manifest：只贡献 systemPrompts 槽
  CLAUDE.md             注入的工程原则（systemPrompts 槽的 file）
  skills/
    write-design-doc/
      SKILL.md          技术设计文档共创 skill
    arch-to-code/
      SKILL.md          架构文档到代码实现全周期 skill
      references/
        blind-review-prompts.md   盲审提示模板
        workflow-script.js        Workflow 脚本模板
```

没有 `renderer/`、没有 `locales/`、没有 `pi-extension/`、没有 `dsh-extension/`。它和 read-claude-md 一样是"无 UI 壳插件"，但机制不同：read-claude-md 走 `piExtension`（内核扩展随启停同步），goody-hao 走 `systemPrompts` 槽（壳收集 + 内核工厂翻译）+ `skills/` 目录（壳挂载到 pi skills 源路径）。

## plugin.json 逐字段

```json
{
  "id": "goody-hao",
  "version": "0.4.9",
  "tier": "official",
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

- **`systemPrompts` 贡献**。`SystemPromptContribution`（`packages/shared/src/domain/contributions.ts` 第 347–353 行）：`id`（贡献 id）、`file`（相对插件目录的文件路径）、`order`（排序，小的先注入）。manifest 只声明这一条，`skills/` 目录**不在 manifest 里声明**——它靠的是"插件目录下有没有 `skills/` 子目录"这个约定，由 `assemble.ts` 的 `pluginSkillsEnsure` 扫描发现（不是 `contributes` 字段）。

- **`description` 的时差**。描述写"经 --append-system-prompt 注入底座 system prompt"，这对应 pi 侧的注入路径。但 systemPrompts 槽现在是多内核中性的：`BackendCreateOptions.systemPromptPaths` 里明确写"pi 翻译成 `--append-system-prompt <path>`;dsh 忽略"（`backend.ts` 第 232 行）。dsh 下这份 CLAUDE.md 不会被注入——它是 pi 专属的 system prompt 文件路径，dsh 显式忽略。description 仍用 pi 术语"底座"是历史残留（读到底座按 pi 内核理解）。

## systemPrompts 槽的注入链路

goody-hao 的 `CLAUDE.md` 从插件目录到内核 system prompt，跨了 registry → session-store → 内核工厂三层，全是壳的机制，goody-hao 一行代码不写。

- **registry 收集**。`src/server/application/loader/registry.ts` 第 377–389 行的 `systemPromptPaths()`：`this.systemPrompts.all()` 拿全部贡献项，`resolve(plugin.path, s.contribution.file)` 解析成绝对路径（`file: "./CLAUDE.md"` → `.../goody-hao/CLAUDE.md`），按 `order` 升序排序返回绝对路径数组。`systemPrompts` 是 `ArraySlot<SystemPromptContribution>`（registry 第 101 行）。

- **session-store 传递**。`session-store.ts` 第 191 行注释点明"插件贡献的 systemPrompts 槽项；插件卸载 → 贡献移除 → 不注入；空数组不拼 argv"。session-store 把 `systemPromptPaths` 作为 `BackendCreateOptions` 的一部分传给 `BackendFactory.create`。

- **内核工厂翻译**。`src/server/kernel/factories/kernel-factories.ts` 第 37–44 行的 pi 工厂：`for (const p of opts.systemPromptPaths ?? []) args.push("--append-system-prompt", p)`——把路径拼成 `--append-system-prompt <path>` argv 传给 pi 子进程。`systemPromptTexts` 同理（角色卡内联）。dsh 工厂**不消费**这两个字段（`backend.ts` 第 232/234 行注释"dsh 忽略"），这是多内核的显式降级：pi 有 `--append-system-prompt` 机制，dsh 没有对应物，dsh 侧这份 CLAUDE.md 静默不进 system prompt。

- **卸载即停止注入**。插件卸载 → registry 的 systemPrompts ArraySlot 移除贡献 → `systemPromptPaths()` 下次收集不再包含该文件 → session-store 不拼对应 argv。这是"内容外挂、内核只提供机制"的完整闭环：goody-hao 卸载，只是下次 spawn 少一个 `--append-system-prompt` 参数，壳和内核机制不动。

## CLAUDE.md 内容（注入的工程原则）

goody-hao 的 `CLAUDE.md`（80 行）是注入的正文，内容是一份精简版工程原则。它和仓库根的 `CLAUDE.md` 是**不同文件**——仓库根的是给开发者的全量纪律（§1–§10 + 工程原则），goody-hao 的这份是**注入给每个会话的、随 system prompt 走的精简版**，只留"关注点分离""组装和调用分开""洋葱架构思维""Worktree 操作禁令""Claude Code 八荣八耻""实现类回复格式要求"六节。

- **为什么是精简版**。注入 system prompt 的内容有 token 成本——每个会话 spawn 都带，太长浪费。所以 goody-hao 的 CLAUDE.md 只留最通用的几条（回调参数是责任边界模糊的气味、组装调用分开、依赖只向内、worktree 禁令、八荣八耻、回复末尾追加架构自检 + 修改文件清单），把全量纪律留在仓库根 CLAUDE.md 给开发者读。

- **"架构自检 + 修改文件清单"的回复格式要求**（第 65–80 行）。这是注入内容里最"强制"的一条：每次涉及代码实现/重构/修复的回复，末尾必须追加"架构自检"checkbox（高内聚/低耦合/开闭/方案视角/洋葱架构五条）和"修改文件清单"（按目录分组的树形清单）。这是注入 system prompt 能真正改变模型行为的地方——不是抽象说教，是可检查的回复格式契约。

## skills 目录与挂载机制

goody-hao 的 `skills/` 目录不靠 `contributes` 字段声明，靠"插件目录下有 `skills/` 子目录"这个约定，由壳在插件生命周期里挂载。这是和 systemPrompts 槽**不同的第二套机制**。

- **`pluginSkillsEnsure` hooks**（`assemble.ts` 第 336–357 行）。`PluginLifecycleDeps["skillsEnsure"]` 的 `onActivate(pluginId, pluginPath, source)`：`join(pluginPath, "skills")` 若存在且非空，`ensurePluginSkillsEntry({ settingsPath, skillsDir, active: true, homeDir })` 把 skills 目录挂进 pi 的 `settings.json` skills[]。`onDeactivate` 对称摘除。`settingsPath` 按 source 区分：project 级用 `process.cwd()/.pi/settings.json`，否则 `~/.pi/agent/settings.json`。

- **`ensurePluginSkillsEntry`**（`src/server/kernel/pi/extension/pi-bundled-skills.ts` 第 68–79 行）。读 settings.json 的 `skills` 数组，`isOurs` 判断（`resolvePath` 归一后等于 target 的普通条目），`active === present` 则不动，否则 append/remove target 并 `writeJsonFile(..., "deep")`。这是 pi 内核自己的存储格式（settings.json skills[] 的源路径条目），由 pi 适配器读写，壳经适配器函数调用不直接碰格式。

- **启动同步**（`assemble.ts` 第 580–597 行）。启动时 `registry.allPlugins()` 遍历所有插件，有 `skills/` 目录的逐个 `ensurePluginSkillsEntry(active: true)`，任一 changed 就 `broadcastSettingsChanged`。这保证"用 my-harness-desktop 就有"不依赖用户先触发 activate。

- **与 `.claude/skills/` 顶级内置源的区别**。`.claude/skills/` 是仓库顶级的内置 skills 源（`my-harness-desktop-guide`、`write-plugin`），经 `mirrorBundledSkills`（`application/bundled/mirror.ts` 的 `mirrorManagedDir`）强制覆盖镜像到 `~/.my-harness-desktop/skills/` 受管目录，再 `ensureBundledSkillsEntry` 挂进 settings.json skills[]。goody-hao 的 `skills/` 是**插件随附**的 skills，走 `ensurePluginSkillsEntry` 挂到插件自己的目录路径。两条路：顶级内置源（受管目录，随 app 升级覆盖）+ 插件随附（随插件启停挂/摘）。

## 两个内置 skill 详解

goody-hao 携带两个 skill，都是"反 AI 味"主题，且 `write-design-doc` 是 `arch-to-code` 的前半（设计），`arch-to-code` 是设计 + 实现 + 验证的全周期。

### write-design-doc（技术设计文档共创）

`skills/write-design-doc/SKILL.md`（188 行）是一个"共创技术设计文档、保证像人写的不像 AI 写的"skill。frontmatter（第 1–9 行）：`name: write-design-doc`、`disable-model-invocation: false`（模型可自动调用）、`argument-hint`。

- **四段式共创工作流**（§2）。对齐问题（动笔前硬门禁，用户没确认"解决什么问题"和大纲前禁止起草正文）→ 按节起草（轻量循环，一节一事）→ Clean Room 盲测（全新读者盲测文档能不能看懂）→ 写 QA 章节。mermaid 图（第 104–119 行）画了回环：盲测暴露缺口回起草改、再测，反复到盲测干净，3 轮还不干净交用户定夺。

- **13 条核心立场**（§1.1–1.13）。无元数据（文档直接从 `# 标题` 开始）、代码不盘点、先想统一抽象再分类、不要声明式类型标签、块状化散文、行文要活、结尾写给人看、禁用 AI 套话、指代落到锚点、写充分不写水、能并行就并行、最后一节固定 QA、方案选最完整最洋葱的。这套纪律和本仓库的文档写作要求高度同源——尤其 §1.5 的"块状化散文"（论证式 bullet、段内并列下钻子 bullet）正是本次这批插件文档在遵守的写法。

- **反模式**（§3）。被催着跳过对齐、盲测偷懒成自己考自己、把核心立场当清单照填、把盲测缺口一股脑塞进 QA。每个反模式都是"AI 味"的典型失败模式。

### arch-to-code（架构文档到代码实现全周期）

`skills/arch-to-code/SKILL.md`（173 行）是"结合真实代码库写一份 ≥3万字架构文档，再用动态 Workflow 长程任务按文档实现代码，最后复盘测试"的全周期 skill。frontmatter `disable-model-invocation: true`（不自动调用，用户显式触发）。

- **前半产 spec（§0–§6），后半实现 + 验证（§7–§8）**。§1 标题 + 简介手动硬门禁（AI 绝不生成标题）→ §2 真实代码接地大纲 → §3 审大纲硬门禁 → §4 扩写 ≥3万字（头脑风暴 + 逐节盲审）→ §5 审全文 → §6 写 QA 章冻结为 spec → §7.0 抽实现任务清单 → §7.1 Workflow 实现代码（discover→transform→verify→loop）→ §8 复盘/复检/测试。

- **与 write-design-doc 不重叠**。frontmatter 第 5–6 行明写："write-design-doc 是前向设计、不落地代码、无真实代码库锚定、非 3万字；本 skill 独立，反 AI 味原则自带一份"。两个 skill 是同一主题（反 AI 味文档）的两种形态：一个只管设计，一个从设计一路到代码实现。

- **`references/` 两份模板**。`blind-review-prompts.md`（104 行）是零上下文 subagent 盲审的提示模板，覆盖 §4.2 逐节盲审、§5 整文档盲测、§8 spec-vs-impl 盲审、§8 复盘四类。`workflow-script.js`（238 行）是 Workflow 脚本模板（discover/transform/verify/loop 四 phase + `topoWaves` 拓扑分波 + `partitionByOverlap` overlap 分组 + `runGate` 用 agent 跑机械门），主对话填占位符后启动。这两份是 skill 的"可执行资产"，不是 SKILL.md 正文，arch-to-code 在 §4.2/§5/§7.1/§8 引用它们。

## skills 如何变成模型可调的能力

goody-hao 的 `skills/` 目录挂进 pi 内核的 skills 源路径后，pi 内核扫描、解析 frontmatter、经 SkillProvider 回报给壳，壳经 skill-manager 展示、模型经内核的 skill 机制调用。这条链路的契约在 `packages/shared/src/domain/skills.ts`。

- **`SkillInfo`（skills.ts 第 17–34 行）**。中性技能：`name`（frontmatter name）、`description`、`scope`（user/project）、`enabled`、`modelInvocable`（frontmatter `disable-model-invocation` 的反值）、`source`/`filePath`/`sourceDir`。`write-design-doc` 的 `disable-model-invocation: false` → `modelInvocable: true`（模型可自动调用）；`arch-to-code` 的 `true` → `modelInvocable: false`（用户显式触发）。

- **`SkillProvider`（skills.ts 第 37–48 行）**。壳和内核之间的技能中立契约：`capabilities`（toggleEnabled/toggleModelInvocable 两根轴）、`listSkills(cwd)`、`setEnabled`、`setModelInvocable`、`watch`。pi 侧实现 `PiSkillProvider`（`src/server/kernel/pi/extension/pi-skill-provider.ts`），读 pi 扩展播报的 `desktop-skills.json`；dsh 侧实现 `DshSkillProvider`（`src/server/kernel/dsh/extension/dsh-skill-provider.ts`）。壳经 `SkillAggregator`（`application/skills/skill-aggregator.ts`）聚合多内核的 provider。

- **壳不读任何内核存储**。扫描目录、读配置、解析 frontmatter 全是内核侧（pi 扩展、dsh 插件）的事，内核经 SkillProvider 回报完整列表。goody-hao 的 skills 只是"内容"——它的 SKILL.md 文件，扫描和解析由内核做，壳只拿到 `SkillInfo` 列表展示。

## 贡献的槽

- **`systemPrompts`**（`SystemPromptContribution`，`contributions.ts` 第 347 行）：贡献 `engineering-principles` → `./CLAUDE.md`。

不贡献 `settings`、`settingsGroups`、`titlebar`、`languages`，不声明 channel，不声明 `piExtension`/`dshExtension`。它的 `skills/` 目录是第二套机制（插件目录约定 + `pluginSkillsEnsure`），不是槽位。

## 与其他插件交互

- **经 session-store 与内核交互**。goody-hao 的 CLAUDE.md 由 session-store 收集 systemPrompts 槽项后经 pi 工厂 `--append-system-prompt` 注入。goody-hao 不 import session-store、不 import 内核工厂，只声明 manifest。

- **与 read-claude-md 的机制对比**。两者都往会话注入内容，但 goody-hao 走 systemPrompts 槽（壳收集 + 内核工厂 argv 翻译，注入 system prompt），read-claude-md 走 piExtension（内核扩展 `before_agent_start` 注入隐藏消息）。前者是"壳往内核传提示"，后者是"内核自己发现并注入"；前者 pi 有 `--append-system-prompt`、dsh 忽略（显式降级），后者 pi 扩展 + dsh 统一适配插件都做（能力对称）。

- **与 skill-manager 的消费关系**。goody-hao 的 skills 挂进 pi 内核后，由 skill-manager 插件的设置页展示（skill-manager 是"出 UI 的壳插件"，内核侧扫描在统一适配插件里）。goody-hao 不 import skill-manager，只提供 skills 内容，skill-manager 经 SkillProvider 消费。

- **与 `.claude/skills/` 顶级内置源并列**。goody-hao 的 skills 和 `.claude/skills/`（write-plugin、my-harness-desktop-guide）是两套内置 skills 来源：前者插件随附（随插件启停挂/摘），后者仓库顶级（镜像到受管目录，随 app 升级覆盖）。两者都最终进 pi 内核的 skills[] 源路径，模型统一可见。

## 相关契约与类型落点

- `SystemPromptContribution`：`packages/shared/src/domain/contributions.ts:347`
- `BackendCreateOptions.systemPromptPaths`：`packages/shared/src/domain/backend.ts:232`
- `systemPromptPaths()`（registry 收集）：`src/server/application/loader/registry.ts:377`
- pi 工厂 argv 翻译：`src/server/kernel/factories/kernel-factories.ts:37–44`
- `pluginSkillsEnsure`：`src/server/bootstrap/assemble.ts:336–357`
- `ensurePluginSkillsEntry`：`src/server/kernel/pi/extension/pi-bundled-skills.ts:68`
- `SkillInfo`/`SkillProvider`：`packages/shared/src/domain/skills.ts:17/37`

## QA

**Q：任务描述说 goody-hao 含 "write-design-doc/write-plugin" 两个内置 skills，但目录里是 write-design-doc 和 arch-to-code，哪个对？**

A：目录里是 `write-design-doc` 和 `arch-to-code` 两个（`src/plugins/system/goody-hao/skills/`）。`write-plugin` 在仓库顶级的 `.claude/skills/write-plugin/`（内置 skills 源，随壳分发的职业技能目录），不属于 goody-hao。所以任务描述里的 "write-plugin" 是张冠李戴——goody-hao 自己的 skills 是 write-design-doc + arch-to-code，write-plugin 是 `.claude/skills/` 顶级内置源里的另一个 skill。两个来源（插件随附 skills/ vs 顶级 .claude/skills/）是不同的挂载机制，别混淆。

**Q：goody-hao 卸载后，已经注入的工程原则还在当前会话里吗？**

A：当前已 spawn 的会话不受影响（system prompt 在 spawn 时已经拼进进程），但**下次新会话**不再注入。卸载 → registry 的 systemPrompts ArraySlot 移除贡献 → `systemPromptPaths()` 下次收集不含该文件 → session-store 不拼 `--append-system-prompt` 参数。这是"卸载即停止注入"的语义：影响的是新会话，不是已运行会话（已运行会话的 system prompt 是进程启动时的快照）。

**Q：dsh 内核下，goody-hao 的 CLAUDE.md 会被注入吗？**

A：不会。`BackendCreateOptions.systemPromptPaths` 注释写"pi 翻译成 --append-system-prompt <path>;dsh 忽略"（`backend.ts` 第 232 行）。pi 工厂把路径拼成 argv，dsh 工厂不消费这个字段。这是多内核的显式降级：dsh 没有 `--append-system-prompt` 这个 spawn 机制，对应能力在 dsh 里是 cordis 插件（不是 spawn argv），所以 systemPrompts 槽在 dsh 下静默不生效。如果将来要给 dsh 也注入这份工程原则，得走 read-claude-md 那样的统一适配插件（dsh cordis 钩子），不是 systemPrompts 槽。

**Q：goody-hao 的 skills 目录为什么不在 plugin.json 里声明？**

A：因为它走的是"插件目录下有 `skills/` 子目录"这个约定，不是 `contributes` 字段。`assemble.ts` 的 `pluginSkillsEnsure.onActivate` 用 `join(pluginPath, "skills")` + `existsSync` 扫描，发现非空就 `ensurePluginSkillsEntry` 挂载。这是和 systemPrompts 槽（manifest 声明）平行的第二套机制——skills 是"目录即声明"，systemPrompts 是"字段声明"。历史原因：skills 挂载机制（`pluginSkillsEnsure`）晚于 systemPrompts 槽引入，且 skills 的数量和内容更"目录化"（一个 skill 一个子目录），用目录约定比 manifest 数组更自然。

**Q：`arch-to-code` 的 `disable-model-invocation: true` 和 `write-design-doc` 的 `false` 有什么区别？**

A：这是 skill 的"模型可否自动调用"轴。`disable-model-invocation: false` 意味着模型可以在 system prompt 里看到这个 skill 并自动调用（write-design-doc 的"写设计文档"触发词明确，模型遇到用户说"写个方案"可以自动触发）；`true` 意味着模型不自动调用，只能用户显式触发（arch-to-code 是 ≥3万字 + Workflow 实现代码的重型流程，自动触发会误伤，必须用户明确说要"架构文档到代码"才跑）。这个字段经内核解析成 `SkillInfo.modelInvocable`（frontmatter 反值），skill-manager 设置页据此渲染"模型可自动调用"开关。

**Q：为什么 goody-hao 的 CLAUDE.md 只有 80 行，而仓库根 CLAUDE.md 有七万多字节？**

A：token 成本。goody-hao 的 CLAUDE.md 经 systemPrompts 槽在**每个会话 spawn 时**注入 system prompt，太长会吃掉大量上下文。所以它只留最通用的六节（关注点分离、组装调用分开、洋葱架构、worktree 禁令、八荣八耻、回复格式要求），把全量纪律（§1–§10 的分层/多内核/通信机制等）留在仓库根 CLAUDE.md 给开发者读。这是"注入给模型的精简版"和"给开发者读的全量版"的分工。
