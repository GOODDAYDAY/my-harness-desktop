# 插件约定式 skills 发现与生效

> **前置术语**：本文涉及几个 my-harness-desktop 核心概念，不展开解释但标注出处——
> - **底座**（pi）：my-harness-desktop 通过 RPC 管理的子进程，一个 CLI coding agent。my-harness-desktop 是它的桌面壳。
> - **settings.json 的 `skills[]`**：底座读 `~/.pi/agent/settings.json` 和 `<cwd>/.pi/settings.json` 的 `skills` 数组来决定加载哪些 skills。数组里放路径字符串，支持 `!`/`+`/`-` 前缀做启用/禁用控制（如 `"+my-skill/SKILL.md"` 表示强制启用，`"!subdir/"` 表示排除）。示例：
>   ```json
>   { "skills": ["/Users/me/.my-harness-desktop/skills", "+git-workflow/SKILL.md", "-deprecated/SKILL.md"] }
>   ```
> - **挂/摘条目**：往 `skills[]` 数组里加/删一个普通路径字符串。bundled-skills 的 `ensureBundledSkillsEntry` 就是做这件事。
> - **registry**：插件注册表（`PluginRegistry`），bootstrap 启动时批量 `registerAll`，lifecycle 的 `activate`/`deactivate` 在插件启停时 `registerOne`/`unregister`。

my-harness-desktop 的 skills 扫描器目前有七个固定数据源。按 scanner 代码（`skill-scanner.ts:190`）的实际顺序：① `~/.pi/agent/settings.json` 的 `skills[]` 显式路径（user scope）、② `~/.pi/agent/skills/`（user scope）、③ `~/.agents/skills/`（user scope）、④ `<cwd>/.pi/skills/`（project scope）、⑤ `<cwd>/.agents/skills/`（project scope）、⑥ cwd 逐级向上的 `.agents/skills/`（project scope）、⑦ `<cwd>/.pi/settings.json` 的 `skills[]` 显式路径（project scope）。一个插件如果想贡献 skills，用户得手动把 skills 文件放进 `~/.pi/agent/skills/`，或者手动在 settings.json 的 `skills[]` 里加路径。这套机制对"插件自带 skills"这件事完全没有感知。

这个设计要解决的问题是：让插件在根目录下放一个 `skills/` 子目录就能贡献 skills——scanner 自动发现、skill-manager 正常展示、底座自动生效，用户不需要手动搬文件或改 settings。

## 1 问题与目标

### 1.1 现状：scanner 不感知插件系统

`skill-scanner.ts` 的 `scanSkills()` 按固定顺序扫七个数据源，全部是硬编码路径或从 settings.json 读的路径数组。它不知道"插件"这个概念的存在——不读注册表、不查插件目录、不关心插件是否激活。

扫描到的 skill 有两个属性标识来源：`sourceType`（`"settings"` 表示从 settings.json 显式声明来的，`"auto"` 表示从固定目录自动扫到的）和 `scope`（`"user"` 或 `"project"`）。这两个属性都不涉及插件。

生效路径只有一条：底座在启动 agent 时，读 `~/.pi/agent/settings.json` 和 `<cwd>/.pi/settings.json` 的 `skills[]` 数组，按数组里的路径加载 skills。固定目录（`~/.pi/agent/skills` 等）底座也直接扫，但插件目录不在固定目录列表里。

### 1.2 缺口：插件贡献 skills 要用户手动操作

一个插件开发者想让自己的插件带几个 skills，目前只有两条路，都不好走：

- 把 skills 文件放进 `~/.pi/agent/skills/`。这意味着插件的 skills 文件和插件本体分离了——卸载插件时 skills 残留，更新插件时 skills 不同步。

- 让用户手动在 settings.json 的 `skills[]` 里加插件 skills 目录的路径。这要求用户知道插件的安装路径，手写绝对路径或 `~` 路径，门槛太高。

bundled-skills 已经有一套"镜像目录 + ensure 挂条目"的模式（`bundled-skills.ts`）：仓库 `.claude/skills/` 随壳分发，启动时镜像到 `~/.my-harness-desktop/skills/`，再按 prefs 开关把路径挂进 `settings.json` 的 `skills[]`。但这套机制只管壳级 skills，不管插件 skills。

### 1.3 目标：约定式目录 + 自动挂摘

插件根目录下有 `skills/` 子目录即贡献 skills。不需要在 `plugin.json` 里声明，不需要用户手动操作。具体行为：

- **发现**：scanner 把已激活插件的 `skills/` 目录作为新数据源，扫到的 skills 和其他来源的 skills 一样在 skill-manager 里展示。

- **生效**：插件 activate 时，插件 skills 目录的绝对路径自动挂进对应 settings.json 的 `skills[]`；插件 deactivate 时自动摘掉。用户无感。

- **可逐个开关**：插件带来的 skills 在 skill-manager 里可以逐个 toggle，体验和内置 skills 一致。

- **scope 分流**：builtin/user/installed 插件的 skills 挂进 user scope（`~/.pi/agent/settings.json`），project 插件的 skills 挂进 project scope（`<cwd>/.pi/settings.json`）。

## 2 约定

### 2.1 规则

插件根目录下存在 `skills/` 子目录即贡献 skills。scanner 对该目录复用现有 `collectSkillEntries` 递归扫描——只收名为 `SKILL.md` 的文件，硬跳过 `.` 开头目录和 `node_modules`，和扫 `~/.pi/agent/skills` 的规则完全一致。插件 skills 目录为空或不存在时，该插件不贡献任何 skill，不报错、不告警。

### 2.2 为什么约定式而非声明式

plugin.json 的 `contributes` 是"显式契约面"——sidePanel、settings、themes、languages、fileActions，每个贡献项都有形状定义（`contributions.ts` 里的 interface），加载器校验形状，渲染层按槽位查。这套机制管的是"插件给桌面槽位贡献 UI 组件"。

skills 不是给桌面槽位贡献 UI 组件。它是要挂进底座 `settings.json` 的外部资源——和 bundled-skills 把目录挂进 `skills[]` 是同一层抽象。声明一个 `contributes.skills: [{ path: "./skills" }]` 只是把"目录存在"这件事在 manifest 里复述一遍，没有增加信息：目录在就在，不在就不在，manifest 声明一个不存在的目录反而制造矛盾。

bundled-skills 本身就不走 contributes 声明——它在 `MainPaths` 里有 `bundledSkillsDir` 和 `bundledSkillsSource` 两个路径，bootstrap 直接注入。约定式 `plugin/skills/` 和这个先例一致：目录存在即声明。

## 3 发现：scanner 加插件数据源

### 3.1 ScanOptions 扩展

`ScanOptions`（`core/domain/skills.ts`）新增 `pluginSkillDirs` 字段，类型为 `PluginSkillDir[]`。scanner 不主动发现插件——它接收 IPC 层注入的插件 skills 目录列表，只管扫描。这保持了 scanner 是纯函数、不依赖插件系统的特性。

```typescript
// core/domain/skills.ts 新增
export interface PluginSkillDir {
  /** 插件 skills 目录绝对路径（如 /path/to/plugin/skills） */
  dir: string;
  /** 插件 id */
  pluginId: string;
  /** scope 与插件 source 对齐：builtin/user/installed → user，project → project */
  scope: "user" | "project";
}

export interface ScanOptions {
  agentDir: string;
  cwd: string;
  homeDir: string;
  /** 已激活插件贡献的 skills 目录列表，由 IPC 层从 registry 收集后注入 */
  pluginSkillDirs?: PluginSkillDir[];
}
```

### 3.2 SkillInfo 扩展

`SkillInfo` 新增 `pluginId` 字段（可选），`sourceType` 联合类型加 `"plugin"` 值。扫描插件数据源时，扫到的 skill 标 `sourceType: "plugin"`、填 `pluginId`。其他来源的 skill 这两个字段都不填（`pluginId` 为 `undefined`，`sourceType` 仍是 `"settings"` 或 `"auto"`）。

```typescript
export interface SkillInfo {
  // ...existing fields...
  sourceType: "settings" | "auto" | "plugin";  // 新增 "plugin"
  /** 贡献该 skill 的插件 id（仅 sourceType === "plugin" 时有值） */
  pluginId?: string;
}
```

### 3.3 收集时机

`skills.list` IPC handler（`api/ipc/skills.ts:16`）在调 `scanSkills` 之前，从 `ctx.registry` 遍历已注册插件，对每个插件检查 `<pluginRoot>/skills/` 是否存在。存在的收集成 `PluginSkillDir[]`，传给 `scanSkills`。

registry 的 `allPlugins()` 返回 `Map<string, { manifest, path, source }>`，其中 `path` 是插件根目录绝对路径。IPC handler 拿到后拼 `join(plugin.path, "skills")`，`existsSync` 检查存在性，按 `plugin.source` 推导 scope（`project` → project scope，其余 → user scope）。

这一步只收**已注册**的插件。在 my-harness-desktop 里，注册和激活是耦合的——`lifecycle.activate()` 先调 `registry.registerOne()` 再 `loader.load()`，`deactivate()` 调 `registry.unregister()`。没有"注册但未激活"的中间态。所以"已注册"="已激活"，未激活的插件不在 registry 里，自然不贡献 skills。

注意：§4.3 的 `onActivate` 也会检查 `join(pluginPath, "skills")` 是否存在——这是同一件事的防御性二次检查。§3.3 的检查是为了不让 scanner 扫不存在的路径（IPC handler 是"运行时随时调"的，检查时路径可能在），§4.3 的检查是为了不往 settings.json 挂空目录。两处检查的动机不同，不是冗余。

### 3.4 scanner 内部扫描分支

`scanSkills` 在现有七个数据源之后，增加插件数据源扫描分支：

```typescript
// 新增分支：插件 skills 目录
for (const psd of opts.pluginSkillDirs ?? []) {
  if (!existsSync(psd.dir)) continue;
  const found = collectSkillEntries(psd.dir, "pi", psd.dir);
  addEntries(found, psd.dir, "plugin", psd.scope, psd.pluginId);
}
```

`addEntries` 需要扩展签名接收 `pluginId`，在构造 `SkillEntry` 时透传。最终 `loadSkillFromFile` 解析后，result push 时如果 `entry.sourceType === "plugin"` 就填 `pluginId`。

### 3.5 去重

去重逻辑不变——仍走 `realpathSync`，在 `seen` 集合里判。插件 skills 目录和固定目录重叠时（比如插件 skills 目录是个 symlink 指向 `~/.pi/agent/skills/xxx`），同一文件只会被收一次。先扫的数据源先入 `seen`，后扫的跳过。

数据源顺序：scanner 代码按七个固定数据源的实际顺序扫（user scope 的 settings → user scope 的 auto 目录 → project scope 的 auto 目录 → project scope 的 settings），插件数据源放在最后——这样固定目录里的文件优先入 `seen`，插件带来的同名文件被跳过。但去重只保留先入的**文件路径**，不涉及 skill name 冲突的覆盖语义——两个不同路径的 SKILL.md 即使 name 相同都会被收，底座自己处理同名 skills 的加载优先级。

## 4 生效：lifecycle ensure 挂/摘

### 4.1 复用 bundled-skills 的 ensure 模式

bundled-skills 的 `ensureBundledSkillsEntry` 做两件事：读 settings.json 的 `skills[]`，判断目标路径是否已在数组里（经 `resolvePath` 归一比对——`~` 展开 + `resolve` 规范化，避免 `~/foo` 和 `/Users/me/foo` 比对不上），不在就加、在就摘。写回走 `writeJsonFile` 的 deep 模式。当前签名：

```typescript
export interface EnsureBundledEntryOptions {
  settingsPath: string;      // settings.json 路径
  targetDir: string;         // 受管目录绝对路径（bundledSkillsDir）
  enabled: boolean;          // 来自 prefs 的 bundledSkillsEnabled
  homeDir: string;
}
export async function ensureBundledSkillsEntry(opts: EnsureBundledEntryOptions): Promise<boolean>
```

插件 skills 的挂/摘逻辑完全同构——只是目标路径从 `bundledSkillsDir` 变成插件 skills 目录，开关从 prefs 的 `bundledSkillsEnabled` 变成插件生命周期事件。**为什么不直接参数化原函数而要新增一个**：`ensureBundledSkillsEntry` 的 `enabled` 字段语义是"壳级 prefs 开关"，调用方在 `bootstrap/index.ts:240` 和 `skills.setBundledEnabled` IPC handler 里直接读 `prefsStore.get("bundledSkillsEnabled")` 传入。插件场景没有 prefs 开关——挂/摘由插件 active/inactive 生命周期驱动，是一个 `active: boolean` 参数。如果把原函数改成接受 `active` 参数，bundled-skills 的调用方也要跟着改（从"读 prefs 传 enabled"改成"读 prefs 传 active"），引入不必要的连锁改动。保留两个函数各管各的调用语义，底层逻辑同构但接口独立：

```typescript
export interface EnsurePluginSkillsEntryOptions {
  settingsPath: string;      // settings.json 路径
  skillsDir: string;         // 插件 skills 目录绝对路径
  active: boolean;           // true=挂条目，false=摘条目
  homeDir: string;
}
export async function ensurePluginSkillsEntry(opts: EnsurePluginSkillsEntryOptions): Promise<boolean>
```

逻辑和 `ensureBundledSkillsEntry` 一致：读 `skills[]`，用 `resolvePath` 归一比对目标路径是否已在，按 `active` 挂或摘。**摘时不清 +/- pattern 残留**——只摘普通路径条目，`isOverridePattern` 过滤掉。重新 activate 时 pattern 还在，逐 skill 开关状态恢复。残留 pattern 在插件未激活期间无害（底座扫不到的文件会忽略）。

### 4.2 scope 分流

lifecycle 层拿到插件的 `source`，按 source 决定挂进哪个 settings.json：

- `builtin` / `user` / `installed` → user scope，settings 路径 = `join(paths.piAgentDir, "settings.json")`
- `project` → project scope，settings 路径 = `join(cwd, ".pi", "settings.json")`

这个分流逻辑和 `getSettingsPath`（`skill-toggle.ts:8`）的语义一致。

### 4.3 在 lifecycle 的 activate/deactivate 里挂钩

`activate` 和 `deactivate` 函数（`lifecycle/index.ts`）在现有逻辑之后，增加 skills ensure 调用。`PluginLifecycleDeps` 接口扩展，新增 skills ensure 能力：

```typescript
export interface PluginLifecycleDeps {
  // ...existing...
  skillsEnsure: {
    onActivate(pluginId: string, pluginPath: string, source: DiscoveredPlugin["source"]): Promise<void>;
    onDeactivate(pluginId: string, pluginPath: string, source: DiscoveredPlugin["source"]): Promise<void>;
  };
}
```

`activate` 函数在 `loader.load()` 成功后、`notifyPluginsChanged()` 之前，调 `deps.skillsEnsure.onActivate`。`deactivate` 函数在 `registry.unregister()` 之后、`notifyPluginUnloaded()` 之前，调 `deps.skillsEnsure.onDeactivate`。

onActivate/onDeactivate 的实现逻辑：

1. 检查 `join(pluginPath, "skills")` 是否存在。不存在就跳过——插件没有 skills 目录，不需要挂摘。
2. 按 source 分流确定 settingsPath 和 scope。
3. 调 `ensurePluginSkillsEntry`（active=true/false）。
4. 返回前让调用方知道是否发生了写入（`broadcastSettingsChanged` 在 IPC 层调，不在 lifecycle 里调——lifecycle 是 application 层，不该直接碰 IPC 广播）。

### 4.4 时序

lifecycle 的 `activate` 是 async 的（worker 加载异步），摘条目的时机会略晚于插件标记为 active。这个延迟可接受——skills 的生效是"下次发消息时底座读 settings.json"，不是实时的。activate 返回后插件已经注册、UI 已渲染，skills 条目在 settings.json 里同步落盘，底座下次读时能看到。

deactivate 同理——`deactivate` 当前是同步函数返回 `void`，但 `skillsEnsure.onDeactivate` 是 async 的。需要把 `deactivate` 改成 async（或用 fire-and-forget）。选择改 async：`deactivate` 改成返回 `Promise<void>` 后，调用方（`disablePlugin`/`uninstallPlugin`/`reloadPlugin`）加 `await`。这三个函数原本就是 `async`（返回 `Promise<{ ok, error }>`），加 `await` 不改变返回类型——IPC handler 透传 Promise，无需改动。`ipcMain.handle` 原生支持 async handler，返回类型不变即不受影响。

### 4.5 reload 的处理

`reloadPlugin`（`lifecycle/index.ts:100`）先 `deactivate` 再 `activate`。改成 async 后，`await deactivate(...)` 会等 skills 摘条目落盘完成才执行 `rediscover()` 和 `activate()`。比以前多了一段写文件延迟，对于 reload 这个低频操作的体验影响可忽略——反而比以前更正确：确保 skills 条目摘干净了再重新挂。skills 条目会先摘再挂——中间态 settings.json 里短暂没有该插件的 skills 条目，可接受，因为 reload 本身是重建过程，中间态不可见。

### 4.6 冷启动：bootstrap 阶段的 skills ensure

这是最关键的一个场景，盲测暴露的缺口：bootstrap 启动时**不走 `activate()`**。看 `bootstrap/index.ts:90-93`：

```typescript
registry.registerAll(discoverPlugins(builtinDir, "builtin"));
registry.registerAll(discoverPlugins(installedDir, "installed"));
registry.registerAll(discoverPlugins(userPluginsDir, "user"));
registry.registerAll(discoverPlugins(projectPluginsDir, "project"));
```

这是直接调 `registry.registerAll()` 批量注册，不走 `lifecycle.activate()`——没有 `loader.load()`、没有 `notifyPluginsChanged()`，自然也不会触发 `skillsEnsure.onActivate`。如果只在 `activate` 里挂钩 skills ensure，内置插件在每次冷启动时都不会往 settings.json 挂 skills 条目——必须有一条 bootstrap 专用的 ensure 路径。

bundled-skills 就是这个模式：它在 bootstrap 里直接调 `ensureBundledSkillsEntry`（`bootstrap/index.ts:240`），不走 lifecycle。插件 skills 在 bootstrap 阶段也走类似的批量 ensure：

1. registry `registerAll` 完成后（`bootstrap/index.ts:93` 之后），遍历 `registry.allPlugins()`。
2. 对每个插件检查 `join(plugin.path, "skills")` 是否存在且非空。
3. 存在的按 `plugin.source` 分流 scope（和 §4.2 一致），调 `ensurePluginSkillsEntry(active=true)`。
4. 收集所有写入结果，任一发生写入则 `broadcastSettingsChanged()`。

这和 bundled-skills 的启动同步同构。区别是 bundled-skills 只有一条路径（`bundledSkillsDir`），插件 skills 要遍历 registry 里所有已注册插件。由于 `ensurePluginSkillsEntry` 内部经 `resolvePath` 归一比对——目标路径已在 `skills[]` 里就跳过不写——所以每次启动跑一遍是幂等的：第一次启动写入，之后启动只是确认一下，不重复写。

实现上，这个批量 ensure 逻辑放在 `bootstrap/index.ts` 里、`ensureBundledSkillsEntry` 调用之后（和它并列，不是嵌套）。bootstrap 需要 import `ensurePluginSkillsEntry`（从 `bundled-skills.ts` 或新的 `plugin-skills.ts`）和 `readdirSync`（检查非空）。和 bundled-skills 一样用 `void ... .then(changed => ...).catch(...)` fire-and-forget，不阻塞窗口创建。

project scope 的插件在 bootstrap 阶段有个特殊处理：桌面应用启动时 `process.cwd()` 通常是家目录，没有"当前项目"概念（`bootstrap/index.ts:87` 注释里说了 `projectPluginsDir` 在打包态降级为"另一个用户级"）。所以 bootstrap 阶段的 project source 插件，其 skills 目录实际路径和 user source 一样在用户目录下——按 source 分流时会挂进 `<cwd>/.pi/settings.json`，但这个 cwd 是家目录，不是真实项目。这不影响功能：条目挂进去无害，scanner 扫到就展示。等"打开项目"功能落地（M8）后，切换项目时会重新初始化 cwd，此时需要重新 ensure——但这是 M8 的设计范围，本文不覆盖。

## 5 toggle 复用

### 5.1 sourcePath 就是插件 skills 目录

`toggleSkill`（`skill-toggle.ts:34`）的 +/- pattern 是 `toPosixPath(relative(sourcePath, filePath))` 算的。插件 skills 的 `sourcePath` = 插件 skills 目录绝对路径，`filePath` = 目录下某个 `SKILL.md` 的绝对路径。`relative` 算出来的 pattern 如 `my-skill/SKILL.md`，和固定目录源的 pattern 形态一致。

`toggleSkill` 函数零改动——它只认 `sourcePath` 和 `filePath`，不关心来源是固定目录还是插件目录。scanner 在扫描插件数据源时已经把 `sourcePath` 设为插件 skills 目录绝对路径，`SkillInfo` 里自然带着这个值，skill-manager 调 toggle 时原样传过来。

### 5.2 用户体验

用户在 skill-manager 里看到的插件 skills 和其他 skills 混在一个列表里，按 name 排序。每个 skill 可以独立 toggle——toggle 写的 +/- pattern 进 settings.json 的 `skills[]`，和插件 skills 目录的普通路径条目共存。

用户可以关掉某个插件带来的某个 skill 而不影响该插件的其他 skills。下次插件 deactivate 再 activate 时，关掉的状态保留（因为只摘普通路径条目，不清 +/- pattern）。

## 6 展示：skill-manager 分组

### 6.1 pluginId 字段

`SkillInfo.pluginId` 有了，skill-manager 可以按来源分组展示。当前 skill-manager 的展示不分组——所有 skills 按 name 排序平铺。加了 `pluginId` 后，可以按 `pluginId` 是否有值来分组：

- **插件 skills**：`sourceType === "plugin"`（`pluginId` 有值），按 `pluginId` 子分组
- **其他 skills**：`sourceType === "auto"` 或 `sourceType === "settings"`（`pluginId` 为 `undefined`），来自固定目录或 settings.json 显式声明

注意 `sourceType === "settings"` 在"其他 skills"里和"内置 skills"里都会出现——它不区分"固定目录自动扫到的"和"用户在 settings.json 里手动加路径的"。如果要进一步区分，需要看 `sourcePath`（固定目录源的 sourcePath 是 `~/.pi/agent/skills` 等，settings 声明源的 sourcePath 是用户写的路径）。这是 UI 层的展示决策，不影响 scanner 和 toggle 的逻辑。skill-manager 可以选择分组展示，也可以继续平铺但在每个 skill 旁边标个小标签显示来源插件。具体展示形态是 skill-manager 插件的设计自由，本文不约束。

### 6.2 chokidar 监听

`skills.watch` IPC handler（`api/ipc/skills.ts:63`）目前监听固定目录 + settings.json 文件。加了插件 skills 目录后，本轮做的事：在 `skills.watch` handler 里从 registry 收集已激活插件的 skills 目录路径，加进 `pathsToWatch` 集合。这是一次性的静态加——watch 建立时收集当前已注册插件的 skills 目录，监听列表在 watch 生命周期内不变。

插件 activate/deactivate 时 watch 列表不会自动更新——已建立的 watcher 不知道新插件来了。这是本轮的已知限制：用户在装新插件后需要重新触发 watch（比如切出再切回 skill-manager 页面）才能监听到新插件的 skills 目录。更优解是监听 `plugins:changed` 事件自动重建 watch，但跨 IPC handler 协作复杂，作为演进项——本文的设计不阻塞这个演进，只是不在本轮做。

## 7 要改的文件清单

### 7.1 圆心层（core/domain）

**`core/domain/skills.ts`**

- `ScanOptions` 加 `pluginSkillDirs?: PluginSkillDir[]` 字段
- 新增 `PluginSkillDir` interface（`dir`、`pluginId`、`scope`）
- `SkillInfo` 加 `pluginId?: string` 字段
- `sourceType` 联合类型加 `"plugin"` 值

### 7.2 用例编排层（core/application）

**`core/application/skills/skill-scanner.ts`**

- `SkillEntry` interface 加 `pluginId?: string` 字段
- `addEntries` 签名加 `pluginId?` 参数
- `scanSkills` 末尾增加插件数据源扫描分支，遍历 `opts.pluginSkillDirs`
- result push 时按 `entry.sourceType` 填 `pluginId`

**`core/application/skills/bundled-skills.ts`**

- 新增 `ensurePluginSkillsEntry` 函数（泛化自 `ensureBundledSkillsEntry`，去掉 prefs 语义，改为 active 布尔）
- 新增 `EnsurePluginSkillsEntryOptions` interface

**`core/application/lifecycle/index.ts`**

- `PluginLifecycleDeps` 加 `skillsEnsure` 字段
- `activate` 函数在 `loader.load()` 成功后调 `deps.skillsEnsure.onActivate`
- `deactivate` 改 async，在 `registry.unregister()` 后调 `deps.skillsEnsure.onDeactivate`
- `disablePlugin`、`uninstallPlugin`、`reloadPlugin` 的 `deactivate` 调用加 `await`

### 7.3 流入适配器层（api/ipc）

**`api/ipc/skills.ts`**

- `skills.list` handler 从 `ctx.registry` 收集已激活插件的 skills 目录，构造 `PluginSkillDir[]` 传给 `scanSkills`
- `skills.watch` handler 把已激活插件的 skills 目录加进 `pathsToWatch`

**`api/ipc/plugins.ts`**

- `lifecycleDeps` 构造时注入 `skillsEnsure` 实现
- `skillsEnsure.onActivate`：检查 `<pluginPath>/skills` 存在性且非空，按 source 分流 settingsPath，调 `ensurePluginSkillsEntry(active=true)`，写入发生时调 `broadcastSettingsChanged`
- `skillsEnsure.onDeactivate`：同上，`active=false`
- 需要 `ctx.paths`（拿到 `piAgentDir`、`homeDir`）和 `cwd`
- **IPC handler 无需改动**——`disablePlugin`/`uninstallPlugin`/`reloadPlugin` 改前后均返回 `Promise<{ ok, error }>`（它们本来就是 async），`ipcMain.handle` 的 async handler 透传不受影响

**`bootstrap/index.ts`**

- 在 `registry.registerAll` 四行之后（第 93 行后）、`ensureBundledSkillsEntry` 调用之后，新增插件 skills 批量 ensure：遍历 `registry.allPlugins()`，检查 `join(plugin.path, "skills")` 存在且非空，按 source 分流 scope，调 `ensurePluginSkillsEntry(active=true)`，任一写入则 `broadcastSettingsChanged()`
- fire-and-forget（`void ... .then().catch()`），和 `ensureBundledSkillsEntry` 同样不阻塞窗口创建

### 7.4 不需要改的

- **`core/domain/contributions.ts`**：不加 `SkillContribution`，约定式不进 manifest 契约
- **`skill-toggle.ts`**：toggle/addPath/removePath 零改动，sourcePath 已是绝对路径
- **`skill-manager` 插件**：分组展示是演进项，不改也能工作——`pluginId` 字段有了，UI 随时可以用
- **`PluginManifest`**：不加字段，不改形态校验

## 8 QA

**Q：插件 skills 目录为空时怎么处理？**

scanner 的 `collectSkillEntries` 扫空目录返回空数组，`addEntries` 不会加任何条目。lifecycle 的 `onActivate` 检查 `join(pluginPath, "skills")` 存在性——目录存在但为空时，仍会调 `ensurePluginSkillsEntry` 挂条目。挂一个空目录进 `skills[]` 无害——底座扫不到 SKILL.md 就什么都不加载。但更干净的做法是 `onActivate` 在目录存在且不为空时才挂条目，跳过空目录。推荐后者：`readdirSync(skillsDir).length > 0` 才挂。

**Q：插件 skills 和固定目录有同名 skill 时谁覆盖？**

去重走 `realpathSync`，不是走 skill name。如果两个来源的 SKILL.md 文件路径不同（不是 symlink 关系），都会被扫到，都会出现在列表里。底座按自己的优先级加载同名 skills（通常后加载的覆盖先加载的），my-harness-desktop 不干预这个语义。skill-manager 里会看到两个同名 skill，分属不同来源——用户可以自己关掉不想要的那个。

**Q：插件升级后 skills 目录变了怎么同步？**

插件升级走 `reloadPlugin`——先 deactivate 再 activate。deactivate 摘掉旧 skills 目录的条目，activate 挂上新 skills 目录的条目（路径没变但内容变了，条目还是挂同一个绝对路径）。中间态 settings.json 里短暂没有该插件的 skills 条目，可接受。如果升级是文件覆盖（不是先卸再装），skills 目录路径不变、内容变了——chokidar 监听到文件变化，触发 `skills:changed` 广播，skill-manager 重新扫描，列表自动更新。settings.json 的条目不需要改（路径没变）。

**Q：项目级插件换项目后残留？**

项目级插件的 skills 挂进 `<cwd>/.pi/settings.json`，不是全局 settings。换项目后 cwd 变了，新项目的 `.pi/settings.json` 不含旧项目的插件 skills 条目。旧项目的 settings.json 里残留的条目只在该项目目录下生效——用户下次打开旧项目时，scanner 从 registry 检查插件是否还在（插件目录不存在或未激活就不扫），settings.json 里的残留条目不影响 scanner 的扫描结果（scanner 不读 settings.json 的条目来决定扫哪些插件，它从 registry 读插件列表）。

但底座会读 `<cwd>/.pi/settings.json` 的 `skills[]`——如果旧项目的 settings.json 里残留了一个已卸载插件的 skills 目录路径，底座会尝试扫这个路径，路径不存在就跳过，无害。用户可以在 skill-manager 的"源路径"列表里手动删掉残留条目（`removeSkillPath`），或直接删 `.pi/settings.json` 里的条目。

**Q：chokidar 监听要不要加插件 skills 目录？**

本轮做：在 `skills.watch` handler 里从 registry 收集已激活插件的 skills 目录路径，加进 `pathsToWatch`。这是一次性静态加——watch 建立时收集当前已注册插件，watch 生命周期内不变。已知限制：插件 activate/deactivate 后 watch 列表不自动更新，用户需重新触发 watch（切出再切回 skill-manager 页面）。自动重建 watch（监听 `plugins:changed` 事件）作为演进项，本轮不做。
