# 文档 vs 代码 全量审计报告（2026-10-02）

**任务**：扫描 pi-desktop 全部文档，对照真实代码，找出 gap、错误与问题。
**范围**：docs/ 193 篇（架构根 16 + design 81 + plugins 52 + legacy 36 + 其他）+ CLAUDE.md（99KB）+ README.md/README_zh.md + 代码注释反向核对。
**方法**：10 组并行审计（每组只读、双证据制——文档行 + 代码行），主线独立复核全部 H 级发现 + 三处争议裁决。定稿后又拉 6 个**对抗性交叉验证组**（54 条抽样断言、每条"先证伪再判"）——结果：约 84% 完全确认；**本报告自己被推翻 2 处计数误报**（AbstractBackend 14 abstract 非 15——初版抄了基类自己的 stale 注释；PiBackend implements 9 面——CLAUDE.md 本是对的）、1 处误撤（glossary:66 "14 条为准"是对的）；4 条收窄口径（ref-audit 例外、docs/design/ 冤案、同名对 10 对、legacy 归档对应一半）；5 条带新事实升格（runBash 前端也无门+守卫测试引用不存在的门、setModel 有历史也已开放切换、audit ⑧⑪⑬三处齐漏 probe4、假绿豁免 27.8% 量化、行号锚 1893 处 4/4 漂）。全部修正已就地回写。
**基线**：main = 2c4949d21 的工作树（含未提交改动）。五个阻断型机器审计全绿——audit:docs（退役符号 392 处命中 0 未标注）、audit:refs（1044 处引用 0 断链）、audit:deps（十三检验 0 违规）、audit:quiet（三检验 0 违规）、audit:session-scope（四检验 0 违规）；报告型 audit:symbols 有 349 个候选（12 个优先级）。

**总体结论先说**：这套文档的"历史标注纪律"执行得比绝大多数项目好（392 处退役符号命中全部带标记、1044 处交叉引用零断链、38 原则/18 反模式自洽、50 插件 1:1 文档对应）。但机器绿 ≠ 语义准——本轮挖出 **79 组 H/M 级语义漂移**（37 组硬伤 + 42 组中伤，每组带双证据、部分覆盖多处行），集中在五个根因模式（§4）；另有文档审计照出的 **7 项代码侧真问题**（§3，含 1 个权限门缺失）与 **6 项守卫自身盲区**（§5）。

---

## 1 最重要的发现（如果只修十处）

| # | 位置 | 问题 |
|---|---|---|
| 1 | 各文档 `capabilities.pi/.dsh`、`KernelId="pi"\|"dsh"`、`KERNEL_IDS` | 旧多内核模型当现状讲，遍布 glossary/core-design/thin-shell/desktop-understanding（8 处）/CLAUDE.md（3 处）。真实代码：`KernelId = string`、11+1 轴能力面 |
| 2 | CLAUDE.md:9 `resume` 六核心、:630/:685 | resume 已于 r72 从契约整体删除（backend.ts:99 5 行删除注释），CLAUDE.md 三处仍当核心意图讲 |
| 3 | "31 命令"（CLAUDE.md×4、pi-backend.ts:3、versions.ts:9、README×2、desktop-kernel、session-flow）| 实测：RpcCommand 联合 **29**、FALLBACK_COMMAND_SET **28**、构造器 **21**。文档体系内五种说法互不一致 |
| 4 | "continue 第八意图/continue? 缺面默认"（session-flow §10.2 全节、directory-structure:131、desktop-kernel:87、core-design:46） | `continue` 是**幽灵成员**：契约无、两后端无、SessionStore 无。续跑=发消息（纯插件层） |
| 5 | `assemble.ts:352-379 pluginPiExtensionEnsure` | 四篇"现行文档"教已死符号与行号（assemble 已瘦身 82 行 → boot/steps 14 步），含教学文档 add-new-kernel.md:324 与 new-plugin/goal/llm-recorder/read-claude-md/plugin-manager：`extensions:{内核id:路径}` + `createPluginExtensionSync()` 才是现状 |
| 6 | docs/README.md 插件清单 | 列了不存在的 dsh-manager/pi-manager；漏 kernels/ 域四篇；"旧文档"段五条路径全过期（docs/core、docs/desktop 已迁 legacy） |
| 7 | new-plugin.md:20/:114/:165/:533 | **教学文档教错误样例**："llm-recorder 无 dsh-extension/、goal 无 locales（反例别学）"——两者都有；`description:` 中文直填（实为 descriptionKey）；`parentPathKey/customKey`（实为 parentPathField/customField）——照抄全部过不了类型 |
| 8 | switchKernel gate | `switchKernelEnabled = true` 已翻（session-store.ts:195），三篇架构文档仍说"gate 死/暂缓/抛错" |
| 9 | README 双语 Node 版本门槛 | "Node.js 18 or higher（electron-vite 的要求）"——electron@43 实测要求 **>= 22.12.0**，electron-vite 要求 ^20.19.0 \|\| >=22.12.0；CI 用的 node 22 |
| 10 | legacy 层 18/36 篇无历史横幅 | 半数冻结归档（i18n.md 教 `window.pi.*`、pi-manager.md 教 `usePiApi()`）既无标注也不被 audit 扫描 |

**突出代码缺陷（文档照出，经交叉验证升格）**：`IPC.session.runBash` **全链路无门**——服务端 handler（sessions.ts:171）无 assertPermission、前端也无门（`usePluginContext` 从未暴露 bash 面，`window.kernel.sessions.runBash` 裸暴露给任意 renderer 代码）、中央网关（gateway.ts:50-66）无 per-channel 权限策略；且 **capability-axis-consumers.test.ts:58 这个守卫测试本身在引用一个不存在的门**。pluginId 根本不进 handler 签名（`(conn, command)` 首参之外无 caller 身份），修门需同时补 caller 传递链。详见 §3。

---

## 2 发现清单（编号条目 87 组：H 37 / M 42 / L 8，多组条目覆盖多处行——逐条明细见工作底稿；行号为本轮实测）

### 2.1 CLAUDE.md（纪律总纲，漂移密度最高的单文件）

| 级 | 位置 | 断言 | 实际 | 证据 |
|---|---|---|---|---|
| H | :361 | `kernel.ts（KernelId = "pi"\|"dsh" + KERNEL_IDS）` | `KernelId = string`（kernel.ts:12），KERNEL_IDS 已删，清单由 KernelRegistry 驱动 | kernel.ts:5-14 |
| H | :391/:59 | §6.3 检验①"字面量联合收敛 kernel.ts 一处"+§1.3 判别气味同判据 | 该判据已随插件化废止，与 :361 一起构成自相矛盾（kernel.ts 注释明说"历史纪律已废止"） | kernel.ts:5 |
| H | :9/:630/:685 | resume 列六核心意图/"dsh 覆盖 pi 不实现"/"别家锚点报错留演进" | resume? r72 已删（无内核实现），锚点重启走 SessionStore.resume 中立层派生，无报错路径 | backend.ts:99-112、dsh-backend.ts:371 |
| H | :137/:155/:325/:369/:693 | "JSONL 31 命令"（5 处） | 联合 29 / FALLBACK 28 / 构造器 21（详见 §4 模式 B） | rpc-types.ts:89-118 |
| H | :90/:475 | `capabilities`"十一个轴" | **12** 成员（含 r50 新增 `systemPrompt?: boolean`），列举漏 systemPrompt | backend.ts:346-378 |
> **【交叉验证更正】** CLAUDE.md:369 "implements 九个中性能力面接口" 经复数**是对的**（pi-backend.ts:104-107 逐数恰 9 个：Steering/Retry/Compaction/Snapshot/Stats/ModelCycle/ToolExec/BusFrame/QuestionChannel；thinking 走基类 override）。初版曾误报为 8——已撤销该发现。真正的漂移点在**计数口径**本身而非此条。
| H | :501 | systemPrompts"dsh 走 cordis" | dsh/minimal/probe4 **零 systemPrompt 消费**（静默缺面）；只有 pi 声明 systemPrompt:true | grep dsh/ systemPrompt = 0；backend.ts:365-370 |
| M | :9 "14 必实现 + 3 缺面默认 + 3 默认成员" | 口径无需改但全仓另有四个互相矛盾的口径（见 §4 模式 A） | abstract-backend.ts:57-133 |
| M | :321-344 目录树 | 漏 probe4/（真实内核目录）、kernel/ 根两个跨内核测试、pi/backend 的 rpc-adapter.ts/resync.ts/pi-legacy-sessions.ts、model/known-tools.ts；test-plugins 只提 minimal 漏 probe4 | ls 实测 |
| M | :8 术语表 | dsh 插件树举例"llm-deepseek" | 生产代码零引用（仅测试）；活跃插件 subagent/compaction-basic/credentials-local；漏提统一适配插件 my-harness-fit-dsh-extension | dsh-config-source.ts:28-39 |

核过为真（抽样）：十三检验、50 插件分域数、audit 全部 npm scripts、双入口零内核 import、事件总线 channels 机制、已知偏离自陈（THEME_TOKEN_DEFAULTS/roleToPrompt 仍真）、`~/.pi/agent/extensions`/`~/.dsh/.my-harness-desktop-plugins` 安装路径、五能力 fit-pi-extension（toolgate/context-probe/bus/subagent/skills）。

### 2.2 docs 根架构文档（声称"以当前真实代码为准"的主文档集）

| 级 | 文档:行 | 断言 | 实际 | 证据 |
|---|---|---|---|---|
| H | glossary.md:48 | KernelId 字面量联合，"全仓唯一字面量之处" | = string（同 CLAUDE.md:361） | kernel.ts:12 |
| H | glossary.md:50 | 能力探测经 `capabilities.pi/.dsh` | 逐轴 BackendCapabilities（11+1 轴） | backend.ts:346-378 |
| ~~H~~ | glossary.md:66 | ~~"以代码（14 条 abstract）为准"是错句~~ | **【交叉验证更正】初版误报**：这句是对的（abstract 实数 14，"15"才是 abstract-backend.ts:37 的 stale 注释）——撤销本条。glossary 真正的错误在 :15 "4 缺面默认"（实为 3）与 :11 "六域"（漏 kernels） | abstract-backend.ts:37（stale 出处） |
| H | desktop-understanding.md:62 | "assemble.ts 706 行全是构造+绑定" + §2.1 时序图画进 assemble 内部 | assemble 仅 **82 行**；启动编排已重构为 boot/steps/ 14 步 + runColdBoot | assemble.ts:1-82 |
| H | desktop-understanding.md:109/:113/:290/:476 | 禁用插件"注册后撤 + i18n 多合并无害" | 发现即过滤**根本不注册**（40-shell-plugins.ts:69-77，头注释点名旧做法被推翻） | 40-shell-plugins.ts:69-77 |
| H | desktop-understanding.md:157/:185/:239/:243/:388/:438/:460/:464（8 处）+ :428/:484 | capabilities.pi 类型守卫全家；"assemble 经 kernel/factories 唯一 import 具体内核" | capabilities.pi/BackendExtensions 桶整体退役（生产 0 命中）；factories 已删、装配零具体内核 import | backend.ts:332-360、pi-backend.ts:120-134、kernel-plugin-loader.ts |
| H | session-flow.md:59-61/:185/:431/:444-451/:482/:533（含 §10.2 全节） | "continue 第八意图"：契约缺面默认、pi 翻译 followUp、dsh session/continue | **幽灵成员**（见 §4 模式 C 续） | backend.ts 全文、abstract-backend.ts:39 |
| H | session-flow.md:231 | "31 个命令闭联合"且列 fork/clone/get_fork_messages/export_html | 联合 29；四命令全不在（forkless 已删） | rpc-types.ts:89-118 |
| H | session-flow.md:348/:537 | withNeutralEntry 翻译器代投 entryAppended（QA"现在怎么修的"） | 已删；现状主侧写穿 writeThroughMessageEnd，entryAppended 降级回填/补漏 | dsh-event-translator.test.ts:316、session-store.ts:1451/:3002/:1406 |
| H | desktop-understanding.md:390-397 + session-flow.md:406-420（两篇共通最大漂移） | renderer `applyEvent` 纯函数 per-messageId patch + entryAppended 两段制水合 | 前端已重构为**中立层镜像 + 执行态叠加层**（applyNeutralChange 归约内容 / applyOverlayEvent 只管执行态） | src/web/stores/neutral-mirror.ts:1-14、session-store.ts:73-129/:877-879 |
| H | core-design.md:46/:57 | resume? 可选意图两大段 | 同 CLAUDE.md:9——r72 已删 | backend.ts:99-112 |
| H | core-design.md:68 | `capabilities: { extensions?: unknown }` 桶 | 同文 :238 自己写对"已退役"——首尾自相矛盾 | backend.ts:332 |
| H | session-mapping.md:101/:319 | `createPiBackend`（kernel-factories.ts:38-52） | 文件已删；实在 pi-backend-factory.ts:45。:11 同句先说 factories 已删又指 factories——自相矛盾 | ls kernel/factories = 无 |
| H | model-switching.md:198/:200/:225/:347 | "9.2 跨内核切换：gate 关闭中"（`switchKernelEnabled = false` 关掉、入口 gate 死、"有历史锁死"） | `switchKernelEnabled = true`（session-store.ts:195），七步切换对有历史会话已生效，文档引用的 `session-store.ts:185/:974` 行号也已漂移 | session-store.ts:195/:1545/:2239 |
| H | model-switching.md:146/:150/:219/:235 | §10 桶探测问题/§11 修法"待做"+dsh"dispose+flush+resume 补丁" | §11.2 修法**已落地**（supportsRuntimeSetModel 双轴判据 + installModelSelection 原地热切） | session-store.ts:786-790、dsh-extension/index.mjs:44 |
| M | core-design.md:46/:208/:498/:499 | "4 缺面默认"（幽灵 continue?）、"9 个主题插件"（8 个）、"38 个插件"（50 个）；:203 附图"15 abstract + 4 缺面"与 :46 的 14 互相矛盾 | — | abstract-backend.ts:39、themes/*/plugin.json |
| M | thin-shell.md:31/:201/:311 + :23 + :277/:316 | KernelId/KERNEL_IDS 当"抽象直接证据"；"contributions.ts 590 行零 import"（702 行 3 个 type import）；factories 引用 | — | kernel.ts、contributions.ts:1-7 |
| M | session-mapping.md:285 | "加内核=加字面量+switch 穷尽" | 加内核=写插件+注册（r48 probe4 实证），圆心零改动 | add-new-kernel.md §0.1 |
| M | e2e-verify.md:7 | "内置 49 个" | 50 个（且脚本判据 >= 49 宽松） | verify-e2e.mjs:226 |
| M | docs/README.md | 插件清单/旧文档路径/model-switching 缺列/core-design 字数减半（详 §1#6） | — | ls 实测 |
| M | model-switching.md:3 | "Electron 双进程经 IPC" | 已前后端分离（WS+/rpc HTTP），渲染零 Electron | ws-transport.ts:1-17 |

### 2.3 desktop-kernel-pi-dsh.md + README 双语

desktop-kernel-pi-dsh.md（逐契约对照文档）九项 H：可缺面清单含幽灵 resume?/continue?（:87/:102/:110/:133/:134）；forkCommand 现状口吻（:92/:361）；"33/32 命令"（:194，实 29/28）；DSH_METHODS 20（实 21，:350/:284 列表含已删 session/resume 漏两个 thinking 补面方法）；dsh setThinkingLevel "继承缺面默认抛错"（:114/:139/:365——实际已 override 经适配插件热切 + pendingThinkingLevel 补发）；能力面旧 opaque 桶（:118）；postInstall 两补丁描述（:500/:372——PiKernelManager 实为空类，pi-kernel.ts:25 注释明说退役）；另 M 级 10 项见工作笔记。

README.md/README_zh.md（双语同行号同伤 13 组）：**H** Node 18 门槛（:13/:120，electron 实测 >=22.12）、theme-manager"三处宽度 slider+分区独立字号"（:453/zh:451——实际无任何宽度控制、字号仅单个全局 fontScale range 0.5–2）、i18n"12 命名空间×48 文件"（:491/zh:489，实 5ns×20 文件）；**M**"22 implemented 槽"（实 23，且列表只列 21 漏 composerStats/composerVoice——:393 自己又引用 composerVoice）、keybindings"默认 11 条"（**实 10 条**，主线裁决）、font-presets"17"（18）、fileIcons"30"（36）、"任意节点 fork"（:49 与自己 :329 矛盾——实为 user-node only）、fit 扩展列表漏 context-probe（:214，CLAUDE.md 的五能力才是对的）、目录树漏 probe4（:202）、goody-hao"注入内核"通用说法（systemPrompts 仅 pi 兑现，dsh/minimal 静默忽略）。

### 2.4 docs/plugins（52 篇）

机制级 H 九项：goal.md:163 / llm-recorder.md:208-213 / read-claude-md.md:96 三篇教 `pluginPiExtensionEnsure/piExtensionEnsure`（assemble 死符号死行号）；kernels/pi.md:174-190/:377 教 postInstall 重打 fork-position/entry_appended 补丁（**教学文档教 CLAUDE.md §1.6-3 明令禁止的违规形态**，patch-rpc-mode.ts 文件已删）；kernels/pi.md:389 与 :339 变更记录自相矛盾（pi:defaultChanged 频道已退役）、kernels/dsh.md:101/:253 与 :79 同型矛盾（dsh:defaultChanged）；kernels/dsh.md:296 "dependsOn 护栏加载时拦停订阅方"（**实际只拦停用/卸载**，lifecycle/index.ts:26-42；timeline dependsOn 悬空 id"pi-manager"照常加载）；timeline.md:135 "composerVoice 无贡献方"（voice-input 恰在贡献 VoiceButton）；plugins/system/i18n.md:96 "16 条"（实 20 条含 i18n.ext，与 docs/i18n.md:446"16 条"同伤）。

系统性 M 一类：**languages 贡献计数法漂移 15 篇 18 处**（模式=后加 `*.plugin`/`*.sidePanel` ns 未回写文档：token-stats 16→20、llm-recorder 12→16、plugins/kernels/pi.md 8ns→6ns/32→24 ……continue 2→8、voice-input 4→12、read-claude-md"无 contributes"实有 languages 4 条等，全部 json 实数核对）。

行号/行数断言漂移 M 一类：plugin-manager.md 十处 assemble.ts 行号全死（40-shell-plugins.ts:52 / 50-wiring.ts:19-42 为现状）、timeline.md"1549 行/573 行"、continue.md"58 行"、blind-review.md"89 行"、token-stats.md"118 行"；goal.md timeline 锚点 788-797→923-933、`.pi-composer-goal`→`.shell-composer-goal`；sidebar.md:215 `.pi-collapsible`→`.shell-collapsible`、ChildSessionRow :995→:1186。行数类断言建议全文"约 N 行"化或删除。

字段/数字 M：sessions-list.md:162/:280 与 sub-agent 文档 `parentPathKey`（实 **parentPathField**，r65 消歧：`*Key`=i18n 键、数据字段用 `*Field`）；ask.md:31 `piExtension` 旧字段名；kernels/dsh.md:263 DSH_FIT_EXTENSION_SOURCE"壳常量"（已删，资产现内核自持+syncFit）；theme.md light"26 key"（25）；font-presets"17 项"（18）。

好样例（核过为真密集）：keybindings.md（除 11→10 一处）DEFAULT_BINDINGS 逐字对上 bindings.ts 与六 channel；sidepanel.md 13 贡献/12 插件全对（最准）；kernels/minimal.md 的 Minimal*Page 三符号**真实存在**（test-plugins/kernels/minimal/renderer），是 audit:symbols 漏扫 test-plugins 的假阳性（见 §5）；kernels/probe4.md 全真。

### 2.5 docs/design（81 篇）与 docs/legacy（36 篇）

已退役机制"整篇现在时"两项：echo-attachments-persist.md（机制 1b6a027 已全链路退役，QA 还教第三方"能蹭上"；review-plugin.md :8/:76/:111-116/:144/:152/:189 同伤）；session-row-badges.md 两条过期先例（:320 goal 模块级单例 + `__resetGoalStoreForTests` 已被会话作用域槽推翻、:674 "ask 无 locales"已不成立）——该文主体是"合法设计先行"（机制未落地非漂移），audit:docs 主动报告它待人工判，本轮完成终裁（**判定成立**，修法=文首加"提案未落地"横幅+修两条先例）。

契约/会话类 M 九项：kernel-design-spec.md:99/:304-334（fork/ForkResult/resume? 契约代码块、"15 abstract+2 缺面"）；session-neutral-layer.md:397-509 与 kernel-switch-projection.md:436-470/:998-1010（**SessionBindingStore 映射表当现行机制**，实际 id 派生+恒 seed，session-store.ts:1602"去映射表"）；kernel-follows-model.md:198（gate）；kernel-agnostic-goal.md:45-57（正文 GoalDriver 与文首修订自相矛盾）/:96（dsh 工具"未接"实已接 dsh-extension/index.mjs:36/:61）；minimal-kernel.md:502（内置工具列 grep，实为 read/list/write/bash）；session-model-config.md:126/230（"三字段齐备"，实四字段含 kernel?，sessions.ts:242"新格式"）。

legacy 层 **18/36 篇无历史横幅**：blind-review、context-files、git-review、i18n、pi-manager、pi-model-manager、plugin-manager-ui、plugins、projects、run-panel、session-bookmarks、session-tree、sessions-list、skill-manager、structure-analysis、theme-manager、themes、token-stats。误导实锤：legacy/i18n.md:19/:25/:33/:79 教 `window.pi.i18n.*`（window.pi 全仓不存在）："48 资源/12ns"（实 20/5）、legacy/pi-manager.md:25/:31 描述的插件本身已不存在并教 `usePiApi()`（0 命中）、legacy/themes.md:29/:62/:121 教 `pi.themes.list()`。对照面（DESIGN.md、core-spec.md、desktop/001-012、core/*）18 篇全有"⚠ 历史稿"横幅——同目录两种命运。同名 14 对里 legacy↔现行文档只有 i18n 一对互指。

---

## 3 文档审计照出的**代码侧问题**（7 项）

| # | 位置 | 问题 | 建议处置 |
|---|---|---|---|
| 1 | **src/server/controllers/sessions.ts:171-175** | **runBash 全链路无门**（交叉验证升格）：服务端 handler 无 assertPermission 且签名不收 pluginId；前端 usePluginContext 从未暴露 bash 面、`window.kernel.sessions.runBash` 裸暴露；中央 gateway 无 per-channel 策略；声称共 4 处（glossary.md:43、build-kernel.ts:409、context.ts:198、**sessions.ts:420 BashApi 注释**），全部无兑现；**capability-axis-consumers.test.ts:58 守卫测试引用不存在的门**。当前无人消费该入口（UI 面无接线），风险是潜伏的声明面 | **建议优先级最高**：修门需先经 wsTransport 传 caller pluginId（参照 bus.ts:15-16 的 hasPermission 形态），补 `assertPermission(pluginId, "rpc:bash")` + 修正守卫测试 |
| 2 | scripts/dependency-audit.mjs:183/:289/:404 | **三处**硬数组（⑧ KERNEL_DIRS / ⑪ KERNEL_IDS / ⑬ IDS）均 `["pi","dsh","minimal"]` **漏 probe4**——probe4 是 test-plugins 注册的活内核（11 文件、plugin.json kernel 块 order:3），当前"恰好无违规"但守卫无覆盖 | 改运行时派生（扫 src/server/kernel/*/plugin.ts）或至少补 probe4 |
| 3 | eslint.config.js:52-54 | files 指向已不存在的 `src/shell/electron-main/**`——三条 IPC 通道字面量护栏**永不匹配任何文件**，静默失效 | 路径改 src/server/transport 或删；并注意 lint script 本身只扫 src/plugins |
| 4 | subprocess-lifecycle.ts:26-29 | 注释写"优先全局 pi，回退数据根"，代码行为**相反**（先查数据根 cli.js） | 改注释 |
| 5 | rpc-adapter.ts:245-250 | 注释以"fork 等命令的调用方看不到失败"论证 reject——fork 命令已退役，例证陈旧 | 换例证 |
| 6 | session-store.ts:1540-1543 | switchKernel 注释自述"查绑定(失效回退)/映射表回切"与自身实现（无绑定、恒 seed）矛盾——正是 switch-projection/neutral-layer 文档漂移的同根源 | 改注释 |
| 7 | pi/protocol/versions.ts:9 等 | 代码内 **22 处**注释引用已死文档路径：docs/core/ 10 处 + docs/modules/0X 8 处 + docs/plugins/05-plugin-i18n 4 处（docs/desktop/ 实测 0 处——比初版口径窄）。legacy 对应关系：core 10 处在 docs/legacy/core/ 有同名文件；modules 与 05-plugin-i18n 的 12 处在 legacy **无同形对应**（只有合文件的 plugins.md/i18n.md） | 同批指路（core 指 docs/legacy/core/；modules/05-plugin-i18n 只能给合文件或去引用） |

（代码注释不属"文档漂移"本体，但按项目"文档=注释也单源"的纪律与 audit:refs 盲区合并陈述。）

## 4 漂移的模式根因（比清单更重要——79 组 H/M 归并为五类）

**A. 计数口径不收敛（跨文档五种说法）**：BaseBackend 成员账有 **14+3**（CLAUDE.md:9）、**15+4**（core-design:203 附图）、**"15+4+3" 口诀被引用**（desktop-kernel:92——它引的口诀 CLAUDE.md 里并不存在）、**14+4**（glossary:15、directory-structure:131 含幽灵 continue?）、**15 abstract**（session-mapping:263）。实测（交叉验证复数）：基类 = **14 abstract** + **3 缺面默认**（listTools/answerQuestion/setThinkingLevel）+ **4 默认成员**（capabilities/configDepPaths/sessionId getter/supportsRuntimeSetModel 默认 true）；契约 BaseBackend = **18 必实现 + 5 可选[?]**。⚠ abstract-backend.ts:37 类注释自己写的"15 条必实现"也是 stale——又一次印证"注释里的数字不可信，数字必须数代码"。同类：31/33/32/29/28 命令数并存；11 vs 10 默认键；16/48 vs 20/488 i18n；38 vs 50 插件；"十一个轴"vs 12 成员。**治法**：这类数字全部改为指示器句式（"成员账以 backend.ts 注释为准"）或补一条静态守卫 grep `\d+ 必实现` 口径单源——audit:docs 已有先例（退役符号表），数字口径同理可进。

**B. 机制退役后未回写（r 系列审计落地≠文档落地）**：resume?（r72）、continue?(旧)、capabilities.pi/BackendExtensions 桶、KERNEL_IDS、kernel/factories/、SessionBindingStore、withNeutralEntry、echoAttachments、postInstall 补丁、switchKernel gate、DshConfigSource.cordis 常量、`pi:defaultChanged`/`dsh:defaultChanged` 频道——**至少 12 个机制的退役只落在代码与 audit 退役表，文档面（含教程）大片未跟**。成因清晰：代码侧有编译器+audit:deps 兜底，"文档侧没有任何东西兜"——doc-drift-audit 只管**符号**退役，管不了**机制**退役（整段叙述照旧成立）。

**C. 教学/导航文档的样例槽（最高优先修复项）**：new-plugin.md 教反例（llm-recorder/goal）、教 parentPathKey/description: 中文文本（照抄过不了类型）；README 双语同错同行号；docs/README.md 列死清单；kernels/pi.md 教违规补丁形态；".pi-composer-goal/.pi-collapsible" 类前缀名（已 shell- 化）。教学文档错一行，读者照抄就是错代码。

**D. 位置口径漂移（boot/steps 化、launcher 行号）**：assemble.ts 706→82 行是本轮所有"assemble.ts:3xx-3xx"死锚的总根（9+ 处文档死援）。行号锚（`文件:行`）与行数断言（"1549 行"）在本仓的演进速度下保质期≈一次迭代，建议全面"文件+函数名"化（audit:refs 只管 §N，管不了行号）。

**E. legacy/冻结层的处遇不一致**：同目录 18 有横幅 18 没有；audit:docs 排除 /legacy/ 的代价在那时（冻结归档不修红）成立，但"无标注也无扫描"意味着 18 篇教 window.pi/usePiApi 的文档站在搜索结果里没有任何护栏。修法轻：18 篇加一行 L3 横幅（与 desktop/001-012 同款）。

## 5 守卫自身的盲区（让本轮漂移"全绿"通过的原因）

本轮五个机器审计全绿，但 79 组语义漂移仍然存在——守卫有六个结构性盲区：

1. **audit:docs 判据②"文件头 15 行横幅"被日常词误触发 → 全篇假绿**（最严重，**交叉验证已量化实锤**）：独立复现脚本逐字复刻审计判据后与真实输出完全对齐（425 命中/0 违规）——**118/425（27.8%）的命中完全依赖这条假横幅豁免**，分布在 17+ 份文档（thin-shell 11、directory-structure 10、stats-single-source 7…）。实锤两例：glossary.md L3 日常句"不再在每篇里重复定义"豁免了 :50 的 `capabilities.pi`（教已删 API）；directory-structure.md L3"历史文档为准"豁免了 12 处 `kernel-factories`/`KERNEL_IDS` 现状引用。口径修正：glossary:48 的裸 `"pi" | "dsh"` 不在 RETIRED 表（表里是 `KernelId = "pi" | "dsh"` 整串），真正实锤是 :50。修法（**已做可回归实验**）：判据②改"前缀锚定真横幅"（只认 `>` 引用块开头的宣告行），docs/design 四篇真横幅文档实测不误伤，全仓红数 0→43 全为假绿被揭开（先消化再设门，照旧"清零升级门"惯例）；同时给 RETIRED 表加词边界防 `sessions.pi` 撞 i18n 键前缀的假红（sessions-list.md:27/:146 已中招）。
2. **段落级标记借窗**：RETIRED 符号若落在含"迁移方案"字样的段（kernel-design-spec.md:498/:588）就能借用 10 行窗内标记走私。
3. **audit:symbols 代码索引漏 test-plugins** → Minimal*Page 等真实符号误报"优先缺失"，真 candidates 被噪声稀释；且它只扫 docs/ 不含 legacy 与 CLAUDE.md/README——**最大的纪律文档（CLAUDE.md 99KB）不在任何文档审计覆盖内**。
4. **audit:refs 只验 §N 文档引用**（PATTERN 要求 `.md`+`§N`），不验代码注释→文档方向，也不验行号锚——doc 内 `文件:行号` 锚共 **1893 处**零守卫，交叉验证抽 4 处 **4/4 全漂**（788-797→923-926 等）。
5. **计数无守卫**："31 命令"在 CLAUDE.md/pi-backend.ts 注释/versions.ts 注释/README×2/desktop-kernel/session-flow 七处存活至今，无任何机械哨兵；DEFAULT_BINDINGS 10vs11 无守卫拦（bindings 守卫只断 parsed.length==DEFAULT_BINDINGS.length）。
6. **CI 不跑任何 audit**：.github/workflows/ci.yml 只有 lint/typecheck/test/build；"CI-able"的十三检验、audit:docs、audit:refs 全部本地自觉。

## 6 修复建议路线图

1. **P0（半天）**：① runBash 全链路权限门（§3#1，经交叉验证升格——含前端门与守卫测试修正）。② CLAUDE.md 纪律级旧模型（KernelId×3、resume×3、31 命令→29×多处、12 轴（补 systemPrompt）、systemPrompt+"dsh 走 cordis"改"明示 dsh/minimal/probe4 缺面"、目录树补 probe4/跨内核测试）一次对齐——纪律总纲错一处，读者拿它当检查表用。
2. **P0（一天）**：教学文档 4 篇错样例（new-plugin.md 反转样例+descriptionKey+两字段名；README 双语 13 组数字；docs/README.md 清单补 kernels 域改 legacy 路径；kernels/pi.md 补丁段）。
3. **P1**：三根大梁重写（desktop-understanding 装配链 + applyEvent 共通段 8+6 处；session-flow continue 意图整节 + 31 命令 + withNeutralEntry；desktop-kernel 可缺面/命令计数/DSH_METHODS/补丁/能力面五段）。
4. **P1**：legacy 层 18 篇加 L3 横幅（一个下午，模板化）；audit:docs 判据②加固（横幅前缀锚定）。
5. **P2**：languages 计数 15 篇、行号锚全面去化、design 契约组 M 级（SessionBindingStore 等）加"已被取代"横幅、代码注释 12+ 处 docs/modules 死路径。
6. **守卫增量（同批）**：audit:symbols 扫描面加 test-plugins、audit:deps KERNEL_IDS 派生化、计数哨兵（数字口径单源 grep）、CI 挂 npm run audit。

---

## 附录 A 核过为真（抽样面）

本轮为"宁缺毋滥"每条发现钉了双证据，同样记录了大量**对得上**的断言，避免修复方误伤：pi/dsh 逐意图对照表 39 个文件指认、事件翻译双矩阵（pi TYPE_MAP 22 条/dsh 两层翻译）、两 catalog 方法签名、goal 状态机+命令词表+四件套、sidepanel 13 贡献/12 插件、keybindings 六 channel、theme 三贡献+__auto__ 哨兵、boot-surface 14 步、skills-layering/unified-project-config/refresh-signal/custom-cli-path 全落地链、web-service-architecture 三入口、五能力 fit-pi-extension、十三检验与 audit 全家 npm scripts、50 插件分域、minimal/probe4 测试内核隔离（"不在生产扫描根"）、THEME_TOKEN_DEFAULTS/roleToPrompt 已知偏离自陈仍属实……详见 docs/reports/doc-code-audit-notes.md（224 行工作底稿，含每条发现的完整证据链与分组"核过为真"面）。

## 附录 B 分组覆盖与可信度

**交叉验证轮**（6 组对抗性证伪，覆盖 54 条抽样断言）：

| 验证组 | 覆盖断言 | 判定结果 |
|---|---|---|
| 代码缺陷组 | 8 条 | 7 确认 + 1 改写口径（死文档路径"22 处"对、但 docs/desktop 实测 0 处、legacy 对应仅 core 10 处成立）；runBash **升格**（前端也无门 + 守卫测试 capability-axis-consumers.test.ts:58 引用不存在的门）；audit 漏 probe4 **补正**（⑧⑪⑬三处齐漏） |
| 契约计数组 | 10 条 | 6 确认 + **2 条推翻本报告**（AbstractBackend 实为 14 abstract 非 15——基类 :37 注释自己就是 stale；PiBackend implements 实为 9 非 8——本报告误报已撤销）+ 2 补强 |
| 教程文档组 | 12 条 | 11 确认 + 1 部分成立（README"分区字号"其实是三 tab 各一个 range，但"三处宽度 slider"仍纯属虚构）；keybindings 实数 10 再度坐实 |
| 运行态漂移组 | 9 条 | 8 确认 + 1 部分成立（SessionStore 构造实为 **8 参**非 7——漏计 questionStore；断言5 再补新事实：`:2239` setModel 对**有历史会话**也已直走 switchKernel，"锁死"整句不成立——行为边界反转，非名词过期） |
| 守卫盲区组 | 6 条 | 6 确认（判据②假绿量化 **118/425=27.8%**；行号锚 1893 处抽 4/4 全漂；ref-audit 例外收窄口径；legacy 归档对应只对 docs/core 10 处成立——modules/05-plugin-i18n 系是**直接删除未归档**）。加固修法已做可回归实验：前缀锚定后真横幅文档 0 误伤、红数 0→43，另发现 RETIRED `sessions.pi` 子串撞 i18n 键的假红风险 |
| 架构断言组 | 10 条 | 8 确认 + 2 推翻/改写：①"abstract 恰 15"**方向反了**（实数 14，glossary:66 是校正不是错误——本报告另一误报同步撤销）；②同名对 **10 对**非 14 对（14 含更名映射，须注口径），且互指路径 `docs/plugins/i18n.md` 本身 404。断言6 收窄：docs/README "旧文档关系"段 6 项中 **5** 项已迁 legacy，**docs/design/ 未迁是冤案**（仍在原位且为现行权威） |

**教训记录**：计数类断言凡是只从注释/一处文件抄数的都翻车了（15 abstract 抄自基类自己的 stale 注释；implements 数错因只扫了子句后半段）——凡数字必亲手数代码，这条已作为本报告的方法论修正写进 §2 引言。

原审计 10 组：CLAUDE.md 1 / README 双语 1 / 架构根 A 9 篇 / desktop-kernel 1 篇 / 运行态 2 篇 / goal-sidebar-i18n-new-plugin 5 篇 / design 契约组 29 篇 / design 插件渲染组 54 篇 / docs/plugins 52 篇 / legacy 36 篇。抽取规则：全部 H 级发现由主线独立到代码复核（10 处抽验全部坐实、3 处子agent 误判已裁决改正——keybindings "11 条核过为真"实为 10、forkCommand 等属确认）。发现条目均为"文档行 + 代码行"双证据；L 级行锚漂移类（约 60 处）已按根因归组不逐条展开，完整明细见工作底稿。
