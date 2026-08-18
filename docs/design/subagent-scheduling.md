# 子agent 插件设计

> **修订记录**：
>
> **2026-08-05 插件化转向**：本文首版是"子agent 进程调度设计"，设想 custom 信封专用协议 + 框架六缺口待补。此后框架两轮演进把地基全换了，本次按代码现状整体重写：
>
> 1. **通信底座由 Session Bus 接管（已落地）**——首版 §2 的 `type:"custom"` 专用信封协议废弃。实证发现 pi 的 `RpcCommand` 是封闭联合，"desktop 往 pi stdin 写自定义 JSON"这条路根本不存在；bus 用现存通道拼出了双向回路（下行 prompt+streamingBehavior、上行 stdout `$bus` 帧、input 钩子 handled/transform 拼请求-响应），且把"subagent 调度"泛化为"会话间 IM"。通信细节本文不再重复，见 `docs/design/session-bus.md`。
> 2. **实现形态定为纯插件串联**——bus 是平的世界（地址+路由，不管父子），subagent 缺的是有向关系层（归属、任务契约、生命周期从属、资源闸）。这层不归 bus 管，也不进内核，由 **sub-agent 桌面插件**（renderer，归属编排）+ **subagent-extension**（pi 侧，tool 注册与帧收发）串联既有基础设施实现。内核、bus、rpc-adapter、preload 零改动。
> 3. **框架缺口全部闭环**——首版 §7 审出的六缺口：二（entry 渲染）由 `messageRenderers` 槽填平、五（`HeaderPatch.custom`）已落地、六（`appendJsonlLine`）已落地、一（sessions-list 分组）由 `sessionGroupings` 声明式槽填平、三（composer 条件渲染）由 `composerPolicies` 槽填平、四（desktop↔pi 双向通道）以 bus 形态落地。本文不再审缺口，只写插件怎么消费这些机制。
> 4. **spawn 升级为场景搭建（同日二修）**——两个反馈的落地：其一，**等待模式（同步/异步）在发起时由 `wait` 参数声明**——调用方在派活那一刻就知道"后面的推理依不依赖这个结果"，等待是派活意图的一部分，不是事后补救；其二，**一轮 tool 调用搭出完整编排场景**——`tasks` 数组支持批量 fan-out、`channel` 参数拉作战室，沿用 bus 的"一轮闭环"底线（`session-bus.md` §5：不许三连才能开干）。
>
> **2026-08-08 对话范式转向（本次）**：模型从"任务中心"升级为"任务 + 可对话"。驱动是实证反馈（用户无法与子会话对话只能拉新的、子进度不可见、卡片刷屏、输出被截断）：
>
> 5. **Q4 决策推翻：用户可经对话面板直接与子会话对话**——原文"用户直接输入会产生指令冲突"是过度防御。用户是父 agent 的主人，用户与子协作不是冲突是最终所有权；协调手段（followUp 排队不打断、bus 帧、tap stream）设计里全有，只是没接到 UI。详见新增 §6.5。
> 6. **完成交付分层**："不转中间流"对 agent 接收方保持（上下文保护），但用户交付物（面板/卡片展开/文件）**全量、零截断**——采集本就是全量，截断只应发生在"给 agent 的帧"（见 §7.2 修订与 session-bus.md §4.3 修订）。
> 7. **展示层默认收起**：spawn/done 卡片折叠成一行（Q7 的"可观测性"保留但降噪），展开看详情，状态面板升级为对话入口。
> 8. **spawn 并行化**：§3.1 第 2 步实现修订——批量 spawn 改 Promise.all 并行（此前 for-await 串行，N 个子 = N 倍冷启动）。
> 9. **生命周期补全**：idle 进程回收（§3.6）、reopen 进程纪律（§6.5 生命周期纪律段）、重启恢复改为懒扫重建账本（§3.4 修订）。
>
> 首版仍成立的论证（独立进程的四条工程理由、tool 差异原则、展示三件套设计）保留在对应章节并更新到插件范式。agent 能力面收敛为 **5 个 tool，每个单独一章**（§5.1–§5.5）。

## 1. 定位：物理平等，关系有向

### 1.1 session 是对话，subagent 是任务

subagent 和普通会话在物理层是同一种东西——都是 `pi --mode rpc` 独立进程，经同一个 `spawnSession` 起、同一套 `RpcAdapter` 绑、同一条 stdin→SIGTERM→SIGKILL 停。崩溃隔离、独立 session 文件、独立 tool 配置、独立生命周期（首版 §1.2 的四条理由）在 bus 时代原样成立。

差异在关系层，一句话：**对话是平的，任务是有向的**——

| 维度 | 普通 session | subagent |
|---|---|---|
| 所有者 | 用户 | 父 agent 的一次 tool 调用 |
| 存在理由 | 开放式对话，无"完成"概念 | 完成具体 task，产出 result 交付父 |
| 生命周期 | 用户开用户关，独立 | 从属：父 abort 它该 abort，父崩溃它该被收尸 |
| 上下文关系 | 自成一体 | 父上下文的"外包片段"——父只留一张卡片 |
| UI 地位 | 顶层公民 | 缩进在父下、输入框灰色 |
| 并发治理 | 不需要（人开几个心里有数） | 需要（LLM fan-out 会失控，闸是防 LLM 的） |

bus 的"subagent 退化为纯用法"（`session-bus.md` §7.4）对通信层成立，对关系层不成立。准确事实：`spawn_subagent = session_create + watch`（bus 已给）**+ 归属持久化 + 父死子清 + 资源闸 + spawn entry 落盘**（关系层，本文的全部内容）。

### 1.2 三层架构

```
┌─ 展示层 ─ 三槽纯消费（机制已就绪，插件只声明）────────────────┐
│  messageRenderers: spawn 卡片（role=subagent_spawned/done）  │
│  sessionGroupings: 左侧栏按 custom.subagent 缩进嵌套          │
│  composerPolicies: 子会话视图灰输入框                         │
├─ 归属编排层 ─ sub-agent 桌面插件（本文主角）─────────────────┤
│  spawn 七步编排 / 父子映射 / 资源闸 / 父死子清 / 完成转发      │
├─ 传输层 ─ Session Bus（已落地，不管父子，一行不改）─────────┤
│  地址 + 路由 + tap + 房间 + 完成采集（agentSettled→输出）      │
└──────────────────────────────────────────────────────────────┘
```

### 1.3 编排者为什么住 renderer 插件

my-harness-desktop 的 main 侧没有插件机制，renderer 插件是"内容"的唯一合法载体（VSCode 扩展同构：扩展跑在 extension host，经 API 驱动内核）。subagent 是内容不是机制，所以归属层住 renderer 插件——依赖方向始终是插件→IPC→main，不违反洋葱。编排的关键路径可靠性由"常驻组件"保证（§7.2 风险一）。

## 2. 通信：bus 帧私域约定

不发明协议、不改 bus。subagent 的流量全部走 bus 既有路由，只约定一组私域 kind。

### 2.1 链路全景

```mermaid
sequenceDiagram
    participant Agent as 父 agent (pi)
    participant Ext as subagent-extension (父 pi 进程内)
    participant Bus as bus 路由器 (main)
    participant Plugin as sub-agent 插件 (renderer)
    participant Sub as 子 agent (pi)

    Agent->>Ext: 调 spawn_subagent tool
    Ext->>Bus: stdout $bus {to:"plugin:sub-agent", kind:"spawn_subagent", id, payload}
    Bus->>Plugin: session:bus IPC 广播(plugin 地址)
    Plugin->>Bus: bus.sessionCreate({cwd, toolConfig, watch:true})
    Bus->>Sub: spawnSession + prompt(task)
    Plugin->>Plugin: 写子头行 custom.subagent / 追加父 spawn entry / tap 父 / 起超时
    Plugin->>Bus: bus.send(父地址, "bus_response", {subagent, spawn_entry_id}, replyTo=id)
    Bus->>Ext: stdin prompt 注入(steer)
    Ext->>Ext: input 钩子吞帧 resolve → tool 返回(dispatched)
    Note over Sub: 子独立执行,父不阻塞
    Sub-->>Bus: agentSettled
    Bus->>Plugin: session_done(watch 登记=插件;含完整输出)
    Plugin->>Plugin: 写子头行 status / 追加父 done entry
    Plugin->>Bus: bus.send(父地址, "subagent_done", {subagent, status, output})
    Bus->>Ext: stdin prompt 注入(followUp)
    Ext->>Agent: input 钩子 transform 人话化进上下文
```

### 2.2 私域 kind 约定

bus 的 `kind` 是开放字符串，路由器不解释。subagent 私域如下（契约单源：subagent-extension 与 sub-agent 插件共用同一份字面量）：

| kind | 方向 | 语义 | 响应 |
|---|---|---|---|
| `subagent_ping` | extension → 插件 | 探测插件在线（session_start 时） | `bus_response` |
| `spawn_subagent` | extension → 插件 | 派活请求 | `bus_response`（replyTo 配对） |
| `list_subagents` | extension → 插件 | 查我的子 agent 全景 | `bus_response` |
| `wait_subagent` | extension → 插件 | 补等一个子到终态 | `bus_response`（延迟回） |
| `send_to_subagent` | extension → 插件 | 父对子追加指令 | `bus_response` |
| `abort_subagent` | extension → 插件 | 中止子 | `bus_response` |
| `subagent_done` | 插件 → 父 extension | 子完成异步通知（done/error/aborted/timeout） | 无（事件帧） |
| `subagent_note` | 插件 → 子会话 | 父追加指令的转发投递 | 无（事件帧） |

上行帧 `to: "plugin:sub-agent"`，路由器经 `session:bus` IPC 广播进 renderer；下行响应 `kind: "bus_response"` + `replyTo` 配对，复用 extension input 钩子的吞帧机制（`session-bus.md` §2.3），同步 tool 语义零新机制。事件帧经 input 钩子 transform 人话化进 agent 上下文。

**from 认证**：插件收到的上行帧 from 已被路由器覆写为发送方 session 地址（`session-bus.md` §3.2），插件据此校验"子的 parent 必须等于请求方"——伪造在传输层已失效。插件发出的帧 from 恒为 `plugin:sub-agent`（pluginSend 覆写），子的地址放 payload 里。

### 2.3 等待模式：发起时声明

调用方在派活那一刻就知道"我后面的推理依不依赖这个结果"——所以**同步/异步是 spawn 的 `wait` 参数，不是一个单独的动作**：

- **`wait: false`（缺省）= 异步**：立即返回 `dispatched` 回执，父 agent 继续推理；每个子完成时 `subagent_done` 事件帧携带完整输出到达（bus 完成通知模型：一次性交付，不转中间流——`session-bus.md` §4）。
- **`wait: true` = 同步**：tool 调用挂起直到本批全部子到达终态，一次性返回全部结果。fork-join 一轮完成。

首版的 spawn 是纯同步语义，bus 范式初稿把它改成了纯异步——两个极端都不对：等待模式是派活意图的一部分，该由调用方在发起时选。`wait_subagent`（§5.3）只保留"发起时选了异步、事后发现需要汇总"的补等场景。

## 3. 编排：spawn 七步与生命周期

### 3.1 spawn 编排七步

插件的 `bus.onMessage` 收到 `spawn_subagent` 帧后执行。`tasks` 是数组，下列步骤对**整批**生效（单个任务就是长度 1 的数组）：

1. **资源闸（整批原子预检）**：内存表数请求方的活跃子，`活跃数 + 本批数量 > 上限`（配置项，默认 5）→ 回 `bus_response {error:"max_concurrent", active, requested, limit}` **整批拒绝**——要么全起要么不起，不产生半个场景。闸是可预检的，原子性体现在这里。
2. **逐个子起进程（并行）**：`ctx.bus.sessionCreate({cwd, toolConfig, watch:true})`——cwd 缺省继承父会话 cwd，toolConfig 取子任务内声明否则共享缺省；watch 的登记方是插件（session_done 先到插件，插件在链上更新 UI 再转发父）。拿到子的 session 地址与 sessionPath。**subagent_id 就是子的 bus session 地址**（`session:<key>`），不发明第二套 id——全部 tool 的 subagent 参数都传这个地址。单个 spawn 失败不构成整批失败：该子在返回数组里标 `status:"spawn_failed"` 如实报告（运行时事实不可预检，和闸的原子拒绝是两个层面）。
   **实现修订（2026-08-08）：本步整批并行**——`Promise.all` 同时起全部子进程，不再 for-await 串行。每个子 = 一个全新 pi 进程冷启动（1~2s），串行时 N 个子累加 N 倍等待（实证：派 5 个活等 5~10s，用户感知"启动慢"）；并行后总时长 ≈ 单个冷启动。并发护栏由第 1 步的 max_concurrent 整批预检兜底，`sessionCreate` 内部无串行依赖，安全。
3. **逐个子生成 spawn_entry_id**（UUID），双向关联的锚。
4. **逐个子写头行**：`ctx.sessions.updateHeader(子sessionPath, {custom:{subagent:{parent_session, spawn_entry_id, task, name, status:"running", allowSpawn, spawned_at}}})`——`HeaderPatch.custom` 域级浅合并 + 锁内原子（`session-header-custom.md`）。
5. **逐个子写父 spawn entry**：`ctx.configFile.append(父sessionPath, {type:"custom_message", customType:"subagent_spawned", display:true, id:spawn_entry_id, content:JSON.stringify({subagent, subagent_session, task, tool_config}), timestamp})`——timeline 的 SpawnCard 数据源。
6. **父死子清监听 + 拓扑收尾**：`ctx.bus.tapStart({session:父, filter:"done"})`（一批只需一个 tap）——父进程死亡触发 bus 的 `processExit→settleSession`，插件收到父的 session_done 后按 status 分流（§3.3）。逐个子挂超时定时器（§3.5）。声明了 `channel` 时逐个子 `ctx.bus.channelMember(channel, "join", 子地址)` 拉进作战室。
7. **按 wait 分流回执**：`wait:false` → 立即 `ctx.bus.send(父, "bus_response", {subagents:[...]}, replyTo=id)`，每个元素带 `{subagent, subagent_session, spawn_entry_id, status:"dispatched"}`；`wait:true` → 存下请求帧 id 不回，等本批全部子到达终态（done/error/aborted/timeout/spawn_failed 都算终态）后一次回 `{subagents:[{subagent, status, output}...]}`。

wait 回执的输出保护（**2026-08-08 修订**）：给 agent 的回执帧仍保留裁剪（`tasks` 长度 1 沿用 bus 的 8000 token、批量每个 2000 token——N 个子全量进父 agent 上下文会爆，批量场景要的是结论集）；但**用户交付物不受此限**——`subagent_done` 事件帧与对话面板输出全量、零截断（§7.2 修订：agent 帧与用户交付分层）。全文经 `subagent_session` 路径始终可达。

### 3.2 状态机与持久化分工

子的状态：`dispatched → running → done | error | aborted | timeout`；**终态可恢复为 reopened（对话续聊，§6.5）**——reopen 不改变 status（done 仍 done），只意味着"进程重新在场"。状态的家分两层：

- **内存表**（插件运行时）：`Map<subagentAddr, {parent, task, spawnEntryId, status, tapId, timeoutTimer, spawnedAt}>`——活跃期的全部操作读它。
- **头行持久化**：`custom-my-harness-desktop.subagent.status` 随状态迁移更新（done/aborted/timeout 都写）。写法是**先读最新 custom.subagent 全域、内存合并、整体写回**——域级浅合并是"域内整体替换"，直接写 `{status}` 会抹掉 parent_session。状态机单线无并发，安全。

### 3.3 父死子清

插件 tap 父会话（filter=done），父的 session_done 到达时按 status 分流：

- `done`（父正常 settled，进程还活着，用户可能继续聊）→ **不清理**，子继续跑。
- `error` / `aborted`（父进程死了）→ 遍历内存表中该父的全部活跃子：`ctx.bus.sessionAbort(子地址)` 逐个杀，子头行写 `{status:"aborted", abort_reason:"parent_crashed"}`，追加父会话……父已死，不再写父 entry（写进死文件无读者），子的处理到此为止。

desktop 整体重启不产生孤儿：`before-quit→stopAll()` 把全部 pi 进程（含子）停掉，房间/tap 清零与进程清零同生共死（`session-bus.md` §3.5）。

### 3.4 重启恢复（2026-08-08 修订：从"无需重建"到懒扫重建）

desktop 重启后全部 pi 进程已死、活跃子为零。旧设计（"内存表天然清零、无需重建"）把重启后子 agent 失忆（列表空、关系断）合理化了——但头行 `custom.subagent` 域是持久化真相源（§6.1），丢失的是**账本视角**（"我派了哪些活、什么状态"），不是数据本身。修订后的恢复语义：

- **账本懒扫重建**：插件的 `list_subagents` / 状态面板 / 对话入口首次访问时，对当前 cwd 会话桶做一次头行扫描，把 `custom.subagent.parent_session` 归属自己的会话重建进内存账本（status 取头行现值）。
- **僵尸 running 归正**：进程已随重启死亡但头行仍 `running` 的，懒扫发现时改写 `interrupted`——诚实标注，不假装在跑。
- **对话入口照常**：已完成子经 §6.5 的 reopen 续聊，不依赖账本在线——reopen 是"以会话文件为锚"，账本只是展示层。

spawn 卡片在父会话文件里持久，timeline 照常渲染历史层级（首版 §6.6 的"回看"能力由头行 + entry 双持久化保住）。

### 3.5 资源闸

两道闸都在插件执行（配置页管默认值）：

- **并发上限**：§3.1 第 1 步，默认每父 5 个活跃子。按"活跃数 + 本批数量"整批预检，超了**整批拒绝**（附 active/requested/limit）——agent 拿到错误自行决策：减批量、先 wait 一批、或放弃。拒绝也是一轮回执，不破坏一轮闭环。
- **超时**：每个子一个定时器（配置项，默认 10 分钟），到点 `sessionAbort` + 子头行写 `{status:"timeout"}` + 追加父 timeout entry + 照常交付终态（`subagent_done{status:"timeout"}` 或计入 wait 批返回）——父收到的信号形状不变，只是状态不同（`session-bus.md` §4.2 语义沿用）。它也是 `wait:true` 的兜底期限：子被闸终结，等待随之返回，挂起不死等。

递归深度不做闸——由 tool 配置涌现（§4.3）。

### 3.6 idle 进程回收（2026-08-08 新增）

子会话完成（agentSettled）后进程仍活着（bus 的 onProcessExit 只在进程死亡时清理）——多个 done 子 = 多个 idle pi 进程挂着，每个 100MB+ 内存。生命周期模型此前只有"出生/死亡"没有"驻留/回收"，这是资源泄漏面。

- **原则**：会话进程按需驻留（用户可能随时对话 reopen），但要有**回收路径**。
- **对话面板关闭即回收**：面板关闭时除 tapStop 外，若目标会话无其他消费者（不是激活会话、无 watch、无房间成员）→ `sessionAbort` 停进程。对话结束进程即释放，不累积。
- **全局兜底**：desktop 的 restart-coordinator 的 idle 清理语义覆盖 bus 子会话（getRunningSessionKeys 含 `bus:<uuid8>` key），或插件在配置页提供"回收全部已完成子进程"按钮。
- **reopen 与回收的关系**：reopen 起的进程同样受面板生命周期约束——面板关、进程停；再开、再起（进程是临时工，会话是文件，随时可复活，`session-bus.md` §2 的进程模型）。

## 4. tool 差异与递归控制

### 4.1 复用已验证回路

子的 tool 限制不走新机制：spawn 时 `toolConfig` 经 `updateSessionHeader` 写进子头行，随壳分发的 tool-gate extension 在子的 `turn_start` 重读头行、`setActiveTools` 硬过滤（tool-manager 场景已验证的回路）。只读分析型（有 read 没 write）、受限执行型（有 bash 没 spawn）、全权委托型（全开）都是 toolConfig 的参数化结果，不是枚举的角色 kind。

### 4.2 子的身份自感知（替代环境变量）

首版设计 desktop spawn 时注入 `MY_HARNESS_DESKTOP_SUBAGENT_ID` 等环境变量供子 extension 感知身份——bus 的 `sessionCreate` 是通用路径，没有 env 注入参数，此路不通。替代方案更顺：**子的 subagent-extension 在 `session_start` 时读自己的 session 文件头行**（tool-gate 已证明 extension 拿得到、读得了头行），发现 `custom.subagent` 存在即知"我是子"。

### 4.3 递归三层防御（2026-08-05 实现期修订）

默认不许递归，三层各自独立生效，**权威闸在插件编排层**：

- **插件权威闸**：任何 `spawn_subagent` 请求到达插件时，请求方在本插件活跃子账上且未声明 `allowSpawn` → 直接拒绝（`spawn_not_allowed`）。这是权威层——请求到达时子的头行早已写好（spawn 编排先于子运行），账上信息确凿，零竞态。
- **extension 自感知（体验层）**：子的 extension 读自己头行，`custom.subagent.allowSpawn !== true` → 不注册 spawn 系 tool，agent 的 tool 清单干净。**注意竞态**：子的 `session_start` 触发时插件可能还没写完头行（bus 的 `sessionCreate` 先注入 task、插件后才 `updateHeader`），此时子误当普通会话会注册 tool——不要紧，agent 调了会被插件权威闸拒绝。所以自感知只是体验优化（清单干净），不是安全边界。
- **toolConfig 过滤（底座兜底）**：父传 `toolConfig.enabledToolIds` 不含 spawn 系 tool 时，tool-gate 在子的 `turn_start` 硬过滤（对 extension 注册的 tool 是否生效需实测，见 §7.2 风险四）。

pipeline 链式（子再拆孙）= 父显式 `allowSpawn:true` + 孙同理。协议层无递归检测，深度是部署决策。

## 5. agent 能力面：五个 tool

五个 tool 由 subagent-extension 注册（ping 探测插件在线才注册，裸 pi / 无插件环境优雅退化）。每个 tool 一轮闭环：一次调用拿完整结果，不许"三连才能开干"。参数里的 `subagent` 一律是子的 bus session 地址（§3.1 第 2 步）。

### 5.1 spawn_subagent —— 一轮搭出完整场景

**语义一句话**：把要派的活一次说清——单个、并行 fan-out、作战室，同步等或异步通知，一轮调用场景就位。

设计基线是一轮闭环（`session-bus.md` §5）：不许"先建会话再拉房再挂监听"式三连。`tasks` 数组表达批量，`wait` 声明等待模式，`channel` 声明拓扑——一次调用把编排场景完整搭出来。

**参数**：

```json
{
  "tasks": "数组, 必填——元素为 string 或对象;string 等价于 {task: 该串}",
  "wait": "boolean?——true=挂起等本批全部完成,一次返回全部结果;缺省 false=立即回执,结果经 subagent_done 逐个到达",
  "channel": "string?——起完把本批全部子拉进这个房间(作战室,不存在即创建);缺省不拉房(隔离模型,完成才通知)",
  "cwd": "string?——共享工作目录;缺省继承父会话 cwd",
  "toolConfig": "{mode, enabledToolIds?}?——共享 tool 限制;被子任务对象内同名键覆盖;缺省全开(mode:all)"
}
```

`tasks` 元素为对象时的完整形状：

```json
{
  "task": "string, 必填——任务描述,作为子的首条 prompt 注入,落地即开工",
  "name": "string?——显示名(卡片/列表用);缺省取 task 前 20 字",
  "model": "{provider, modelId}?——模型覆盖;缺省继承父",
  "toolConfig": "object?——覆盖顶层共享声明",
  "allowSpawn": "boolean?——允许该子再 spawn 孙;缺省 false(§4.3)"
}
```

**场景回放**（每个都是一轮）：

```jsonc
// 单个同步:等结果
{ "tasks": ["把 auth.ts 拆成 3 个文件"], "wait": true }

// 并行 fan-out 3 个 + 等全部结论(fork-join)
{ "tasks": ["拆 auth.ts", "写 auth-login 测试", "写 auth-token 测试"], "wait": true }

// 并行 3 个异步,各回各的;父继续陪用户
{ "tasks": ["拆 auth.ts", "补测试", "跑集成"], "wait": false }

// 作战室:2 子同房互通(拆接口的改了签名,写测试的立刻知道)
{ "tasks": [{ "task": "拆 auth.ts" }, { "task": "按新接口写测试" }], "channel": "auth-squad" }

// 受限委托:只读分析型,不能改文件不能再拆
{ "tasks": [{ "task": "审计 storage 层", "toolConfig": { "mode": "custom", "enabledToolIds": ["read", "bash"] } }] }
```

**返回**（`wait:false`，立即回执；数组形状恒定，单个也是数组）：

```json
{ "subagents": [
  { "subagent": "session:abc123", "subagent_session": "~/.pi/agent/sessions/<cwd桶>/<uuid>.jsonl", "spawn_entry_id": "uuid", "status": "dispatched" }
] }
```

**返回**（`wait:true`，本批全部终态后一次返回）：

```json
{ "subagents": [
  { "subagent": "session:abc123", "status": "done", "output": "拆成 auth-login.ts / auth-token.ts / auth-session.ts" },
  { "subagent": "session:def456", "status": "timeout", "output": "<已产生的部分输出>" }
] }
```

部分失败语义：每个元素独立状态——`done/error/aborted/timeout/spawn_failed` 都算终态，不阻塞其他。批量 wait 的每个 output 截断到 2000 token（附 session 路径，总量保护）；`tasks` 长度 1 时沿用 bus 的 8000 token 截断（`session-bus.md` §4.3）。

**结果交付**（`wait:false` 时）：每个子完成时 `subagent_done` 事件帧逐个到达，payload `{subagent, status, output, session_path}`——extension transform 进父上下文：`【子 agent 完成】任务:<name> 状态:<status>\n<output>`。

**实现链路**：§3.1 七步。

**错误**：`max_concurrent`（整批拒绝，附 active/requested/limit）。错误作为 tool 返回值给 agent，自行决策（减批量/先等/放弃）。

### 5.2 list_subagents —— 查全景

**语义一句话**：我派出去的子 agent 都在什么状态——编排前侦察、完成后盘点的唯一查询入口。

**参数**：

```json
{
  "status": "\"active\"|\"done\"|\"all\"?——过滤;缺省 all(含历史,完成态带结果摘要)"
}
```

**返回**：

```json
{ "subagents": [
  { "subagent": "session:abc123", "name": "拆分 auth.ts", "status": "running",
    "spawned_at": 1754131200, "finished_at": null, "output_preview": null }
] }
```

**实现链路**：插件查内存表（活跃）+ 头行扫描（历史，按 `custom.subagent.parent_session == 请求方` 过滤）。完成态的 `output_preview` 取输出前 200 字，全文经 `subagent_session` 路径自取（read 工具）。

**边界**：只列请求方自己的子（from 认证后的 parent 过滤），看不到别人的——编排决策只需要自己的拓扑。

### 5.3 wait_subagent —— 补等

**语义一句话**：发起时选了异步、干着干着发现需要汇总了——补等一个子到终态。

主语义已在 spawn 的 `wait` 参数（§2.3）；本 tool 只服务"fork 时不知道要 join、join 时机后知"的场景。已在 spawn 声明 `wait:true` 的场景不需要它。

**参数**：

```json
{
  "subagent": "session 地址, 必填",
  "timeout_ms": "number?——最长等待;缺省不限(跟随子的超时闸,闸终结即返回);显式传则提前返回"
}
```

**返回**：

```json
{ "subagent": "session:abc123", "status": "done", "output": "<完整输出>" }
```

**实现链路**：插件存下请求帧 id 不回；子的 session_done 到达时以结果为 payload 回 `bus_response`（replyTo 配对，extension 吞帧 resolve）。wait 自身超时回 `{status:"wait_timeout"}`——子不受影响继续跑，结果仍会经 `subagent_done` 到达。对**已终止**的子 wait 立即返回当前状态与输出（幂等，不报错）。同一子被并发 wait 多次：各自挂起、各自回。

**边界**：extension 侧的 pending 超时要大于等待时长（`callDesktop` 默认 60s 不够，subagent-extension 的 wait 系调用统一放大到子超时上限 + 30s）。pi tool 系统对长挂起 tool 调用的容忍度是实测项（§7.2 风险五）——若底座有硬超时，wait 退化为"轮询式等待"：extension 收到底座超时后以 `list_subagents` 查状态再决定是否重发 wait，语义不变。

### 5.4 send_to_subagent —— 追加指令

**语义一句话**：子跑偏了，给它补一句——父对运行中子的单向纠偏通道。

**参数**：

```json
{
  "subagent": "session 地址, 必填",
  "message": "string, 必填——追加的指令文本"
}
```

**返回**：`{ "subagent": "session:abc123", "delivered": true }`

**实现链路**：插件 `ctx.bus.send(子地址, "subagent_note", {text: message, from_parent: 父地址})`——deliver 按事件帧 followUp 注入子的 stdin（排队，不打断子当前 run——`session-bus.md` §2.1 策略）。子的 extension input 钩子识别 `subagent_note` transform 为：`【父 agent 追加指令】<message>`。子的回复是其 turn 的新发言，不属于本 tool 的语义范围。

**错误**：子已终止 → `{error:"subagent_finished", status}`（不给死会话注入）；subagent 地址不属于请求方 → `{error:"not_your_subagent"}`（归属校验）。

### 5.5 abort_subagent —— 中止

**语义一句话**：停掉一个运行中的子。

**参数**：

```json
{
  "subagent": "session 地址, 必填",
  "reason": "string?——中止原因,记进子头行与父 entry"
}
```

**返回**：`{ "subagent": "session:abc123", "status": "aborted" }`

**实现链路**：归属校验（子的 `parent_session` 必须等于请求方）→ `ctx.bus.sessionAbort(子地址)`（stdin→SIGTERM→SIGKILL 停止链）→ 子头行写 `{status:"aborted", abort_reason}` → 追加父 `subagent_done` entry（status=aborted）→ 停超时定时器。随后 bus 的 processExit 触发的 session_done 到达时，内存表已标 aborted，跳过重复转发。

**边界**：对已终止的子幂等——返回当前终态，不报错不二次杀。

## 6. 元数据与展示

### 6.1 子头行 `custom-my-harness-desktop.subagent` 域

```json
{
  "type": "session_header",
  "custom-my-harness-desktop": {
    "subagent": {
      "parent_session": "~/.pi/agent/sessions/<cwd桶>/<父uuid>.jsonl",
      "spawn_entry_id": "uuid(与父 spawn entry 的 id 互锚)",
      "task": "把 auth.ts 拆成 3 个文件",
      "name": "拆分 auth.ts",
      "status": "running|done|error|aborted|timeout|interrupted",
      "allowSpawn": false,
      "spawned_at": 1754131200
    }
  }
}
```

desktop 私有、底座不感知（`session-header-custom.md` 的开放命名空间语义）。它是重启恢复的唯一真相源，也是展示三槽的判定数据。

**实现期补丁（2026-08-05）：头行是双钥匙。** 除 `subagent` 域外，插件同时写一个平铺键 `"subagent.parent_session": "<父 sessionPath>"`——`sessionGroupings` 槽的消费方是平铺直接访问（`custom[parentPathKey]`，无嵌套路径解析），父路径必须作为独立平铺键供它；`composerPolicies` 的存在性判定用 `subagent` 域键即可。两个键各司其职，状态迁移只更新 `subagent` 域，平铺键写一次不变。

### 6.2 父会话的 custom_message entry

spawn / done / aborted / timeout 各追加一条（JSONL 只追加不原地改）：

```json
{ "id": "<spawn_entry_id>", "type": "custom_message", "customType": "subagent_spawned",
  "display": true, "timestamp": "...",
  "content": "{\"subagent\":\"session:abc123\",\"subagent_session\":\"...\",\"task\":\"...\",\"tool_config\":{...}}" }
```

`customType: "subagent_done"` 的 content 带 `{subagent, status, output_preview}`。经圆心 `sessionEntryToNeutral` 提升为 `role=customType` 的 NeutralMessage 进时间线（`custom_message` 是官方公开通道，`type:"custom"` 会被圆心过滤——首版 Q18 的教训沿用）。SpawnCard 渲染时按 `subagent` 地址配对同会话后续的 done entry 翻状态。

**2026-08-08 修订（默认收起）**：spawn/done 卡片**默认折叠成一行**（icon + name + 状态/任务首行摘要），点击展开详情（task 全文 / output 预览 + 「打开」「对话」按钮）。批量 fan-out 不再刷屏（实证反馈：5 个子 = 10 条卡片铺满父时间线）；Q7 的"可观测性"保留但降噪——状态与细节在展开态和状态面板，不在默认行。全量输出不进父会话文件（卡片 content 只带短预览），内容在子会话文件，经「打开/对话」进入。

### 6.3 展示三槽：插件只声明

manifest 静态声明，零命令式注册代码：

```json
{
  "contributes": {
    "messageRenderers": [
      { "role": "subagent_spawned", "component": "SpawnCard" },
      { "role": "subagent_done", "component": "SpawnDoneCard" }
    ],
    "sessionGroupings": [
      { "id": "subagent", "parentPathKey": "subagent.parent_session",
        "childLabelKey": "subagent.childLabel", "childIcon": "git-fork" }
    ],
    "composerPolicies": [
      { "id": "subagent", "customKey": "subagent",
        "readonlyMessageKey": "subagent.composerReadonly" }
    ]
  }
}
```

父会话 timeline 的 spawn 卡片（**2026-08-08 修订：默认收起**，见 §6.2）、左侧栏缩进嵌套（首版 §6.3）、子会话视图灰输入框（composerPolicies 声明，见下方 manifest；用户对话走 §6.5 面板不冲突——面板是独立窗口，子视图仍只读）——三处渲染行为全由槽机制兑现，插件 export 对应组件即可。

对话面板经 sidePanel 槽贡献（**2026-08-08 新增**）：

```json
{
  "sidePanel": [
    { "id": "sub-agent-dialog", "label": "对话", "icon": "message-square",
      "component": "SubAgentDialog", "revealOn": "subagent:dialog", "order": 70 }
  ]
}
```

`revealOn: "subagent:dialog"` + 插件 channels 声明同值 + 卡片/列表点「对话」时 `ctx.events.emit("subagent:dialog")`——声明式揭示（右侧面板展开 + Tab 激活），插件代码不出现自己的 contribution id，框架经事件总线 tap 居中撮合。

### 6.4 状态面板与配置页

- **sidePanel（升级为对话入口）**：子 agent 列表——**含历史（done 态）**，每行（任务/状态/耗时 + 输出预览）+ 「对话」按钮（§6.5）+ abort 按钮（running 时，与用户手势 abort 同路径，首版 Q15）。旧设计只列活跃子、完成态靠父时间线卡片——对话范式下历史子也要可访问可对话，列表承载。
- **settings**：声明 `configFile`（`~/.my-harness-desktop/config/sub-agent.json`，跟既有插件同目录惯例）——并发上限（默认 5）、超时（默认 10min）。框架自动管读/写/dirty/save/拦截，插件只渲染 UI 和报 onChange。编排核心不缓存配置——每次 spawn 现场 `configFile.get` 读，免变更通知。

### 6.5 用户对话面板（2026-08-08 新增：对话范式转向的核心）

**语义一句话**：用户经右侧面板与任意会话（含已完成 subagent）来回对话——发消息过去、对方流式回复、再发再回。终结"只能拉新的"（子跑完想继续只能重新 spawn 重述上下文）。

**为什么之前不行**：旧设计 Q4 禁止用户直接与子对话（"指令冲突"）——过度防御。协调手段设计里全有，只是没接到 UI：followUp 排队（`session-bus.md` §2.1，不打断子的 turn）、tap stream 的正当消费者是 plugin（`session-bus.md` §3.6："消费者是人，没有上下文成本"）、bus.send 是插件唯一发声通道（`session-bus.md` §5.8 附注）。对话面板把它们组合起来，是设计文档内部的自洽延伸，不是新协议。

**机制**（全部走既有 bus 能力，不动内核）：

- **发**：`ctx.bus.send("session:<addr>", "chat", {text})` → 路由器 deliver → 目标会话 input 钩子 transform（`bus-extension` 的 formatFrame 对 plugin 来源已区分"来自桌面对话面板的消息——请直接回复"，必回复语义成立）→ followUp 排队注入，不打断目标当前 turn。
- **收**：`tapStart({session: addr, filter: "stream"})`——stream 是 plugin 目标的合法全量事件流；tap_event 帧经 `ctx.bus.onMessage` 收到，按 messageStart/Update/End 流式渲染。**这就是用户的进度视图**（旧设计 Q3 让用户切会话视图看进度——切走打断当前流，等于没有；面板让进度可见且不打断）。
- **续聊（已完成子）**：目标离线时 `bus.send("desktop", "session_reopen", {cwd, sessionPath})`——以已有会话文件起进程续上下文（不抢激活语义，key=`bus:<uuid8>`；路径圈禁 `~/.pi/agent/sessions/`）。子的文件上下文完整保留，接着聊不用重述。
- **历史载入**：打开即 `ctx.sessions.openSession` 纯文件读，把目标会话最近 N 条 user/assistant 消息带进面板——reopen 续同一文件，历史不丢。
- **记录不落父时间线**：对话消息不进父会话文件（避免再次填充）；子的回复天然落子会话自己的文件（那是它的时间线），面板是内存态视图 + 文件态。

**生命周期纪律（§3.6）**：面板关闭 → tapStop + 目标无其他消费者则 `sessionAbort` 停进程。reopen 起的进程同样受面板生命周期约束——进程是临时工，会话是文件，随时可复活。

**并发护栏**：快速连续打开多个目标时，后发者胜、先发者放弃（单调序号），不互相覆盖 target。

## 7. 资产清单与工程风险

### 7.1 三样资产 + 一处契约透传（bus/preload 零改动）

1. **`packages/subagent-extension/`**（pi extension，~150 行）：ping 探测插件在线 + 注册 5 个 tool + input 钩子（`subagent_done`/`subagent_note` transform、`bus_response` 吞帧）+ 子身份自感知（读头行决定注册与否，体验层）。帧读写/pending 表仿 `bus-extension/runtime.ts` 模式。交付：installer 在 app 启动时同步到 `~/.pi/agent/extensions/subagent-extension/`（bus-extension-installer 同模式）。
2. **`src/plugins/sessions/sub-agent/`**（桌面插件）：manifest（三槽声明 + `sessions:bus` 权限 + configFile）+ `core/orchestrator.ts`（纯 TS 编排核心——spawn 七步/状态机/资源闸/父死子清，不 import react 可裸单测）+ renderer 组件（SpawnCard、SpawnDoneCard、状态面板、配置页、常驻挂载件）。
3. **bootstrap 一行**：`installSubagentExtension()` 接线。
4. **契约透传（实现期补丁）**：`PluginContext.configFile` 加 `append`——preload 的 `config-file:append` IPC 早已暴露（`session-jsonl-append.md` §5.3 定为框架契约），PluginContext 原收窄只透传 `get`（防通用 JSON 读写滥用）。append 是 JSONL 追加原语、语义与配置读写不同，透传它正是该设计的本意。改动两处：domain `context.ts` 类型 + packages/react `plugin-context.ts` 一行。

### 7.2 风险清单（按严重度，实现前逐一验证）

1. **常驻订阅命门**：`bus.onMessage` 的订阅发生在组件挂载期，而 messageRenderers/sessionGroupings/composerPolicies 三槽组件是"查表渲染"不常驻——没有常驻挂载点就收不到 spawn 请求，全链路断在第一步。**解法**：插件往 sidebar 槽贡献"子agent"分组组件（UI 本来也需要），其 useEffect 挂 `bus.onMessage` 编排循环，组件常驻=订阅常驻。开工第一天验证。
2. **域级浅合并是整体替换**：更新子头行 status 必须先读最新 `custom.subagent` 全域、内存合并、整体写回（§3.2）。
3. **父会话文件双写竞态**：插件 append entry 时父 pi 也在写同一文件——O_APPEND 单行 <4KB 原子，首版 Q12 已论证可接受。
4. **tool-gate 对 extension tool 的过滤**：递归控制的 toolConfig 兜底是否盖住 extension 注册的 tool，实测；盖不住则 §4.3 的 extension 自感知单保险独立成立。
5. **pi tool 系统的长挂起容忍**：`wait_subagent` 的挂起时长超底座容忍时退化为轮询式等待（§5.3 边界）。
6. **对话面板 tap/进程泄漏（2026-08-08 新增）**：面板关闭必须 tapStop（stream tap 是全量事件，挂在路由器上持续广播）+ 目标无其他消费者时停进程（§3.6）。面板组件若被直接卸载（tab 切走不点关闭）要由组件卸载钩子兜底清理，不能依赖用户手点关闭按钮。
7. **reopen 路径圈禁**：`session_reopen` 的 sessionPath 来自插件 payload，必须圈禁 `~/.pi/agent/sessions/`（reopen 把文件内容读入会话上下文，越界是信息泄露）。

## 8. 落地路径

- **第一阶段：闭环**。风险一验证 → subagent-extension（spawn/list/abort 三个）→ 插件编排核心 + 三槽声明 → spawn/done 卡片。验收：agent 调 spawn_subagent 起子、结果自动回、父会话出卡片、左侧栏缩进、子视图灰框、重启后层级还在。
- **第二阶段：操控面**。`send_to_subagent` + `wait_subagent` + 状态面板 + 配置页 + 超时闸。验收：父能纠偏运行中的子、能同步等结果、超时自动收尸。
- **第三阶段（2026-08-08 追加）：对话范式**。spawn 并行化（§3.1 第 2 步）→ 对话面板（§6.5：发 chat 帧 + tap stream + reopen 续聊 + 历史载入）→ 卡片默认收起（§6.2）→ 交付分层（session-bus.md §4.3：agent 帧截断、用户交付全量）→ idle 进程回收（§3.6）。验收：批量派活秒起、跑完可续聊、进度流式可见、父时间线不刷屏、输出零截断、关面板即释放进程。

## 已知缺口（演进，不藏）

1. **bus 子会话污染会话列表**：`bus:<uuid8>` 的会话文件出现在 sessions-list，用户看到一堆莫名会话。候选解法：列表按 key 前缀过滤 bus 会话，或 bus 会话带独立标记。待与 sessions-list 插件协调。
2. **对话消息落子文件的形态**：chat 帧经 input 钩子 transform 进上下文，但落盘的 entry 形态（原文 JSON 帧 vs 人话）未验证——若为 JSON 帧原文，子文件会有丑 JSON 行；readSession 的解析行为需实测。
3. **followUp 积压无上限**：目标会话忙时对话消息排队，连发多条 = 上下文堆积，无队列上限。候选解法：面板侧限流提示或队列长度上限。
4. **会话间关系的全局视图**：父子关系仅头行 + 运行时账本，无"会话关系图"（谁派了谁、谁在聊谁）的一等视图。对话面板是单点入口，多会话拓扑可视化未设计。

## QA

**Q1：插件没装/没在线时 agent 调 spawn_subagent 会怎样？**
调不到——subagent-extension 的 ping（`to:"plugin:sub-agent"`）无响应即不注册 tool，agent 的 tool 清单里根本没有它（plugin 地址无订阅者即弃恰好构成探测语义）。裸 pi、无插件环境同理优雅退化。

**Q2：为什么不直接把 spawn 逻辑加进 bus 的 desktop op？**
bus 管平的世界（地址+路由），父子是有向关系层——加进 bus 就把"归属"这个内容层语义焊进传输层，聊天室等场景被迫带着它跑。分层让两侧独立演化：bus 升级不动 subagent，subagent 换语义不动 bus。

**Q3：子的进度用户能看到吗？**
分两侧答。**父 agent** 看不到——bus 完成通知模型（不转中间流，一次性交付完整输出），agent 间上下文隔离比"实时感"值钱，此决策不变。**用户**经对话面板（§6.5）的 tap stream 看到流式进度——stream 的正当消费者是 plugin（人是消费者、无上下文成本），面板补上了旧设计"切会话视图看进度"的笨重缺口（切走打断当前流，等于没有）。agent 看 agent 只吃完成态，人看人走面板，两套不冲突。

**Q4：用户能直接给子 agent 发消息吗？**
**能——经对话面板（§6.5），2026-08-08 推翻旧决策**。旧答案"不能，会指令冲突"是过度防御：用户是父 agent 的主人，用户与子协作是最终所有权。协调手段天然存在：对话消息 followUp 排队不打断子的 turn（`session-bus.md` §2.1）、bus-extension 对 plugin 来源的 chat 帧区分"请直接回复"文案、对话记录不落父时间线（不污染父 agent 上下文）。子视图的 composerPolicies 只读条保留——那是"子会话自己的时间线"的只读态，用户的对话发生在面板这个独立窗口，两者不冲突。父 agent 的 send_to/abort 路径不变（那是 agent 对子的纠偏），用户对话是人的入口。

**Q5：spawn entry 的 id 为什么由插件生成而不是 bus 生成？**
双向关联的锚需要同时出现在父 entry 和子头行——两处写都是插件做的，插件生成 UUID 天然两处一致。bus 不知道 spawn_entry_id 的存在（它是 subagent 私域概念）。

**Q6：父子拉房间自动 fan 行不行，为什么还要有 send_to_subagent？**
房间是双向对话（子的每条发言也 fan 给父，上下文互灌），send_to 是单向纠偏（父说话子收，子的回复是其自己 turn 的事）。subagent 语义要的是后者；想要前者（父子平等协作）的用法直接 channel_member 拉房，是 bus 的原生场景，不需要本插件。

**Q7：父 agent 和用户在同一个会话里（激活会话），子完成通知会不会打扰用户？**
会出现在时间线——`subagent_done` transform 后进父的上下文，作为一条 user-role 输入可见。这正是 spawn 卡片的状态翻转时机（done entry 落盘）。**2026-08-08 修订**：卡片默认收起成一行（§6.2），用户看到的是紧凑的"🔹 拆分 auth.ts ✅"摘要而非大段输出——可观测性保留，降噪；细节在展开态/状态面板/对话面板。

**Q8：多个父 agent 同时派活，资源闸会不会互相挤占？**
并发上限按父隔离计数（每父 5 个）——一个父的 fan-out 不影响另一个父的额度。全局并发（跨父的总子进程数）当前不设闸：pi 进程即会话进程，总量受 desktop 既有会话管理约束；真出现全局失控再收进配置项。

**Q9：批量 wait 时一个子失败，其他子等不等？**
等"全部终态"而不是"全部成功"——`done/error/aborted/timeout/spawn_failed` 都算终态，失败项带各自状态如实返回，不阻塞其他子，也不让父为一个失败饿死整批。fork-join 的正常语义。

**Q10：pipeline（A 完了再起 B）能一轮搭出来吗？**
不能，也不该能——B 的输入物理依赖 A 的输出，时间序列折叠不进一次调用。这是两轮的本质不是工具的缺陷：`spawn({tasks:[A], wait:true})` 拿到结果再 `spawn({tasks:[B]})`；或异步派 A、`subagent_done` 到达后派 B。`tasks` 数组表达的是"并行 fan-out"，不是依赖编排 DSL。

**Q11：spawn 的 `channel` 把子拉进作战室，父在房间里吗？**
不在——`channel` 只拉本批的子。父要进场旁听或插话，自己调 `channel_member` 进房（父的 tool 面同时持有 bus 六件与 subagent 五件）。隔离是默认（不传 channel，完成才通知），互通是显式声明——子的 turn 发言自动 fan 是作战室的语义本体，不该偷袭默认场景。
