# 新会话启动包：两份任务的交接 prompt

本文是给**下一个会话**的启动材料。两条任务各自独立，可分别开会话，也可一个会话顺序做。每条给三样：精神说明（为什么做、判据是什么）、方案说明（做什么、落点在哪）、可直接粘贴的 prompt。

写作时的 main 基线：`363c2094` 之后（main 已被其他分支合并前进到 `353b58b7`，开工前重新对齐）。所有行号基于 `363c2094`，漂移后按符号名定位。

配套文档（先读它们，本文不重复内容）：

- `docs/design/stats-single-source.md` —— 统计单源的完整设计与论证（26986 汉字，三轮盲审收敛）
- `docs/design/bus-notification-defects-and-stats-handoff.md` —— bus 四缺陷的根因与修法（**已修复合入**）+ 统计交付物 1 的落点清单与七步执行清单（§3.5）

## 1. 任务 A：补缺陷 C 的 e2e 守卫（小，先做）

### 1.1 精神说明

bus 的缺陷 C 已修复（main `674329fc`）：`sendPromptTo` 曾无条件走 pi 专属扩展面，dsh 会话因此**静默收不到任何 bus 帧**（房间消息/任务注入/握手响应全丢，还被 `.catch(()=>{})` 伪装成"目标已死"）。修法是能力探测——有扩展面带 `streamingBehavior` 走扩展面，没有走契约中性 `sendMessage`。

已有验证：单元测试 6 条（含红绿验证——搬到修复前代码上 6 条全红，失败信息正是 bug 本身）、全量 1654 passed、typecheck/audit:deps/audit:quiet/build 全绿。

**缺口**：单测用的是 fake backend，证明了"分流逻辑正确"，没证明"真实 dsh 进程真能收到帧"。按 CLAUDE.md §5.6，涉及内核进程/真实发送的改动必须有 e2e。缺陷 C 是四个缺陷里唯一静默丢功能的，值得这条真实守卫。

判据（做到什么算完成）：一个 e2e 脚本，起真实 dsh 会话，经 bus 给它发一帧，断言它收到了（帧文本出现在该会话的消息流/落盘数据里），静默跑（不弹窗不抢焦点），可重复执行且清理测试数据。

### 1.2 方案说明

- 新建 `scripts/demo/bus-dsh-frame.e2e.mjs`，参考同目录 `dsh-round.e2e.mjs` / `dsh-multiturn.e2e.mjs` 的骨架（CDP 连接、隔离 HOME、清理）。
- 链路：app 起来 → 建/激活一个 dsh 会话 → 从另一个会话（或 bus op）向它 `channel_member join` 一个房间 → 往房间发一帧 chat → 断言 dsh 会话收到了（查它的落盘 entries 或经 `get_last_assistant_text` 不可行——收帧不是回复，应查帧注入：`sendPromptTo` 会把帧 JSON 注入目标会话的 prompt 流，落盘为 user 消息，查中立层 entries 里该会话出现 `"$bus"` 文本即可）。
- 修复前的对照：这个脚本在旧代码上应当失败（dsh 收不到帧）——如果时间允许，跑一次红绿对照，证据更硬。
- 静默：走 `scripts/demo/lib/quiet-env.mjs`（`MHD_WINDOW=hidden`），`npm run audit:quiet` 必须仍然 0 违规。
- 前置条件与 `session-store.dsh.integration.test.ts` 同款：dsh CLI + cordis.yml + API key，缺一跳过不伪造成功（`describe.skipIf` 同款逻辑，脚本里 exit 0 + 打印 skipped）。

### 1.3 可直接粘贴的 prompt

```
读 docs/design/bus-notification-defects-and-stats-handoff.md §2.1（缺陷 C）和本文档 §1，
然后补一条 e2e 守卫：新建 scripts/demo/bus-dsh-frame.e2e.mjs，起真实 dsh 会话、
经 bus 房间给它发一帧、断言它收到（帧 JSON 注入为 user 消息落进中立层 entries）。
参考 scripts/demo/dsh-round.e2e.mjs 的骨架与清理逻辑，走 quiet-env 静默跑，
前置缺失时跳过不伪造。走 worktree 闭环：建分支 → 写脚本 → npm run build →
node scripts/demo/bus-dsh-frame.e2e.mjs 跑通 → audit:quiet 全绿 → commit（四要素）→
合并回 main → 删自建 worktree。
```

## 2. 任务 B：统计单源交付物 1（大，主体工作）

### 2.1 精神说明

**问题**：统计功能对 pi 好用、对 dsh 全零——但数据不是缺的。实测 1130 个会话（pi 1063 / dsh 67），50 个 dsh 会话的中立层 entries 里带完整 usage（如 `{"input":158,"output":147,"cacheRead":8448,"cacheWrite":0,"cost":0,"totalTokens":8753}`），与 pi 的 usage 同一种形状、同一个解析函数（`messageUsageOf`）就能吃。根因是统计实现长在 pi 的专属路径上（`get_session_stats` RPC + `capabilities.extensions` 分流），中立层成为唯一真相源后没跟着抬上去。

**终态**：统计的真相源是壳的中立会话层。一个投影器（纯函数，`entries → SessionStats`）、一条代码路径，pi/dsh/minimal 无差别；内核统计接口从统计链路退役；中立契约变薄（删 `SessionCatalog.projectStats` / `contextProbeTokens` + `DSH_METHODS.sessionProjectStats`）。

**核心判据**（每个决策回到这三问）：

1. 投影器不认识 `KernelId`——switch 分支键是 `role`，不是内核。
2. 内核形状差在**适配器**抹平（dsh 补 `stopReason`/`startedAt`/接 `request/context`），不在投影器里加分支。
3. 缺数据 = `null`（诚实未知），不是 `0`（伪造）。`$0.00` 与"—"必须可区分。

### 2.2 方案说明

完整设计在 `stats-single-source.md`，落点与七步清单在交接文档 §3/§3.5。开工前必读：设计文档 §2（抽象）、§3.1（投影器）、§3.4（适配器补形状）、§7（落地切分，尤其 §7.2 为什么按读口切）；交接文档 §3.5（七步执行清单，每步标"改哪、验什么、绿了再下一步"）。

七步概要（细节在 §3.5）：

1. 圆心类型：cost 改可空 ×4 + `messageUsageOf` 加 `priced` 标志（**形状判据**：cost 是对象=真计价、数字=占位未知）+ `ModelInfo.cost?`
2. 投影器 `stats-projector.ts`（纯函数，复用圆心四算法）+ 实测 fixture 单测
3. turn-boundary 写穿（`agentSettled` 分支）+ header 摘要增量（挂 `appendNeutralEntryWithHeader`）
4. dsh 适配器补三处形状（`stopReason` / `startedAt` / `request/context` → `contextWindowChanged`）
5. 切 `getStats`（删 `:2448` throw 与 `:2450` extensions 分流）+ `openSession`（`stats: null` → 投影结果）
6. token-stats 渲染层跟进 cost 可空（`CostRow` null → 破折号）
7. e2e（G10：dsh 真实发一轮断言 tokens 非 0/上下文条非空/tps 有值）+ 静态守卫两条 + 文档同步（`kernel-parity-audit.md:82` 与 `token-stats.md` §6.4 两处 stale）

**两个必踩的坑**（盲审揪出的，不看文档一定踩）：

- 统计必须吃 `lineageContent`，**不能**吃 `neutralMessagesOfSession`——后者内含 `deduplicateAdjacent`，会把多条同内容的 turn-boundary 压成一条，turns 恒为 1。守卫 G12 专盯这条。
- turn-boundary 的隐藏靠 `display: false`（`isVisibleMessage` 只看这个字段），**不是** role 名单；但它**不能**加进 `STANDARD_ROLES`（会落入非标准 role 全量去重）。三处消费方机制各不相同：渲染=display 字段、AI 上下文=白名单未收录、克隆=全搬（正确，克隆体该有自己的 turns）。

**交付物边界**：交付物 1 只做上面七步（本会话读口）。项目总换 header 求和是交付物 2、dsh 计价补面是交付物 3、契约瘦身是交付物 4——按设计文档 §7.1 的表，一个 commit 一个交付物，每个自身完整。

### 2.3 可直接粘贴的 prompt

```
读 docs/design/stats-single-source.md 的 §2、§3.1、§3.4、§7，再读
docs/design/bus-notification-defects-and-stats-handoff.md 的 §3（尤其 §3.5 七步执行清单），
然后落地统计单源的交付物 1（七步全做完，一个 worktree 一个 commit）。
两个必踩的坑在交接文档 §3.2：统计吃 lineageContent 不吃 neutralMessagesOfSession（G12 守卫）；
turn-boundary 靠 display:false 隐藏、不进 STANDARD_ROLES。
fixture 必须从 ~/.my-harness-desktop-dev/sessions/*.entries.json 截真实数据（不手造）。
每步 typecheck + 相关 vitest 绿了再进下一步；最后 e2e 静默跑（quiet-env）+ audit:deps 全绿。
走 worktree 闭环：合并前对齐 main、合并后复验、删自建 worktree。
交付物 2/3/4 不在本次范围（见设计文档 §7.1）。
```

## 3. 顺序建议与注意事项

- **先 A 后 B**：A 小（一个脚本），且它是 B 的 e2e 基础设施的同款练习；B 大（七步），需要完整上下文预算。
- 两个任务都不碰对方文件，可并行开两个会话（各自 worktree，合并前对齐 main）。
- **别用 `session_create(watch:true)` + channels 批量派盲审子会话**——上一轮因此触发 289 帧刷屏事故（watch 单向门 + 房间回声环 + 每帧占一回合）。缺陷 A/B 已修复，但修复要**重启桌面端**才生效；重启前派子会话仍会踩旧行为。要派用 `spawn_subagent`（无 watch 单向门），盲审不加 channel。
- 桌面端如果还没重启过：重启一次，既加载 bus 修复，也清掉积压的通知队列。
