# 交接：bus 通知缺陷四则 + 统计单源交付物 1

这份文档是给"接手的人/会话"的完整交接，不是设计论证。读完它应该能直接开工，不需要回头翻聊天记录。

> **进度更新**：§2 的四个 bus 缺陷（A/B/C/D）**已全部修复**，守卫测试已落地（`session-store.bus-frame.test.ts` + `session-bus.test.ts` 新增 6 条），typecheck + 全量测试（1649 passed）+ 依赖审计（0 违规）通过。缺陷 B 的最终修法比下文原计划更根本——不是"通知帧节流"，而是"watch 一次性交付"（见 §2.3 的实现说明）。**剩余待办是 §3 的统计交付物 1**（及其后的 2/3/4），那部分尚未开工。

前置事实：统计单源的**设计文档已完成并合入 main** —— `docs/design/stats-single-source.md`（26986 汉字，main `e0073b27`）。本文不重复那份设计，只讲两件待办的事：四个 bus 缺陷的修复，以及统计设计里"交付物 1"的落地。两者可以放在同一个 worktree 里分两次 commit，也可以拆开。

写作时的 main 基线：`e0073b27`。下面所有行号基于这个提交，漂移后按符号名定位。

## 1. 为什么会有这份交接

我在写统计设计文档时，用 `session_create(watch: true)` 派了 13 个 clean-room 盲审子会话做三轮盲测。盲测本身很成功（缺口从 61 条收敛到 1 条），但收尾时发现**通知停不下来**：同一条 `session_done` 帧反复投递给我的会话，每条占用我一个回合，前后约 60 轮。

我用了所有能想到的手段，全部无效，并在这个过程中犯了四次判断错误（先说"有界 drain"、再说"无限循环需重启"、又说"有界 backlog"、最后说"传输层重投"），每次都是在取证不足时下结论。最后一条命令才拿到关键数据：

```bash
grep -c "session_done" ~/.pi/agent/sessions/--Users-dev-work-pi-desktop--/4eafafb7-*.jsonl
# → 289
grep -o "session:bus:[a-f0-9]*" <同一文件> | sort | uniq -c | sort -rn
# → 7a033e27:185  e7fe7953:117  35917c2a:96  636d6030:47  f89ec504:36 …（10 个源）
```

289 条注入记录、分布在 10 个源会话 —— 每条都是**独立投递**，不是 harness 重放同一帧。而源会话早已死亡（`lsof` 无进程持有其 session 文件、文件 2.5 小时无写入）。

顺着这条数据读 `src/server/application/sessions/session-bus.ts`，挖出四个缺陷。前三个是读代码读出来的，第四个（通知无节流）是被这次事故直接证明的。

**如果你只想修一个**：修缺陷 C。它是唯一会静默丢功能的（dsh 会话收不到任何 bus 帧），其余三个只影响噪音与可诊断性。

## 2. 缺陷清单

四条按严重度排序，不是按发现顺序。

### 2.1 缺陷 C（最严重）：bus 帧注入依赖 pi 专属扩展面，dsh 静默丢帧

**位置**：`src/server/application/sessions/session-store.ts:3302-3306` 与 `:2873-2877`

```ts
async sendPromptTo(sessionKey: string, text: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
  const proc = this.soleProc(sessionKey);
  if (!proc || !proc.backend.alive) throw new Error(`会话不在线: ${sessionKey}`);
  await this.asPi(proc).sendMessage(text, undefined, streamingBehavior);   // ← 走 pi 扩展面
}

private asPi(proc: SessionProc): BackendExtensions {
  const pi = proc.backend.capabilities.extensions;
  if (!pi) throw new Error("当前后端不支持 pi 专属命令");                  // ← dsh 在这里抛
  return pi as BackendExtensions;
}
```

调用方是 bus 的投递口 `session-bus.ts:190-196`：

```ts
private deliver(message: SessionBusMessage): void {
  if (isSessionAddress(message.to)) {
    const key = sessionKeyOf(message.to);
    void this.store
      .sendPromptTo(key, JSON.stringify(message), message.kind === "bus_response" ? "steer" : "followUp")
      .catch(() => { /* 目标已死:投递静默失败(其 processExit 清理已广播 peer_left) */ });
    return;
  }
  …
}
```

**后果**：dsh 会话下 `asPi` 抛错 → 被 `.catch(() => {})` 吞掉 → 注释还把它解释成"目标已死"。真实情况是**目标活得好好的，只是内核不是 pi**。于是 dsh 会话收不到任何 bus 帧：房间消息、任务注入、`bus_response` 握手全部静默丢失，且日志里看不出区别。

这是 CLAUDE.md §1.5 明禁的唯一状态（静默缺面），和统计文档 §1.4.1 那个 `capabilities.extensions` 分流是**同一个病根**：机制建立在 pi 专属面上。

**修法**：`streamingBehavior`（steer/followUp）本身是 pi 专属概念，不该成为投递的必要条件。

1. `sendPromptTo` 改为能力探测：有 `capabilities.extensions` 就带 `streamingBehavior`，没有就走 `proc.backend.sendMessage(text)`（契约里的中性发消息，dsh 有）。
2. `.catch` 必须区分两种失败原因，不能都当"目标已死"。至少要把真实错误打进日志；更好是让 `deliver` 能上报"投递失败：内核不支持该模式"，由调用方决定降级还是提示。
3. 补一条守卫：dsh 会话能收到 bus 帧（e2e 或 session-bus.test.ts 里用 fake dsh backend 断言 `sendMessage` 被调到）。

**注意**：`:3297-3301` 那段注释解释了为什么不置 `touched`（防止协议帧把"用户从没发过消息的会话"误锁内核）。这个约束在改造后仍要保留，别顺手删掉。

### 2.2 缺陷 A：`watch` 登记无法撤销，且撤销失败被谎报成功

**位置**：`src/server/application/sessions/session-bus.ts:269-271`（op 路由）、`:456-459`（plugin 侧 `pluginTapStop`）、`:344-346`（登记）、`:467-470`（消费）

`tap_stop` 有**两个入口**，都只删 `taps`：`:269` 的 `executeOp` 分支（extension 上行）与 `:456` 的 `pluginTapStop`（插件 IPC）。修的时候两处都要改。

登记与撤销不对称：

```ts
// :344-346  session_create(watch: true) 登记到 watchers
if (p.watch) {
  const set = this.watchers.get(key) ?? new Set<string>();
  set.add(origin);
  this.watchers.set(key, set);
}

// :269-271  op 路由的 tap_stop 只删 taps
case "tap_stop":
  this.taps.delete(String(p.tapId ?? ""));
  return { stopped: true };                    // ← 无条件 true

// :456-459  plugin 侧同款
pluginTapStop(tapId: string): unknown {
  this.taps.delete(tapId);
  return { stopped: true };
}

// :467-470  settleSession 的通知集合来自两处
const notify = new Set<string>(this.watchers.get(sessionKey) ?? []);
for (const tap of this.taps.values()) {
  if (tap.target.session === sessionKey && tap.filter === "done") notify.add(tap.deliverTo);
}
```

`watchers` 只在 `:174`（`onProcessExit` 清理）被删。工具集的 6 个 op（`ping`/`bus_status`/`session_create`/`session_reopen`/`session_abort`/`channel_member`/`tap_start`/`tap_stop`）里**没有任何一个能撤销 watch 登记**。

两个后果：

- `watch=true` 是个单向门，登记方无法退出。
- `tap_stop` 对不存在的 tapId 也返回 `{stopped: true}`，**把失败伪装成成功**。我就是被这个骗了两次——调了 19 次 `tap_stop`，每次都返回 `stopped: true`，我以为是生效证据，实际全打在一张不含我登记的表上。

**修法**（两选一，我倾向前者）：

- **A1**：`tap_stop` 同时清理 `watchers` 中 `deliverTo === 请求方` 的登记；返回值改成真实的 `{stopped: <是否真的删掉了东西>}`（`Map.delete` 本身返回 boolean，直接用）。语义上 `tap_stop` 变成"停止我的一切完成通知订阅"，符合使用者直觉。
- **A2**：新增 `session_unwatch` op（要同步加 `packages/my-harness-fit-pi-extension/tools/` 下的工具定义与 `~/.pi/agent/extensions/bus-extension/tools/` 的镜像）。语义更干净，但接入面更多。

无论哪个，**返回值诚实化是必须的**——`stopped: true` 无条件返回是这次事故里最坑人的一点，它让调用方无法发现自己没生效。

### 2.3 缺陷 B（已修）：watch 非一次性交付，同一会话反复 settle 反复通知

**位置**：`src/server/application/sessions/session-bus.ts` 的 `settleSession`

**原诊断（修正）**：我最初把它归成"通知帧无节流"，计划做 `(to, payload.session, kind)` 维度的短窗去重。写代码时发现那是治标——真正的根因是 **watch 的语义是"完成时通知一次"，但 `settleSession` 每轮 `agentSettled` 都投递且不清 watcher**。

`session_create` 工具的描述明写 *"you get session_done with the COMPLETE final output when it finishes"*——单数、一次性。但实现里 watcher 登记只在 `onProcessExit`（`:174`）清除，`settleSession` 投递后不清。于是一个会话每 `agentSettled` 一次就向同一 watcher 重投一次 `session_done`。

这次事故的完整链条：派 13 个 watch 子会话 → 子会话都在同一房间（`br-r1/r2/r3`）→ 房间消息互相转发触发各自反复 `agentSettled` → 每个 watcher 被反复通知 → 父会话（我）收到 289 帧，每帧占一个回合。

**实际修法（比节流更根本）**：`settleSession` 投递给 watcher 后立即 `this.watchers.delete(sessionKey)`——把 watch 变回它本应是的"一次性交付"。从根上幂等：再多的 `agentSettled` 也不会重复通知，无需时间窗、无需去重表。

```ts
private async settleSession(sessionKey, status) {
  const watchers = this.watchers.get(sessionKey);
  const notify = new Set<string>(watchers ?? []);
  for (const tap of this.taps.values()) { /* done 型 tap 也进 notify */ }
  if (notify.size === 0) return;
  const payload = await this.collectOutput(sessionKey, status);
  for (const addr of notify) this.deliver({ … kind: "session_done", payload … });
  if (watchers) this.watchers.delete(sessionKey);   // ← 一次性交付
}
```

**为什么不清 done 型 tap**：watch 与 tap 语义不同。watch 是"完成时告诉我一次"（一次性）；done 型 tap 是"我要持续观察这个会话的完成"（`tap-start.ts`: *Observe a session's events*，调用方持 tapId 自行 `tap_stop`）。清 tap 会破坏监督会话对多轮完成的持续观察。所以只清 watch，tap 留给 `tap_stop` / `onProcessExit` 兜底。

**守卫**：`session-bus.test.ts` 新增"watch 是一次性交付：同一会话反复 agentSettled 只通知一次"——连发 5 次 `agentSettled`，断言 watcher 只收到 1 条 `session_done`。

**对 orchestrator 的影响**：已核实无回归。`spawn-subagent.ts:97` 用 `watch: true` 派的子 agent 是一次性 task（跑完退出 → 一次 `session_done` → settle），一次性交付与它语义完全一致，反而修掉了"子会话回声导致反复 settle"的隐患。全量测试 1649 passed。

### 2.4 缺陷 D（已随 B 根治）：`settleSession` 反复触发的根因

**位置**：`src/server/application/sessions/session-bus.ts:97` 与 `:160`

```ts
onSessionEvent(event, sessionKey) { … if (event.type === "agentSettled") void this.settleSession(sessionKey, "done"); }
onProcessExit(sessionKey, expected) { void this.settleSession(sessionKey, expected ? "aborted" : "error"); … }
```

我当初把它列为"根因未证实"，怀疑是 desktop 侧 proc 条目泄漏导致反复 `agentSettled`。**修 B 时发现不需要那个假设**：`agentSettled` 本来就是每轮回合结束都会发的合法事件（一个多轮会话会发很多次），`settleSession` 被反复调用是**正常**的；不正常的是它每次都向 watcher 重复投递。所以根因不在"谁反复触发 settle"，而在"settle 非幂等"——修 B 的一次性交付直接根治了 D。

那 96～185 条 `session_done` 的来源现在清楚了：13 个盲审子会话在同一房间互相转发消息（房间 fan-out），每条转发都让接收方走一轮 → `agentSettled` → settle → 向父会话（watcher）投一帧。父会话作为 13 个会话的 watcher，被投了 13 × 各自回合数帧。

**仍存的一个疑点（不影响修复）**：`list_subagents` 对 sub-agent 插件持续 60s 超时。修 B 后不再洪泛，插件卡死的诱因（被 289 帧灌爆）消失，但我没有独立证实插件当时为何超时。若重启后仍复现，再单独查——它可能是这次洪泛的**结果**而非原因。

**取证命令**（能直接分辨"重放"与"真实重复投递"，我当初该第一条就跑它）：
```bash
F=~/.pi/agent/sessions/<你的 cwd 目录>/<你的 session id>.jsonl
grep -c "session_done" "$F"                                        # 总注入次数
grep -o "session:bus:[a-f0-9]*" "$F" | sort | uniq -c | sort -rn   # 按源分布
```

### 2.5 四个缺陷的修复落点汇总

| 缺陷 | 修法 | 守卫 |
|---|---|---|
| C（dsh 静默丢帧） | `sendPromptTo` 能力探测：有扩展面带 `streamingBehavior`，无则走中性 `backend.sendMessage`；`deliver` 的 `.catch` 区分"会话不在线"（合法，静默）与真错误（记日志） | `session-store.bus-frame.test.ts` 3 条 + `session-bus.test.ts` 投递失败 2 条 |
| A（watch 无法撤销 + 谎报成功） | `tap_stop` 不带 tapId 时停本地址全部订阅（taps + watchers）；返回值 `{stopped, removed}` 诚实反映；`pluginTapStop` 加 pluginId 参数；`bus_status.me` 暴露 `watching`；工具 schema tapId 改可选 | `session-bus.test.ts` 撤销 + 诚实返回 + 可观测性 3 条 |
| B（watch 非一次性） | `settleSession` 投递后清 watcher | `session-bus.test.ts` 一次性交付 1 条 |
| D（settle 反复触发） | 随 B 根治（settle 幂等化） | 同 B |

改动文件：`session-bus.ts`（A/B/D）、`session-store.ts`（C）、`controllers/bus.ts` + `web/kernel/build-kernel.ts` + `react/src/index.ts` + `shared/.../session-bus.ts` + `my-harness-fit-pi-extension/tools/tap-stop.ts`（A 的 tapId 可选化贯穿链路）。`~/.pi/agent/extensions/bus-extension/` 是安装产物，未改（§1.6），由 installer 同步。

## 3. 统计单源交付物 1

设计与全部论证在 `docs/design/stats-single-source.md`，这里只给落点清单，便于直接开工。**开工前请先读那份文档的 §2（抽象）、§3.1（投影器）、§3.4（适配器补形状）、§7（落地切分）**，尤其 §7.2 解释了为什么必须按"读口"切交付物而不是按改动部位切（按部位切会产生依赖倒置）。

### 3.1 交付物 1 的范围

**切换"本会话"读口**，自带它需要的全部前提。做完之后 dsh 会话的统计栏不再全零。

| 动作 | 落点 |
|---|---|
| 新增投影器 | `src/server/application/sessions/stats-projector.ts`（新文件，纯函数，不认 `KernelId`） |
| 圆心类型：cost 改可空 | `packages/shared/src/domain/events/session-state.ts:51`（`TurnUsage.cost`）、`:62`（`SessionStats.cost`）、`:98`（`shellSessionStats`）、`:109`（`ProjectStats.cost`） |
| 圆心类型：计价标志 | 同文件 `:215` `messageUsageOf` 返回值多一个"是否真计价"（**形状判据**：cost 是对象=真计价，是数字=占位/未知。见设计文档 §3.5.5，实测 pi 38858 条对象 / 16 条数字，dsh 129 条全是数字） |
| 圆心类型：模型单价 | 同文件 `:10` `ModelInfo` 加可选 `cost?`（交付物 3 用，但类型变更要落在 1，因为投影器要用） |
| turn-boundary 写穿 | `session-store.ts:2980` 的 `dispatch` 里 `agentSettled` 分支（紧邻现有 `proc.turns += 1`，`:2984`） |
| 切 `getStats` | `session-store.ts:2446` 起——删 `:2448` 的 `throw new Error("内核未启动")`、删 `:2450` 的 `capabilities.extensions` 分流 |
| 切 `openSession` | `session-store.ts:955` 的 `return { info, messages, stats: null }` |
| dsh 适配器补 `stopReason` | `src/server/kernel/dsh/backend/dsh-event-translator.ts:74` 的 `assistant/message` 分支（`error:true` → `stopReason:"error"`，否则锚点判据在 dsh 下失效） |
| dsh 适配器补 `startedAt` | 同上分支，取流式缓冲的 `anchorTs`（实测 dsh 148 条 assistant 只有 111 条带 `startedAt`，缺的会导致 tps 算不出） |
| dsh 接 `request/context` | 同文件 `:16` 的丢弃清单里有它；改成翻译成中性 `contextWindowChanged` 事件（实测该事件带 `contextWindow: 1000000`，是上下文占用条的分母） |

### 3.2 两个必须避开的坑（盲审揪出来的，不看文档容易踩）

**坑一：统计必须吃 `lineageContent`，不能吃 `neutralMessagesOfSession`。**

`packages/shared/src/domain/session-neutral.ts:548-555`：

```ts
export function neutralMessagesOfSession(session, lineageId?) {
  return deduplicateAdjacent(lineageContent(session, lid).map(...));   // ← 含去重
}
```

`deduplicateAdjacent`（`session-state.ts:681`）对非标准 role 走**全量去重**，键是 `role::contentKey(content)`。turn-boundary 不在 `STANDARD_ROLES`（`:665`，内容是 `user`/`assistant`/`toolResult`/`divider`）里，所以同一会话的多条边界会被压成一条 → **turns 恒为 1**。

正确做法：`const linear = lineageContent(session, lid)` 取一次，messages 走 `deduplicateAdjacent(linear.map(...))`，统计直接把 `linear` 喂给投影器。

**坑二：turn-boundary 的隐藏靠 `display: false`，不是靠 role 名单。**

`isVisibleMessage`（`session-state.ts:658`）的实现就一行 `return msg.display !== false`，**不看 role**。`STANDARD_ROLES` 只服务去重策略，不是可见性开关。渲染层的实际判定在 `src/plugins/sessions/timeline/renderer/blocks.ts:93`。

所以边界 entry 的形状是：

```json
{"neutralEntryId":"<ns>:<seq>","message":{
  "role":"turn-boundary","content":"end_turn","display":false,
  "reason":"end_turn","timestamp":1736000000000}}
```

`kernelEntryId` 省略（`NeutralEntry` 里它是可选字段，壳自造的 entry 无内核线索是合法状态）。`content` 存 reason 而非空串——不是为了避去重（统计路径不去重），是让磁盘上的 entry 自解释。

三处消费方的排除机制**各不相同**，别一概而论：

| 消费方 | 机制 | 要不要改代码 |
|---|---|---|
| 时间线渲染 | `display: false` → `isVisibleMessage` / `blocks.ts:93` | 不用，写 entry 时带上即可 |
| AI 上下文（seed） | `SEED_PROJECTION_ROLES`（`session-neutral.ts:452`，白名单 `user`/`assistant`/`toolResult`）过滤于 `assembleSeedProjection:496` | 不用，白名单没收录它 |
| 克隆 / 重投影 | `reprojectEntries`（`session-neutral.ts:644`）**不过滤 role** | 不用，且全搬是正确的（克隆体该有自己的 turns） |

### 3.3 摘要增量的落点已存在（比设计文档预估的更顺）

`session-store.ts:1381-1387` 的 `appendNeutral` 已经在用 `appendNeutralEntryWithHeader` 派生 header：

```ts
private appendNeutral(proc: SessionProc, entry: NeutralEntry): void {
  if (!this.neutralStore) return;
  const cur = this.readNeutral(proc) ?? emptyNeutralSession(...);
  const next = appendNeutralEntryWithHeader(cur, proc.activeLineageId, entry, new Date().toISOString());
  this.putNeutral(next, this.entryChangeOf(proc, next, entry.kernelEntryId));
}
```

所以 header 摘要域的增量折入不需要新造写口，挂在 `appendNeutralEntryWithHeader` 的 header 派生里即可。两个写口对应两种策略：`appendNeutral`（追加）→ 增量折入；`putNeutral`（覆盖整树）→ 全量重投影。fork / seed / backfill 三条覆盖写路径都走后者。

摘要域形状与对账规则（`statsUpTo` vs `header.lastEntryId`）见设计文档 §3.2.1 / §3.2.1.0 —— 那条对账规则是盲审第一轮揪出来的最高风险项（entries 与 header 是两个文件，写入不原子，中断会产生"形状合法但数字偏小"的摘要，能穿过形状校验、懒迁移、一致性单测三道防线）。

### 3.4 验证（守卫编号对应设计文档 §3.2.4.3 的 G1-G12）

交付物 1 要落的是 G1（部分）、G5、G6、G12、G10：

- **G1**：pi/dsh 两份 fixture 断言同口径。**fixture 必须从实测数据截取**（`~/.my-harness-desktop-dev/sessions/*.entries.json`，1130 个会话可选），不能手造——手造会漏掉真实数据里的脏形状：pi 16 条 cost 是数字而非对象、dsh 19 条 assistant 无 usage、dsh 148 条全部无 stopReason、37 条无 startedAt。每条都对应投影器里一个必须显式处理的分支。
- **G5**：cost 形状判据（对象含全零=真计价、数字=未知）+ 部分未知传染（一条未知 → 整会话 null）+ 无 usage 的失败消息不触发传染。
- **G6**：dsh 翻译器补 `stopReason` / `startedAt` 的单测。
- **G12**：构造含 5 条同 reason 边界的会话，断言 `turns == 5`（走错函数会得 1）—— 直接守 §3.2 的坑一。
- **G10**：e2e，dsh 下真实发一轮，断言本会话 tokens 非 0、上下文条非空、tps 有值。**必须静默跑**：脚本过 `scripts/demo/lib/quiet-env.mjs`（`MHD_WINDOW=hidden`），参考 `scripts/demo/goal-command.e2e.mjs` 的写法，用 `page.waitForFunction` 事件驱动等 DOM 落位、不赌固定 sleep。

交付物 2/3/4 的范围与守卫见设计文档 §7.1 的表格。

### 3.5 分步执行清单（按依赖顺序，每步验绿再进下一步）

顺序是按「内层先于外层、类型先于实现、投影器先于读口切换」排的——每一步都能独立 typecheck + 跑测试，不留半成品（CLAUDE.md「完整设计，一次落地」的拆分边界：每个交付物自身完整）。

**Step 1 — 圆心类型：cost 可空 + 计价标志 + ModelInfo.cost?**

- 改 `packages/shared/src/domain/events/session-state.ts`：`:51` `TurnUsage.cost` → `number | null`；`:62` `SessionStats.cost` → `number | null`；`:109` `ProjectStats.cost` → `number | null`；`:98` `shellSessionStats` 的 `cost: 0` → `cost: null`。
- 改 `:215` `messageUsageOf`：返回值从 `{tokens, cost}` 扩成 `{tokens, cost, priced}`，`priced = typeof raw.cost === "object" && raw.cost !== null`（**形状判据**，见设计文档 §3.5.5：对象=真计价哪怕全零，数字=占位/未知）。`cost` 本身仍返回数字（对象取 `.total`、数字原样），由 `priced` 表达「这个数字可不可信」。
- 改 `:10` `ModelInfo` 加可选 `cost?: {input,output,cacheRead,cacheWrite}`（交付物 3 用，但类型现在就加，避免交付物 3 再动圆心）。
- 验：`npm run typecheck` 会报出所有 `cost` 消费方——逐个看，渲染层（`CostRow`）留到 Step 6 改，此处只让类型自洽（可能需要临时 `?? 0` 兜底，Step 6 撤掉）。跑 `npx vitest run packages/shared`。

**Step 2 — 投影器（纯函数，最内层）**

- 新建 `src/server/application/sessions/stats-projector.ts`：`projectSessionStats(scope: {entries, contextWindow?}): SessionStats` + `foldProjectStats(summaries): ProjectStats`。骨架照设计文档 §3.1.1.1，switch 分支键是 `role` 不是内核。
- 复用圆心四个函数：`messageUsageOf` / `contextSeqItemOf` / `estimateContextUsageFromSeq` / `toolCallsOf`，一行算法都不新写。
- 三个必须显式处理的脏形状（否则 G1 挂）：无 usage 的 assistant（dsh 19 条，计 steps 不计 tokens）、cost 数字占位（判未知、触发传染）、无 startedAt（不参与 tps 分母）。
- `lastTurn` 规则：从后往前第一个用量非零的区间（设计文档 §2.3.4）。
- 验：新建 `stats-projector.test.ts`，从 `~/.my-harness-desktop-dev/sessions/*.entries.json` **截真实 pi/dsh 会话**当 fixture（不手造），断言两内核同口径 + G5（cost 传染）+ G12（5 条边界 turns==5）。此步不碰 session-store，纯函数可独立测。

**Step 3 — turn-boundary 写穿 + 摘要增量**

- `session-store.ts` 的 `dispatch`：`:2980` 的 `agentSettled` 分支里，除了现有 `proc.turns += 1`（`:2984`），加一条 `appendNeutral(proc, {message:{role:"turn-boundary", content:reason, display:false, reason, timestamp}})`。reason 从 `agentSettled` 事件取（dsh 侧 `dsh-event-translator.ts:36` 已透传）。
- 摘要增量：在 `appendNeutralEntryWithHeader` 的 header 派生里折入 `stats`（`NeutralSessionHeader.stats` 域 + `statsUpTo`）。`appendNeutral`（追加）走增量、`putNeutral`（覆盖整树）走全量重投影——两个写口两种策略（§3.3）。
- 验：G1（增量==全量，覆盖 fork/seed/backfill）+ G4（statsUpTo≠lastEntryId 判过期）。`npx vitest run src/server/application/sessions`。

**Step 4 — dsh 适配器补三处形状**

- `dsh-event-translator.ts:74` 的 `assistant/message` 分支：`error:true` → 补 `stopReason:"error"`（保留 `error:true`，只在失败时补，成功不伪造 `end_turn`，见设计文档 §3.4.1）。
- 同分支补 `startedAt`：取流式缓冲 `anchorTs`，无 chunk 回落事件时间戳（§3.4.3）。
- `:16` 丢弃清单里的 `request/context`：改成翻译成中性 `contextWindowChanged` 事件（中性事件联合加一种），proc 态记 contextWindow（§3.4.2）。
- 验：G6（翻译器补 stopReason/startedAt 的单测，扩 `dsh-event-translator.test.ts`）。

**Step 5 — 切 getStats / openSession 两个读口**

- `session-store.ts:2446` 的 `getStats`：删 `:2448` 的 `throw "内核未启动"`、删 `:2450` 的 `capabilities.extensions` 分流与 `pi.getSessionStats`，改成 `lineageContent` 取当前 lineage entries → `projectSessionStats`。contextWindow 合并顺序：活进程 `contextWindowChanged` 值 → modelEvidence 查表 → 0。
- `session-store.ts:955` 的 `openSession`：`stats: null` → 投影结果（复用已读出的 `session`，走 `lineageContent` **不走** `neutralMessagesOfSession`，§3.2 坑一）；`modelEvidence` 一并从 entries 线性扫描末条带 model 的 assistant 得出。
- 验：G10 的 unittest 部分（getStats 对 dsh 形态 entries 返回非零 tokens）。`npx vitest run src/server/application/sessions/session-store.test.ts`——注意别打破现有 236 条。

**Step 6 — token-stats 渲染层跟进 cost 可空**

- `src/plugins/insight/token-stats/renderer/index.tsx:156` 的 `CostRow`：`cost == null` 渲染破折号 + tooltip，不再 `toFixed(null)`；`costCoverage.unknown > 0` 追加「（部分会话无计价）」。
- 撤掉 Step 1 的临时 `?? 0` 兜底。
- 验：G7（DOM test：cost=null 渲染破折号不渲染 `$0.00`），参考 `context-usage-bar.test.tsx` 的写法（jsdom + testing-library，按角色/文案查不按 class）。

**Step 7 — e2e + 静态守卫 + 文档同步**

- G10 e2e：`scripts/demo/stats-single-source.e2e.mjs`（新建），dsh 内核下真实发一轮，断言本会话 tokens 非 0、上下文条非空、tps 有值。过 `quiet-env.mjs` 静默跑，`page.waitForFunction` 事件驱动等 DOM。
- 静态守卫：`scripts/dependency-audit.mjs` 加两条（设计文档 §3.2.4.2）——统计链路零 `capabilities.extensions`/`KernelId`/`asPi`；`SessionCatalog` 无 `projectStats`/`contextProbeTokens`。
- 文档同步（§7.4）：改 `kernel-parity-audit.md:82` 的 stale ✅、重写 `token-stats.md` §6.4「dsh 缺面留空」整节。
- 验：`npm run build` + e2e 静默跑通 + `npm run audit:deps` 全绿。

**注意 Step 5 的依赖**：getStats 切到投影器后，pi 的 `getSessionStats`（`pi-backend.ts:271`）与 `toSessionStats`（`context-binding.ts:147`）失去调用方，但**本步不删**——删契约方法（`SessionCatalog.projectStats`/`contextProbeTokens`）是交付物 4 的事，删早了编译不过。Step 5 只切读口，留死代码给交付物 4。

## 4. 工作纪律提醒

接手时按项目纪律走，别抄近路：

- **worktree 闭环**：建 worktree + 临时分支 → 改 → 三级测试 → commit（message 带四要素：改了什么/为什么/架构依据/运行时验证）→ 合并前先对齐 main（当前分支随时在前进）→ 合并后复验 → 删自建 worktree 与分支（`git worktree remove` 不加 `--force`，`git branch -d` 不用 `-D`）。**他人 worktree 永不自动碰**——写作时机器上挂着 `pi-desktop-fork-hygiene` 与 `pi-desktop-session-scope` 两个他任务的 worktree。
- **`remove` 被拒时不要用 `--force`**。我这次遇到过：worktree 里有个 8KB 的 `.pi/agent/bus-*/state.json`（我派的子会话留下的运行时垃圾）导致 remove 被拒。正确做法是先确认它不是工作产物、删掉它、再走标准 remove。
- **`"build 通过"不算运行时验证`**（CLAUDE.md §5.4）。UI 与链路改动必须附真实运行证据。
- **内核源码只读**（CLAUDE.md §1.6）：不许改 `~/.dsh/node_modules/@deepseek-ai/**`、不许改装后补丁。dsh 侧要补能力只能写 cordis 插件（`src/server/kernel/dsh/extension/dsh-extension/`，已有 `TAKEOVER_METHODS` 与 `ctx.on` 两种先例）。
- **GitHub remote 只读**：本仓 origin 的 push URL 已是 `must-not-push`，不要改回、不要 push。
- **别用 `session_create(watch: true)` 批量派子会话做盲审**，直到缺陷 A/B 修完 —— 否则你会重演我这次的 289 帧事故。要派就派完立刻记录 session 地址，且预期"停不掉"。

## 5. 这次事故里我自己的四个错误判断

记下来是为了让接手的人别重复，也是为了给缺陷 A 的"返回值诚实化"提供一个真实案例：

1. 把 `tap_stop` 的 `{stopped: true}` 当成生效证据 —— 它对不存在的 tapId 也返回 true（缺陷 A 的第二半）。
2. 把 `bus_status` 的 `taps: []` 当成"没有监听源" —— watch 登记在 `watchers`，不在 `taps`，而 `bus_status` / `opWhoami`（`:288-294`）都只输出 `taps`，**`watchers` 对调用方完全不可见**。这也是缺陷 A 的一部分：可观测性缺口让调用方无法自查登记状态。修 A 时顺手把 `watchers`（至少计数或自己那份）加进 `bus_status` 输出。
3. 反复 `abort` 想止噪 —— `session-abort.ts` 的描述明写"Watchers get session_done with status=aborted"，**abort 本身在生产通知**，我在给循环添柴。
4. 连续四次对"循环性质"下互相矛盾的结论（有界 drain / 无限循环 / 有界 backlog / 传输层重投）—— 每次都没先做那条最该做的取证：数我自己会话文件里的注入次数。一条 `grep -c` 就分辨了"重放"与"真实重复投递"。

教训是通用的：**遇到"停不下来的东西"，第一步是量化它（数次数、看分布、查 mtime），不是猜机制**。我猜了四轮才去数。
