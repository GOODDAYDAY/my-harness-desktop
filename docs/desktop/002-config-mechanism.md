# 002 配置机制：会话级、项目级、全局级

> ⚠ **历史稿**：本文是 pre-多内核 的 pi-only 旧术语稿（"底座"/旧"内核"=壳机制），术语与架构以 CLAUDE.md + kernel-design-spec.md + core-spec.md 为准，本文保留作历史参考。

my-harness-desktop 的配置体系有三层作用域：会话级、项目级、全局级。三层各司其职，读有优先级，写有默认姿态，一切路径由框架按规则推导，插件不碰路径、不感知 cwd、不写任何路径字符串字面量。

本文从物理落点讲起，逐层展开读路径、写路径、锁与并发、安全边界，最后收在插件不做什么。

## 1 问题与目标

### 1.1 根因：同一个逻辑散落在多个插件

my-harness-desktop 早期的插件配置有四条通道并存：`ctx.config`（ConfigStore，按 pluginId 隔离的 KV，存在 `~/.my-harness-desktop/plugins-data/{id}/config.json`）、`configFile.get/set`（通用 JSON 文件自由读写，白名单限 `~/.my-harness-desktop/` 和 `~/.pi/agent/` 前缀）、`configFile.getLayered/setProject/clearProject`（文件级分层覆盖，项目级覆盖全局级整份文件）、`prefs`（electron-store，纯全局桌面偏好）。

四条通道是同一件事——"插件配置读写"——在"路径怎么构造 × 分不分层"这个二维空间里的四个散落点。每个插件都得自己回答一遍"我的配置该住哪、怎么分层"：

- **session-bookmarks** 的数据从项目目录被安全评估逼到 `~/.my-harness-desktop/plugins-data/session-bookmarks/<cwd-hash>/`，书签和项目物理分离，git 追踪不到、换机器带不走。
- **session-colors** 的图钉所有项目混存在同一个 `plugins-data/session-colors/config.json` 里，只是 UI 按 sessionPath 过滤。
- **notes** 自己造了两层存储（全局 `~/.my-harness-desktop/notes.json`、项目级 `<cwd>/.my-harness-desktop/notes.json`），路径约定都和别人不一样。
- **tool-manager** 和 **timeline** 最早直接拼 `${cwd}/.my-harness-desktop/config/tool-groups.json` 传给 configFile，被白名单拒绝、IPC 抛错。

根因是框架没有默认姿态，逼着每个插件自己发明轮子。这正是洋葱架构里的判别气味三：同一逻辑在多个外部入口各写一遍，该收进框架统一承担。

### 1.2 终态：三层作用域，一条统一通道

统一之后的配置模型只有一条规则：**插件配置默认项目级，全局兜底，会话级按会话文件走。**

```
会话级 → 项目级 → 全局级
（精确）  （覆盖）  （兜底）
```

- **会话级**：数据和会话文件同生共死。存在会话头行 `custom-my-harness-desktop` 开放命名空间里，读写走 `ctx.sessions.updateHeader`。
- **项目级**：和项目目录绑定，在 `<cwd>/.my-harness-desktop/` 下。随项目走，git 可追踪，换机器带走，团队可共享。
- **全局级**：和用户绑定，在 `~/.my-harness-desktop/` 下。所有项目的兜底默认值，换项目不丢。

三个概念的唯一判据是：**这份配置的意义是否依附于某个项目、某个会话，还是依附于用户本人。**

## 2 三层作用域与物理落点

### 2.1 全局级：用户级兜底

**物理位置**：`~/.my-harness-desktop/config/{pluginId}.json`

这是桌面数据根下的 `config/` 子目录，一个插件一个文件，按 pluginId 命名。打包版和 dev 版的逻辑前缀都是 `~/.my-harness-desktop`，但物理落点随运行态分流：

- **打包版**（`app.isPackaged === true`）：`~/.my-harness-desktop/config/{pluginId}.json`
- **dev 版**（`npm run dev` 或 `npm start`）：`~/.my-harness-desktop-dev/config/{pluginId}.json`

分流逻辑在 `src/client/paths.ts:21` 的 `resolveMyHarnessDesktopDir()`，单源控制：

```typescript
export function resolveMyHarnessDesktopDir(): string {
  return join(homedir(), app.isPackaged ? ".my-harness-desktop" : ".my-harness-desktop-dev");
}
```

契约层面写的是逻辑前缀 `~/.my-harness-desktop`，manifest 和 renderer 声明的路径走 `expandDesktopPath`（`src/client/paths.ts:27`）映射到当前物理数据根——契约不变，物理落点分流。

**例外：两个不分流的目录**：

- `~/.pi/agent/`（底座标准目录）：底座的 settings.json、models.json、sessions/ 都在这里，两版共享，只配一次。
- `<cwd>/.my-harness-desktop/`（项目级）：跟着项目走，不属于桌面数据根。

**全局级放什么？** 和项目无关的桌面级配置——如 `recentCwds`（最近打开的项目列表）、`customOrder`（插件排序）、插件的运行偏好。也用作所有项目级配置的兜底——项目级没有的 key，读全局。

### 2.2 项目级：项目级默认

**物理位置**：`<cwd>/.my-harness-desktop/config/{pluginId}.json`

`<cwd>` 是当前打开的项目根目录。bootstrap 在构造 ConfigStore 时注入动态 getter（`src/bootstrap/index.ts:133-139`）：

```typescript
const configStore = new ConfigStore({
  userDir: CONFIG_DIR,                        // ~/.my-harness-desktop/config/
  getProjectDir: () => {
    const cwd = sessionStore.getActiveCwd();  // main 侧 cwd 事实源
    return cwd ? join(cwd, ".my-harness-desktop", "config") : null;
  },
});
```

`getProjectDir` 是动态 getter，不是启动时注入一次的静态值。用户切换项目后下一次 `ctx.config.get/set` 自动走新项目的路径，ConfigStore 内部缓存按 `projectDir:pluginId` 分 key（`config-store.ts:137`），切项目不会串数据。

**项目级只存 diff**。`set("groups", x)` 就只有 `groups` 这一个 key 进项目级文件，其他 key 项目级一个字节都没有。全局层后续更新了项目级没碰过的 key，项目自动享受到新值——它本来就没有覆盖那个 key。覆盖的 key 不受全局更新影响。

**项目级写什么？** 和项目有关的配置，且用户需要每个项目各自定制——书签、图钉、工具组、提示词、项目的默认模型/思考深度。

### 2.3 会话级：和会话文件同生共死

**物理位置**：会话 JSONL 文件第一行（头行）的 `custom-my-harness-desktop` 字段

每个会话是一个 `.jsonl` 文件，第一行是会话头（`{type:"session", id, timestamp, cwd, ...}`），desktop 在头行加了 `custom-my-harness-desktop` 开放命名空间。字段形状是一个 `Record<string, unknown>`，顶层 key 即域名（"谁的数据谁写"），域内整体替换。

头行的实际形状（以 subagent 域为例，`src/core/domain/sessions.ts:48`）：

```json
{
  "type": "session", "id": "sub-1", "timestamp": "...", "cwd": "...",
  "custom-my-harness-desktop": {
    "subagent": { "parent_id": "...", "parent_session": "..." },
    "model": { "provider": "anthropic", "modelId": "claude-sonnet-4-20250514", "thinkingLevel": "high" }
  }
}
```

读：scanner 的 `listSessions` 和 `readSession` 在构造 `SessionInfo` 时透传 `custom-my-harness-desktop`（`session-scanner.ts:113`），`SessionInfo.custom` 字段上直接可读。

写：走 `ctx.sessions.updateHeader(sessionPath, { custom: { 域名: { ... } } })`，内部 `updateSessionHeader` 在目录锁内做域级浅合并——`{k:v}` 只动 k 域，其他域原样保留（`session-scanner.ts:227-239`）。

**会话级放什么？** 天生属于这个会话、和会话文件同生共死的配置——会话的模型/思考深度、subagent 的父子归属、插件的私有会话级设置（如 timeline 的折叠状态）。

## 3 读路径：谁读谁的什么

### 3.1 项目级与全局级：顶层 key 浅合并

`ctx.config.get(pluginId, key)` 的读路径分两步（`config-store.ts:60-64`）：

1. 读项目级文件和全局文件各自到内存——每层一次 `readFileSync` + `JSON.parse`，缓存到 `entry.user` 和 `entry.project`。
2. 返回 `{...user, ...project}[key]`——顶层 key 浅合并，项目级覆盖全局。

文件不存在或 JSON 损坏时该层按 `{}` 处理，`console.warn` 记录（`config-store.ts:168-177`）。

`ctx.config.all(pluginId)` 返回合并后的全量快照（`config-store.ts:67-71`）。`ctx.config.getScope(scope)` 返回某一层的原始快照，不合并——这是为**并集型数据**（如 notes 的全局常用语和项目笔记并集展示）准备的，覆盖型配置用 `all` 即可。

### 3.2 会话级：随会话打开、从 SessionInfo 读取

会话级配置不走 ConfigStore，走 `SessionInfo.custom`。读取时机分两类：

- **跨插件展示元数据**（如 subagent 的 parent_id）：listSessions 返回的 `SessionInfo` 上带 `custom`，渲染方直接读 `info.custom?.subagent?.parent_id`。
- **插件私有设置**（如 timeline 的折叠状态）：打开会话后读 `openSession` 返回的 `SessionDetail.info.custom?.timeline`。

会话级和项目级/全局级不存在合并——会话级数据不属于任何项目，它只属于那个会话文件。

### 3.3 配置不属于 ConfigStore 的例外：底座配置与桌面偏好

两类明确不进入 ConfigStore 的统一通道：

- **底座配置**（`~/.pi/agent/settings.json`、`~/.pi/agent/models.json`）：底座进程自己读写的标准路径，desktop 只是代管界面。它们不走项目级覆盖——底座进程 spawn 时 cwd 就是项目目录，底座自己若有项目级配置机制，那是底座的事。操作入口在 `pi-manager` 和 `pi-model-manager` 插件，走 `configFile.get/set` 白名单通道。
- **桌面偏好**（主题 id、字体、字号、窗口布局）：纯全局，和项目无关，走 electron-store（`ctx.prefs.get/set`），不进分层模型。

## 4 写路径：默认项目级，全局是显式出口

### 4.1 `ctx.config.set`：默认落项目

`set(pluginId, key, value)` 的写路径（`config-store.ts:86-104`）：

- **有当前项目**（`getProjectDir()` 返回非 null）：写项目级 `<cwd>/.my-harness-desktop/config/{pluginId}.json`，只写这一个 key——项目级文件自然累积成 diff。
- **没有当前项目**（用户还没打开目录）：写全局 `~/.my-harness-desktop/config/{pluginId}.json`。全局层此时是唯一的家。

`value === undefined` 时从目标层删除该 key——项目级删了回退全局，全局删了就没了。

**默认姿态就是项目级。** 插件调 `ctx.config.set("key", value)` 时不需要传任何路径参数——框架按 pluginId 推导完整路径，从构造到落盘全程插件不接触路径字符串。安全模型从"插件传路径，框架校验"翻转为"框架推路径，插件不碰"——路径逃逸的攻击面整个消失（`unified-project-config.md §3.5`）。

### 4.2 写全局的唯一显式出口：`scope: "global"`

有当前项目时，插件代码写全局只有一个入口：`set` 的 `scope: "global"` 参数。

```typescript
ctx.config.set("recentCwds", v, { scope: "global" });
```

这个参数是每次写入时调用方对这一个 key 的目标选择，不是插件在 manifest 里声明"我是全局型插件"。同一个插件可以既有项目级 key 又有全局 key——例如 session-colors 的 pins 是项目级（天然跟项目），pinsVisible 是全局（界面偏好）。

bootstrap 构造 ConfigStore 时 `getProjectDir` 按当前 cwd 动态解析，`set` 内部通过 `targetDir = scope === "global" ? this.userDir : (projectDir ?? this.userDir)` 决定落盘位置（`config-store.ts:89`）。

### 4.3 用户侧的显示触发：设置页的两个框架按钮

设置页框架托管（`saveMode=framework` 的 settings 贡献项）提供了两个按钮，覆盖型配置的插件自动获得，不写一行代码：

- **设为全局**：读两层合并后的整份配置，写入全局文件。项目级文件保留——覆盖过的 key 继续覆盖，没覆盖的 key 从此用刚写入全局的新值。
- **移除项目覆盖**：删项目级文件，该插件在这个项目的配置整体回退到全局默认。

两个按钮旁边还有一个来源徽标（"项目"或"全局默认"），告诉用户当前配置来自哪层。

这两个触发者是面向用户的显式动作，不是插件代码里可调用的 API——插件代码能碰全局层的只有 `scope: "global"` 一条路。"全局写必须显式"就是这个意思：无论是代码还是用户，都没有"不小心写错层"的路径。

## 5 会话级配置：模型、思考深度、插件私有数据

### 5.1 归属翻转：从"全局 pref 驱动"到"会话自己持有"

早期模型和思考深度的配置归属是倒的：全局 `pref.currentModelId`（持久化到 general.json）驱动所有会话——用户在会话 A 切了模型，全局 pref 被改写，会话 B 下一次发消息被 flush 对齐到会话 A 的选择。根因是会话不持有自己的模型/深度配置，真相被拆成"全局 pref + 进程临时快照"两块，pref 是主、会话是跟随。

翻转后（`session-model-config.md`）：会话自己持有模型/深度，持久化在头行 `custom-my-harness-desktop.model` 域，形状是 `{provider, modelId, thinkingLevel}` 三字段单域整体替换（`src/core/domain/sessions.ts:140-144`）：

```typescript
export interface SessionModelPrefs {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}
```

- **活会话**：运行时真相在底座进程（`state.model` / `state.thinkingLevel`），持久化投影在头。每次 sync 比对头与进程状态，不一致以进程为真回写头。
- **历史会话**：无活进程时从头读 `custom?.model`，经 `parseSessionModelPrefs` 窄化校验（`domain/sessions.ts:151-157`，三字段齐备且均为字符串才认）。
- **新会话壳**（还没发过消息）：composer 显示默认配置层（底座 settings.json 的 defaultModel + general.json 的 defaultThinkingLevel），首条消息发送时灌入进程并落下头。

`pref.currentModelId` / `pref.currentThinkingLevel` 整个退役——这两个字段连同 setter 从 ui-store 删除，存量 general.json 里的 `currentModelId` 键读到即忽略。

### 5.2 写入通道：`updateSessionHeader` + custom 补丁

插件写会话级配置只有一条路：

```typescript
ctx.sessions.updateHeader(sessionPath, {
  custom: { timeline: { collapsedToolIds: ["call_001"] } },
});
```

HeaderPatch 的 `custom` 字段是 `Record<string, unknown> | null`（`src/core/domain/sessions.ts:135`）。写入在 `updateSessionHeader` 的目录锁内做域级浅合并（`session-scanner.ts:227-239`）：

- `{ timeline: { ... } }` → 只动 `custom-my-harness-desktop.timeline`，其他域原样保留
- `{ timeline: null }` → 删这一个域
- `custom: null` → 删整个 `custom-my-harness-desktop` 字段
- 删光域后字段本身不留空壳（`Object.keys(cur).length === 0 → delete header["custom-my-harness-desktop"]`）

写入侧还附带 8KB 软信号（`session-scanner.ts:249-251`）：头行序列化后超 8KB 打 warning 日志，不拒绝写入。8KB 是 toolConfig 两条读取链（desktop 的 `readSessionToolConfig` 和 tool-gate 底座 extension）的热路径预算，设计约定见 `session-header-custom.md §2.4`。

### 5.3 读通道：SessionInfo.custom 透传

listSessions 和 readSession 在构造 `SessionInfo` 时透传 `header["custom-my-harness-desktop"]` 到 `info.custom`（`session-scanner.ts:113` 和 `:377`），消费方直接从 `info.custom?.域名` 取。

model 域的读取有专门的窄化 helper `parseSessionModelPrefs`（`domain/sessions.ts:151-157`），三字段齐备且均为字符串才认，手改文件塞畸形数据当"无自定义"处理。

## 6 框架级文件通道

### 6.1 configFile.get/set：白名单门控

`configFile.get(path)` 和 `configFile.set(path, data, mode)` 是框架级通用 JSON 文件读写通道，挂在 `window.pi.configFile` 上。路径由调用方传完整路径，main 进程的 `resolveConfigFilePath` 做白名单校验（`src/api/ipc/config.ts:44-50`）：

```typescript
function resolveConfigFilePath(path: string): string {
  const abs = expandDesktopPath(path, paths.homeDir, paths.myHarnessDesktopDir);
  const allowed = [paths.myHarnessDesktopDir, paths.piAgentDir];
  const ok = allowed.some((root) => abs === root || abs.startsWith(root + sep));
  if (!ok) throw new Error(`configFile 路径越界...`);
  return abs;
}
```

白名单只放行两个前缀：`~/.my-harness-desktop/`（桌面配置区）和 `~/.pi/agent/`（底座配置区）。`~/.my-harness-desktop` 是逻辑前缀，经 `expandDesktopPath` 映射到当前数据根（dev 态 `-dev` 目录）。

**白名单为什么不能放行 `<cwd>/.my-harness-desktop/`？** 白名单是固定前缀匹配，cwd 是运行时变量——如果允许，插件传 `cwd="/etc"` 就拼出 `/etc/.my-harness-desktop/`，等于放行任意目录（`layered-config.md Q7`）。

### 6.2 getLayered / setProject / clearProject：框架自用分层通道

这三个 API 是 configFile 的分层扩展，语义已从最初的"文件级整份覆盖"演进为"顶层 key 浅合并"（`unified-project-config.md §2.2`）。路径由 main 构造（调用方只传 `cwd` 和 `relPath`），不走白名单——relPath 有独立的三禁校验：禁绝对路径、禁 `~`、禁 `..`（`api/ipc/config.ts:71-80`）：

```typescript
function resolveRelPath(cwd: string, relPath: string): { project: string; global: string } {
  if (relPath.startsWith("/") || relPath.includes("~"))
    throw new Error("relPath 不能是绝对路径或含 ~");
  if (relPath.split(sep).includes(".."))
    throw new Error("relPath 不能含 ..");
  return {
    project: join(cwd, ".my-harness-desktop", relPath),
    global: join(paths.myHarnessDesktopDir, relPath),
  };
}
```

- **getLayered**：读两层做 key 级浅合并 `{...globalDoc, ...projectDoc}`，两层都不存在返回 `null`。
- **setProject**：写项目级路径，mode 参数管文件内合并（`"replace"` 整份覆盖或 `"deep"` 深合并），两层间的 fallback 只在读时发生。
- **clearProject**：删项目级文件，下次读回退全局。

这三个 API 定位为框架自用通道——设置页"设为全局/移除项目覆盖"按钮、general.json 分层读写走它们。插件不再直接调它们——插件配置全部走 `ctx.config`。

### 6.3 configFile 在 PluginContext 中的收窄

在 PluginContext 契约上（`src/core/domain/context.ts:118-121`），`configFile` 只保留了 `get` 和 `append`：

```typescript
configFile: {
  get: (path: string) => Promise<Record<string, unknown>>;
  append: (path: string, entry: Record<string, unknown>) => Promise<void>;
};
```

- `get` 是只读旧数据迁移窄口——一次性搬迁用，常规配置读写走 `ctx.config`，docstring 标注"新代码勿用"。
- `append` 是 JSONL 追加原语的透传（`config-file.ts:64` 的 `appendJsonlLine`），服务 session 文件等 append-only 文件。写入口和 writeJsonFile 共用同一把目录锁（`withDirLock`），追加时尾字节补换行处理崩溃残留的撕裂尾。

## 7 锁与并发安全

### 7.1 withDirLock：所有写操作的统一锁原语

`withDirLock` 是 `src/core/application/config/config-file.ts:21-32` 的目录锁原语，基于 `proper-lockfile` 实现，stale 5 秒、失败重试 3 次。锁目录而非文件：首次写时文件可能不存在，锁文件会 ENOENT，锁已 `mkdir` 的目录最稳。

这个原语是共享的——ConfigStore 的 `persist`（`config-store.ts:184`）、`writeJsonFile`（`config-file.ts:52`）、`appendJsonlLine`（`config-file.ts:69`）、`updateSessionHeader`（`session-scanner.ts:190`）全部走同一把锁。一个锁实现被所有写入方引用，不存在"这里锁了那里没锁"的漏点。

### 7.2 ConfigStore 的 per-file 写队列

目录锁串行化同目录的并发写，但 proper-lockfile 的重试机制在高并发下会产生 ELOCKED 和读脏的问题。ConfigStore 在锁之上加了一层 per-file 写队列（`config-store.ts:92-103`），同 `targetDir:pluginId` 的写入串行执行，队列 key 含目标目录——同插件跨层写（项目级和全局级）不互斥，同一层同一插件的写才串行。

### 7.3 写入的原子性与会话文件的撕裂窗

`updateSessionHeader` 是整文件重写：`readFileSync` 全文、改头行、`writeFile` 写回，在读-改-写过程中持目录锁。活会话的 pi 进程在文件尾 append（JSONL 追加），不走这个锁——desktop 读完后、写回前的几 ms 里，pi append 的行可能被旧 content 覆盖丢失。

这个撕裂窗不是 custom-my-harness-desktop 引入的——`toolConfig` 写入同款，session-bus 的 spawn + 立刻写 toolConfig 就是走这条路径，已在线验证。受益于 subagent 写入时机（spawn 后立刻，pi 尚未产出几行），实际丢失窗口极短（`session-header-custom.md §3.4`）。

appendJsonlLine 不存在这个窗口——它是追加写，不碰已有内容。

## 8 插件不做什么：路径零接触

统一配置通道的设计意图之一，是让插件代码里没有任何路径字符串、没有任何 cwd 感知、没有任何放错层的判断。具体落点是：

- **不拼路径**。`ctx.config.set("key", value)` 不传路径——framework 按 pluginId 推导 `<cwd>/.my-harness-desktop/config/{pluginId}.json` 或 `~/.my-harness-desktop/config/{pluginId}.json`。
- **不感知 cwd**。`getProjectDir` 在 bootstrap 注入、ConfigStore 内部解析，插件侧看不到 cwd 值，也不知道当前有没有项目。
- **不选通道**。插件不需要知道 configFile 白名单、分层 fallback、锁机制——`ctx.config.get/set/all` 就是全部 API。
- **不碰安全门控**。路径由框架构造，插件侧没有任何字符串能影响落盘位置——路径逃逸的攻击面从"插件能传什么坏路径"变成"不存在"。

唯一的例外是写全局时要在 `set` 里传 `scope: "global"`——插件需要知道两层存在，才能声明自己的数据属于全局层。这不是"碰路径"，而是"声明归属层"——参数是抽象的层概念，不是路径字符串。

会话级同样是零路径接触：插件调 `ctx.sessions.updateHeader(sessionPath, { custom: { ... } })`——`sessionPath` 是从 `SessionInfo.path` 拿的已有值，不是插件自己拼出来的。

## 9 QA

**Q1：没有打开任何项目时，`ctx.config.set` 写到哪里？**

写全局。`getProjectDir` 返回 `null`，ConfigStore 自动落到全局文件。等用户打开项目后，这些 key 自然成为该项目的全局兜底。不需要"暂存区"或"待迁移"状态。

**Q2：项目级能删掉全局层已有的某个 key 吗？**

不能。key 级浅合并模型里，项目级只能覆盖 key 的值，不能表达"这个 key 在我这个项目里不存在"。需要"删条目"语义的配置，正确的设计是把条目放进一个 key（如数组），项目级整体替换这个 key——数组里有没有某个条目就是完整答案。

**Q3：插件原来用 `ctx.config` 的代码要改吗？**

不改。IPC 签名、`get/set/all` 三个方法全部不变，变的只是 ConfigStore 的 `projectDir` 从启动时注入的静态 `null` 改成动态 getter。已在用 `ctx.config` 的插件零改动获得项目级分层。唯一的例外是数据天然全局的插件（如 projects 的 `recentCwds`），要在 `set` 里补一个 `{ scope: "global" }`。

**Q4：会话头行的 `custom-my-harness-desktop.model` 域和 `ctx.config` 的关系是什么？**

没有关系。`custom-my-harness-desktop.model` 在会话文件头行里，跟着会话走；`ctx.config` 的项目级在 `<cwd>/.my-harness-desktop/config/{pluginId}.json`，跟着项目走。前者的消费者是 timeline（会话的模型/深度），后者的消费者是设置页（跨会话的配置项）。它们的共同点是"都不在全局层写死的 pref 里"——会话级和项目级各管各的。

**Q5：为什么不在白名单里直接放行 `<cwd>/.my-harness-desktop/`？**

白名单是固定前缀匹配，cwd 是运行时变量，放行任意 cwd 拼出来的路径等于放行任意目录。更重要的是模型不同：白名单通道是"插件传路径，框架校验"，统一通道是"框架推路径，插件不碰"——攻击面从"插件能传什么坏路径"变成"不存在"。

**Q6：data-root 分流（`.my-harness-desktop` vs `.my-harness-desktop-dev`）会影响会话文件和项目级配置吗？**

不影响。会话文件在 `~/.pi/agent/sessions/`（底座标准目录，不分流），项目级配置在 `<cwd>/.my-harness-desktop/config/`（跟着项目走，不分流）。分流只影响全局层 `~/.my-harness-desktop/` vs `~/.my-harness-desktop-dev/` 下的桌面数据（配置、偏好、安装的插件等）。

**Q7：手工编辑项目级 `.my-harness-desktop/config/tool-manager.json` 后，插件怎么感知变化？**

当前框架不监听 `.my-harness-desktop/` 下的文件变更。ConfigStore 的缓存每次读走 `loadEntry`，命中缓存就不读磁盘——外部编辑后旧缓存不会自动失效。如果用户手工改了文件，切到别的项目再切回来或重启应用会重新加载。如果需要实时感知外部编辑，那是未来的 `fs.watch` 增强，不在这套机制的范围。
