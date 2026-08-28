# llm-recorder 插件技术文档

## 1 定位与整体架构

- **一句话定位**：llm-recorder 是一个归 `insight` 域的壳插件，把「每次 LLM 调用的完整请求体 + 响应消息」落盘成项目级 JSONL，右侧面板按会话查看、设置页统计与清理。它观察的是 pi 内核进程内、RPC 事件流拿不到的那份数据——provider 原生请求体。

- **它解决的缺口是「实际发了什么」而非「我以为发了什么」**：`src/server/kernel/pi/protocol/event-translator.ts` 的 `TYPE_MAP` 把底座事件翻成中性事件，但这条流里没有 LLM 请求的 payload——`message_*` 事件携带的是组装后的消息（一条一条吐），不是「这次调用实际发出的完整请求体」（含完整历史、工具定义、系统提示的整体）。请求构造发生在底座内部（compaction 截断、system prompt 拼装、工具 schema 注入都是底座干的），桌面侧自己重放拼出来的只是「我以为发了什么」。记录的价值恰恰在「实际」，所以必须在底座进程内动手。

- **架构是「写半 + 读半 + 文件契约」三段，两半互不知晓对方存在**：写半是插件自带的 pi 内核扩展 `src/plugins/insight/llm-recorder/pi-extension/index.ts`，运行在每个 pi 进程内（每会话一进程），挂底座 hook 拿数据、追加写 JSONL；读半是 renderer `src/plugins/insight/llm-recorder/renderer/index.tsx`，经 `fs:project` 声明能力读文件、按 `seq` 配对渲染。两半只共享文件契约（`docs/design/llm-recorder-design.md §3.2` 的行格式），不共享任何类型、任何通道、任何运行时对象。

- **这是「插件携带内核扩展」通用机制的首个内容落点**：`docs/design/llm-recorder-design.md §5` 把这个诉求的通用形态抽象为「桌面插件需要一份只有底座进程内才有的数据」——解法不是给 RPC 协议加事件（那是改底座，且 payload 上事件流是性能炸弹），而是让插件自带一个底座 extension，在底座进程内挂 hook 写侧车文件，桌面插件读文件。先例是 toolgate 扩展把 `pi.getAllTools()` 清单播报进 `~/.pi/agent/desktop-known-tools.json`；本插件把它从 toolgate 的 bootstrap 私货升格为任何插件可用的 `manifest.piExtension` 声明式通道。

## 2 目录结构与四件套

- **物理布局**（`src/plugins/insight/llm-recorder/`）：
  - `plugin.json`：manifest，声明 `renderer`、`piExtension`、`permissions: ["fs:project"]`、三个槽位贡献（§8）。
  - `renderer/`：桌面壳插件（UI 组件 + 槽位贡献 + 事件订阅）。三个文件：`index.tsx`（面板与设置页两个入口组件）、`payload-views.tsx`（结构化视图）、`record-modal.tsx`（详情弹窗）。
  - `pi-extension/`：pi 内核插件（给 pi 补「记录能力」的 TS 扩展），只有一个 `index.ts`。
  - `core/`：纯 TS 逻辑层，`log-model.ts`（JSONL 解析/配对/游标/分片）与 `payload-model.ts`（请求/响应体拆解），各带一个 `.test.ts`。文件头自注「不 import react/ctx，可裸单测」。
  - `locales/`：四个 locale（`zh-CN`/`zh-TW`/`en`/`de`）× 三个 namespace（`panel.json`/`settings.json`/`plugin.json`）。
  - `extension-flow.test.ts`：放在插件根目录而非 `pi-extension/` 内——文件自注「该目录整体同步到 `~/.pi/agent/extensions/`，测试文件不能混进去」。

- **四件套内聚与「非必要不修改内核」的对照**：这个插件只带 `renderer/` + `pi-extension/` + `core/` + `locales/`，没有 `dsh-extension/`——因为「记录每次 LLM 请求」这个能力在 dsh 侧没有对称的 hook 面，dsh 内核不暴露 provider 请求体，本插件对 dsh 显式缺席（§9 展开）。这正是四件套的语义：按需带件，不是每件必填。

- **`core/` 与 `renderer/`、`pi-extension/` 的边界**：`core/` 是纯函数，不 import react、不 import ctx、不 import 底座类型包；`renderer/` 只 import `@my-harness-desktop/react` 和 `@my-harness-desktop/shared`（壳插件依赖纪律），并从 `../core/log-model`、`../core/payload-model` 引纯函数；`pi-extension/` 只 import `node:fs`/`node:path`，不 import 官方 `@earendil-works/pi-coding-agent`（文件头自注：内核 node_modules 里的类型仓库 tsconfig 够不到，手写用到的窄结构，与 toolgate 同纪律）。三条依赖各不越界。

## 3 数据流总览

- **完整链路**（`docs/design/llm-recorder-design.md §5.4` 的 mermaid 图，落成文字）：pi 进程内的 hook（`before_provider_request`/`after_provider_response`/`message_end`/`turn_start`/`compaction_start`/`compaction_end`）驱动 `llmRecorder(pi)` 扩展 → 扩展追加写 `<cwd>/.my-harness-desktop/llm-logs/<会话文件名>.jsonl`（含 `.N.jsonl` 分片）+ 读-改-写 `index.json`；扩展每次请求前读 `<cwd>/.my-harness-desktop/config/llm-recorder.json`（开关）；renderer 面板经 `fs:project` 读日志、设置页读 `index.json` 出统计、`removePath` 整目录清理、`ctx.config` 写开关。

- **三个项目级落点，各司其职**：
  - `llm-logs/<会话名>.jsonl`：日志本体，追加写、按 `seq` 配对。会话文件名 = 会话 JSONL 的 basename（形如 `2026-07-28T05-21-56-699Z_019fa72c-....jsonl`，时间戳 + uuid 天然唯一）。
  - `llm-logs/index.json`：增量统计 `{version, sessions: {<会话文件名>: {bytes, requests, updatedAt}}}`，设置页统计的数据源——没有它，「统计多少数据」就得扫读全部日志（可能几百 MB）。
  - `config/llm-recorder.json`：开关（`recordEnabled`），框架统一配置通道按 pluginId 推导的落点，`ctx.config.set("recordEnabled", ...)` 写的正是这里，扩展按 mtime 缓存读。

- **为什么是项目级而非全局**（设计 §6.2 三条否决全局）：需求明确「跟项目走」；`fs:project` 圈禁让项目级读写零新 IPC（全局读反而要开新通道）；敏感数据随项目目录存续、清理边界清晰。`extension` 用 `process.cwd()` 拼路径，`renderer` 用 `useUiStore.currentCwd` 拼 `logDirOf(cwd)`（`renderer/index.tsx:30-32`），两侧恒一致。

## 4 写半：pi-extension 的落盘设计

### 4.1 hook 能力边界

- **六个 hook，四个事件 + 一个 ctx 句柄**（`pi-extension/index.ts:45-51` 的 `RecorderApi.on` 签名）：`before_provider_request`（`payload: unknown`，完整请求体，只读不改）、`after_provider_response`（只有 `status`，没有 body）、`message_end`（`message`，组装后完整 `AgentMessage`）、`turn_start`（`turnIndex`）、`compaction_start`/`compaction_end`（`inCompaction` 翻转）。`ctx.sessionManager.getSessionFile()` 是常驻查询接口（`RecorderContext`），不是事件——它在会话创建时（`newSession()`）就生成路径，早于任何一次 LLM 调用，所以「全新会话第一条消息」时 `before_provider_request` 首次触发必然拿得到有效文件名。

- **响应侧只有组装态、拿不到 raw SSE 流**：`after_provider_response` 触发时响应流还没被消费，hook 只给 status 和 headers；`message_end` 的 assistant 消息是底座把流逐 token 拼完、工具调用解析完之后的完整产物。这是底座的架构上限，设计 §2.2 如实接受：本插件记录的是「请求全量 + 响应组装态」，不是 wire-level 抓包——抓包的人去配 HTTP 代理，不是装这个插件。

- **任何 hook 内异常静默吞掉**：`llmRecorder` 里每个 `pi.on` 回调的 handler 体都包 `try { ... } catch { /* 记录失败不影响会话 */ }`（`pi-extension/index.ts:199-273`）。文件头自注这条纪律：记录扩展炸了不该带走会话。这是它与 toolgate 共守的「扩展是副驾驶、不是主链路」底线。

### 4.2 行格式契约

- **JSONL 两类行，`kind` 区分**（`pi-extension/index.ts` 的 `appendLine` 写、`core/log-model.ts` 的 `LogLine` 读，两侧契约一一对应）：
  - request 行：`{seq, ts, kind:"request", turnIndex?, payload}`。`turnIndex` 在 turn 外内部调用（compaction 等）时**字段缺失，不是 null**——`appendLine` 里 `...(turnIndex !== undefined && !inCompaction ? { turnIndex } : {})`（`pi-extension/index.ts:243`），面板按字段缺失判断。
  - response 行：`{seq, ts, kind:"response", status?, durationMs?, message}`。`status` 在连接级失败时缺失（`after_provider_response` 未触发）；`durationMs` 由扩展自算（`before` 与 `message_end` 的时间差）。

- **`seq` 是会话内单调序号，`before` 时分配，request/response 两行同 `seq` 即一对**：读侧 `pairRecords`/`mergeRecords` 以 `seq` 为键配对（§6.1）。`status` 与 `durationMs` 各一行代码的成本，却是「失败请求」「慢请求」的第一筛选维度，面板把它们渲染在记录行头（§5.5）。

### 4.3 seq 续号：进程重启不归零碰撞

- **根因与解法**（`pi-extension/index.ts:217-228` 的 `ensureSeqBaseline`）：`seq` 不能是纯进程状态——底座进程重启（应用重启/模型配置变更/restart 协调）后同一会话续写，若计数器归零，新行 `seq` 与旧行碰撞，读侧按 `seq` 配对会把旧记录顶掉。解法：进程内首次接触某会话时，`ensureSeqBaseline` 先 `initShard` 扫该会话已有分片、经 `maxSeqInText`（跳过坏行取最大 `seq`）取磁盘最大 `seq`，把全局 `seq` 抬到该值，再 `++seq` 分配新号。每进程每会话只续一次（`ShardState.seqSynced` 标志）。

- **这是有测试钉死的正确性点**：`extension-flow.test.ts:72-90` 的「进程重启(新扩展实例)后续号,不归零碰撞,旧记录不被顶掉」——用 `makeFakePi()` 造假 pi API（实现 `RecorderApi` 同签名 + `fire` 驱动事件），第一个实例写 `seq 1,2`，第二个实例（模拟重启）写 `seq 3`，断言读侧 `pairRecords` 得到 `[3,2,1]` 三条、旧记录不丢。测试还自证了 `fireRequest` 模拟一次完整调用的三段事件序（before → after → message_end）。

### 4.4 pending 配对与失败路径

- **配对靠进程内顺序队列**（`pi-extension/index.ts:177` 的 `pending: PendingCall[]` + `PendingCall {seq, startTs, status?}`）：`before_provider_request` 分配 `seq`、记 `startTs`、`pending.push({seq, startTs})` 并写 request 行（`pi-extension/index.ts:230-247`）；`after_provider_response` 把 `status` 写到数组末尾元素 `pending[pending.length - 1]`（`:249-254`）；`message_end`（`role === "assistant"`）从数组头部 `pending.shift()` 出队，凑齐 `seq`/`status`/`durationMs` 写 response 行（`:256-273`）。底座没有给跨 hook 的关联 id，进程内配对靠这个顺序队列；落盘之后桌面侧怎么配对靠 `seq`，两件事不冲突。

- **「末尾写 status、头部出队」在严格有序下的等价性**：`after_provider_response` 用 `pending[pending.length - 1]`（栈语义），`message_end` 用 `pending.shift()`（队列语义）——若存在多路并发在飞，二者会错位；但底座进程内 provider 调用严格有序（一次调用的事件序 `before → after(可缺席) → message_end` 串行），单次调用期间 `pending` 至多一个元素，末元素即首元素。这个等价性依赖「进程内事件严格有序」不变量，设计 §2.3 写明。

- **失败路径也落盘，分两种**（设计 §2.3）：provider 返回了响应但调用失败（4xx/5xx、流中断）——`after_provider_response` 照常触发，response 行有 `status` 非 200；连接级失败（超时/DNS/网络断）——`after_provider_response` 不触发，若底座 auto-retry 链走完产出带 error 的 assistant 消息，`message_end` 出栈写 response 行但无 `status`；若连 error 消息都没产出，此调用保持孤儿。request 在 `before` 之后进程崩了，request 行已落盘、response 行永远缺失——面板按「无响应的孤儿 request」展示（`response: null`，标「未返回」）。

### 4.5 rotate 与自愈

- **单文件超 512KB rotate**（`pi-extension/index.ts:53` 的 `SHARD_LIMIT = 512 * 1024`）：`appendLine`（`:180-197`）在 `state.size > 0 && state.size + bytes > SHARD_LIMIT` 时开新分片。`shardPath(dir, name, index)`（`:104-106`）：`index === 0` 返回 `<名>.jsonl`（首片无编号），`index > 0` 返回 `<名>.<index+1>.jsonl`——所以磁盘上看到的编号分片从 `.2.jsonl` 起递增，**没有 `.1`**，这是有意的（大多数会话永远只有一片，文件名保持最简形）。

- **512KB 的取法咬合读侧 1MB 上限**：桌面 `FsApi.readFile` 限 1MB（`src/server/controllers/fs-git.ts:61` 的 `readFile` handler 走 `readTextFile`），而长会话的请求 payload 含完整历史、体积随会话长度平方增长。payload 单行可达几十 KB，阈值要大于单行最坏情况、小于 1MB 读取上限，512KB 取在中段。`state.size > 0` 的守卫保证单行超过阈值也能写出（不无限 rotate）。这是两半设计的咬合点：写侧按读侧能力上限切分，读侧按写侧分片约定合并（`shardNumber`，§6.1）。

- **`index.json` 损坏/半截自愈**：`updateIndex`（`:151-171`）写前 `try { JSON.parse } catch { 从空重建 }`——重建恢复文件本身，但桶按会话增量累积，重建后历史会话统计永久偏低（直到整目录清理归零重来），这是与「手动删单文件」同源的漂移，设计 §3.4 有意接受。日志行本身只追加不改写，崩溃最多损失最后半行，面板 `parseLogText` 跳过坏行。

- **`index.json` 不做全量对账**：`updateIndex` 只在扩展自己写行时增量更新对应会话桶。用户手动删了某日志文件，`index.json` 里那个会话的统计残留、从此偏大，直到整目录清理。设计 §3.4 说死：统计是量级参考不是账本，为它对账要做全目录扫读，恰恰违背设 `index.json` 的初衷。正确清理路径只有设置页整目录清。

### 4.6 开关与配置读取

- **每请求读 + mtime 缓存**（`pi-extension/index.ts:89-102` 的 `recordEnabled`）：`statSync(configPath())` 取 mtime，`cfgCache` 命中同 mtime 直接返回缓存 `enabled`，否则 `readFileSync` + `JSON.parse` 取 `recordEnabled !== false`（文件缺失/损坏 `catch` 返回 `true`）。「文件缺失默认记」——装了这个插件就是来记录的，开关默认开。

- **开关是运行时行为，与插件启停是两条时间线**（§4.7、§10）：`recordEnabled` 由 `ctx.config.set` 写 `<cwd>/.my-harness-desktop/config/llm-recorder.json`，extension 已加载的进程里下一次请求前读即生效，停记不用等新会话；插件启停决定「底座进程里有没有这个 extension」，只对新 spawn 的会话生效。设置页把这两条如实拆成两句提示（`settings.timingNote`，§5.6）。

### 4.7 安全红线

- **headers 整条不碰**：`before_provider_headers` 能拿到完整请求头——含 `Authorization`（API Key 明文）。这个 hook 整个不挂（`RecorderApi` 的 `on` 签名里根本没有 `before_provider_headers` 事件名）。request 行只存 `before_provider_request` 的 payload（请求体不含凭证，凭证在传输层 header），response 行只存 status 和组装消息，`after_provider_response` 的 headers 丢弃。设计 §2.4 说「这个口子从设计上焊死，不留可选开启」。

- **payload 仍是敏感数据**：请求体含完整对话内容、工具定义、system prompt。日志落在项目目录，`settings.sensitiveNote` 提示「如项目用 git 管理，建议加入 .gitignore」，但插件不替用户改 `.gitignore`（设计 QA 明说）。安全红线防的是凭证泄漏，敏感内容由用户自己的 .gitignore 决策管理。

## 5 读半：renderer 的全量 + 增量

### 5.1 RecordsTab 与关联键

- **关联键是会话文件名**（`renderer/index.tsx:143-148`）：`RecordsTab` 读 `useUiStore((s) => s.currentCwd)` 与 `useUiStore((s) => s.currentSessionPath)`，`base = sessionPath ? (sessionPath.split(/[\\/]/).pop() ?? null) : null`（`:163`）取当前会话文件绝对路径的 basename，再读 `llm-logs/<basename>`（含 rotate 分片）。这跟写侧用 `path.basename(ctx.sessionManager.getSessionFile())` 当文件名严格对仗。

- **三个渲染态**：无 `sessionPath` → `EmptyState`「先打开一个会话」；`loaded && pairs.length === 0` → `EmptyState`「这个会话还没有请求记录」（`emptyHint` 提示「记录由随插件注入的底座扩展执行；刚启用插件的话，新会话才开始记录」）；否则渲染 `pairs.map` 的 `RecordRow` 列表（`renderer/index.tsx:269-294`）。

### 5.2 全量加载与世代守卫

- **`fullLoad`（`renderer/index.tsx:192-219`）**：`listShards(dir)` 枚举分片（`:182-189`，`listDir` 一层 + `shardNumber` 过滤 + 按分片号升序），逐个 `ctx.fs.readFile` 读全文、`parseLogText(text)` 解析、`nextCursor(text)` 回填游标，最后 `setPairs(pairRecords(lines))`。读失败（目录不存在 = 从未记录）→ 空列表。

- **世代守卫 `loadEpochRef`（`renderer/index.tsx:158-161`）**：`base`/`cwd` 切换即 `++loadEpochRef.current` 换代。全量与增量在异步 `readFile` 返回后都检查 `loadEpochRef.current !== epoch`——旧代的慢结果（大会话分片多、逐个 readFile 读得慢）到达时拦截 `setPairs`/`setLoaded`，否则慢的旧加载会覆盖新会话的加载结果。注释标注 `main d6262fa` 是根因修复点。`useEffect` 里 `base`/`cwd` 变化时先 `setLoaded(false)` + `setPairs([])`（`:252-256`），立即清空旧列表——加载窗口期不残留上个会话的记录。

### 5.3 增量加载与游标

- **`incrementalLoad`（`renderer/index.tsx:223-249`）**：`listShards` 后对每个分片读全文、`nextCursor(text)` 取总行数，`cursorRef.current.get(s.name) ?? 0` 取已读游标，`cursor < total` 才 `parseLogText(text, cursor)` 只解析新增行，最后 `mergeRecords(prev, newLines)` 增量合并。游标是「分片名 → 已读行数」的 `Map<string, number>`（`cursorRef`，`:155`），不是会话级——新分片（游标查不到）从 0 读、旧分片续读。

- **全量读完后回填游标是「增量不退化回全量」的关键**（`renderer/index.tsx:211` + 注释）：首次走全量，全量读完成把各分片当前行数 `cursors.set(s.name, nextCursor(text))` 回填进 `cursorRef`，作为后续增量的起点。切会话/切项目/挂载时游标重置、走全量。

- **触发粒度对齐数据粒度，删掉 400ms 防抖**（`renderer/index.tsx:258-267` 的 `useEffect`）：订阅 `ctx.sessions.onEvent`，过滤 `event.type !== "messageEnd"`、跳过非活跃（`!isActiveRef.current`），命中才 `void incrementalLoad()`。`messageEnd` = LLM 调用完成 = 扩展写完该 seq 配对——数据粒度与触发粒度对齐，替代了 `docs/design/plugin-decoupling.md §6.1` 点名的「messages 流式变化 → 400ms 尾沿防抖 → 全量重读」的赌时序形态（CLAUDE.md §3.6 要消灭的模式）。

- **写盘先于事件到达的时序保证**（`plugin-decoupling.md §6.3`）：扩展的 `message_end` handler 同步写 response 行（写盘在 handler 内完成），底座随后才把事件沿 RPC 事件流发到 renderer 的 `onEvent`——这个顺序由「写盘是 handler 的同步步骤、事件发出在 handler 返回之后」保证，增量读不会读到未写完的半行。

### 5.4 payload 尺寸缓存

- **`payloadSizeOf`（`renderer/index.tsx:171-179`）**：`sizeCacheRef: Map<seq, number>` 按 `seq` 缓存 `byteSize(pair.request.payload)`。日志只追加、同 `seq` 尺寸永不变，所以缓存永不过期；切 `base`/`cwd` 时 `useEffect` 里 `sizeCacheRef.current = new Map()` 重置（`:165-169`）。这是「事件驱动 + 惰性缓存」的典型：只算一次、增量只追加、不重算历史。

### 5.5 渲染：RecordRow 与 RecordModal

- **`RecordRow`（`renderer/index.tsx:38-139`）**：一条记录一行，头部从左到右是展开箭头、`#seq`、时间（`fmtTime`）、轮次/内部调用、status（`pair.response === null` → 灰「未返回」；`status` 非 2xx → 红；2xx → 绿）、耗时、用量摘要（`↑输入 ↓输出 ⇄缓存读`，来自 `peekUsage`）、右侧放大按钮 + payload 字节数。展开后渲染 `RecordDetail`。

- **窄了从后往前逐档隐藏**（`renderer/index.tsx:34-77`）：`MAX_HIDDEN = 3` 档，`ResizeObserver` 监听头部宽度——变宽 `setHidden(0)` 全显、变窄 `forceCheck()` 触发溢出复检；第二个 `useLayoutEffect` 里 `el.scrollWidth > el.clientWidth + 1 && hidden < MAX_HIDDEN` 则 `setHidden(hidden + 1)`。隐藏序从后往前：用量（`hidden < 1`）→ 耗时（`hidden < 2`）→ 轮次（`hidden < MAX_HIDDEN`）；放大按钮恒在第一行不参与隐藏。这是无 JS 溢出检测库下的手写响应式收敛，每个断言落在具体 state 上。

- **`RecordModal`（`record-modal.tsx:38-81`）**：`fixed` backdrop + `stopPropagation` 面板 + Esc/背景/× 三路关闭（`useEffect` 挂 `keydown` 监听 `Escape`，cleanup 移除）。文件头自注与 session-tree 的 fullscreen-map 同款形态。`RecordDetail` 是行内展开与弹窗共用的唯一渲染体（`record-modal.tsx:14-30`）——两处只是容器不同，内容组件同一份，改一处两处同步。

### 5.6 RecorderSettings：统计 + 清理 + 开关

- **统计从 `index.json` 来（`renderer/index.tsx:310-332` 的 `reload`）**：`ctx.config.get<boolean>("recordEnabled")` 读开关（缺省 `true`）；`ctx.fs.readFile(logDirOf(cwd) + "/index.json")` + `parseIndex` 取 `Record<string, SessionStats>`，`Object.values` 聚合会话数/请求数/字节数。读不到（从未记录/刚清理）→ 全零，不报错。

- **开关即时生效走 `saveMode: "manual"`**（`plugin.json` 的 settings 贡献项声明 + `renderer/index.tsx:338-342` 的 `toggle`）：`ctx.config.set("recordEnabled", next)` 直接写、无保存浮层——因为开关要能被扩展在下个请求读到，不能等用户点保存。这是 `SettingsContribution.saveMode` 语义（`contributions.ts:23` 注释「manual = 实时生效，无浮层，仅打开按钮」）在真实插件里的用法。

- **清理两步确认**（`renderer/index.tsx:344-356` 的 `cleanup`）：第一次点 `setCleanArmed(true)`，按钮变 danger + 文案「再点一次确认删除」，第二次 `ctx.fs.removePath(logDirOf(cwd))`（`removePath` 在 `assertProjectPath` 圈禁内天然放行）→ `reload()` 归零。删除走 `fs:project` 声明能力，不走配置通道（日志是数据不是配置）。

## 6 纯函数核心：core/

### 6.1 log-model.ts：解析/配对/游标/分片

- **类型契约（`core/log-model.ts:4-30`）**：`RequestLine`（`seq`/`ts`/`kind:"request"`/`turnIndex?`/`payload`）、`ResponseLine`（`seq`/`ts`/`kind:"response"`/`status?`/`durationMs?`/`message`）、`LogLine = RequestLine | ResponseLine`、`RecordPair`（`seq`/`request`/`response: ResponseLine | null`——null 即孤儿）、`SessionStats`（`bytes`/`requests`/`updatedAt`）。文件头自注「契约与 pi-extension/index.ts 的写入侧一一对应（设计 §3.2/§3.4）」——这是契约单源在「跨进程文件契约」场景的落地：类型各写一份但逐字段镜像，因为两半物理隔离、不能 import 同一份。

- **`parseLogText(text, fromLine = 0)`（`:35-51`）**：按 `\n` split，从 `fromLine` 起逐行 `trim`、`JSON.parse`，校验 `seq`/`ts` 是 number，按 `kind` 分派，坏行（进程崩溃留的半截行）与形态不合法行跳过。`fromLine` 是增量读的游标续读入口。

- **`nextCursor(text)`（`:61-68`）的根因约束**：游标不能直接用 `text.split("\n").length`——split 把末尾 `"\n"` 拆成额外空串元素（`"A\n"` → `["A",""]`），游标恒比真实消费位置多 1，下次增量从「末尾空串之后」开始、真正新增行落在游标之前被跳过、面板状态永不流转。本函数只数非空行，与 `parseLogText` 的 `fromLine`（split index）语义精确对齐。这是有测试钉死的（`log-model.test.ts:4-26`）。

- **`pairRecords(lines)`（`:72-83`）全量配对**：以 `seq` 为键，request 建 pair、response 补 response，孤儿 response（无 request 配对）丢弃，倒序返回。**`mergeRecords(prev, newLines)`（`:92-104`）增量合并**：根因约束是「不能用 `pairRecords(newLines)` 做增量」——request 先落盘、response 后落盘的中间态下，newLines 只有 response 行，`pairRecords` 会把它当孤儿丢弃，面板停在「未返回」永不流转。本函数把新行按 `seq` 写回 `prev`：response 总能命中 prev 里的 request。三个测试用例（`log-model.test.ts:45-79`）覆盖「response 后于 request」「同批到达」「分两次增量」三种时序。

- **`shardNumber(fileName, base)`（`:107-113`）**：分片匹配——`fileName === base` 命中首片返回 1；`fileName` 以 `base` 开头、以 `.jsonl` 结尾、中间 `.\d+` 命中编号分片返回 N；否则 null。`index.json`、无关 `.jsonl`、双后缀都返回 null。这是写侧 `shardPath` 的读侧镜像（首片无编号、编号从 2 起的约定被精确解析）。

- **`parseIndex(text)`（`:122-129`）**：解析 `index.json`，文件缺失/损坏返回 null，调用方按「暂无数据」展示。`SettingsSection` 的 `reload` 里 `parseIndex` 返回 null → 全零。

### 6.2 payload-model.ts：请求/响应体拆解

- **拆解策略是「尽力而为、认不出回退」**（文件头自注 + `describeRequest`/`describeResponse`）：请求体是 provider 原生形状（Anthropic/OpenAI 各有不同，设计 §2.1 明确不归一化），认出 `messages` 数组即按结构化处理，认不出（`recognized: false`）视图退回原始 JSON 墙（`RequestPayloadView`/`ResponseMessageView` 里的 `RawJsonFold`）。`recognized` 是 `RequestView`/`ResponseView` 的判别字段（`payload-model.ts:53/76`）。

- **尺寸一律 UTF-8 字节**（`byteSize`，`:88-96`）：`TextEncoder().encode(JSON.stringify(value)).length`，与落盘行尺寸同口径。文件头自注：面板旧版用 `JSON.stringify` 的字符数当字节数，中文内容系统性偏小，这里修正。`byteSize("中")` 的测试断言是 5（引号 2 + UTF-8 中文 3）。

- **`PayloadPart` 六类块（`payload-model.ts:7-18`）**：`kind: "text" | "thinking" | "toolUse" | "toolResult" | "toolCall" | "other"`，每块带 `bytes`/`title`/`preview`/`raw`，`tool_result` 的 `is_error` 进 `isError`。`blockToPart`（`:154-203`）按 `type` 分派：`text`→`textPart`、`thinking`→思考块、`tool_use`→`toolUse`（Anthropic，`input`）、`tool_result`→`toolResult`（`toolResultText` 抽块数组里 `type:"text"` 的文本做预览）、`toolCall`→`toolCall`（OpenAI，`arguments`）、未知→`other`（不丢信息）。

- **Anthropic/OpenAI 双形状在工具字段上分叉**（`toolName` `:214-221`、`toolBody` `:224-228`）：Anthropic 工具名在顶层 `tool.name`、schema 在 `tool.input_schema`；OpenAI 工具名藏在 `tool.function.name`、schema 在 `tool.function.parameters`。`describeRequest` 里 `const body = toolBody(t); const schema = body.input_schema ?? body.parameters`（`:278-279`）把两种形状归一成同一 `ToolView`。`schemaType`（`:230-238`）把 `array` + `items.type` 折叠成 `array<object>` 这类展示型。测试（`payload-model.test.ts:54-136`）用一份 Anthropic payload 和一份 OpenAI payload 分别钉死。

- **`describeRequest`（`:257-311`）的拆解结果**：`recognized`/`model`/`params`（`KNOWN_REQUEST_KEYS = {model, messages, system, tools}` 之外的键，如 `max_tokens`/`stream`/`thinking`）/`system`（裸 string 或块数组都收）/`systemBytes`/`tools`/`toolsBytes`/`messages`/`messagesBytes`/`totalBytes`。`describeResponse`（`:332-344`）拆 pi 组装态 assistant 消息：`model`/`stopReason`/`usage`（`peekUsage`）/`parts`（`contentToParts`）/`totalBytes`。`peekUsage`（`:314-329`）提取 `input`/`output`/`cacheRead`/`cacheWrite`/`totalTokens`/`cost.total`，任一字段存在才返回 `UsageView`，否则 undefined。

## 7 结构化视图：payload-views.tsx 与 record-modal.tsx

- **把 100KB+ 原始 JSON 墙拆成可折叠组成块**（文件头自注）：请求 = 概览参数 + System + 工具定义 + 消息历史（逐条逐块），响应 = 用量 + 内容块。`Fold`（`payload-views.tsx:71-99`）是折叠单元，`defaultOpen` 控制默认展开；折叠态默认重置——展开记录时组件才挂载，各 `Fold` 内部 `useState` 天然从零开始。

- **markdown 渲染走槽消费、本插件不 import 渲染引擎**（`payload-views.tsx:19-25` 的 `useMarkdownComponent`）：`useBlockRenderers()` 查 `blockRenderers` 槽全部贡献，`resolveBlockRenderer(items, "text")` 按 `(block, name?)` 二键解析取 text 块赢家（即 markdown 插件的 `MarkdownText`），`resolveBlockRendererComponent(item)` 按名匹配插件 exports 里的组件，cast 成 `MarkdownComponent = ComponentType<{text, streaming?}>`。槽中无渲染器（markdown 插件被禁用）时 `useMarkdownComponent` 返回 undefined，`TextBody`（`:136-144`）回退纯文本 `CodePre`——这是软依赖 + 优雅降级，与 file-preview 同款。

- **`RequestPayloadView`（`payload-views.tsx:260-378`）**：先 `describeRequest`，`!recognized` 时提示「未识别的请求体形状」+ `RawJsonFold`；recognized 时渲染 model/params 的 grid（`gridTemplateColumns: "max-content 1fr"`）、System 折叠（`firstLineOf` 做子标题）、工具定义折叠（`ToolBody` 渲染 `description` 走 markdown + `ToolParams` 渲染 `name`/`type`/`required`/`description` 参数表）、消息历史折叠（`roleColor` 给 user/assistant/system 上色，默认展开最后一条消息 `defaultOpen={i === view.messages.length - 1}`）、底部 `RawJsonFold` 保底看原始 JSON。

- **`ResponseMessageView`（`payload-views.tsx:404-433`）**：`describeResponse`，头部 `stopReason` Chip + `UsageChips`（`↑↓⇄Σ` 四指标 + `$cost`）+ 总字节，`parts.map` 的 `PartView`（文本类默认展开、其余默认折叠），底部 `RawJsonFold`。`PartView`（`:163-194`）对 text/thinking 用 `TextBody`（markdown 或纯文本），其余用 `CodePre`（`prettyJson` 美化）；`KIND_LABEL_KEY` 把 `kind` 映射到 `panel.text`/`panel.thinking`/`panel.toolCall`/`panel.toolResult`/`panel.other` i18n key，`partColor` 给 toolResult 的 error 上红、toolUse/toolCall 上主题色。

- **`CopyButton`（`:101-122`）**：`navigator.clipboard.writeText` 写、`done` 态 1.5s 回显 Check 图标、失败静默。`prettyJson`/`paramText`/`safeStringify` 三个纯函数把任意值安全转成可展示文本。`fmtBytes`（`:27-32`）B/KB/MB 三分档，`fmtCount`（`:34-38`）1k 缩写——这两个被 `renderer/index.tsx` 从 `./payload-views` 复用（`index.tsx:19`）。

## 8 槽位贡献

- **三个槽位，一个 data 类、一个 view 类、一个 i18n 类**（`plugin.json:15-97`）：
  - `sidePanel`：`{id:"llm-records", label:"请求记录", icon:"scroll-text", component:"RecordsTab", order:55}`。`label`/`icon` 直接进 manifest（`SidePanelContribution` 契约字段名是 `label` 不是 `title`，`contributions.ts:84`）。`order:55` 排在 token-stats 之类观测类 tab 附近。**无 `revealOn`**——它没有需要「某个 channel 被 emit/invoke 时展开面板」的触发场景，面板靠用户主动点 tab，数据刷新靠 `messageEnd` 订阅（§5.3）。
  - `settings`：`{id:"llm-recorder", title:"请求记录", icon:"scroll-text", component:"RecorderSettings", saveMode:"manual", order:9}`。`saveMode:"manual"` 是关键（§5.6）——开关要即时写、不进保存浮层。
  - `languages`：12 项 = 4 locale × 3 namespace（`llm-recorder.panel`/`llm-recorder.settings`/`llm-recorder.plugin`），`resources` 指向 `./locales/<locale>/<namespace>.json`。`plugin.json` 里的 `displayName`/`description` 中文文案是 manifest 元数据（`PluginManifest.displayName`），而 `plugin.llm-recorder.displayName` 这类 i18n key 是插件管理器列表渲染时 `t()` 查的文案（语言插件供给），两者分层——manifest 值用于无语言包时的兜底。

- **组件自动匹配（§7.4 纪律的落地）**：`plugin.json` 声明 `component: "RecordsTab"`/`"RecorderSettings"`，框架加载 renderer module 后读 `contributes.sidePanel[].component`/`contributes.settings[].component`，在 module 的 exports 里找同名组件自动注册。`renderer/index.tsx` 只 `export function RecordsTab` / `export function RecorderSettings`，不调任何 `registerXxxComponent`——plugin ID、component 名、slot contribution ID 在插件代码里零字面量。

## 9 与其他插件交互

- **结论先行：llm-recorder 是一个「零 channel、零 dependsOn、只消费一个槽」的纯观察者**。它不 `export const channels`（grep 全目录无 `channels` 字样）、不 `ctx.events.emit`、不 `ctx.events.invoke`、不 `ctx.events.on` 任何插件 channel、`plugin.json` 没有 `dependsOn` 字段。它与其他插件的全部耦合只有两条：一条是**槽位消费**（读 `blockRenderers` 槽的 text 块渲染器），一条是**框架系统面订阅**（读框架 store + 订阅框架会话事件流）。这两条都不走事件总线，所以也不需要 `dependsOn`。

- **槽位名：它贡献的槽**——`sidePanel`（contribution id `llm-records`）、`settings`（contribution id `llm-recorder`）、`languages`（namespace id `llm-recorder.panel`/`llm-recorder.settings`/`llm-recorder.plugin`）。这三个槽的消费方是壳框架（右面板框架、设置页框架、i18n 合并器），不是任何具体插件——框架只认槽位契约不认 llm-recorder。所以「谁消费了 llm-recorder 的槽」的答案是「框架」，llm-recorder 不反向依赖任何壳插件。

- **槽位名：它消费的槽**——`blockRenderers`，且只取 `block: "text"` 的通用项（`resolveBlockRenderer(items, "text")`，不传 name，所以是「未声明 names 的通用层」，`block-renderers.ts:48` 的 `generic` 分支）。text 块渲染器由 `markdown` 插件贡献（`src/plugins/sessions/markdown/plugin.json` 的 `{id:"text", block:"text", component:"MarkdownText"}`），组件 props 契约 `{text, streaming}`。llm-recorder 通过 `useBlockRenderers()` + `resolveBlockRenderer` + `resolveBlockRendererComponent` 拿到它，cast 成 `MarkdownComponent`。

- **为什么这是软依赖、不需要 `dependsOn`**：`useMarkdownComponent`（`payload-views.tsx:19-25`）在槽中无 text 渲染器（markdown 插件被禁用/卸载）时返回 `undefined`，`TextBody` 回退 `CodePre` 纯文本呈现——功能不丢、只是少了 markdown 高亮。而 `dependsOn`（`contributions.ts:495` 的 `PluginManifest.dependsOn`）是「凡消费别人的 channel（on 或 invoke）都应声明」的生命周期护栏，管的是事件总线的订阅关系，不是槽位消费。llm-recorder 不 `on`/`invoke` 任何插件 channel，markdown 是槽位软依赖（有则美化、无则降级），因此不声明 `dependsOn` 是契约自洽的，不是疏漏。

- **channel 名：全部为零，且是有意为零**。对照 `docs/design/plugin-decoupling.md §2.2` 的判据——emit 适合「状态变更通知」（payload 是轻量信号，消费者自取数据），invoke 适合「携带参数的命令」。llm-recorder 两样都不需要：它没有要向外界广播的状态（记录数据落盘在文件里，谁要谁自己读），没有要命令别的插件做的事（它自己不渲染进别人的渲染区，别人的渲染区由对方查槽）。它最接近「通知」的一次是 `messageEnd` 到达——但那走的是 `ctx.sessions.onEvent`（框架会话事件流，`packages/shared/src/domain/events/session-state.ts:444` 的 `MessageEndEvent`），不是插件 channel，不归事件总线管，更不归 `dependsOn` 管。

- **框架 store 只读、框架事件订阅**：`RecordsTab`/`RecorderSettings` 读 `useUiStore((s) => s.currentCwd)` / `(s) => s.currentSessionPath`（`renderer/index.tsx:146-147/302`）——这是 `plugin-decoupling.md §2.1` 的「框架 store 只读」手段（数据归框架、多消费方），不是「插件间共享 store 互写」（后者被 CLAUDE.md §8.2 禁止）。`ctx.sessions.onEvent` 订阅的是激活会话视图流（区别于 `onKernelEvent` 的全量 kernel 事件流，后者带 sessionKey、含后台会话——`plugin-decoupling.md §6.2` 明确「记录面板只显示激活会话，用 onEvent 足够」）。

- **契约单源在跨插件面的落点**：llm-recorder 与 markdown 插件之间共享的契约只有一条——`blockRenderers` 槽 text 块的组件 props `{text: string, streaming?: boolean}`（`payload-views.tsx:15` 的 `MarkdownComponent` 本地类型 cast）。这条契约的权威定义在 markdown 插件的 `MarkdownText` 组件与 `BlockRendererContribution`（`contributions.ts:465-477`）的组合里，llm-recorder 不复制一份「text 渲染器的协议」，只 cast——这是「消费而非翻译」原则（§3.1）在槽消费面的体现：主动消费对方吐出的结构化组件，自己决定怎么用（`streaming={false}` 固定传，因为记录详情里是完整文本不是流式）。

## 10 pi 扩展同步机制

### 10.1 manifest 声明 + 生命周期挂摘

- **`manifest.piExtension` 字段（`contributions.ts:507-511`）**：`PluginManifest.piExtension?: string`，插件目录内相对路径（本插件声明 `"./pi-extension"`）。声明后框架在 activate 时把它同步到 `~/.pi/agent/extensions/<pluginId>/`，deactivate/uninstall 时摘除——这是「内容插件私货的生命周期通道」，区别于 toolgate 等内核基础设施的 bootstrap 常驻同步（`contributions.ts:507-511` 注释明说）。

- **生命周期接线（`src/server/application/lifecycle/index.ts:102-104/126-128`）**：`activate()` 在 `registry.registerOne` + `loader.load` 之后，`if (deps.piExtensionEnsure && manifest.piExtension)` 调 `piExtensionEnsure.onActivate(manifest.id, pluginPath, manifest.piExtension)`；`deactivate()` 对称调 `onDeactivate(pluginId)`。`PluginLifecycleDeps.piExtensionEnsure` 是接口（`:80-83`），实现在 `client/pi`（写内核目录是流出适配），此处只持接口——依赖倒置，与 `skillsEnsure`/`dshExtensionEnsure` 同一形状。

- **装配（`src/server/bootstrap/assemble.ts:363-370`）**：`pluginPiExtensionEnsure` 把接口绑到 `syncPluginPiExtension(pluginId, join(pluginPath, piExtension))` / `removePluginPiExtension(pluginId)`，经 `controllers/plugins.ts:39` 注入 lifecycle。启动对账在 `assemble.ts:601-614`：遍历非禁用插件，声明了 `piExtension` 的 `syncPluginPiExtension(id, resolve(plugin.path, rel))`，最后 `reconcilePluginPiExtensions(active)` 摘孤儿。

### 10.2 安装器：marker 纪律 + 入口声明

- **`src/server/kernel/pi/extension/pi-extension-installer.ts` 的四个导出**：`syncPluginPiExtension`（`:64-99`）、`removePluginPiExtension`（`:102-113`）、`reconcilePluginPiExtensions`（`:117-135`）。常量 `EXT_ROOT = ~/.pi/agent/extensions`（`:20`）、`MARKER_FILE = ".my-harness-desktop-plugin"`（`:21`）。

- **marker 纪律（文件头 + `hasMarker`/`removePluginPiExtension`）**：同步完成的目录里写 `.my-harness-desktop-plugin` 标记文件（内容为 pluginId）。摘除与启动对账只碰带 marker 的目录——用户在 `extensions/` 下手装的同名目录不被误删；同步时目标已存在但无 marker（用户同名扩展）则 `console.warn` 跳过、不覆盖用户数据（`:80-83`）。这是「无特权差异 + 不破坏用户数据」在流出适配层的落地。

- **入口声明收敛到壳子一层**（`kernel-extension.ts:21-43` 的 `findExtensionEntry`）：递归扫目录找入口文件，优先 `index.<ext>`、否则字典序第一个匹配文件。pi 侧壳子扫 `.ts/.js` 生成 `package.json` 声明（`patchPackageJson`，`:51-61`，写 `pkg.pi.extensions = ["./<entry>"]`），dsh 侧壳子扫 `.mjs` 写 cordis.yml——两个内核都改为「被壳子声明」，发现逻辑单一来源。本插件的 `pi-extension/` 只有一个 `index.ts`，`findExtensionEntry(sourceDir, [".ts",".js"])` 直接命中它。

- **diff 跳过 + 异常兜底**：`dirSignature`（`:32-48`）算目录内容签名（相对路径 + 文件内容全量拼接，跳过 marker 与 package.json），签名相同则 `{changed:false}` 直接返回，避免每次 activate 都重拷。任何异常 `catch` 后 `console.error` + 返回 `{installed:false}`，不 crash——扩展同步失败只记日志，插件本体照常加载（文件头明说）。

### 10.3 时序约束：启用/停用都只对新会话生效

- **pi 的 extension loader 只在 spawn 时扫一次 `~/.pi/agent/extensions/`**（`pi-extension-installer.ts` 文件头 + 设计 §5.3 引 toolgate-installer 同款注释）：已在跑的 pi 进程不热更。推论：插件启用后，新会话立即开始记录，已在跑的会话要重启（新开或 fork）才记录；停用/卸载方向对称——摘除目录后新 spawn 进程不再加载它即停记，但已在跑的进程内存里仍持有 extension 代码，记到进程自然退出。

- **这与记录开关形成两条时间线，设置页如实提示**（`settings.timingNote`）：记录开关（`ctx.config` 写 `recordEnabled`）是运行时行为，下个请求生效；插件启停是进程生命周期行为，只对新会话生效。想立刻停记正在跑的会话，用开关不用等进程退出（§4.6）。

## 11 权限与安全边界

- **`permissions: ["fs:project"]`（`plugin.json:12-14`）是唯一声明能力**：renderer 读日志、清日志全走 `ctx.fs`，每条调用都在 IPC 边界被双重校验——`registry.assertPermission(pluginId, "fs:project")` 检查 manifest 声明 + `assertProjectPath(raw)` 圈禁路径（`src/server/controllers/fs-git.ts:17-32`）。圈禁是 fail-closed：无激活 cwd 拒绝、`resolve` + 前缀检查防 `..` 逃逸。日志落在 `<cwd>/.my-harness-desktop/llm-logs/` 天然在项目根内，读删零新 IPC。

- **除 `fs:project` 外零权限、零持久化声明**：本插件不用 `git`/`llm:oneshot`/`rpc:bash` 等声明能力，读框架 store（`useUiStore`）和订阅 `ctx.sessions.onEvent` 是核心默认能力（所有壳插件可用，不需声明）。它也不声明 `configFile`（settings 贡献项没有 `configFile` 字段，`SettingsContribution.configFile` 可省）——开关走 `ctx.config` 运行时通道，不做框架 save/dirty 管线。

- **写半的安全保证在底座进程内、读半的暴露面是项目目录**：写半不碰 `before_provider_headers`（§4.7）；读半只读文件、不写日志（唯一的「写」是 `ctx.config.set` 写自己的开关，和 `removePath` 删自己的日志目录）。两半合起来的威胁模型是：第三方若拿到项目目录就能读到日志里的完整对话内容——所以 `settings.sensitiveNote` 提示 `.gitignore`，但不替用户改。

## 12 QA

**Q：llm-recorder 为什么不走事件总线，不声明任何 channel？**

它是纯观察者，不是生产者、不是命令发出者。它记录的数据落盘在文件里，谁要谁自己经 `fs:project` 读；它不往别人的渲染区塞 UI（markdown 渲染走 `blockRenderers` 槽消费），不命令别的插件做动作。唯一接近「通知」的 `messageEnd` 走 `ctx.sessions.onEvent` 框架会话事件流（`packages/shared/src/domain/events/session-state.ts:444` 的 `MessageEndEvent`），不是插件 channel，不归事件总线、不归 `dependsOn` 管。对照 `plugin-decoupling.md §2.2` 的 emit（状态广播）/invoke（带参命令）分工，两样它都不需要，所以零 channel 是判据推出来的结果，不是「没来得及加」。

**Q：markdown 插件被禁用后，llm-recorder 的详情视图会坏吗？**

不会。`useMarkdownComponent`（`payload-views.tsx:19-25`）查 `blockRenderers` 槽的 text 块，`resolveBlockRenderer(items, "text")` 拿不到渲染器（markdown 被禁用）时返回 `undefined`，`TextBody`（`:136-144`）回退 `CodePre` 纯文本——功能不丢、只少 markdown 高亮。这是软依赖 + 优雅降级，所以 `plugin.json` 不需要 `dependsOn: ["markdown"]`：`dependsOn` 管的是「on/invoke 别人的 channel」的订阅护栏，槽位软依赖不在其语义内。

**Q：底座进程重启后，为什么旧记录不会被新记录的 `seq` 碰撞顶掉？**

`seq` 不是纯进程状态。`ensureSeqBaseline`（`pi-extension/index.ts:217-228`）在进程内首次接触某会话时，`initShard` 扫该会话已有分片、`maxSeqInText` 取磁盘最大 `seq`，把全局 `seq` 抬到该值，再 `++seq` 分配新号。读侧按 `seq` 配对，所以重启续写不会顶掉旧记录。`extension-flow.test.ts:72-90` 用两个假 pi 实例（模拟进程重启）钉死了「新实例续到 3、读侧得到 `[3,2,1]`」。

**Q：增量读的游标为什么不直接用 `split("\n").length`？**

`split("\n")` 会把末尾 `"\n"` 拆成额外空串元素（`"A\n"` → `["A",""]`），游标恒比真实消费位置多 1，下次增量从「末尾空串之后」开始、真正新增行落在游标之前被跳过、面板永不流转。`nextCursor`（`log-model.ts:61-68`）只数非空行，与 `parseLogText` 的 `fromLine`（split index）语义精确对齐。`log-model.test.ts:4-26` 把这个根因钉成了断言。

**Q：记录的响应是模型返回的原始数据吗？**

不是原始 SSE 流，是底座把流逐 token 拼完、工具调用解析完之后的组装态 assistant 消息（content + toolCalls + usage）。`after_provider_response` 触发时响应流还没被消费，hook 只给 status 和 headers，拿不到 body——wire-level 抓包请用 HTTP 代理，本插件的定位是会话调试面板，组装态对「模型答了什么」是完备答案（设计 §2.2、§6.3）。

**Q：卸载插件后，磁盘上已写好的日志会被删吗？**

不会，这是设计决策不是遗漏。生命周期挂摘只摘 `~/.pi/agent/extensions/llm-recorder/` 里的 extension 代码（`removePluginPiExtension`），`<cwd>/.my-harness-desktop/llm-logs/` 下的日志原样保留——日志是用户的项目调试资产，框架不替用户做「卸载即焚」。想删，去设置页点清理按钮（`RecorderSettings.cleanup`，两步确认后 `ctx.fs.removePath` 删整个目录）。

**Q：我在文件管理器里手动删了某个会话的日志文件，为什么设置页统计没变小？**

`index.json` 是增量统计：`updateIndex`（`pi-extension/index.ts:151-171`）只在扩展写行时更新对应会话桶，不做全量对账。手动删单文件留下残留统计，直到整目录清理后重建。这是有意接受的漂移——统计是量级参考不是账本，为它对账要扫读全部日志，恰恰违背设 `index.json` 的初衷。正确清理路径只有设置页整目录清。

**Q：这个插件的记录对 dsh 内核生效吗？**

不生效，且是显式缺席而非静默失败。llm-recorder 的四件套只有 `pi-extension/` 没有 `dsh-extension/`——「记录每次 LLM 请求体」依赖底座进程内的 provider hook（`before_provider_request` 等），dsh 内核（Cordis 插件树）不暴露等价的请求体 hook 面，本插件对 dsh 无贡献。多内核默认纪律下，这是「适配器翻译/内核补面/显式降级」三分法里的显式降级：能力入口只对 pi 有意义，不伪造、不静默。将来若 dsh 提供请求体观测 hook，可加 `dsh-extension/` 对称补面。
