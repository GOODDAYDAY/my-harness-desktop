# skill-manager

## 1 这个插件解决什么问题

pi 底座有一套完整的 skill 发现、加载、启用/禁用机制——从四个目录树扫描 SKILL.md，用 `settings.json` 的 `skills[]` 数组里的 `+/-` 模式条目控制每个 skill 的开关，`SettingsManager` 暴露读写 API，`ResourceLoader.reload()` 在运行时重新扫描。但这套机制只能通过 pi 自己的 TUI（`pi config` 命令）或手编 JSON 操作。my-harness-desktop 的桌面用户在一个 GUI 应用里工作，没有理由让他们切到终端跑 `pi config` 或者手动编辑 `~/.pi/agent/settings.json` 去管理 skills。

这个插件把 pi 的 skill 管理搬进 settings 槽。管的不是 SKILL.md 的内容——那 是 skill 作者的事，用任何编辑器都能改。管的是"有哪些 skill、从哪些路径来、哪些开着、哪些关了、添加一个新路径来源、移除一个不想要的路径来源"。对应 pi 的 `pi config` TUI 的 GUI 版，操作对象是 `settings.json` 的 `skills[]` 数组和自动发现的目录树。

一个关键边界：这个插件不负责让 pi 运行中的会话实时生效。pi 没有"reload"的 RPC 命令——`reload()` 是 `AgentSession` 的内部方法，只在交互模式的 `/reload` 命令里调，不经 JSONL RPC 暴露。所以插件写完 settings.json 后，变更在 pi 下次启动新会话时生效；如果用户想在当前会话里立即生效，需要自己在 pi 的终端里跑 `/reload`。这个限制不是插件的问题，是 pi 的 RPC 协议设计决定的——插件能做的是把 UI 做好、把文件写对、把"下次会话生效"这件事在界面上说清楚。

## 2 pi 的 Skill 体系

要设计这个插件，先得把 pi 的 skill 机制从头到尾搞清楚。下面不是设计，是对 pi 源码的事实描述——`skills.ts`、`package-manager.ts`、`resource-loader.ts`、`settings-manager.ts`、`agent-session.ts` 这几个文件里 skill 相关的逻辑。

### 2.1 四种发现来源

pi 从四个地方找 skills，每个地方有不同的 scope 和发现方式。理解这四个来源是设计 scanner 的前提——my-harness-desktop 的 scanner 要复刻同样的发现逻辑，否则展示出来的 skill 列表和 pi 实际加载的不一致。

**`settings.json` 的 `skills[]` 数组（显式路径）**。用户在 `~/.pi/agent/settings.json` 里写 `"skills": ["~/.claude/skills"]`，pi 把这些路径当作"显式声明的 skill 来源目录"。`PackageManager.resolve()` 里的 `resolveLocalEntries()` 方法处理这些条目：先把普通条目（不以 `!`/`+`/`-` 开头的）当作路径解析，`collectFilesFromPaths()` 递归扫描找 SKILL.md；然后 `applyPatterns()` 根据模式条目决定哪些文件 enabled。scope 是 user（全局 settings）或 project（项目级 settings）。source 标记为 `"local"`。

**`~/.pi/agent/skills/` 目录（自动发现，user scope）**。pi 在 `addAutoDiscoveredResources()` 里扫描 `agentDir/skills` 目录，调用 `collectAutoSkillEntries(dir, "pi")` 递归找 SKILL.md。这里的 `mode: "pi"` 表示是 pi 自己的 skills 目录，发现规则是：目录含 SKILL.md 就当 skill 不再递归；否则递归子目录；根目录的 `.md` 文件也认。source 标记为 `"auto"`，scope 是 `"user"`。

**`~/.agents/skills/` 目录（自动发现，user scope）**。和上面一样，但路径是 `~/.agents/skills`（不是 `~/.pi/agent/skills`）。这个目录是跨工具共享的——Claude Code、Cursor 等工具也可能往这里放 skills。pi 用 `mode: "agents"` 扫描它，发现规则和 pi 模式略有不同：根目录的 `.md` 文件不自动认（只认 SKILL.md）。source 标记为 `"auto"`，scope 是 `"user"`。

**项目级 `.pi/skills/` 和 `.agents/skills/`（自动发现，project scope）**。当项目被信任（`projectTrusted = true`）时，pi 扫描 `{cwd}/.pi/skills/` 和 `{cwd}/.agents/skills/`。此外，`collectAncestorAgentsSkillDirs()` 会从 cwd 往上遍历，在每一级目录的 `.agents/skills/` 下找 skills——直到遇到 `.git` 目录停止。这意味着如果项目在 `/Users/foo/projects/myapp`，而 `/Users/foo/.agents/skills/` 也有 skills，pi 会把它们也加载进来（project scope）。source 是 `"auto"`，scope 是 `"project"`。

### 2.2 SKILL.md 的结构和发现规则

SKILL.md 是一个带 YAML frontmatter 的 Markdown 文件：

```markdown
---
name: my-skill
description: This skill helps with...
disable-model-invocation: false
---

# My Skill

Body content...
```

frontmatter 有三个字段：`name`（可选，缺省用目录名）、`description`（必填，缺了 skill 不加载）、`disable-model-invocation`（可选，true 时不进 system prompt，只能 `/skill:name` 调用）。pi 用 `yaml` 包解析 frontmatter（`parseFrontmatter` 函数），不是正则——YAML 的多行值、引号、转义用正则会出错。

`collectSkillEntries()` 是核心发现函数，逻辑是：

1. `readdirSync` 列目录条目。
2. 如果当前目录有 `SKILL.md`，加载它，返回——不再递归。这保证每个 skill 是一个独立单元。
3. 否则遍历子目录：跳过以 `.` 开头的、跳过 `node_modules`、follow symlink。对每个子目录递归。
4. 在 `mode: "pi"` 下，根目录的直接 `.md` 文件也当作 skill（向后兼容）。`mode: "agents"` 下不认根目录散文件。
5. 尊重 `.gitignore`、`.ignore`、`.fdignore`——`addIgnoreRules()` 在每层目录读这些文件，`ignore` 包做匹配。

`loadSkillFromFile()` 解析 frontmatter，做校验：name 不超过 64 字符、只允许小写 a-z + 连字符、不能 `--` 连续；description 必填、不超过 1024 字符。校验失败记 diagnostic 但不崩——skill 不加载，其余 skills 照常。

### 2.3 启用/禁用：+/- 模式条目

这是整个机制最精巧的部分。`skills[]` 数组里的条目不只是路径——它们同时也是启用/禁用的控制开关。

`skills[]` 的条目分两种：

- **普通条目**：不以 `!`/`+`/`-` 开头的，如 `"~/.claude/skills"`。这些是"来源声明"——pi 扫描这些路径找 SKILL.md。
- **模式条目**：以 `!`/`+`/`-` 开头的。这些不是来源声明，而是对"已发现 skills"的启用/禁用控制。

`isOverridePattern()` 判断一个条目是否是模式条目：`!`/`+`/`-` 开头就是。`splitPatterns()` 把 `skills[]` 拆成普通条目和模式条目两拨。普通条目去扫描文件，模式条目去决定扫描到的文件哪些启用。

`isEnabledByOverrides(filePath, patterns, baseDir)` 是判定函数，优先级从低到高：

1. 默认 enabled = true（扫描到的 skill 默认启用）。
2. `!pattern` 排除匹配的（enabled = false）。
3. `+path` 强制启用（enabled = true，覆盖前面的 `!`）。
4. `-path` 强制禁用（enabled = false，覆盖前面的 `+`）。

`-` 优先级最高——这意味着如果你想关掉某个 skill，往 `skills[]` 加一条 `-{相对路径}` 就行，它一定被关。

pi 的 `ConfigSelectorComponent.toggleTopLevelResource()` 是 toggle 的实现：拿到当前 `skills[]`，过滤掉和目标 skill 相关的旧模式条目，根据目标状态推入 `+{pattern}`（启用）或 `-{pattern}`（禁用），然后调 `setSkillPaths(updated)` 写回。pattern 是 SKILL.md 相对于来源目录的路径。

### 2.4 加载流程：从 settings 到 system prompt

`ResourceLoader.reload()` 是完整的加载流程，在 pi 启动、`/reload`、切会话时调：

1. `settingsManager.reload()` 重新从磁盘读 settings.json（global + project 合并）。
2. `packageManager.resolve()` 扫描所有来源，收集到 `ResourceAccumulator`——每个 skill 有 `{ path, metadata, enabled }`。enabled 由 `applyPatterns()` / `isEnabledByOverrides()` 判定。
3. 过滤出 `enabled = true` 的 skill paths。
4. `updateSkillsFromPaths()` 调 `loadSkills()` 加载这些 paths——读 SKILL.md、解析 frontmatter、校验。
5. `formatSkillsForPrompt()` 把 skills 格式化成 XML 塞进 system prompt——每个 skill 一个 `<skill>` 块，含 name、description、filePath。`disableModelInvocation = true` 的不进。
6. LLM 在对话中根据 description 判断要不要读某个 skill 的 SKILL.md。

### 2.5 reload 的触发时机

pi 有 reload 能力，但触发路径有限：

- **交互模式 `/reload` 命令**：`interactive-mode.ts` 的 `handleReloadCommand()` 调 `session.reload()`，内部走 `settingsManager.reload()` + `resourceLoader.reload()` + 重建 runtime。
- **`AgentSession.reload()` 方法**：`agent-session.ts:2544`，公开 API，SDK 可调。
- **print 模式**：`print-mode.ts:95`，处理完一个 prompt 后调 `session.reload()`。
- **RPC 模式**：`rpc-mode.ts:341`，session 对象有 `reload` 方法但**不经 JSONL RPC 暴露**——RPC 命令类型定义里没有 `reload`。

关键结论：**my-harness-desktop 通过 RPC 和 pi 通信，RPC 没有暴露 `reload` 命令**。my-harness-desktop 的 31 个 RPC 命令里没有 reload。这意味着 my-harness-desktop 写完 settings.json 后，无法通过 RPC 让 pi 当前会话重新加载 skills——用户必须在 pi 的终端里手动跑 `/reload`，或者重启会话。

`get_commands` RPC 命令返回当前会话已加载的 skills（以 `skill:{name}` 形式），但这只包含 enabled 的、已加载的——管理界面需要看到全部（含禁用的），所以不能只靠 `get_commands`。

### 2.6 settings.json 的读写

`SettingsManager` 暴露了 skill 相关的 API：

- `getSkillPaths()`：返回全局 `skills[]` 数组的拷贝。
- `setSkillPaths(paths)`：写全局 `skills[]`，`markModified("skills")` + `save()`。
- 项目级变体：`getProjectSkillPaths()` / `setProjectSkillPaths(paths)`。

settings.json 有两级：global（`~/.pi/agent/settings.json`）和 project（`{cwd}/.pi/settings.json`）。project 级覆盖 global 级——`deepMergeSettings()` 合并。my-harness-desktop 的 scanner/toggle 直接用共享 `readJsonFile` / `writeJsonFile`（`application/config/config-file.ts`）读写——自带 `withDirLock` 串行化防并发写、`deepMergeJson` 深合并、目录不存在时 mkdir。

## 3 为什么不能直接用 pi 的 RPC

上面已经说了最关键的一点：RPC 没有 `reload` 命令。但问题不止这一个——即使有 reload，管理界面需要的信息也超出了 RPC 当前能提供的范围。

**`get_commands` 只返回 enabled skills**。RPC 的 `get_commands` 命令（`rpc-mode.ts:656-686`）返回 `{ commands: RpcSlashCommand[] }`，每个 command 有 `name`、`description`、`source`、`sourceInfo`。source 为 `"skill"` 的就是 skills。但这只包含**已加载、已启用**的 skills——`formatSkillsForPrompt()` 过滤掉了 `disableModelInvocation = true` 的，`resourceLoader` 只把 `enabled = true` 的传给 `loadSkills()`。管理界面需要看到全部 skills（含禁用的、含 `disableModelInvocation` 的），`get_commands` 给不了。

**my-harness-desktop 不能 import pi 的 `loadSkillsFromDir`**。pi 是一个独立子进程，不是 my-harness-desktop 的 npm 依赖。`@earendil-works/pi-coding-agent` 不在 my-harness-desktop 的 `node_modules` 里——pi 是通过 `packages/pi-cli/dist/` 随壳分发的可执行文件。my-harness-desktop 的代码不能 `import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent"`。这意味着 skill 的扫描逻辑必须在 my-harness-desktop 自己的 application 层重新实现。

**pi 的 `SettingsManager` 不经 RPC 暴露**。`getSkillPaths()` / `setSkillPaths()` 是进程内 API，不是 RPC 命令。my-harness-desktop 要读写 settings.json，只能自己读文件——用共享 `readJsonFile` / `writeJsonFile` 原语。

结论：my-harness-desktop 不能依赖 pi 的代码或 RPC 来管理 skills。扫描、判定 enabled/disabled、读写 settings.json——全部在 application 层实现。但这不是"重复发明轮子"——这是两个独立进程之间的边界使然。pi 的 `loadSkillsFromDir` 在自己的进程里跑，my-harness-desktop 的 scanner 在 Electron main 进程里跑，两者读的是同一份文件系统、同一份 settings.json，结果应该一致。

## 4 Skill Scanner

`application/skills/skill-scanner.ts` 是这个插件的核心——它复刻 pi 的 skill 发现逻辑，在 my-harness-desktop 的 application 层实现。

### 4.1 扫描逻辑

scanner 的输入是：agentDir（`~/.pi/agent`，由 shell 注入）、cwd（当前项目目录，来自 `ui-store.currentCwd`）。输出是 `SkillInfo[]`。

扫描分三步走：

**第一步：读 settings.json 的 `skills[]`，拿到显式路径来源和模式条目**。`readJsonFile()` 读 `~/.pi/agent/settings.json`，取出 `skills` 字段（`string[]`）。项目级的 `{cwd}/.pi/settings.json` 也读——如果存在且项目被信任的话。`splitPatterns()` 把普通条目和模式条目分两拨。普通条目是显式声明的来源目录，模式条目是 `+`/`-`/`!` 控制开关。

**第二步：扫描所有来源目录**。来源有四类，和 pi 的发现逻辑一一对应：

- settings.json `skills[]` 的普通条目路径——每个路径 resolve 后，如果是目录就递归找 SKILL.md，如果是 `.md` 文件就直接当 skill。
- `~/.pi/agent/skills/`——`collectSkillEntries(dir, "pi")` 同款逻辑。
- `~/.agents/skills/`——`collectSkillEntries(dir, "agents")` 同款逻辑。
- `{cwd}/.pi/skills/` 和 `{cwd}/.agents/skills/`——项目级，同款逻辑。加上 `collectAncestorAgentsSkillDirs(cwd)` 遍历祖先目录的 `.agents/skills/`。

每个来源扫描完得到一个 `DiscoveredSkill` 列表，包含 `filePath`（SKILL.md 绝对路径）、`baseDir`（skill 所在目录）、`sourcePath`（来源路径，如 `~/.claude/skills`）、`scope`（`"user"` 或 `"project"`）、`sourceType`（`"settings"` 或 `"auto"`）。

**第三步：解析 frontmatter + 判定 enabled**。对每个 `DiscoveredSkill`，读 SKILL.md 内容，用 `yaml` 包解析 frontmatter，拿 name / description / disable-model-invocation。name 缺省用目录名。校验和 pi 一致——name 64 字符限制、小写+连字符、description 必填。

enabled 判定复刻 `isEnabledByOverrides()`：默认 true，`!` 排除，`+` 强制启用，`-` 强制禁用。pattern 是 SKILL.md 相对于来源目录的路径——和 pi 的 `getResourcePattern()` 一致。

### 4.2 frontmatter 解析

pi 用 `yaml` 包的 `parse()` 函数解析 frontmatter。my-harness-desktop 的 scanner 也用 `yaml` 包——不复刻一个正则解析器。frontmatter 的格式是 `---\n{yaml}\n---\n{body}`，pi 的 `extractFrontmatter()` 逻辑是：检查是否以 `---` 开头，找下一个 `\n---` 作为结束标记，中间的 YAML 字符串传给 `parse()`。

my-harness-desktop 的 scanner 复刻同样的提取逻辑，用同一个 `yaml` 包。这不违反"手写收敛到成熟包"——`yaml` 就是成熟包，pi 也用它。my-harness-desktop 需要加 `yaml` 作为依赖（如果还没有的话）。

### 4.3 symlink 处理

pi 的 `collectSkillEntries()` 对 symlink 做了 `statSync()` 跟踪——用户的 `~/.claude/skills/deploy-skill` 是一个 symlink 指向 `/Users/user/projects/internal-tools/.claude/skills/deploy-skill`。scanner 同样 follow symlink：`entry.isSymbolicLink()` 时 `statSync(fullPath)` 判断真实是文件还是目录。

scanner 在 `SkillInfo` 里标记 `isSymlink: boolean` 和 `realPath: string`（`realpathSync` 解析后的真实路径）——UI 上展示 symlink 标记，让用户知道这个 skill 是个链接，不是本地文件。这和 pi 的行为一致——pi 也跟踪 symlink，且用 `canonicalizePath()` 去重（同一个真实文件不重复加载）。

### 4.4 .gitignore 尊重

pi 用 `ignore` 包处理 `.gitignore` / `.ignore` / `.fdignore`，把 ignore 规则过滤后的文件当作技能——本质是把"哪些文件进 git"的版本控制语义误当"哪些技能生效"的语义。实际案例：`~/.claude/skills/.gitignore` 用 `/*/` + 白名单做 git 跟踪控制，复用后 9 个本地技能会在管理页凭空消失。

**scanner 刻意不读 ignore 文件（方案 B）**：管理界面要展示的是"目录里真实存在的全部技能"，与 pi 的加载策略解耦。硬排除只留 `.` 开头目录和 `node_modules`（避免失控递归）。注意这带来一个已知差异：pi 实际加载的 skill 集可能比管理页展示的少（pi 被 ignore 规则过滤的，管理页仍展示）——属可接受的显示超集，与 §12.4"scanner 结果是 get_commands 超集"的预期一致。

### 4.5 去重

pi 用 `canonicalizePath()` 做去重——同一个真实文件（通过 symlink 指向同一处）只加载一次，先注册的胜。scanner 同样用 `realpathSync()` 去重——`Map<string, SkillInfo>` 以真实路径为 key，后扫描到的重复直接跳过。

但 scanner 和 pi 的去重有一个差异：pi 的去重在 `loadSkills()` 里做，先注册的胜；scanner 的去重在扫描阶段做，按来源优先级排序——settings.json 显式路径 > auto 发现、user scope > project scope。这保证扫描结果和 pi 的加载结果一致。

### 4.6 SkillInfo 类型

```typescript
interface SkillInfo {
  name: string;
  description: string;
  filePath: string;          // SKILL.md 绝对路径
  baseDir: string;           // skill 所在目录
  sourcePath: string;        // 来源路径（如 ~/.claude/skills 或 /Users/.../.pi/skills）
  sourceType: "settings" | "auto";  // 显式声明 vs 自动发现
  scope: "user" | "project";       // user 级 vs project 级
  enabled: boolean;                 // 当前是否启用
  disableModelInvocation: boolean;  // frontmatter 标记
  isSymlink: boolean;
  realPath: string;                 // symlink 解析后的真实路径
}
```

这个类型定义在 `domain/skills.ts`（圆心单源，零外部依赖）——它是跨层引用的稳定契约：scanner（application）产 `SkillInfo[]`，IPC 传给 renderer，renderer 消费。`packages/core` re-export 给 `packages/react`，插件从 `@my-harness-desktop/react` import 拿到类型。依赖方向：application import domain，反向不可。

## 5 启用/禁用：+/- 模式条目的读写

toggle 一个 skill 的 enabled 状态，底层是往 `settings.json` 的 `skills[]` 数组写 `+`/`-` 模式条目。这个逻辑复刻 pi 的 `ConfigSelectorComponent.toggleTopLevelResource()`。

### 5.1 toggle 的算法

toggle 接收三个参数：`skill: SkillInfo`、`enabled: boolean`、`scope: "user" | "project"`。

**第一步：算 pattern**。pattern 是 SKILL.md 相对于来源目录的路径。如果来源是 `~/.claude/skills`，skill 的 filePath 是 `/Users/user/.claude/skills/my-methodology/SKILL.md`，那么 pattern 是 `my-methodology/SKILL.md`。用 `path.relative(sourcePath, filePath)` 计算，转成 POSIX 路径（`/` 分隔符）。这和 pi 的 `getResourcePattern()` 一致。

**第二步：读当前 `skills[]`**。经共享 `readJsonFile()` 拿到当前 settings，取出 `skills` 数组。project 级走 `{cwd}/.pi/settings.json`（如果存在且项目被信任）。

**第三步：过滤旧模式**。遍历 `skills[]`，把所有以 `!`/`+`/`-` 开头且去掉前缀后等于 pattern 的条目过滤掉。这保证同一个 skill 只有一个模式条目——不会出现先 `+` 后 `-` 叠了两层。

**第四步：推入新模式**。`enabled = true` 推 `+{pattern}`，`enabled = false` 推 `-{pattern}`。

**第五步：写回**。把更新后的 `skills[]` 数组经共享 `writeJsonFile(settingsPath, { skills: filtered }, "deep")` 深合并写回。`writeJsonFile` 自带 `withDirLock` 串行化 + `deepMergeJson` 深合并（已有原语，不手写 read+lock+write）。写完后 shell 侧 IPC handler 广播 `settings:changed` 事件，settings-page 订阅后自动 +1 refreshSignal 重读 active configFile——pi-manager 等共享 settings.json 的插件 UI 自动刷新，不失同步。

### 5.2 添加路径来源

用户在 UI 底部的输入框输入一个绝对路径（如 `/Users/user/.claude/skills` 或 `/some/path/SKILL.md`），选择 user 或 project 级别，点"添加"。

底层很简单：读当前 `skills[]`，把新路径追加到数组末尾（普通条目，不带前缀），写回。如果路径已经在数组里（普通条目或模式条目去掉前缀后匹配），不重复添加——提示"已存在"。路径在写入前做 resolve（展开 `~`、解析相对路径），存的是展开后的绝对路径。

### 5.3 移除路径来源

用户点路径旁边的 × 按钮。底层：读当前 `skills[]`，过滤掉这个路径的普通条目**和**这个路径下所有 skill 的模式条目。后者需要扫描这个路径下有哪些 SKILL.md，算出它们的 pattern，然后把 `skills[]` 里所有匹配这些 pattern 的 `!`/`+`/`-` 条目都删掉——否则移除路径后，指向已不存在 skill 的模式条目会残留在 `skills[]` 里，虽然 pi 会忽略它们（文件不存在），但不干净。

### 5.4 写入安全性

所有写入都经共享 `writeJsonFile()`——自带 `withDirLock` 串行化防并发写撕裂，`deepMergeJson` 深合并不覆盖其他字段。插件不自己拼文件操作，复用已有原语（呼应"手写收敛到成熟包"——`writeJsonFile` 已经收敛了锁+合并逻辑）。toggle/addPath/removePath 三个写操作完成后，shell 侧 IPC handler 广播 `settings:changed` 事件，settings-page 订阅后自动刷新——pi-manager 等共享 settings.json 的插件 UI 同步更新。

project 级写入直接走 `writeJsonFile({cwd}/.pi/settings.json)`——`writeJsonFile` 自带 mkdir（目录不存在时 `mkdirSync({ recursive: true })`），不需要额外处理。

## 6 IPC 通道设计

新增四个 IPC 通道，全部在 `shell/electron-main/index.ts` 注册。

### 6.0 通道总览

已实现 7 个通道（比初版设计多两个）：`skills:list`、`skills:toggle`、`skills:addPath`、`skills:removePath`、`skills:watch` / `skills:unwatch`，外加：

- **`skills:toggleForce`**：renderer 发 `{ filePath, force }`，main 调 `toggleForceInvocation` 直接改写 SKILL.md 的 `disable-model-invocation` frontmatter，写后广播 `skills:changed`。对应 UI 上每行的第二个 toggle（"强制进入上下文"）。
- **`skills:getSourcePaths`**：renderer 发 `{ cwd }`，返回 `{ user: string[], project: string[] }`——settings.json `skills[]` 里的普通条目（裸路径），供"添加路径来源"区域展示已配置路径列表。

写操作（toggle/addPath/removePath）完成后统一调 `broadcastSettingsChanged()`，settings-page 订阅 `system:settingsChanged` 后自动刷新——pi-manager 等共享 settings.json 的插件 UI 不失同步（早期版本只有 skills:* 广播，后来收敛为统一广播，见 §10.1）。

### 6.1 `skills:list`

renderer 发 `{ cwd: string }`，main 调 scanner 扫描全部来源，返回 `SkillInfo[]`。cwd 来自 `ui-store.currentCwd`——renderer 调时传当前项目目录。

main 侧：

```typescript
ipcMain.handle("skills:list", (_e, cwd: string) => {
  const skills = scanSkills({ agentDir: PI_AGENT_DIR, cwd });
  return skills;
});
```

`scanSkills` 是 scanner 的入口函数，同步执行（全量扫描通常 < 100ms，不需要异步）。如果扫描慢（skill 目录特别多），改成异步——但同步够了，pi 的 `loadSkillsFromDir` 也是同步的。

### 6.2 `skills:toggle`

renderer 发 `{ filePath: string, enabled: boolean, scope: "user" | "project", sourcePath: string, cwd: string }`。main 调 toggleSkill，写回 settings.json。

main 侧先读 settings.json，算 pattern，过滤旧模式，推入新模式，写回。写回走 `writeJsonFile(settingsPath, { skills: filtered }, "deep")`（global 和 project 级都走同一原语）。写完后广播 `settings:changed` 事件。

### 6.3 `skills:addPath` / `skills:removePath`

addPath：renderer 发 `{ path: string, scope: "user" | "project" }`。main 读 `skills[]`，检查路径是否已存在，追加，写回。

removePath：renderer 发 `{ path: string, scope: "user" | "project", cwd: string }`。main 读 `skills[]`，过滤掉这个路径的普通条目和相关模式条目，写回。removePath 需要先扫描这个路径下有哪些 skills 才能算出要删哪些模式条目——调 scanner 的 `scanSkillsFromPath(path)` 方法。

### 6.4 `skills:watch` / `skills:changed`

文件监听通道。renderer 发 `{ cwd: string }` 开始监听，main 返回一个 unsubscribe 函数的句柄。当监听的目录有文件变化时，main 推 `skills:changed` 事件给 renderer，renderer 重新调 `skills:list` 刷新。

具体实现见下面 §8。

### 6.5 preload 暴露

在 `packages/react/src/index.ts` 的 `PiApi` 接口里加：

```typescript
skills: {
  list: (cwd: string) => Promise<SkillInfo[]>;
  toggle: (opts: { filePath: string; enabled: boolean; scope: "user" | "project"; sourcePath: string; cwd: string }) => Promise<void>;
  toggleForce: (opts: { filePath: string; force: boolean }) => Promise<void>;
  addPath: (opts: { path: string; scope: "user" | "project" }) => Promise<void>;
  removePath: (opts: { path: string; scope: "user" | "project"; cwd: string }) => Promise<void>;
  getSourcePaths: (cwd: string) => Promise<{ user: string[]; project: string[] }>;
  watch: (cwd: string, onChanged: () => void) => () => void;
};
```

preload 的 `contextBridge.exposeInMainWorld` 里加对应的 IPC 调用。`watch` 用 `ipcRenderer.on("skills:changed", onChanged)` + 返回 cleanup 函数（cleanup 里 `removeListener` + 调 `skills:unwatch`）。

### 6.6 权限

`skills` 是核心默认能力——不需要声明权限。理由：skills 管理操作的是 pi 底座的配置文件（`~/.pi/agent/settings.json`），不是用户项目文件系统。和 `piSettings` 一样是核心默认——`pi-manager` 插件调 `piSettings.get/set` 也不需要权限声明。`fs` 和 `git` 需要权限是因为它们读的是用户项目里的文件，有安全边界；skills 管理没有这个边界。

## 7 项目上下文动态化

pi 的 project 级 skills 随 `cwd` 变化——不同项目的 `.pi/skills/` 和 `.agents/skills/` 不一样。my-harness-desktop 的 `ui-store` 已经有 `currentCwd`，用户切换项目时更新。

### 7.1 扫描时传入 cwd

`skills:list` IPC 接收 `cwd` 参数，scanner 用它扫描项目级目录。renderer 调时从 `useUiStore(s => s.currentCwd)` 取当前 cwd 传入。

### 7.2 项目切换时重新扫描

renderer 监听 `currentCwd` 变化——`useEffect(() => { refresh(); }, [currentCwd])`。`refresh()` 调 `skills:list` 重新扫描，更新本地 state。

文件监听也要重建——旧的 watcher 监听的是旧项目的目录，新项目要监听新目录。§8 详述。

### 7.3 绝对路径

所有路径在 UI 上显示为绝对路径。settings.json 里的 `skills[]` 条目可以是 `~` 开头的（pi 支持 `~` 展开），但 scanner 扫描后输出的 `sourcePath` 和 `filePath` 都是 resolve 后的绝对路径。UI 显示绝对路径——不用 `./` 相对路径，因为相对路径在项目切换后语义会变，绝对路径不会。

项目级目录在 settings.json 里不存——它们是自动发现的，pi 根据 `cwd` 扫描。所以"项目路径来源"在 UI 上是只读的——展示 `{cwd}/.pi/skills` 和 `{cwd}/.agents/skills`，但不能添加/移除（它们的存在与否取决于文件系统，不取决于 settings.json）。

### 7.4 项目 banner

UI 顶部展示当前项目路径的 banner，让用户知道"你现在看到的项目级 skills 属于哪个项目"。banner 内容：

- 项目路径：`/Users/user/self/git-project/my-harness-desktop`
- 统计：启用 20 · 禁用 7 · 共 27
- 监听状态：绿点脉冲 + "文件监听中"

项目路径从 `ui-store.currentCwd` 取。如果 `currentCwd` 为空（用户还没选项目），banner 显示"未选择项目"，项目级 skills 区域为空。

## 8 文件监听与热加载

"热加载"在这个插件里的含义需要精确界定。由于 pi 没有 reload RPC，my-harness-desktop 无法让 pi 运行中的会话实时加载新 skills。但 my-harness-desktop 的 UI 可以实时反映文件系统的变化——用户在另一个编辑器里改了 SKILL.md、删了一个 skill 目录、加了一个新 skill，UI 立即更新。这是"UI 热加载"，不是"pi 热加载"。

### 8.1 监听对象

监听的目录列表是动态的，取决于当前配置：

- `settings.json` 的 `skills[]` 普通条目指向的目录
- `~/.pi/agent/skills/`
- `~/.agents/skills/`
- `{cwd}/.pi/skills/` 和 `{cwd}/.agents/skills/`
- `collectAncestorAgentsSkillDirs(cwd)` 返回的目录列表

当用户添加/移除路径来源时，监听列表要更新。当用户切换项目时，监听列表要重建——旧项目的目录取消监听，新项目的目录开始监听。

### 8.2 fs.watch 实现

Node 的 `fs.watch()` 有平台差异和递归限制——macOS 支持 `recursive: true`，Linux 不支持。my-harness-desktop 是 Electron 应用，主进程跑在 Node 上，但用户可能在 macOS 或 Linux 或 Windows 上。

用 `chokidar` 包做文件监听——成熟包，处理了平台差异、递归监听、ignore 规则、初始扫描。不手写 `fs.watch` 包装——那会在平台差异和边界情况上踩坑（呼应"手写收敛到成熟包"）。

实现用 chokidar 的 `ignored` 正则 `/(^|[/\\])\./` 跳过隐藏文件/目录，不配 `ignore` 包——与 scanner 不尊重 `.gitignore` 的决策保持一致（见 §4.4）。另开 `awaitWriteFinish`（300ms 稳定阈值）避免写入中途触发。监听 `add`/`unlink`/`change`/`addDir`/`unlinkDir` 全部五类事件。同时监听全局和项目级 `settings.json`（见 §8.5）；项目级文件不存在时强制保留监听（chokidar 监听父目录兜底），否则首次创建 project settings 的那一刻收不到事件。

### 8.3 去抖策略

文件系统事件会爆发——一次 `git pull` 可能触发几十个 `add`/`unlink` 事件。不去抖的话每个事件都触发一次全量重扫，UI 闪烁。

去抖方案：chokidar 的 `awaitWriteFinish` 选项 + 手动 debounce。chokidar 事件 → debounce 300ms → 全量重扫 → 推 `skills:changed` 给 renderer。300ms 的窗口内如果有新事件，重置计时器——只在文件系统安静下来后才重扫。

全量重扫而非增量——skill 的发现逻辑是递归的，一个目录的增删可能影响整个树的结构（比如一个目录从"含 SKILL.md"变成"不含 SKILL.md"）。增量更新太复杂且容易和 pi 的发现逻辑不一致。全量重扫 100ms 以内完成，用户无感知。

### 8.4 生命周期

监听的生命周期跟随插件 UI 组件：

- **mount 时**：renderer 调 `skills:watch(cwd, onChanged)`，main 创建 chokidar watcher，注册 `skills:changed` 事件。
- **unmount 时**：cleanup 函数调 `skills:watch` 返回的 unsubscribe，main 关闭 chokidar watcher，移除事件监听。
- **cwd 变化时**：先 unsubscribe 旧的（关闭旧 watcher），再 subscribe 新的（创建新 watcher）。

main 侧维护一个 `Map<string, chokidar.FSWatcher>`（key 是 cwd），防止同一 cwd 创建多个 watcher。renderer 侧每个组件实例只持有一个 watcher 句柄。

### 8.5 settings.json 变化监听

除了 skill 目录，settings.json 本身的变化也要监听——如果用户在另一个程序里改了 settings.json 的 `skills[]` 数组（比如跑了 `pi config`），UI 要刷新。

chokidar 同时监听全局 `~/.pi/agent/settings.json` 和项目级 `{cwd}/.pi/settings.json` 两个文件，触发同样的去抖重扫流程。settings.json 的变化只影响"路径来源列表"和"模式条目"，不直接影响 skill 文件——但去抖重扫会重新读 settings.json 重新算 enabled 状态，结果一致。项目级文件可能尚不存在（首次添加 project 级路径时才创建），chokidar 会监听其父目录兜底。

### 8.6 "下次会话生效"的 UI 提示

toggle 一个 skill 后，UI 上短暂显示"变更将在下次会话生效"的提示。这不是阻塞性的——用户可以继续操作其他 skills。提示的目的：让用户知道"你在这里改了开关，但 pi 当前会话不会立即看到变化"。

如果 pi 在未来版本暴露了 reload RPC 命令，这里可以加一个"立即生效"按钮——调 reload RPC 让 pi 重载。但当前不支持，所以只提示不操作。

## 9 插件结构

### 9.1 manifest

```json
{
  "id": "skill-manager",
  "version": "0.4.9",
  "displayName": "Skills",
  "description": "技能管理",
  "renderer": "./renderer/index.tsx",
  "contributes": {
    "settings": [
      {
        "id": "skills",
        "title": "Skills",
        "icon": "wrench",
        "component": "SkillManagerPage",
        "saveMode": "manual",
        "order": 3
      }
    ]
  }
}
```

`saveMode: "manual"`——不需要框架的 configFile 机制（这个插件不编辑一个配置文件，而是通过 IPC 调 scanner + toggle）。`order: 3`——实际值（初稿写 2，最终排到了第 4 位）。`configFile` 不声明——无配置文件，不显示"打开配置"按钮。

### 9.2 目录结构

```
src/plugins/skill-manager/
  plugin.json
  renderer/
    index.tsx        # 全部 UI 一个文件：SkillManagerPage 主组件 + SkillRow/Toggle/
                     # FilterButton/PathList 内部子组件（未拆文件，体量可控）
```

application 层新增：

```
src/application/skills/
  skill-scanner.ts   # 扫描器：发现 + frontmatter 解析 + enabled 判定
  skill-toggle.ts    # toggle 逻辑：+/- 模式条目的读写（走 writeJsonFile）
  skill-paths.ts     # 共享路径 helper（toPosixPath/resolvePath/isOverridePattern/stripOverridePrefix）
```

shell 层在 `index.ts` 注册 6 个 IPC handler（list/toggle/addPath/removePath/getSourcePaths/watch/unwatch）。

### 9.3 renderer 组件

主组件 `SkillManagerPage` 是一个 `SettingsComponentProps` 消费者——但它不用 `config` 和 `onChange`（`saveMode: "manual"`，无 configFile）。它只用 `refreshSignal`——框架刷新按钮触发时重新调 `skills:list`。

组件内部 state：

- `skills: SkillInfo[]`——scanner 返回的完整列表
- `filter: "all" | "enabled" | "disabled"`——筛选
- `search: string`——搜索文本
- `page: number`——当前页码
- `pageSize: 20`——每页条数

`useEffect` 依赖 `[refreshSignal, currentCwd]`——刷新或项目切换时重新拉列表。chokidar watcher 的 `onChanged` 回调也调同一个拉取函数。

筛选和搜索在 renderer 侧做——`skills` 拿到全量后，`filter`/`search` 改变不需要重新调 IPC，只重新切本地数组。分页同理。

列表渲染：表头（toggle | Name | 来源 | Description）+ 行。每行：toggle 开关、skill name（symlink 标记）、source path（绝对路径，截断显示）、description（截断）。点击行展开完整 description。

底部：添加路径来源区域——输入框 + scope 选择（user/project）+ 添加按钮。下方显示已配置的 user 路径和 project 路径列表，每条带移除按钮。

### 9.4 i18n

这个插件的 UI 文案走 i18n（`t("settings.skills")` 等），key 放在 i18n 插件的 `settings` 命名空间 locale 文件里（`zh-CN/settings.json`、`en/settings.json`、`zh-TW/settings.json`、`de/settings.json`）。key 用 `settings.skillXxx` 前缀——和 `settings.models`、`settings.font` 等其他设置页 key 同级。renderer 调 `t("settings.skillAll")` 等，经 `nsSeparator: "."` 解析到 `settings` namespace + `skillAll` key。

### 9.5 SkillInfo 契约归属

`SkillInfo` 类型定义在 `domain/skills.ts`（圆心单源，零外部依赖）。`packages/core` re-export 给 `packages/react`，插件 renderer 从 `@my-harness-desktop/react` import 拿到类型。scanner 实现在 `application/skills/skill-scanner.ts`，import `domain/skills` 拿类型——依赖只向内。

`yaml` 包和 `chokidar` 包是 application 层和 shell 层的依赖，不进 domain（domain 零依赖）。`yaml` 在 `application/skills/skill-scanner.ts` 里 import，`chokidar` 在 `shell/electron-main/index.ts` 里 import。

共享路径 helper（`toPosixPath`/`resolvePath`/`isOverridePattern`/`stripOverridePrefix`）收敛在 `application/skills/skill-paths.ts` 单一源——skill-scanner 和 skill-toggle 都 import 共享源，不各自复制（消除 resolvePath 在两份间漂移的风险）。

## 10 和其他插件的关系

### 10.1 和 pi-manager 的关系

pi-manager 管的是 `~/.pi/agent/settings.json` 的全部 43 个字段——包括 `skills` 字段（在"路径与扩展"分组里，显示为一个 `string[]` 编辑框）。skill-manager 管的也是 `skills` 字段，但只管 `skills` 这一个字段，管的方式更专业——不只是编辑字符串数组，而是扫描出每个 skill、展示它们的状态、提供 toggle。

两者操作同一份数据（`settings.json` 的 `skills` 字段），但视角不同：pi-manager 是"原始 JSON 编辑器"视角，skill-manager 是"skill 管理器"视角。用户可以在 pi-manager 里直接编辑 `skills` 数组的原始内容，也可以在 skill-manager 里用 GUI 管理——两者写到的是同一个字段。

**一致性保障**：两者写同一个文件（`~/.pi/agent/settings.json`），skill-manager 写完后广播 `settings:changed` 事件，pi-manager 的 settings-page 订阅后自动刷新——不会失同步。pi-manager 写走框架的 `config-file:set`（不广播 `settings:changed`），skill-manager 写走 `writeJsonFile` + 广播——只有 skill-manager 外部写时才推送通知，不构成循环。

### 10.2 和 sessions-list / timeline 的关系

sessions-list 和 timeline 消费 `useSessionStore` 的 `commands` 字段——`get_commands` RPC 返回的 `skill:{name}` 条目。这些是**已启用的、已加载的** skills。skill-manager 改了某个 skill 的 enabled 状态后，当前会话的 `commands` 不会变（pi 没 reload），但下次会话启动时 `commands` 会反映新状态。

skill-manager 不直接写 `useSessionStore`——它写的是 `settings.json`，pi 读 settings.json 加载 skills，my-harness-desktop 通过 `get_commands` RPC 拿到加载后的结果。数据流是：skill-manager → settings.json → pi（下次会话）→ get_commands RPC → session-store.commands → sessions-list/timeline。中间隔着 pi 的文件读取和会话重启，不是实时的。

### 10.3 和 i18n 的关系

skill-manager 的 UI 文案走 i18n（`t("skill-manager.*")`）。如果 i18n 插件没有 skill-manager 的 key，`t()` 走 fallback 链返回 key 本身——功能不中断，只是文案不对。后续在 i18n 插件的 locale 文件里补 skill-manager 的 key。

### 10.4 和 theme-manager 的关系

无关系。skill-manager 不碰主题，theme-manager 不碰 skills。

## 11 UI 交互细节

### 11.1 列表行为

列表是扁平的——所有来源的 skills 混在一个列表里，按 name 字母序排列。"来源"列显示绝对路径（截断，hover 显示完整路径），不用 badge 标记——路径本身就携带了来源信息（`~/.claude/skills` 是 settings 声明、`~/.pi/agent/skills` 是 auto 发现、`/Users/.../my-harness-desktop/.pi/skills` 是 project 级）。

筛选：三个 tab（全部 N / 启用 N / 禁用 N），数字实时更新。搜索：匹配 name 和 description，不区分大小写。分页：每页 20 条，底部分页器（‹ 1 2 3 ›）。筛选 + 搜索 + 分页都在 renderer 侧做，不重新调 IPC。

### 11.2 toggle 行为

点 toggle 开关：立即更新本地 state（乐观更新），同时调 `skills:toggle` IPC。IPC 成功后不做额外操作（本地 state 已经是对的）。IPC 失败时回滚本地 state，显示错误提示。

toggle 后短暂显示"变更将在下次会话生效"的 toast（3 秒后消失）。连续 toggle 多个 skill 只显示一个 toast——不打扰用户。

### 11.3 添加路径

输入框接受绝对路径（`/Users/user/.claude/skills`）或 `~` 开头路径（`~/.claude/skills`）。scope 选择器（user / project）默认选 user。点"添加"后：

1. 路径 resolve（`~` 展开、相对路径解析），存为绝对路径。
2. 检查路径是否存在——不存在显示"路径不存在"错误，不添加。
3. 检查路径是否已在 `skills[]` 里——已存在显示"已存在"，不重复添加。
4. 调 `skills:addPath` IPC，成功后清空输入框，列表刷新。

### 11.4 移除路径

移除路径来源不是删 skill 文件——是从 `skills[]` 里删掉这个路径条目和相关模式条目（相关模式条目通过扫描该源下的 skills 反算得到，见 §5.3）。移除后，这个路径下的 skills 不再被 pi 发现——下次会话启动时它们会从 `get_commands` 里消失。

**已知缺口（演进）**：移除非空路径前本应有确认对话框（`移除路径 {path}？此路径下的 {N} 个 skills 将不再被 pi 发现`），当前实现直接调 `skills:removePath` IPC，无二次确认。误点 × 即移除，需要加回必须重新输入路径。

### 11.5 symlink 显示

symlink skill 的 name 旁边显示一个小标记（`symlink` 文字或图标），hover 显示真实路径。这让用户知道"这个 skill 是个链接，改它等于改链接目标"。

### 11.6 空状态

没有 skills 时显示空状态：

- `~/.pi/agent/skills/` 目录为空：`此目录下暂无 SKILL.md`
- 搜索无结果：`没有匹配 "{query}" 的 skill`
- 筛选"禁用"但全部启用：`没有禁用的 skill`

## 12 scanner 和 pi 的一致性

scanner 的扫描结果必须和 pi 的 `loadSkills()` 一致——否则 UI 展示的和 pi 实际加载的不一样，用户会困惑。一致性靠"同一套发现规则 + 同一份 settings.json"保障，但有几个需要注意的边界。

### 12.1 发现规则一致

scanner 的 `collectSkillEntries()` 大体复刻 pi 的同款函数：先找 SKILL.md 不递归、再递归子目录、跳过 `.` 开头和 `node_modules`、follow symlink。mode 区分（`"pi"` 认根目录散文件、`"agents"` 不认）一致。两处**刻意**不复刻：(1) 不读 `.gitignore` 族文件（方案 B，根因见 §4.4）；(2) "pi" 模式的根目录裸 `.md` 排除 README*——README 常带 frontmatter description，不排则每个源目录冒出一个名为 "skills" 的幽灵条目。这两处差异属有意设计：管理页展示"真实存在的技能"，允许比 pi 实际加载的多（超集关系，§12.4）。

### 12.2 enabled 判定一致

scanner 的 `isEnabledByOverrides()` 复刻 pi 的同款函数：默认 true、`!` 排除、`+` 强制启用、`-` 强制禁用。pattern 计算方式一致——SKILL.md 相对于来源目录的 POSIX 路径。

### 12.3 不一致的来源

有一种情况 scanner 和 pi 可能不一致：**pi 在加载 skills 时有 `skillsOverride` 钩子**（`resource-loader.ts:140`），允许 extensions 修改 skill 列表。如果某个 extension 用 `skillsOverride` 过滤掉了某些 skills，pi 实际加载的和 scanner 扫描的不一致。但这属于 extension 的行为，不是 pi 的标准行为——scanner 不需要复刻 extension 的 override 逻辑。这种不一致是可接受的——标准用户的 skills 不经过 extension override。

另一个不一致来源：**pi 的 `includeDefaults` 参数**。`loadSkills()` 的 `includeDefaults = true` 时加载默认目录，`false` 时不加载。my-harness-desktop 的 scanner 总是扫描默认目录——因为管理界面需要展示全部 skills。这不一致也是可接受的——scanner 展示的是"有哪些 skills 可用"，pi 加载的是"哪些 skills 被传给了当前会话"。

### 12.4 一致性验证

scanner 写完后，做一个验证：用 scanner 扫描 `~/.claude/skills`，同时调 `get_commands` RPC 拿 pi 当前加载的 skills 列表。scanner 的结果应该是 `get_commands` 结果的超集——scanner 有全部（含禁用），`get_commands` 只有 enabled。如果不是超集关系，说明 scanner 的发现逻辑有 bug。

## 13 架构归属检查

按项目的洋葱六层纪律检查每个新增文件的归属。

**`application/skills/skill-scanner.ts`**——application 层。scanner 做的是用例编排（扫描 + 解析 + 判定），不碰 UI 不碰进程。它 import `node:fs`（标准库）、`yaml`（成熟包）、`ignore`（成熟包）。不 import electron、react、gateway。路径参数由 shell 注入（agentDir + cwd）。符合"application 不依赖 shell"。

**`application/skills/skill-toggle.ts`**——application 层。toggle 逻辑是纯计算（算 pattern + 过滤 + 推入），写经共享 `writeJsonFile`（已有 application 层原语，自带 `withDirLock` + `deepMergeJson`）。不碰 UI 不碰进程。

**`application/skills/skill-paths.ts`**——application 层。共享路径 helper（`toPosixPath`/`resolvePath`/`isOverridePattern`/`stripOverridePrefix`），skill-scanner 和 skill-toggle 都 import 共享源，不各自复制。

**`shell/electron-main/index.ts` 新增 IPC handler**——shell 层。IPC 注册是 Electron 主进程的事，是会变的框架细节。handler 调 application 层的 scanner 和 toggle，不自己实现逻辑。

**`shell/electron-main/preload.ts` 新增 `skills` 暴露**——shell 层。contextBridge 暴露是 Electron preload 的事。

**`packages/react/src/index.ts` 新增 `PiApi.skills` 类型**——发布面。re-export 类型 + 声明接口形状，不实现逻辑。

**`packages/react/src/plugin-context.ts`**——`skills` 挂进 PluginContext（`ctx.skills`），插件经 `usePluginContext()` 统一获取，符合"插件不直访 `window.pi`"的纪律。skills 操作无权限校验，ctx 原样透传 `window.pi.skills`，不做 pluginId 相关分流。

**`src/plugins/skill-manager/`**——内容层。纯 renderer 代码，只 import `@my-harness-desktop/react` 和 `react-i18next`。不 import `src/domain`、`src/gateway`、`src/application`、`src/shell`。

依赖方向：`plugins/skill-manager` → `packages/react` → `packages/core` → `domain`。`application/skills` → `domain/skills`（SkillInfo 类型）+ `application/config`（writeJsonFile/readJsonFile 原语）。`shell` → `application`。全部向内，无反向依赖。

## 14 和框架的分工

框架管什么：组件注册（`registerSettingsComponent`）、设置页壳（`SettingsSection`）、`refreshSignal` prop。skill-manager 走 `saveMode: "manual"`，不使用框架的 configFile 生命周期——它有自己的 IPC 通道管数据读写。

插件管什么：渲染列表 UI、调 `usePiApi().skills.*` IPC、管理本地筛选/搜索/分页 state、chokidar watcher 的 subscribe/unsubscribe。

和 pi-manager 的分工差异：pi-manager 用框架的 configFile 机制（`configFile: "~/.pi/agent/settings.json"` + `configMerge: "deep"`），框架管读/写/dirty/save/reset。skill-manager 不用 configFile 机制——它不编辑一个配置文件的字段，而是通过 scanner 扫描 + IPC toggle 管理一个列表。所以 `saveMode: "manual"` + 无 `configFile` 声明，框架不介入数据读写。

## 15 如果没有这个插件

删掉 `src/plugins/skill-manager/` 目录后，内核一行不动。设置页少一个"Skills" tab。用户管理 skills 得手动编辑 `~/.pi/agent/settings.json` 的 `skills[]` 数组——往里面加路径、手动写 `-{pattern}` 禁用某个 skill。或者切到终端跑 `pi config` 用 TUI 管理。两种方式都可用但都不方便——JSON 编辑容易打错 pattern、TUI 要切到终端不符合桌面应用的使用习惯。

第三方可以完全替代这个插件——贡献一个 `settings` 槽位的 `component`，调 `usePiApi().skills.*` IPC，渲染自己的 UI。skill-manager 作为 builtin 优先级最低，第三方版本会覆盖它。

## 16 QA

**Q：用户在 skill-manager 里 toggle 了一个 skill，当前正在跑的 pi 会话会立即生效吗？**

不会。pi 没有 reload RPC 命令，settings.json 的变更在 pi 下次启动新会话时生效。UI 上 toggle 后会显示"变更将在下次会话生效"提示。如果用户想让当前会话立即生效，需要去 pi 的终端里跑 `/reload`——这是 pi 交互模式的内部命令，不经 RPC 暴露。未来 pi 如果暴露了 reload RPC，这里可以加"立即生效"按钮。

**Q：scanner 扫描出来的 skill 列表和 pi 实际加载的不一致怎么办？**

标准情况下一致——scanner 复刻了 pi 的发现逻辑、读同一份 settings.json。不一致的可能来源有两个：一是 pi 的 extension 用了 `skillsOverride` 钩子过滤 skills（非标准行为，scanner 不复刻）；二是 pi 的 `includeDefaults` 参数为 false（特定 CLI 调用场景，scanner 总是扫默认目录）。这两种情况是可接受的边界——scanner 展示"文件系统里有哪些 skill 可用"，pi 加载"当前会话配置决定加载哪些"。

**Q：用户在 pi-manager 里改了 skills 数组的原始内容，skill-manager 的 UI 会更新吗？**

会，但有 300ms 延迟。chokidar 监听全局和项目级 `settings.json` 文件变化，去抖 300ms 后全量重扫，UI 刷新。用户在 pi-manager 里改完保存后，skill-manager 的 UI 在 300ms 内更新到一致状态。

**Q：用户切换项目后，项目级 skills 多久能刷新？**

立 即。renderer 的 `useEffect` 依赖 `currentCwd`，项目切换时 `currentCwd` 变化触发 `useEffect` 重跑，调 `skills:list` 重新扫描。chokidar watcher 也重建——旧的取消，新的创建。整个过程 < 100ms，用户无感知。

**Q：skill 目录里有几千个 SKILL.md，扫描会不会卡？**

不会。pi 的 `collectSkillEntries` 是递归 `readdirSync`，不读文件内容——只在找到 SKILL.md 后才读 frontmatter。几千个目录的递归扫描在 50ms 以内完成。frontmatter 解析只对找到的 SKILL.md 做（通常几十个，不是几千个）。全量重扫（文件监听触发）也在 100ms 以内。

**Q：用户添加了一个不存在的路径，怎么办？**

IPC 返回错误"路径不存在"，renderer 显示错误提示，不添加到 `skills[]`。scanner 在扫描时也跳过不存在的路径——`existsSync` 检查。pi 的 `loadSkills()` 对不存在的路径记一个 warning diagnostic，不崩。两边一致。

**Q：两个路径来源下有同名的 skill（同名 SKILL.md），怎么办？**

和 pi 一致：先发现的胜，后发现的记 collision diagnostic 但不加载。scanner 的去重用 `realpathSync`——如果两个路径下的 SKILL.md 是同一个真实文件（通过 symlink 指向同一处），只保留一个。如果是两个不同的同名 skill 文件，两个都出现在列表里，但 name 相同——UI 上展示 name + sourcePath 区分。pi 加载时同名 collision，先注册的胜——scanner 不决定谁胜，只展示"有 collision"这个事实。

**Q：project 级 settings.json（`{cwd}/.pi/settings.json`）不存在怎么办？**

正常情况。`readJsonFile` 读不存在文件返回空对象，`skills` 字段为 `undefined`，scanner 当作空数组处理。用户在 UI 上添加 project 级路径时，`writeJsonFile` 会 mkdir + 创建文件。

**Q：用户在 pi 里跑了 `pi config` 改了 skills，skill-manager 的 watcher 能感知吗？**

能。`pi config` 写的是 `~/.pi/agent/settings.json`（或 project 级的 `{cwd}/.pi/settings.json`），chokidar 监听这两个文件。`pi config` 保存后，文件变化触发 watcher，300ms 去抖后重扫，UI 更新。

**Q：skill-manager 自己不改 SKILL.md 文件吧？**

不改。skill-manager 管的是"settings.json 的 skills[] 数组"和"哪些 skill 启用/禁用"——它不碰 SKILL.md 的内容。如果用户想编辑 SKILL.md 内容，用任何编辑器改，skill-manager 的 watcher 会感知文件变化并刷新 frontmatter 解析结果（name/description 可能变）。但这是"感知变化"不是"编辑内容"——skill-manager 不是编辑器。
