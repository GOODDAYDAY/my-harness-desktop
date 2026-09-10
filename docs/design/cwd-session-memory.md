# 切项目保留会话状态：项目级"上次看的会话"记忆

## 1 问题

左栏点一个项目，切过去永远是一个**新会话**——哪怕刚才还在那个项目里读某个会话、翻到一半、正打算接着看，切走再切回就回到了空白新会话。浏览上下文（在看哪个会话）没有任何地方被记住。

根因在 `projects` 插件的 `switchCwd`（旧实现）：

```ts
setCurrentCwd(dir);
setCurrentSessionPath(null);        // 清
setCurrentNeutralSessionId(null);   // 清
setSessionTitle(null);              // 清
await useSessionStore.getState().startNewChat(dir);   // 永远新会话
```

"切走时把一切清掉 + 起新会话"是无条件写死的：既没有"记住我刚才在看哪个会话"，也没有"切回来时恢复它"。同一段"清三连 + startNewChat"序列在 `⌘N` 与 `sessions-list.newSession` 里还各抄了一份（§3.3 判别气味三）。

## 2 设计

### 2.1 一句话

**壳记住"每个项目上次看的会话"，切项目与冷启动都恢复它；没有记录或记录失效才退回新会话。**

### 2.2 记忆是什么、存在哪

- **形状**：`prefs.lastSessionByCwd: Record<cwd, sessionId>`——键是项目目录，值是会话标识（**中立主键 `neutralSessionId` 优先**，老会话没有 ns 时回落投影路径 `path`；`openSession` 本身双形态归一，两种都收）。
- **位置**：桌面偏好 `prefs`（`config.json`），与 `lastCwd` 同域。三个理由：
  1. 它是**导航状态**（"我上次导航到哪"），与 `lastCwd` 同类，不是某个插件的业务内容；
  2. 恢复动作要能被**冷启动**（`app-main`）和**切项目**（`projects` 插件）共用，而 `app-main` 读不到插件私有配置；
  3. 壳读插件 config 是反向依赖（§1.1）：机制（切项目/恢复）在壳，值（哪个项目）也不该藏在插件私有区。
- **不进多端同步白名单**（`SYNCED_PREF_KEYS`）：导航状态各端独立，与 `lastCwd`/`sidebarWidth` 同款处理。

### 2.3 写入时机：打开成功那一刻，不是切走那一刻

两处写穿（都在壳里）：

| 时机 | 位置 | 写什么 |
|---|---|---|
| 成功打开一个会话 | `session-store.openSession` 拿到 detail 之后 | `rememberSessionForCwd(detail.info.cwd, ns ?? path)` |
| 新会话物化（首条消息落盘 → `sessionStart` 水合） | `session-store.hydrateSessionStart` | `rememberSessionForCwd(currentCwd, ns ?? sessionFile)` |

两条铁律：

- **`startNewChat` 绝不写 null**。否则冷启动那一次 `startNewChat(lastCwd)` 会把刚恢复的记忆清成空——记忆自毁。
- **不能只在"切走时"记**。那样冷启动恢复拿到的是"上次切出的那个会话"，而不是"退出时真正打开的那个"，与用户实际看到的画面不符。

### 2.4 读取与恢复：两个壳动作

```ts
// session-store.ts
restoreForCwd(cwd)   // 该项目上次的会话:有记忆且 openSession 成功 → 打开它;否则 startNewChat(cwd)
switchCwd(cwd)       // 左栏项目行的唯一入口:幂等守卫 → setCurrentCwd → restoreForCwd → bumpSession
```

- `restoreForCwd`：**恢复是锦上添花，不是必经步骤**。`openSession` 返回 false（会话读不出来）或抛错（内容损坏）都退到新会话壳，并留一条 `console.warn`——一句坏记忆不许把切项目或冷启动打断。
- `switchCwd`：`cwd === currentCwd` 直接返回（点当前已激活的项目 = 幂等 no-op；旧行为是"重开一个新会话"，在新语义下等于无意义地丢掉当前会话）。
- 两个消费者：`projects` 插件（切项目）与 `app-main` 冷启动。**同一个入口，语义不漂**——否则会出现"冷启动给新会话、切走再切回才恢复"的不一致。
- 冷启动那一次必须 `await`（不能像旧代码那样 `void`）：恢复要读会话文件并把基线写进 store，而渲染闸门在 `hydrateP` 之后才 `initSessionStore()`（事件订阅 + 中立层镜像基线），抢跑会丢那一份基线。5s 的 `Promise.race` 仍是兜底上限。

### 2.5 顺带收口：会话上下文三连

`currentSessionPath` / `currentNeutralSessionId` / `sessionTitle` 这组清理此前在四处各写一遍（`projects.switchCwd`、`projects.removeCwd`、`⌘N`、`sessions-list.newSession`）。现在只有两处实现：

- `useUiStore.clearSessionContext()`——壳提供的唯一三连清理动作；
- `startNewChat` 内部调它（新会话必然清三连），于是 `⌘N` 与 `newSession` 各自缩成一行。

## 3 行为对照

| 场景 | 行为 |
|---|---|
| 首次访问某项目 | 无记忆 → 新会话壳（与旧行为一致） |
| 切回访问过的项目 | 恢复该项目最近打开/物化的那个会话（ns 主键） |
| 记忆指向的会话不可读（被删/损坏/读盘失败） | 退新会话壳 + `console.warn`，不打断操作 |
| 新会话里切走再切回 | 恢复到上一个**真实**会话（离开时的空会话壳不算状态；草稿仍在 `new:<cwd>` 键下，按 `+`/⌘N 可见） |
| 删掉项目再加回来 | 记忆不删 → 直接恢复上次会话 |
| 点当前已激活项目 | 幂等 no-op（**行为变更**：旧行为是重开新会话） |
| 冷启动 | 恢复 `lastCwd` 项目上次看的会话（**行为变更**：旧行为永远新会话） |
| 项目目录被移动/改名 | 已知边界，不设守卫：记忆按 cwd 键自洽（记录时就在那个 cwd 里打开），此时路径本身已失效，`openSession` 的失败兜底会退成新会话 |

## 4 为什么不这么做

- **不记在 `projects` 插件 config**：冷启动读不到；壳动作依赖插件私有数据是反向依赖；导航状态与 `lastCwd` 拆成两处存储会漂。
- **不做"离开瞬间状态"（含未发送的空会话壳）**：那需要"写 null"参与记忆，而 null 参与后冷启动那次 `startNewChat` 与恢复路径会互相覆盖（顺序耦合）；且空会话壳没有可恢复的实体（零 RPC、未落盘），"恢复一个空壳"与"起一个新会话"在观感上等价。代价是本项目新会话里的草稿切回来不自动显形（草稿按 `new:<cwd>` 键存在内存里，按 `+` 即见）。
- **不把恢复逻辑写在插件里**：`openSession` 不是裸 RPC——按序 `setContext(cwd, path)`、水合 path/ns/title、失败回滚、`markRead` 都在壳侧（`sessions-list.select` 那一套）。插件手抄一份必然漂移，且冷启动那条路径根本调不到插件。插件侧现在只剩一行：`await useSessionStore.getState().switchCwd(dir)`。

## 5 验证

- **unittest**（`src/web/stores/session-store.test.ts`）：无记忆→新会话 / 有记忆可开→恢复（ns/path/title 一起回来）/ 记忆失效→退新会话 / 记忆读取抛错→退新会话（不打断）/ 点当前项目幂等 / 打开成功写穿记忆（ns 优先、老会话回落 path）/ `startNewChat` 不覆盖记忆 / `sessionStart` 水合补记 / `startNewChat` 清三连。
- **e2e**（`scripts/demo/cwd-session-restore.e2e.mjs`，真实产物 + 隔离 HOME，零 token）：真实点击串 A→B→A 恢复各自的会话、点当前项目幂等、真冷启动（杀进程重启）恢复、悬空记忆退新会话且 app 仍可用、页面零报错。
