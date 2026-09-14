# dsh SDK server 方法面补全：不赌上游发版，方法面由自己的插件保证

> Version: v1 | Date: 2026-09-14 | 状态：**已实施**
>
> 姊妹文档：`dsh-capability-gate.md`（探测/降级机制）、`dsh-fit-extension.md`（补面单一落点）、
> `seed-wire-alignment.md`（seed 的 wire 形状）、`dsh-sdk-server-supplement.md`（给上游的交接规格，
> 本文是它在「上游迟迟不发版」现实下的本仓自足解）。

## 1 问题

用户症状：goal 续跑发送失败，会话流里出现注解卡「续跑发送失败，目标已自动暂停：dsh 内核版本过旧,缺少 session/seed 方法(请升级 dsh 内核)」。

三段链路：goal 插件续跑发送（`goal-controller.ts` `firePrompt`）→ 壳后端惰性物化 lineage（`session-store.ts` `materializeActiveLineage`，dsh 进程新起、内存空空，首发前必须把中立历史灌进去）→ `DshBackend.seed` 发 `session/seed` → dsh 运行时回 `unknown DeepSeek Harness SDK runtime method: session/seed` → 懒探测记缺面 → 转成 `missingMethodError`（`dsh-backend.ts`）→ goal 有界重试 3 次同样失败 → 暂停 + 留痕。

目标暂停本身是对的（不让目标条亮着 active 实际停摆）。错的是诊断和建议：**"版本过旧"与"请升级"两条都是假的**。

## 2 根因（实测钉死，不是猜）

### 2.1 npm 上发布的 SDK server 只有 3 个 request 方法

对 registry 直接 `npm pack` 验证：

```
@deepseek-ai/dsh-sdk-jsonrpc-server@0.1.1-rc.2  → handleRequest: initialize / session/prompt / shutdown
@deepseek-ai/dsh-sdk-jsonrpc-server@0.1.5-rc.2  → 同上（distTag next，当前最新）
```

而桌面 `DshBackend` + `DshSessionCatalog` 实际调用 **16 个** request 方法（见 §3 清单）。也就是说：**上游 master 的 server.ts 有 18+ 个方法，但一个都没发出来**——`dsh-capability-gate.md` §1 记录的"npm next 停在 0.1.1-rc.2、只有 3 个方法"这个事实，到今天（0.1.5-rc.2）依然成立。这不是"版本旧"，是**发布节奏与方法面长期不同步**。

### 2.2 "升级"是死路

`DSH_SPEC.distTag = "next"` → 装到的就是 0.1.5-rc.2 → 依然只有 3 个方法。用户照着错误提示升级，只会重装一次、再撞一次同样的错。

### 2.3 版本号根本不是可靠指标

装机目录里曾有一份 27 KB 的 `dsh-sdk-jsonrpc-server/lib/index.js`（20 个方法），`package.json` 版本号与 9.6 KB 瘦版**完全相同**（都写 `0.1.1-rc.2`）。前者是上游源码本地 `tsc` 构建的产物（`lib/` 下有 `tsconfig.tsbuildinfo` + `*.js.map` + `lib/types/*.js`，发布 tarball 的 `files` 白名单只含 `.d.ts`，绝无这些）。**同一个版本号对应两套完全不同的方法面**——任何基于版本号的门槛都是假门槛，这与 `dsh-capability-gate.md` §3「版本号比对这条路走不通」的结论一致，且现在有了第二重证据。

### 2.4 关键发现：缺的只是"方法暴露层"，core 能力全在

逐包 md5 对比 npm rc.2 与本地构建产物：

| 包 | 对比 | 说明 |
|---|---|---|
| `dsh-agent` / `dsh-agent-loop` / `dsh-llm` / `dsh-scope` / `dsh-attachment` / `dsh-goal` / `dsh-session-persistence` / `dsh-subagent` / `dsh-sdk-protocol` | **逐字节相同** | core 能力面一致 |
| `dsh-session` | 差一个方法 | npm 版缺 `SessionStore.delete(id)` |
| `dsh-session-persistence-jsonl` | 差一个方法 | npm 版缺 backend `delete(id)` |
| `dsh-sdk-jsonrpc-server` | **9.6 KB vs 27.7 KB** | 唯一的大缺口：方法暴露层 |

**结论：桌面缺的从来不是"dsh 的能力"，而是"把能力暴露成 JSON-RPC 方法"的那一层壳。** 而这一层恰好落在 cordis 插件能接管的位置——`HarnessSdkJsonRpcServer.prototype.handleRequest` 是一个普通类方法，插件 patch 它即可加方法。本仓的 `my-harness-fit-dsh-extension` **早就在这么干**：`session/setModel` 原地热切、`session/getThinkingLevels`、`session/setThinkingLevel` 三个方法都是插件补的，不是运行时给的（`dsh-thinking-level.md`）。

所以这次不是"要不要用插件补方法"的架构选择——**架构选择三个月前就做了并且验证过了**，这次只是把补面范围从 3 个方法扩到全部 16 个，让"方法面由谁保证"这件事彻底从上游发版节奏里解耦。

### 2.5 更深一层：双副本陷阱（既有补面其实也一直是坏的）

排查过程中用探针插件实测出一个**比"上游没发版"更严重的问题**：

```json
{ "resolved": [
    { "via": "bare",  "url": "~/.dsh/node_modules/.../dsh-sdk-jsonrpc-server/lib/index.js",                  "patched": true  },
    { "via": "argv1", "url": "~/.my-harness-desktop/dsh/node_modules/.../dsh-sdk-jsonrpc-server/lib/index.js", "patched": false } ],
  "same": false }
```

- 插件 `import "@deepseek-ai/dsh-sdk-jsonrpc-server"` 走**插件自己所在目录**的解析链：
  `~/.dsh/node_modules` → 实测它是一个**符号链接**，指向 `~/.my-harness-desktop-dev/dsh/node_modules`（开发数据根）。
- CLI 运行时用的是**它自己所在安装目录**那份：`~/.my-harness-desktop/dsh/node_modules`（生产数据根）。
- `same: false` —— 两个不同的 `HarnessSdkJsonRpcServer` 类对象。

后果：**patch 打在 A 副本、实际服务请求的是 B 副本 → 所有补面静默失效**。不只 `session/seed`，
连"已实施"三个月的 `session/setModel` 热切、`session/getThinkingLevels`、`session/setThinkingLevel`、
`session/meta` 事件类型补面**全都是坏的**——而症状表现为「dsh 内核版本过旧，缺少 session/seed」，
一个把排查方向彻底带偏的诊断（谁会去怀疑"插件 patch 打错了副本"？）。

实测复现（瘦版 CLI + 生产 cordis.yml）：`session/getThinkingLevels` 返回
`unknown DeepSeek Harness SDK runtime method` —— 这条方法在 `dsh-thinking-level.md` 里标着
"已实施 + 有运行时证据"。证据是真的，只是那次验证跑在 `~/.my-harness-desktop-dev` 数据根上
（两侧同源，patch 生效）；换到生产数据根就失效了。**环境差异导致的"验证时好、装机后坏"**。

正解（§4.2 落地）：一切对 dsh 内核包的取用都从 `process.argv[1]`（CLI 入口）出发做 node 解析
——那才是实际服务请求的运行时闭包；并且 patch **覆盖全部副本**（bare + runtime，去重后逐个幂等 patch），
因为插件加载期无法预知哪个副本会服务请求。

## 3 实测确认的能力底座（补面可行性证据）

用瘦版 npm 运行时（`~/.my-harness-desktop/dsh`，只有 3 个方法）起真实进程，挂一个探针 cordis 插件实测：

| 探针项 | 结果 |
|---|---|
| `ctx.get("sessions")` / `agents` / `sessionPersistence` / `llm` | **全部可用**（插件 `inject = []` 时用 `ctx.get` 取，绕开 cordis 的 inject 限制） |
| `ctx.get("attachments")` / `ctx.get("goals")` | **MISSING**（spine 未挂载）→ 见 §5 降级处置 |
| `agents.create({ sessionId, seed, meta, agentOptions })` | **支持 seed**：6 个 seed 事件建会话 → `deriveMessages()` 忠实回放出 user/assistant 两条 |
| `sessions.fork(source, boundary)` | **可用**，子会话 header 带 `parentSession: "p3"` + `seedLength: 6`（inclusive boundary 5 → 6） |
| `persistence.list()` | **可用**，返回 header 列表，子会话 header 含 `parentSession`/`seedLength` |
| `persistence.listArtifacts()` | **可用**，返回 `{ header, path }` → delete 的落点 |
| `sessions.delete` / `persistence.delete` | **不存在**（npm 版）→ 自行实现：`handle.dispose()` + `rm(artifact.path)`（实测 dispose 后 `sessions.get` = GONE、rm 后 `list()` 里该 id 消失） |
| `agent.cancel` / `agent.followup` / `agent.steer` | **可用** → abort 的落点 |
| `session.append("session/meta", {meta})` | **可用**，事件正常广播 → rename/updateHeader 的落点 |
| `handle.dispose()` | 同时 detach session + agent（`session/disposed` + `agent/disposed`） |

一条都没猜——每行都是探针进程的 JSON-RPC 返回值。

## 4 设计

### 4.1 落点与结构

```
src/server/kernel/dsh/extension/dsh-extension/
  index.mjs          # 既有：ask / goal 工具 / CLAUDE.md 注入 / skill 轴 / 强语义接管
  sdk-methods.mjs    # 新增：SDK server 方法面补全（本设计的承载体）
  extension.json     # 描述更新
```

拆文件的理由（高内聚）：`index.mjs` 已 718 行，承载四块既有能力；方法面补全是**独立的第五块**（它补的是协议层，其余四块补的是工具/钩子层），单独一个文件让"这块能力 = 这个文件"，也让 §4.2 的静态守卫可以只扫它。同步走现成 `syncFitDshExtension`（`cpSync` 整目录 → 多文件天然支持，cordis 只 import 入口 `index.mjs`，内部相对 import 走 node ESM 解析，实测通过）。

`sdk-methods.mjs` 同时承担 §2.5 双副本陷阱的正解：导出 `resolveRuntimeModule(pkg)`（从
`process.argv[1]` 出发解析运行时闭包里的那份，解析不到回落 bare import）、
`resolveServerClasses()`（返回去重后的**全部** `HarnessSdkJsonRpcServer` 副本）、
`resolveRuntimeHelpers()`（`SessionId` / `createUserMessage` / `createAssistantMessage` /
`installModelSelection` / `KNOWN_SESSION_EVENT_TYPES` 一律取运行时闭包那份）。
`index.mjs` 里既有的 bare import（`HarnessSdkJsonRpcServer` / `installModelSelection` /
`KNOWN_SESSION_EVENT_TYPES`）全部改为经这三个函数取——**这是把既有三块补面从"静默失效"里救回来的关键**，
不只是为新增方法服务。

### 4.2 单一 patch 点：一张方法表，不叠 patch

既有 `index.mjs` 在模块顶层 patch 了一次 `handleRequest`。若新文件再 patch 一次，就出现**两个 patch 互相包裹**——顺序依赖、错误归属难查（谁的 `orig` 是谁）。所以收敛成：

```js
// sdk-methods.mjs
export function installSdkMethodSupplement(handlers) { /* 幂等：只 patch 一次，表驱动分派 */ }
export const SDK_METHOD_SUPPLEMENT = { "session/seed": seed, "session/getTree": getTree, … };

// index.mjs（一次 install，一张表）
installSdkMethodSupplement({
  ...SDK_METHOD_SUPPLEMENT,      // 补缺：原生没有的
  "session/setModel": hotSwap,   // 接管：语义严格强于原生（既有）
  "session/getThinkingLevels": …, "session/setThinkingLevel": …,
});
```

分派规则：表里有 → 走表；表里没有 → 交回原生 `handleRequest`（原生抛 unknown-method 就照常抛，壳的懒探测/降级纪律不变）。**不吞原生方法、不改原生语义**，只加、只接管被明确声明的那几条。

### 4.3 方法面清单（16 条，逐条对齐桌面 TS 侧的期望形状）

| 方法 | 桌面调用方 | 补面实现 | 依据 |
|---|---|---|---|
| `session/seed` | `DshBackend.seed` | `agents.create({sessionId, seed: entriesToSeedEvents(...)})`，返回 `{sessionId}` | 实测 §3；事件重建照胖版 `entriesToSeedEvents`（turn/start→step/start→user/message→assistant/message→step/end→turn/end），`toolResult` 跳过（忠实工具环重建是上游 follow-up，本次不扩范围） |
| `session/getTree` | `DshBackend.getTree`、`DshSessionCatalog.getTree` | 由 `persistence.list()` 的 `parentSession`/`seedLength` 反查建 lineage 树 | **优于胖版**：胖版靠构造期监听 `session/created` 攒 `childIndex`，patch 场景下 server 已构造完 → 攒不到；且重启即丢。走持久化 header 反查，跨进程可重建 |
| `session/getEntries` | `DshBackend.getEntries` | `sessions.get(SessionId).deriveMessages()` → `{id, role, content}` | 实测回放正确 |
| `session/bookmark` | `DshBackend.bookmark` | 校验 lineage 存在（live 或 persisted），返回 `{lineageId, boundary}` | 坐标书签，无副本 |
| `session/resume` | `DshBackend.resume` | live 直接 `fork`；不 live 先 `agents.resume({resumeSessionId})` 再 fork | 比胖版稳健（胖版要求 live，重开历史会话点书签会 unknown session） |
| `session/deleteBookmark` | `DshBackend.deleteBookmark` | no-op `{}` | 坐标书签无物可回收 |
| `session/abort` | `DshBackend.abort` | `record.handle.agent.cancel({kind:"user"})`；unknown session = no-op | "空闲时 abort 无害"契约 |
| `session/rename` | `DshBackend.setSessionName`、`DshSessionCatalog.renameSession` | `session.append("session/meta", {meta:{name}})` | 实测事件正常广播 |
| `session/updateHeader` | `DshSessionCatalog.updateSession` | 同上，`meta: patch` | 桌面自有元数据（pinned/archived/custom） |
| `session/get` | `DshSessionCatalog.readCustom` | `{info:{path,id,cwd,created,modified,name?,pinned?,archived?,custom?}, messages}`；unknown → `null`（不是错误） | meta 折叠取最后一次写 |
| `session/list` | 目录（`DSH_METHODS.sessionList` 已声明） | `persistence.list()` → 列表投影 | 无 persistence 插件 → `[]` |
| `session/delete` | `DshSessionCatalog.deleteSessions` | live: `handle.dispose()`；durable: `listArtifacts()` 定位 → `rm(path)` + 尝试删空目录 | npm 版无 `sessions.delete`/`persistence.delete`，实测该组合等效 |
| `session/projectStats` | `DshSessionCatalog.projectStats` | 遍历 cwd 下 persisted sessions，累加 `assistant/message` 的 `usage.*` + 数 `user/message`；cost 恒 0 | dsh 无成本核算 |
| `session/setModel` | `DshBackend.setModel` | **既有**（`installModelSelection` 原地热切） | `model-switching.md` §11.1 |
| `session/getThinkingLevels` / `session/setThinkingLevel` | `DshBackend` 同名方法 | **既有** | `dsh-thinking-level.md` |

不补的（明确不扩范围）：`session/continue`（桌面已用"中立层内容灌给内核"替代，`session-store.ts:2060` 注释）、`session/fork`（fork 归壳，§7 内核是单线执行器；`resume` 内部用 `sessions.fork` 但不必暴露 RPC）、`session/title`（是通知不是 request）。

### 4.4 两个真缺口的显式降级（不静默、不伪造）

| 缺口 | 后果 | 处置 |
|---|---|---|
| `ctx.attachments` MISSING | 瘦版 `session/prompt` 只读 `contentBlocks`，桌面 `sendMessage(text, images)` 传的 `images` 会被**静默丢弃** | **接管 `session/prompt`**：有 images 且 `ctx.get("attachments")` 不可用 → 显式抛错（"该 dsh 运行时未挂载 attachment 服务，图片附件不支持"），绝不静默丢图。无 images 时原样交回原生 |
| `ctx.goals` MISSING | 胖版 `session/continue` 的 goal 重臂分支不可用 | 不补 `session/continue`（§4.3 已排除）；桌面的 goal 走自己的文件侧车（`get_goal`/`create_goal`/`update_goal` 三工具），不依赖 dsh 的 goal 服务，无实际缺口 |

### 4.5 错误文案：从假诊断改诚实诊断

`dsh-backend.ts` 的 `missingMethodError` 原文案「dsh 内核版本过旧,缺少 X 方法(请升级 dsh 内核)」两处不实（版本不一定旧、升级一定没用）。改为：

> `dsh 运行时不提供 X 方法（该版本 SDK server 方法面缺此能力，且桌面适配插件未补齐；升级 npm 版本无法解决）`

补面落地后这条错误在正常路径上不会再出现（16 个方法全有），它退化成真正的"异常兜底"——插件没装上、或用户手改了 cordis.yml 摘掉了我们的块。文案诚实描述这个状态，不给错误的行动建议。

### 4.6 接管判据与退役条件（不预支上游）

- **补缺类**（seed/getTree/…）：原生若长出同方法，**原生优先**——表驱动分派前先问原生。判据用行为探测（§2.3 已证明版本号不可信）：`installSdkMethodSupplement` 时对原生 `handleRequest` 发一次探针不可行（需要实例），改为**在分派时惰性判定**：表项标 `preferNative: true` 的方法，首次命中时先试原生、原生抛 unknown-method 才走补面，判定结果缓存进表（每进程一次）。
- **接管类**（setModel/thinkingLevel）：语义严格强于原生（原地热切 vs dispose+resume），**不做原生优先**——沿用既有决策，等上游长出 in-place 热切再退役。

## 5 守卫（§3.7：没有守卫的修复只是"这次对了"）

| 层 | 文件 | 守什么 |
|---|---|---|
| **unittest（纯逻辑）** | `dsh-extension/sdk-methods.test.ts` | `entriesToSeedEvents` 的事件重建（user 开 turn、assistant 闭 turn、toolResult 跳过、seq 单调、末条未闭合自动收尾）——从 `.mjs` 抽出的纯函数，不碰 dsh |
| **静态守卫** | `dsh-extension/dsh-sdk-method-coverage.test.ts` | 扫 `sdk-methods.mjs` 的方法表 ∪ `index.mjs` 的接管项，与「桌面 TS 侧实际调用的 `DSH_METHODS` 集合」对账：**桌面每调一个方法，补面表必须有它**。防止将来加一个 `DSH_METHODS.x` 却忘了补（正是本次 bug 的形态） |
| **e2e（真机，瘦版运行时）** | `dsh-extension/dsh-sdk-supplement.integration.test.ts` | 起真实**瘦版** dsh 进程（原生 3 方法）+ 本仓插件源码（`cpSync` 到临时目录、`node_modules` 符号链接到瘦版安装目录 → 隔离、不碰用户 `~/.dsh`）→ 12 条用例逐条打通 16 个方法（seed/getEntries/getTree/bookmark/resume/rename+updateHeader+get 的 meta merge/list/projectStats/abort/setModel/getThinkingLevels/delete/带图 prompt 显式报错）。**不花真 token**（全是本地操作），可常态跑。反向验证：把 `installSdkMethodSupplement` 破坏成空转 → 11/12 失败，证明它真能抓到补面失效 |
| **e2e（真机，需 API key）** | `dsh-backend.integration.test.ts` | 既有 seed 转录用例：**删掉 `if (missing) return` 的静默跳过**（补面后缺面 = 真 bug，跳过会掩盖回归） |
| **DOM 交互** | 既有 `goal-note-card.test.tsx` | `send_failed` 注解卡的呈现路径不变（本次不改 UI） |

## 6 为什么不是别的路

- **不是"等上游发版"**：三个月了没发（0.1.1-rc.2 → 0.1.5-rc.2 方法面零增长）。把用户的核心链路（发送）吊在上游发布节奏上，是把控制权交出去。
- **不是"改内核源码"**：§1.6 红线，三个形态（外部仓库 / 已装包 / 装后补丁）一律禁止。本方案动的是**我们自己的 cordis 插件**，落在 `~/.dsh/.my-harness-desktop-plugins/`（marker 目录），碰不到内核本体。
- **不是"把胖版产物拷进安装目录"**：那是手改已装包（§1.6 形态 2），下次 `KernelManager.install` 的 `prepareInstallDir` 会 `rm -rf node_modules` 整体冲掉——正是本次事故的重现路径。
- **不是"降低中立契约的要求"**：`seed` 是 `BaseBackend` 的 14 条 abstract 之一（跨内核切换投影的地基）。为了让瘦 dsh 跑通而把 seed 变成可选，等于让契约迁就某个内核的发布状态——违反 §1.5「内核先抽象、后实现」。
- **不是"在壳侧造影子实现"**（自己写 dsh 会话文件）：违反 §3.1「消费而非翻译」，且壳不读内核存储是 §7.5 不变量。

## 7 验收

1. 瘦版 npm 运行时（`~/.my-harness-desktop/dsh`，原生 3 方法）+ 本插件 → §4.3 的 16 个方法逐条有响应。
2. goal 续跑在 dsh 会话上跑通：不再出现「缺少 session/seed」、不再自动暂停。
3. 跨内核切换 pi → dsh（有真实历史）走通 seed 投影，dsh 侧 `getEntries` 能回放。
4. 图片附件在瘦版 dsh 上**显式报错**，不静默丢图。
5. 双副本被覆盖：探针实测 `resolveServerClasses()` 返回的每个副本的 `handleRequest` 都已带补面（生产数据根 + 开发数据根两种环境都验）。
6. `npm run audit:deps` 十检验全绿；新增三个测试文件全绿（25 + 6 + 12）；`npx vitest run` 全绿。

## 8 QA

**Q：为什么 `session/meta` 事件类型补面也要改成运行时闭包解析？它不是 patch，只是 `Set.add`。**
A：同一个陷阱的另一种形态。`KNOWN_SESSION_EVENT_TYPES` 是模块级 `Set`——bare import 拿到的是 A 副本的 Set，
coordinator 校验时读的是 B 副本的 Set，`add` 在 A 上对 B 毫无作用。实测正是如此（`same: false`）。
凡是"模块级可变状态"或"类原型"，跨副本都不共享，一律必须取运行时闭包那份。

**Q：既然双副本是根因，为什么不干脆让 CLI 和插件解析到同一份 node_modules？**
A：那是环境层面的巧合，不是设计。生产数据根（`~/.my-harness-desktop/dsh`）与 `~/.dsh/node_modules`
符号链接指向开发数据根，是本机历史遗留（`~/.dsh` 曾是手工摆产物的地方）。换一台机器、
或用户没做过这个符号链接，两侧本来就是两份。补面代码必须在**任意拓扑下都正确**——
所以正解是"解析运行时闭包 + patch 全部副本"，而不是"要求环境恰好同源"。

**Q：`getTree` 的 fork 关系为什么要显式 `flush`？**
A：实测抓到：`sessions.fork` 之后不 flush，子会话 header（`parentSession` / `seedLength`）
还留在 write-behind 队列里没落盘，而 `getTree` 是从 `persistence.list()` 的 header 反查建树的
→ 只返回根 lineage，fork 关系丢失。补 flush 后实测两条 lineage 都在，且
`fork.parentLineageId` 正确。同理 seed / rename / updateHeader 也都 flush——
持久元数据不能赌 write-behind 的定时器（进程可能在 flush 前就死）。

**Q：`session/get` 的 meta 折叠为什么是 merge 而不是上游的 last-write-wins？**
A：实测抓到 bug：桌面把元数据拆成两个独立写口分别调——`rename` 只写 `{name}`、
`updateHeader` 只写 `{pinned, archived, custom}`（`DshSessionCatalog` 两个方法）。
上游 `latestMeta` 是"取最后一个 meta 事件"，last-wins 下先 rename 再 pin → **name 被抹掉**。
patch 语义本就是部分更新，故 merge。这条在单测与真机 e2e 里都钉了断言。

**Q：补面这么多方法，等于把上游 server.ts 抄一遍，维护成本怎么算？**
A：不是抄，是**用 dsh 自己的公开 core API（`ctx.agents`/`ctx.sessions`/`ctx.sessionPersistence`）实现协议层**——这些 API 在 npm rc.2 与本地构建版逐字节相同，是稳定面。抄的只是"方法名 → 调哪个 core API"的映射，约 300 行。上游哪天真发了全量方法面，`preferNative` 判据让补面自动让位（§4.6），文件可整块删。

**Q：patch 原型方法不会和其他插件冲突吗？**
A：会，如果两处都 patch。所以 §4.2 收敛成**单一 patch 点 + 一张表**，本仓内所有 dsh SDK 方法面（补缺 + 接管）都经 `installSdkMethodSupplement` 注册，不存在第二个 patcher。第三方插件若也 patch，那是它的问题（cordis 插件树里谁后加载谁包外层，语义可预期）。

**Q：`getTree` 改成从 persistence 反查，和胖版的 childIndex 结果会不一致吗？**
A：胖版的 `childIndex` 只在**当前进程内** fork 过的会话上有条目，进程重启即丢；persistence 反查读的是持久化 header 的 `parentSession`，**跨重启完整**。两者对本进程内 fork 的会话结果一致（实测子会话 header 就带 `parentSession`），对历史 fork 则反查更全。这是修正，不是偏差。

**Q：seed 跳过 `toolResult` 会丢历史吗？**
A：丢的是"工具调用的往返细节"，不丢对话连续性——`entriesToSeedEvents` 上游注释明写这是有意的 follow-up（忠实工具环重建需要配对 `tool/call`/`tool/result`）。跨内核切换要的是"模型知道之前聊了什么"，user/assistant 两条足够。保持与上游同口径，不自行加戏。

**Q：`session/delete` 自己 `rm` 文件，绕过 dsh 的持久化协调器安全吗？**
A：分两步且顺序有意义——先 `handle.dispose()`（让 write-behind 队列 flush 完、live store detach），再 `rm` artifact。实测 dispose 后 `sessions.get` = GONE、rm 后 `persistence.list()` 里该 id 消失，无残留状态。上游胖版的 `persistence.delete` 实现也就是 `rm(artifact.path, {force:true})`，语义相同。

**Q：为什么图片附件是抛错而不是降级成纯文本发送？**
A：静默丢图 = 伪造成功（用户以为图发出去了，模型没看到）。这是 §1.5 明令禁止的"静默缺面"。显式抛错让用户知道"dsh 这边发不了图"，可以选择换 pi 内核或去掉图片——处置权在人。
