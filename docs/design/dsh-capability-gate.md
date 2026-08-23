# dsh 内核能力门槛：探测、降级与按需调用

## 1. 问题：桌面盲调了一套装上的 dsh 没有的能力

先立一个立足点，后面不再解释：本项目是一个桌面壳，通过一份中立契约 `BaseBackend` 同时托管两个同级内核——pi 和 dsh。每个内核交一个适配器（`PiBackend` / `DshBackend`），把内核专属形状翻译成中立契约。本文只谈 dsh 这一侧，具体谈一件事：桌面假定 dsh 有某些能力，而装上的 dsh 可能没有，这个 gap 怎么处理。

现象锚点。壳的 IPC channel `session:setModel`（冒号是 IPC channel 的命名约定）报错，正文却是 `unknown DeepSeek Harness SDK runtime method: session/seed`（斜杠是 JSON-RPC 方法名的命名约定，两套命名不是笔误）。完整调用链是：`SessionStore.setModel`（壳侧的切模型编排方法，注意它和 IPC channel `session:setModel`、JSON-RPC 方法 `session/setModel` 是三个不同东西）→ 经 `ModelCatalog`（模型清单，每条带内核归属）反查出这个模型属于 dsh → `switchKernel("dsh")`（跨内核切换编排）→ `DshBackend.seed` 发 `session/seed` → 运行时回了 unknown-method。seed 是"把一段中立会话历史灌进内核"的动作，这里被种进了一个没有这套方法的 dsh 里。

根因是版本错位。deepseek-harness 仓库的 master 源码里，SDK server（`packages/sdk/server/src/server.ts`，这个路径在 deepseek-harness 仓库，不在本仓库）已经补齐 18 个 request 方法：`initialize`、`session/prompt`、`session/fork`、`session/getEntries`、`session/getTree`、`session/bookmark`、`session/resume`、`session/abort`、`session/setModel`、`session/seed`、`session/list`、`session/get`、`session/delete`、`session/deleteBookmark`、`session/rename`、`session/updateHeader`、`session/projectStats`、`shutdown`；`session/seed` 由 commit `818e24e415` 加入。除此之外还有 `session.event`、`session.status`、`session.created` 这类**通知**（服务器推客户端的，不计入 request 方法数）。但 npm 的 `next` dist-tag（发布标签）还停在 `0.1.1-rc.2`，那个版本只有 `initialize`/`session/prompt`/`shutdown` 三个 request 方法。桌面 `DSH_SPEC`（dsh 内核的安装规格）里 `distTag = "next"`，装的就是这个旧版。

入口没接错。`dsh-jsonrpc-agent`（SDK server 的可执行入口）就是"给外部进程驱动 dsh"的 rpc 入口，桌面接对了。缺的不是入口，是"装上的 dsh 到底有哪些方法"这份契约——桌面代码按 master 写，装的却是旧发布版，二者之间没有一道能力门槛挡着。

## 2. 入口钉死：SDK server 是 rpc 入口，dsh CLI 不是

dsh 有两个入口，分工不能混。`dsh` CLI（deepseek-harness 仓库的 `apps/cli`）是 profile 启动器，三个 profile 全给人：`web`（dsh 自己的浏览器 UI）、`tui`（终端）、`headless`（一次性任务）。它没有给外部进程用的持久 stdio 协议，桌面不该接它。

SDK server（`packages/sdk/server` + `jsonrpc-demo`，后者就是 `dsh-jsonrpc-agent` 这个 bin）才是外部入口，它的 README 原话是 "Serves out-of-process SDK clients over stdio JSON-RPC"。这就是 pi `--mode rpc` 在 dsh 侧的对等物——pi 是另一个内核，桌面靠它的 CLI rpc 模式接入；dsh 靠 SDK server 接入。桌面要的"起进程、发请求、收事件"，它一条不少。

推论是桌面消费 SDK server 的原生协议（`initialize` → `session/prompt` → `session.event` 通知），不包 dsh 的 `web` UI。这条现在没漂，写在这里是为了防止后面又有人把 `dsh --profile web` 当成接入点。

## 3. 能力探测：桌面要知道装上的 dsh 有哪些方法

现状是盲调。`DshBackend` 的 `seed`/`fork`/`getTree`/`getEntries`/`bookmark`/`resume`/`abort` 全是不加甄别地发 request，没有探测、没有门槛、没有缺面清单。装上 3 方法的旧运行时，任何一条都裸炸 unknown-method。`session/setModel` 是唯一的例外——它有个 catch 把 unknown-method 吞成 no-op，那是另一类问题，见 §4。

探测是两层，不是先后两段。别把"近期惰性、终态主动"读成两个阶段——它们是同时存在的两层：

- **eager 层**（依赖 deepseek-harness 改 `initialize` 结果返回能力图）：启动握手后一次性拿到能力图——"方法名 → 是否支持"的映射，形状由 deepseek-harness 定、桌面只消费——缓存进 `capabilities`，启动就知道缺哪些。
- **lazy 层**（不依赖任何外部改动，现在就有）：对 eager 层没覆盖到的方法，按需调用。枚举范围就是 §1 列的 18 个 request 方法；判别靠 "unknown method" 这个错误文本——它自带方法名（`unknown ... method: session/xxx`），据此定位到具体缺哪一个，记进缺面清单，本进程内之后不再调。

两层并存，有 eager 就用 eager，没有就全靠 lazy。所以不存在"惰性发现要撑多久"的过渡期——lazy 是永久地板，eager 是加速层；deepseek-harness 把能力图发出来只是让"失败才知道"变成"启动就知道"，lazy 永远留作兜底。

版本号比对这条路走不通，别走。`initialize` 响应的 `serverInfo.version` 现在硬编码 `0.0.1`，拿它做门槛是假的；npm 版本号也在漂——本地 master 的 server 是 `0.1.0-rc.5`、发布的 `next` 反而是 `0.1.1-rc.2`，patch 位数字大的那个反而是旧的（rc 位又指向相反方向），两个数字互相矛盾，根本没法拿来做门槛。靠行为（有没有这个方法）判，不靠版本号判。

## 4. 显式降级：缺了的方法怎么办

缺面的时序先说死，否则"入口置灰"和"惰性发现"会打架。没有 eager 能力图（纯 lazy）时：入口一开始不灰，用户第一次点 fork → 发 `session/fork` → 收到 unknown-method → 转成一条清晰报错（"该 dsh 内核版本不支持 fork"）→ 记缺面 → 该入口从此置灰。第一次点击会先吃一次清晰报错，之后才灰。有 eager 能力图时：启动即知，入口一开始就灰，用户根本点不到。两种形态的差别只在于"第一次点击之前知不知道"，降级结果一致。

`seed` 缺面的后果要写死。pi→dsh 且有真实历史时缺 `session/seed` = 无法跨内核迁移，显式报错"dsh 内核版本过旧，缺 session/seed，无法跨内核迁移历史"。没有"先把历史导出、再换别的机制灌进 dsh"的兜底——唯一出路是装一个带 `session/seed` 的新版 dsh。空会话不受影响，因为它根本不会走到 seed（§5）。这是显式接受的边界，不是遗漏。

`session/setModel`（JSON-RPC 的运行时切模型方法）的静默吞要收口。现在的 catch（`dsh-backend.ts:135`）把 "unknown ... method" 当 no-op，模型没切成功但桌面当成功，用户零感知——这违反"不静默、不伪造成功"。改成记 warn 加上报 kernel 事件，UI 有机会提示"该 dsh 版本不支持运行时切模型"。顺带说明：dsh 的模型是 `initialize` 握手时定的，惰性创建的会话自然用握手时的 provider/model，所以运行时 `session/setModel` 缺面时，模型停在握手定的值，不算崩，只是"选中的模型没生效"这件事必须让用户看见。

缺面清单的事实归属、形状与跨进程通道。清单由 `DshBackend` 持有并上报——只有它知道 `session/xxx` 这些内核专属方法名。形状上，`capabilities` 是每内核各报各的：pi 报"全量具备"，dsh 报"缺了哪些"（同样是一份"方法名 → 是否具备"的映射）；壳读的是同一份 `capabilities`，不按 `kernel === "dsh"` 硬分支，所以 pi/dsh 无特权差异不破。跨进程上，这份清单经既有 kernel 事件通道从 main 进程广播到 renderer，payload 就是缺面方法名清单，UI 订阅后按能力键置灰对应入口——不是 UI 直接读 main 侧的 backend 对象，中间隔着 Electron 进程边界，走事件通道。能力键与具体 UI 入口的对应关系属 UI 插件内容，不在本文档范围。

## 5. 按需调用：不该发的方法不发

先定义贯穿全节的判据，避免"空会话/无内容/有历史"三个词漂移。`lineage` 是会话里的一条线性历史；`session.lineages` 为空 = 空会话 = 无历史可搬；非空 = 有真实历史。下文所有"要不要 seed / 要不要起 pi"的判断都用这一个标准，不再引入第二个词。

空会话跳过 seed。`switchKernel` 现在无条件 `await newBackend.seed(session)`（`session-store.ts:721`），空会话也发 `session/seed`——没东西可灌却硬灌，这正是本次报错被触发的直接路径（根因仍是 §1 的版本错位，跳过空 seed 只是让这条路径不再撞上缺口）。加一个"空则跳过"，直接起目标内核。会话标识不受影响：dsh 的会话标识就是桌面传入的 `sessionId`（初始是 cwd 的桶名，即项目目录映射成的会话标识），服务端在首次 `session/prompt` 时惰性创建；`seed` 返回的是服务端重绑后的 id，跳过了 seed，桌面就继续用自己的 `sessionId`，服务端照样惰性创建。所以"直接起目标内核"不缺会话标识，缺的只是"把历史灌进去"这一步——而空会话本就没历史可灌。

`SessionStore.setModel`（壳侧的切模型编排）先路由再起进程。现在它先 `ensureForSend()`（发送前保证进程在跑，会起 pi）再 `ModelCatalog` 反查路由（`session-store.ts:978 → 988`），选 dsh 模型会先起一个 pi 空壳再切走。改成先反查目标内核：目标 ≠ 当前 且 无历史（`session.lineages` 为空）时，直接以目标内核建 proc，不起 pi；有历史时才走 §1 调用链里的 switchKernel + seed 编排（seed 缺面时的后果见 §4）。

这三节是一体的：探测解决"有没有"，按需调用解决"要不要"，降级解决"没有还要时怎么办"。三者合起来才是完整的能力门槛——不是把 seed 的报错补个 catch 了事。

## 6. QA

**Q：seed 缺面时，pi 的历史就彻底迁不过去了吗？**
A：对。没有"导出→再灌"的兜底，唯一出路是装一个带 `session/seed` 的新版 dsh。桌面侧把这件事显式报出来，不假装能迁。这是显式接受，不是遗漏。

**Q：惰性发现下，用户第一次点 fork 会先报错吗？**
A：会。纯 lazy 阶段，第一次点击先吃一条清晰报错（"该 dsh 内核版本不支持 fork"），该入口随后置灰。这是 lazy 的固有代价；eager 能力图落地后变成启动即灰。

**Q：缺面清单是"永久"的吗？升级 dsh 后会自动恢复吗？**
A："永久"只指当前 dsh 进程的生命周期。dsh 是每会话一进程，重新 spawn 即重新探测，升级后新起的进程自然按新版本重新报能力。不落盘、不跨进程。

**Q：为什么不用版本号做门槛？**
A：`initialize` 的 `serverInfo.version` 硬编码 `0.0.1`，且 npm 版本号在漂（本地 master `0.1.0-rc.5` vs 发布 `next` `0.1.1-rc.2`，patch 位和 rc 位两个数字方向相反）。版本号不可信，只能靠运行时行为判。

**Q：setModel 缺面时，模型到底切没切？**
A：没切。模型停在 `initialize` 握手定的值。桌面记 warn + 上报事件提示"该 dsh 版本不支持运行时切模型"，不静默、不假装成功。

**Q：capabilities 扩展成能装 dsh 能力面，pi 侧要动吗？**
A：pi 侧不动，它报"全量具备"。能力面是每内核各报各的，壳走同一读取机制、不 special-case，pi/dsh 无特权差异不破。

**Q：空会话跳过 seed 后，dsh 的会话标识从哪来？**
A：桌面传入的 `sessionId`（初始是 cwd 桶名），服务端首次 `session/prompt` 惰性创建。跳过 seed 不缺标识，只是少了"把 pi 历史灌进去"这一步。
