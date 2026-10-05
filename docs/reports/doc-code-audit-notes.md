# 文档 vs 代码 审计——工作底稿（每条发现的完整证据链）

> 本文件是 [doc-code-gap-audit-2026-10.md](./doc-code-gap-audit-2026-10.md)（终版报告）的**工作底稿**：按审计推进顺序记录的事实基线、全部发现的原始证据与三处裁决过程。终版报告按主题归并这些条目；查单条证据时从本稿入手。分组与 10 个审计 subagent 的原始分工一一对应。

## 机器审计现状（2026-10-02 实测）
- `npm run audit:docs`：退役符号 392 处命中，0 处未标注（绿）；`session-row-badges.md` 被报告"含现状对照但无过期标记"，需人工判
- `npm run audit:refs`：1044 处显式 §N 交叉引用，0 断链（绿）
- `npm run audit:symbols`：4697 个文档符号，349 个在代码找不到；12 个优先级（带内核 token）
- audit:deps 十三检验（绿）；audit:quiet 三检验 0 违规（绿）；audit:session-scope 四检验 0 违规（绿）

## 已确认发现
### H1: docs/README.md 插件清单漂移
- manager/ 列了 `dsh-manager、pi-manager`，但 `src/plugins/manager/` 只有 plugin-manager、skill-manager、theme-manager、tool-manager 4 个。dsh-manager/pi-manager 已随 §kernel-plugin 改为 `src/plugins/kernels/{dsh,pi}`
- docs/README.md 只列六域（insight/manager/project/sessions/system/themes），缺第七域 `kernels/`（kernels/dsh + kernels/pi 是壳插件之一，docs/plugins/kernels/ 有 4 篇文档 dsh.md/pi.md/minimal.md/probe4.md）
- 实测 50 个壳插件 = insight3 + manager4 + project5 + sessions18 + system9 + themes9 + kernels2；test-plugins 另有 minimal/probe4
- docs/README.md "与旧文档的关系" 段提到的 `docs/design/`、`docs/core/`、`docs/desktop/` —— `docs/core/`、`docs/desktop/` 路径已不存在（已移入 docs/legacy/core、docs/legacy/desktop）

### H2: CLAUDE.md §6.2 断言 KernelId 是字面量联合
- CLAUDE.md（§6.2）写 `kernel.ts（KernelId = "pi" | "dsh" + KERNEL_IDS，内核身份单源）`
- 真实代码 `packages/shared/src/domain/kernel.ts`：`KernelId = string`（不透明 id，去字面量化），KERNEL_IDS 已删除（退役表也换了措辞）
- CLAUDE.md §6.3 检验①"全仓 "pi" | "dsh" 字面量联合应收敛到 kernel.ts 一处" 与 kernel.ts 注释"全仓唯一能出现 pi|dsh 字面量的历史纪律已随插件化废止"直接矛盾

### M1: CLAUDE.md §6.1 目录树延期
- 目录树没有 `src/server/kernel/probe4/`（真实存在：backend/kernel/manager/plugin.ts）与 `src/server/kernel/tool-filter-axis.test.ts` 等；test-plugins 也没有 probe4（实际 test-plugins/kernels/probe4 存在，CLAUDE.md 只提 minimal）

### H3: resume 意图已删，CLAUDE.md 仍当现状讲（三处）
- r72 已从 `BaseBackend` 删除可选成员 `resume?`（backend.ts:99 起 5 行长注释说明删除依据：壳全仓从没探测过这个面；dsh-backend.ts:371 有同样退役注释）
- 但 CLAUDE.md:9 术语表仍把"会话标识（getTree·getEntries·bookmark·**resume**）"列为六条核心意图之一；CLAUDE.md:685 QA 仍在描述"直接 resume 别家内核锚点会报错、switchKernel 留演进"的现存语义
- 实际：锚点重启走 `SessionStore.resume(snapshotId)` 中立层派生（deriveSession），与 backend.resume 无关

### H4: "pi 31 命令"系列计数漂移（四源各说各话，全与代码不符）
- CLAUDE.md:137/:155/:325/:369 与 pi-backend.ts:3、versions.ts:1/:9 都说"31 命令"
- docs/desktop-kernel-pi-dsh.md:194 单独改口"实际是 33 个 type 字面量（最后一个 reload）；FALLBACK_COMMAND_SET 收 32 个"
- 实测（本工作树）：commands.ts 21 个 build*Command；rpc-types.ts 命令联合 29 个成员（第 30 个是 reload+extension_ui）；versions.ts FALLBACK_COMMAND_SET 28 个字面量、但文件头第 9 行仍写"31 命令字面量回退集"
- versions.ts:2 注释引用 "docs/modules/02 §6 + DESIGN.md §6.4" —— docs/modules/ 已不存在（死锚点，DESIGN.md 已移 docs/legacy/）
- 建议：以 RpcCommand 联合为准一次对齐（说明 reload/+extension_ui 例外），"31"作为历史简称退役进标记段

### H5: BaseBackend 成员计数口径漂移（四种说法并存，全不稳合）
- CLAUDE.md:9 "14 必实现 + 3 缺面；docs/core-design.md:203 "15 abstract + 4 缺面 + 3 默认成员"；
  desktop-kernel-pi-dsh.md:92 说 CLAUDE.md 的口诀是"15 必实现 + 4 缺面 + 3 默认"（而 CLAUDE.md 现写 14+3+3，该注引用了一个不存在口诀）
- docs/directory-structure.md:131 缺面默认列了 `continue?` —— **幽灵成员**（backend.ts 无 continue?；"续跑就是发消息"，continue 意图已退役）
- docs/glossary.md:15、session-flow.md:55、session-mapping.md:263 各自不同组合
- 实测：AbstractBackend 15 abstract 成员 + 3 个缺面默认（listTools/answerQuestion/setThinkingLevel） + seed 等接口必实现成员若干
- 建议：一次全仓对齐为实测口径，并删 directory-structure.md 的 `continue?` 幽灵

### H6: PiBackend "九个中性能力面"多计
- CLAUDE.md:369 称 `implements 九个中性能力面接口`；实测 pi-backend.ts:104-107 只 implements 8 个（Steering/Retry/Compaction/Snapshot/Stats/ModelCycle/ToolExec/BusFrame/QuestionChannel），thinking 走基类 override setThinkingLevel（缺面默认条目），非 implements 面

### M2: doc-symbol-audit 盲区
- 代码索引只扫 `src, packages, scripts`，不含 `test-plugins` → MinimalManagerPage/MinimalExtensionsPage/MinimalModelsPage 报为"优先缺失"，实际存在于 test-plugins/kernels/minimal（假阳性）
- 扫描范围只 `docs/`（不含 legacy），CLAUDE.md、README.md、README_zh.md 完全不在任何文档审计覆盖内（最大的纪律文档无守卫）

### H8: glossary.md 术语表教旧模型（三处硬伤）
- glossary.md:48 **KernelId**：仍教 `"pi" | "dsh"` 字面量联合 + "全仓唯一能出现内核身份字面量的地方"——kernel.ts 实际是 `KernelId = string`（不透明 id，注释明说"历史纪律已随插件化废止"）
- glossary.md:50 **能力探测**：仍教 `backend.capabilities.pi` / `.dsh`——按内核名分字段已退役，现为逐轴 `capabilities.<轴>`（steering/retry/…/thinking）
- glossary.md:15 六域（themes/sessions/project/insight/manager/system）——实际七域（+kernels/，e5f2c6689 引入）；"27 个槽位"数字对，但"六域"漏 kernels 域
- glossary.md:78 "「15 条必实现」是旧说法……以代码（14 条 abstract）为准"——实际 AbstractBackend 恰好 15 个 abstract 成员，这条澄清自己又给了错数字
- **为什么 audit:docs 全绿没抓到**：段落内 "kernel-plugin" 是豁免标记词；且 audit 的"文件头 15 行横幅"判据被第 3 行"不再在每篇里重复定义"误触发（假绿）——参考手册在最显眼处教已删 API 而守卫静默

### H9: 现行 i18n 文档语言资源计数过期
- docs/plugins/system/i18n.md:96 称 plugin.json "contributes.languages 16 条（4 locale × 4 id）"——实测 20 条（4 locale × 5 id，新增 `i18n.ext`），locales 目录 20 个 JSON（每语言 5 命名空间：common/settings/plugin/shell/ext）
- merge.ts 插件合并步骤锚点（L77-139）与其他行锚点随 i18n 演进漂移（轻度）

### H10: 代码注释里的"死文档锚点"（audit:refs 盲区：不扫代码→文档引用）
- 全仓 22 处代码注释引用已不存在的 docs 路径：`docs/modules/02`（pi 协议层 7 处：versions/event-translator/context-binding/rpc-adapter/resync/correlator + wire）、`docs/core/extension-management.md`（4 处）、`docs/plugins/05-plugin-i18n`（3 处）等——旧路径已全部移入 docs/legacy/（如 extension-management.md 现在是 docs/legacy/core/）。读者按注释找不到文档
- ref-audit 只验 docs 内部 §N 引用，不验代码注释 → 文档cursor系统性盲区

- 该文声称锚点指向 main f40fc821，现 main=2c4949d，行号锚点已漂移（unread 条件实际在 :1018 非 :871；文件行数 1181→1354；`reconcilePendingQuestionsBeforeSend` 在 :1970 非 :1959）
- 文档设计的机制（SessionRowStore/行级数据源登记表 registerSessionRowStores/ask-dock/领先脉冲徽章）**均未落地**（全仓 0 命中、packages/react/src 无 session-row-stores.ts、ask renderer 无 ask-dock.tsx）
- 但"现状"描述本身仍准：行内指示仍硬编码在 sessions-list 的 SessionRow（未被注册机制取代）
- 出口建议：按脚本设计加"（现状已核）"或"已标注为设计未落地"标记，或在头部加"本设计尚未实现，§1.2'现状'截至 f40fc821"横幅

### T1: audit:docs 主动报告 → 人工裁决：session-row-badges.md
- 文档声称锚点指向 main f40fc821，现状行号已漂移（unread 条件实际 :1018 非 :871；sessions-list renderer 行数 1181→1354；reconcilePendingQuestionsBeforeSend :1970 非 :1959）
- 文档设计的机制（SessionRowStore 行级数据源登记表/黎 ask-dock/领先脉冲徽章）全仓 0 命中，未实现；但"现状"描述（行内指示硬编码在 SessionRow）仍准
- 出口：头部加"（设计未实现·写稿于 f40fc821）"横幅即可同时消解 audit:docs 报告与读者误导

### H11: 「assemble.ts 的 pluginPiExtensionEnsure 闭包」四文档教已退役符号
- 现状：bootstrap 已重组为 boot/steps/* 分片（assemble.ts 仅 82 行）；插件声明内核扩展的字段形态已是 `extensions: { 内核id: 路径 }` + `KernelPlugin.createPluginExtensionSync()`（50-wiring.ts:183, ops.ts:17-21, 70-fit-extensions.ts）
- audit:symbols 已把它列为优先候选（audit 自己也在注释里写明迁移："kernel-plugin"），但四篇现行文档未修：
  - docs/plugins/sessions/goal.md:163（"实现在 src/server/bootstrap/assemble.ts:363-379"）
  - docs/plugins/insight/llm-recorder.md:212（"assemble.ts:363-370"）
  - docs/plugins/system/read-claude-md.md:96（"assemble.ts 的 pluginPiExtensionEnsure hooks（第 352–360 行左右）"）
  - docs/add-new-kernel.md:324（教人加新内核时写这个闭包——教学文档教不存在的 API，最重）
- 伴生：`syncPluginPiExtension`/`syncPluginDshExtension` 的名字仍存在于 installer（server/kernel/{pi,dsh}），但消费方/装配位置与文档行号全错

### L1: minimal-kernel-acceptance.md 目录清单轻漂移
- 文档列 `kernel/` 4 个 .mjs，实际 5 个（多 `minimal-events.mjs`）；无损大局（验收报告是历史快照），L

### M5: eslint.config.js IPC 通道护栏已成死配置（文档审计照出的代码问题）
- eslint.config.js:52-54 的 files 指向 `src/shell/electron-main/**` 与 `src/shell/ipc-channels.ts` —— src/shell/ 目录已不存在（重构后为 src/server/transport），三条 IPC 字面量拦截规则**永不匹配任何文件**，静默失效
- thin-shell.md:346 自己也说"其作用域是 src/shell/electron-main/**（已重构前的路径），属于历史遗留配置"——但代码未修
- 关联：eslint 的 lint npm script 只跑 `src/plugins/`，所以这些规则即使路径对了也不会在 CI 跑（lint 范围窄于配置范围）

### M6: CI 未接任何 audit:* 守卫（文档声称"CI 可以自动化"的落差）
- CLAUDE.md:389 说依赖方向检验"CI 可以自动化"；audit:deps 自称 "CI-able 守卫"（脚本头注释）
- 实际 .github/workflows/ci.yml 只跑 lint/typecheck/test/build——十三检验、audit:docs、audit:refs、audit:quiet 等**全都不在 CI**
- 后果：docs 审计绿不绿完全靠本地自觉；与该项目"守卫进 CI"的纪律叙述有落差

### H12（守卫机制缺陷，两条审计全局绿的根本原因）: audit:docs 判据②（文件头 15 行横幅）被日常词误触发 → 全篇假绿豁免
- 实测两个案例：
  1. glossary.md:3 "……**不再**在每篇里重复定义这些词……不以后面的**历史**文档为准" —— 普通叙述句命中 marker 词 → L48 `KernelId="pi"|"dsh"`、L50 `capabilities.pi/.dsh`（RETIRED 表符号、无标记）整篇放行
  2. directory-structure.md:3 "结论一律以当前代码为准，不以后面的历史文档为准" → :297/:303/:603/:613/:656 把已删 `kernel/factories/`（RETIRED 符号 kernel-factories）当现状讲、:133 教已退役 `PiExtensions`，全部放行
- 判据设计自注释说“文件级横幅豁免”是为了避免误伤整篇历史文档，但 marker 词是“历史/不再”这类高频日常词，**任何头三行带这三个字的文档自动全篇免检**——假绿比漏报更坏（skills §10.3：守卫最坏形态是让人以为有守卫）
- 同文件内自相矛盾的样本：directory-structure.md :674（Q&A）正确说"那个目录**已删**"，:603 又把它当现状教——同篇一半新一半旧

### README 双语组（subagent 复核 + 主线抽验确认，双语同行号同伤）
H13. Node 版本门槛错误：README.md:120/:13 徽章行/README_zh.md:120 说"Node.js 18 或更高（electron-vite 的要求）"——实测 electron@43 engines 要求 node >= 22.12.0，electron-vite 要求 ^20.19.0 || >=22.12.0；CI（.github/workflows/ci.yml:15）用 node 22。中文 548/英文 550 排查表同样写 18
H14. theme-manager"三处宽度 slider + 界面/代码/输入框独立字号 slider"（README:453/zh:451）：实际 theme-manager 无任何宽度控制（宽度=layout-engine 拖拽手柄桥 sidebarWidth）；字号只有单个全局 fontScale range(0.5–2)（font-tab.tsx:121），无分区独立档。双语同错
H15. i18n"12 命名空间 × 4 语言 = 48 资源文件"（README:491/zh:489）：实际 i18n 插件 20 文件（4 语言 × 5 命名空间：common/settings/plugin/shell/ext）
M8. settingsGroups 说"开关/下拉/滑块"（README:495/:244/zh:493/:244）：实际 type 只有 boolean|enum|int（contributions.ts:63），无 slider
M9. "22 implemented 槽位"（README:237/zh:237）：PluginContributes 实际 23 个槽；README 只列 21 个（漏 composerStats/composerVoice——而 :393 自己又引用了 composerVoice）
M10. keybindings"默认 11 条"（README:509/zh:507）：DEFAULT_BINDINGS 实际 10 条（bindings.ts）
M11. font-presets"17 项"（README:485/zh:483）：实际 18 项（7 mono+6 english+5 chinese）
M12. file-tree"30 条 fileIcons 映射"（README:403/zh:403）：实际 36 条
M13. pi"31 命令契约"（README:200/zh:200）：与 H4 同源；RpcCommand 联合实际 29
M14. goody-hao"注入内核的系统提示词"（README:522/zh:520）：systemPrompts 槽只有 pi 实现（--append-system-prompt；BackendCapabilities.systemPrompt 仅 pi 声明）；dsh/minimal 静默忽略——README 通用口径掩盖了单内核不对称
M15. 目录树（README:202/zh:202）漏 src/server/kernel/probe4/；194-215 行的树还缺 routing/、bootstrap/boot/、web/kernel/ 子层（L 级简化）
M16. 能力表"任意节点 fork/bookmark/jump"（README:49/zh:49）：实际 fork 只接受用户回合边界锚（pi 用户锚点约束 + boundary 回合语义），README 自己 §3.4.5(:329) 也说 user-node only——前后自相矛盾
M17. fit 扩展列表"toolgate/bus/subagent/skills 四工具"（README:214/zh:214）：实际五能力（toolgate/context-probe/bus/subagent/skills，index.ts:20-24）——README 漏 context-probe；CLAUDE.md:9/术语表是对的（五能力）

### desktop-kernel-pi-dsh.md（608 行逐契约对照文档，subagent 全审 + 主线抽验坐实）
H18. :87/:102/:110/:133/:134 可缺面清单含幽灵成员：`resume?`（r72 已删，backend.ts:99-112）与 `continue?`（全仓 0 命中）——现存可缺面是 listTools?/setTools?/onProcessExit?/answerQuestion?
H19. :92 以现状口吻写 "`PiBackend.forkCommand`"（pi 私有方法返回 RpcResponse）——forkCommand 在生产代码 0 命中，pi fork 已退役（kernel-forkless），无任何历史标记；:361 §5.1 表同伤
H20. :194 pi 协议"33 个 type 字面量/FALLBACK 32"——实数 RpcCommand 联合 29（fork/clone/get_fork_messages/export_html 已退役删除，versions.ts:23-24 注释）、FALLBACK 28；关联 :65/:210 "31 命令"（与 H4 同源）
H21. :350 说 DSH_METHODS 20 方法、:284 列包 session/resume——实数 21 键、无 sessionResume（r72 删），且新增 sessionGetThinkingLevels/sessionSetThinkingLevel 两个补面方法
H22. :365/:117/:138/:139 dsh 思考强度描述为"继承缺面默认抛错"——实际 DshBackend.setThinkingLevel 已 override 走适配插件 session/setThinkingLevel 运行时热切（dsh-backend.ts:276-292 + pendingThinkingLevel 首发-后补发），非缺面
H23. :118 能力探测还是旧 opaque 桶形态 `{ pi?: unknown; dsh?: ThinkingCapabilities }`——已拆 11+2 轴 BackendCapabilities（thinking.missing 也已删）；:144 能力行漏 pi systemPrompt:true
H24. :500/:372 "PiKernelManager.postInstall 打 patchRpcModeForkPosition/patchAgentSessionEntryAppended"——PiKernelManager 全类仅 `extends KernelManager {}`（pi-kernel.ts:20-25），补丁已退役、无历史标记
M19. :180/:505 装配叙述指旧 assemble.ts 硬编码清单闭包（"kernel === 'pi'" seed 派发、冷启动自愈清单）——实际 boot/steps/50-wiring.ts 经 kernelRegistry 派发、95-kernel-reconcile 从注册表驱动（机制层已无内核字面量）
M20. :188 BackendCreateOptions 含 `agentDir`/`maxTokens?`——两字段均已从契约删除（backend.ts:433/r128），dsh-backend.ts:29 有退役注释
M21. :126/:358 "dsh sessionId 构造缺省=cwdToBucketName(cwd) 回落"——现在构造缺 sessionId 直接抛错（dsh-backend.ts:123-127 "历史上这里回落 cwd 桶名"已改）
M22. :98 "SessionStore.abort 对 pi 有先 abortBash 双保险"——顺序已收进 PiBackend.abort（pi-backend.ts:198-207），SessionStore.abort 内核无关
M23. :290 DEFAULT_CORDIS_YAML 列举含 llm-deepseek——实际无 llm-deepseek、多 credentials-local；:292 PLUGIN_ID_MAP 的 llm-deepseek 举例倒还在（24 条数对）但组合清单已不默认含它
M24. :165/:357/:543 dsh rawFilePath 写死 "session.jsonl.zstd"——实际双形态明文优先（dsh-catalog.ts:87-99），明文正是 appendToolResult 续路的前提
M25. :336 引用旧缺面错误文案"版本过旧"——实际文案已改为指向适配插件（dsh-backend.ts:208-222 措辞纪律注释）
M26. :439 "switchKernelEnabled = false（暂缓切换）"——实值 true（session-store.ts:195），切换已启用
M27. :33/:188 全景图列 `factories/` 与 `kernel-factories.ts`——目录已删（各内核自持 <id>-backend-factory.ts），与 directory-structure.md:297 同伤
M28. :431 SessionProc 字段清单漏 effectiveModel 等
注：该文档逐意图对照表的 39 个文件指认、pi TYPE_MAP 24 条映射、dsh 事件翻译、catalog 方法签名等"核过为真"面很宽——漂移集中在计数/可缺面清单/补丁与 thinking 描述（多为 r72/r128 之后未回写）

### 代码侧注释漂移（subagent 审计照出，非文档问题，备案）
- subprocess-lifecycle.ts:29 注释写"优先全局 pi(走 PATH)，回退数据根 pi/ 的 cli.js"——实际代码先查数据根 cli.js（existsSync 命中即 return node cliJs），才回退全局 `pi`；注释与行为相反
- rpc-adapter.ts:245-250 注释以"fork 等命令的调用方看不到失败"论证 reject 契约——fork 命令已退役（rpc-types 无 fork），例证陈旧

### goal/sidebar/sidepanel/i18n/new-plugin 组（subagent 全审 + 主线抽验坐实）
H25. docs/goal.md 整篇按旧版实现讲"现状"（8 处 H）：5.2 广播 `{active}` 收口在写入口（实际独立 effect 发 `{goal}` 全量）、:432 pendingQueue 说成 ui-store 字段（实际 session-pending.ts 作用域槽+hasPendingUserSend）、:166 set_goal"覆盖旧目标"（实际归并为 editGoal 保轮次+defaultMaxRounds）、:319/:683 "失败静默不重试"（实际 3 次退避→paused+显形+deferred 欠账）、:143 DEFAULT_MAX_GOAL_ROUNDS=256（实际 1000，settingsGroups 可覆盖）、:235 useState+三 ref（实际五会话作用域槽）、:534 "两槽贡献"（实际四类贡献+auxParsers+sessionSlots）、:381 /goal set"吞掉发送"（实际返回 {send} 所见即所得，limit 子命令未提）
H26. docs/sidebar.md:21 教已删的 SidebarContribution `title` 字段（死字段，contributions.ts:112 有删除注释，DOM 显示"会话"而 manifest 写"对话"证明它没被用）；:191 教 `parentPathKey`（实际 parentPathField，r65 消歧）
H27. docs/i18n.md:188 "main 从未 init i18next"——r78 已接线（50-wiring.ts:235 initTranslator + server-i18n-wiring.test.ts 守卫 + 5 处服务端 t() 消费）；引注只盖了一行，279/:416 仍按旧结论行文；:63/:314/:355 计数 38 插件/30 ns/16 条（实际 50/37/20）
H28. docs/new-plugin.md:20/:114 教学样例反转——说"llm-recorder 没有 dsh-extension/、goal 没有 locales/（反例别学）"，实际两者都有（llm-recorder 有 dsh-extension 目录，goal 有四语 locales 并正规贡献 languages），初学者会照此得出"goal 不做 i18n"的错误结论；:165 样例代码用 `description:` 中文字面量（实际字段是 descriptionKey i18n 键，照抄过不了类型且违背同文档自己的 i18n 纪律）；:533 教 parentPathKey/customKey（实际 parentPathField/customField，照写 manifest 消费方读不到）
M29. goal.md 行号/类名/token 漂移（timeline 订阅 783→923-933、.pi-composer-goal→.shell-composer-goal、测试计数 11/11/8/15/7→14/12/17/29/12）；M30. sidebar.md pi-collapsible→shell-collapsible、ChildSessionRow 行号；M31. i18n.md 装配指 assemble.ts:506（实际 boot/steps/40/50）；:295 引 src/plugins/manager/pi-manager/locales（已移 kernels/pi）；M32. new-plugin.md 圆心行号全线漂移 +30~70 行、activate/deactivate 已 runOps 驱动
L2. sidepanel.md 三 action 行号 390-413→293/300/307（描述本身对，最准的一篇）

### docs/design 契约组（subagent 全审）
M33. kernel-design-spec.md:99/:304-334——"15 abstract+2 缺面"含 fork/resume（已删，缺面默认实为 3 条）；§9 代码块含 fork(...):Promise<ForkResult>
M34. session-neutral-layer.md:397-509（第四编）与 kernel-switch-projection.md:436——把已删的 SessionBindingStore 映射表/isBindingValid 当现行机制讲（实际 id 派生+恒 seed，session-store.ts:1602"去映射表"）；kernel-follows-model.md:198 "switchKernel gate=false"（实值 true）；kernel-agnostic-goal.md:45-57 正文 GoalDriver 分层图与文首"迁回壳插件"修订自相矛盾、:96 "dsh 工具未接"（已接，dsh-extension/index.mjs:36）；minimal-kernel.md:502 内置工具列 grep（实际只有 read/list/write/bash）
M35. session-model-config.md:126 "三字段齐备才认"（实际四字段含 kernel?，sessions.ts:242"新格式"）
L3. base-interface-lineage.md（fork/resume 当五操作之二，无历史横幅）、bookmark-snapshot-fork-unify.md:14（KernelId 字面量）、:234/:258 行号漂移、:322 ".seed( 静态守卫 CI 报警"承诺落空（约束成立但 scripts/ 无守卫）、abstract-backend.md:90 计数、kernel-plugin.md:53 createCatalog 带参示意、kernel-design-spec.md:498/:588 引已删 kernel-factories.ts/kernel-managers.ts
- 附：session-store.ts:1540-1543 switchKernel 注释自述"查绑定/映射表回切"与实现矛盾（代码注释漂移，同根源）

### docs/plugins 52 篇组（subagent 全审，主线已裁决 2 处争议）
H29. 扩展同步旧符号三连（同 H11 根因，确认全为真）：sessions/goal.md:163、insight/llm-recorder.md:208-213、system/read-claude-md.md:96 均教 assemble.ts:352-379 的 pluginPiExtensionEnsure/piExtensionEnsure——实际 manifest `extensions: Record<KernelId,string>`（contributions.ts:595）+ KernelPlugin.createPluginExtensionSync()（boot/ops.ts:17-21）
H30. kernels/pi.md:174-190/:377 教 PiKernelManager postInstall 重打 fork-position/entry_appended 两补丁（引 patch-rpc-mode.ts 已删文件）——PiKernelManager 是空类、补丁已退役（pi-kernel.ts:25-27 注释），CLAUDE.md §1.6-3 明令禁止装后补丁并点名退役：教学文档教违规形态
H31. kernels/pi.md:389 vs :339、kernels/dsh.md:101/:253 vs :79 两文档各自"正文 vs 变更记录"自相矛盾——正文仍教 emit pi:defaultChanged/dsh:defaultChanged（频道已退役，改走 system:refreshRequested），全仓无 emit 点
H32. kernels/dsh.md:296 "dependsOn 护栏在加载时拦停订阅方"——实际护栏只拦停用/卸载（lifecycle/index.ts:26-42 canDeactivate），加载不校验依赖存在（timeline dependsOn "pi-manager" 是悬空 id 也照常加载）
H33. sessions/timeline.md:135 "composerVoice 当前无贡献方"——voice-input 实际贡献 VoiceButton（plugin.json:13-16）——与 voice-input.md:27 互证口径不一
H34. system/i18n.md:96 "16 条（4×4）"——实 20 条含 i18n.ext（与 docs/i18n.md:446 的"16 条"同伤，README 48 文件说亦同源）
M36. languages 贡献计数法漂移（15 篇 18 处，模式=后加 *.plugin/*.sidePanel ns 未入档）：token-stats(16→20)/llm-recorder(12→16)/pi.md(8ns/32→6ns/24)/dsh.md(1→2ns)/tool-manager(12→16)/file-preview(4→8)/file-tree(8→12)/stickers(8→16)/sub-agent(8→16)/im-graph(4→12)/review(8→12)/session-bookmarks(4→12)/session-tree(12→16)/continue(2→8)/voice-input(4→12)/plugin-manager/plugin.json 口径/read-claude-md"无 contributes"(实有 languages 4 条)/retry 四项(实 8)、system/i18n.md:29 "38 个插件"(实 50)
M37. sessions/goal.md（docs/plugins 篇）:31 DEFAULT_MAX_GOAL_ROUNDS=256（实 1000）；:10 "没有 locales/"（实有四语）；:18-22 教 piExtension/dshExtension 旧字段名（实 extensions:{pi,dsh}）+“两槽贡献”（实五键）
M38. kernels/dsh.md:263 "assemble.ts:164-176 DSH_FIT_EXTENSION_SOURCE 合并四插件"——壳常量已删（dsh/plugin.ts:145），资产现内核自持 + syncFit；随插件带 dsh-extension 的只剩 goal/llm-recorder
M39. 行数断言漂移：timeline.md:21 "1549 行"（实 1686）、:27 "573"（实 677）、continue.md:10 "58"（72）、blind-review.md:61 "89"（129）、token-stats.md:22 "118"（138）、file-tree.md:5 "37"
M40. themes/theme.md:15 light "26 key"（实 25；dark 36 对）；font-presets.md:3 "17 项"（实 18；README 同伤）
M41. sessions-list.md:162/:280 parentPathKey（实 parentPathField）；ask.md:31 "piExtension"旧名；sessions-list.md:294 同
【裁决】plugins 组称 keybindings.md "11 条核过为真"是**误判**——DEFAULT_BINDINGS 逐条数实为 10 条（bindings.ts 无 11th）；docs/plugins/system/keybindings.md:3/:59 "11 条"确系漂移，与 README:509"11 个默认"同根（代码注释"第 17 行"之类行锚也偏）。keybindings 守卫只断言 parsed.length==DEFAULT_BINDINGS.length（未钉具体数），计数漂移无守卫拦
L4. timeline.md:63-71 dependsOn "pi-manager" 悬空 id 依据段（pi 插件 id 实为 "pi"）；goal.md:150 timeline 行号 788-797→923-926、composer 67-68→363-365；tool-manager.md:45 行号微漂
- minimal.md 的 Minimal*Page 三符号**确认是 audit:symbols 假阳性**（真实存在于 test-plugins/kernels/minimal/renderer/{index,extensions,models}.tsx），文档无误——audit 工具漏扫 test-plugins 实锤（M2）

### docs/legacy 历史层组（subagent 全审 36 篇）
H35. legacy 平铺层 18/36 篇无任何历史横幅（blind-review、context-files、git-review、i18n、pi-manager、pi-model-manager、plugin-manager-ui、plugins、projects、run-panel、session-bookmarks、session-tree、sessions-list、skill-manager、structure-analysis、theme-manager、themes、token-stats）——而 DESIGN/core-spec/desktop/001-012 另 18 篇全部有横幅；audit:docs 又明确排除 /legacy/（"冻结归档不造没法修的红"），冻结层既无标注保障也无扫描兜底，读者无从辨伪
H36. 合并确认（README "旧文档"段五处路径全过期 + manager 清单 + kernels 域缺行——与 H1 同源，本组给出完整证据链：docs/core/、docs/desktop/、docs/plugins/*.md 平铺、DESIGN.md、core-spec.md 实际全在 docs/legacy/ 下）
H37. 同名 14 对 legacy↔现行文档仅 i18n 一对有指针，其余双无取代指针（themes、theme-manager、session-tree、sessions-list、skill-manager、token-stats、projects、session-bookmarks、git-review、blind-review、plugin-manager-ui、pi-manager、pi-model-manager、plugins）——读者两篇都搜到时无所适从
M42. legacy/i18n.md 全篇教死 API window.pi.* + 48 资源（实 20）；pi-manager.md 教 usePiApi()（全仓 0 命中）+ 描述的插件本身已不存在（并入 kernels/pi）；themes.md 教 pi.themes.list() + "七个主题插件"（实八个+everforest）；session-tree.md 引死路径 gateway/context-binding.ts + fork(entryId,"at") 旧签名
L5. legacy/DESIGN.md:5 横幅自身尾引 docs/core-spec.md 也不存在（同目录即是）

### 架构组 A（subagent 全审 + 主线复核实锤）
【代码缺陷，文档照出】P0 序候选：src/server/controllers/sessions.ts:171-175 的 IPC.session.runBash handler 无任何 assertPermission（注释自称"高危 RCE 门控"，但 rpc:bash 权限在 server 端从未被检查；对比 kernel.ts:120 llm:oneshot、fs-git.ts:36 fs:project 都有 assertPermission 门）。glossary.md:43、build-kernel.ts:409 注释、context.ts:198 都声称"需声明 rpc:bash"——三处文档/注释声称的门在服务端不存在。建议：补 `assertPermission(pluginId, "rpc:bash")`（或至少在报告中标为待修 bug）
H38. docs/model-switching.md:196/:200/:219/:347 "switchKernelEnabled = false、gate 死"（实值 true，session-store.ts:195）；:146/:150 §10/§11 "桶探测/dispose+flush+resume 补丁、修法待做"——§11.2 修法已落地（supportsRuntimeSetModel 判据 + installModelSelection 原地热切），文档自陈"待做"未标已落地
H39. docs/core-design.md:46/:57 resume? 两大段当现状讲（r72 已删）；:68 capabilities.extensions?: unknown 桶（同文 :238 自己写对"已退役"，自相矛盾）
H40. docs/session-mapping.md:11 自相矛盾（同句先说 factories 已删又指 factories/kernel-factories.ts）；:101/:319 三引已删的 kernel-factories.ts:38-52（createPiBackend 实在 pi-backend-factory.ts:45）
M43. glossary.md:48（KernelId 字面量/:50 capabilities.pi——并入 H8）；core-design.md:46/:208 "4 缺面默认"（实 3，幽灵 continue?）；glossary.md:44/core-design.md:175/:306/:316 piExtension/dshExtension 旧字段名（实 extensions 映射）；session-mapping.md:285 "加字面量+switch 穷尽"旧模型（实插件+注册）；thin-shell.md:31/:201/:311 KernelId/KERNEL_IDS 证据、:23 "590 行零 import"（实 702 行 3 个内部 type import）、:277/:316 factories
M44. docs/README.md 增补发现：model-switching.md 整篇缺列（18 篇只列 17）；core-design.md 字数 ~1.5w 标注实 ~3.1w（翻倍）；:51 manager 域 dsh-manager/pi-manager + :48 六域缺 kernels（并入 H1/H36）
L6. e2e-verify.md:7 "49 个内置"（实 50，脚本判据 >=49 宽松）；core-design.md:498 "9 个主题插件"（实 8 插件 13 贡献）、:499 "38 个插件"（实 50）；model-switching.md:3 "Electron 双进程 IPC"（已前后端分离 WS/HTTP）；minimal-kernel-acceptance.md:84 "extension 轴名"（已细化 11 轴）;e2e-verify.md:89 写死 dev 模型名（环境相关断言）

### 运行态组：desktop-understanding.md + session-flow.md（subagent 全审 + 主线抽验坐实）
H41. desktop-understanding.md:62 "assemble.ts 706 行全是构造+绑定"、§2.1 时序图把 15 个启动动作画进 assemble 内部——实际 assemble 仅 82 行，编排已重构为 boot/steps/ 14 个具名步骤 + runColdBoot；:428 "assemble 是唯一 import 具体内核的地方(经 kernel/factories)"——factories 已删、装配零具体内核 import
H42. desktop-understanding.md:290/:109/:113/:476 "禁用插件注册后撤 + i18n 多合并几串无害"——实际发现即过滤不注册（40-shell-plugins.ts:69-77，文件头注释自己点名旧做法被推翻），i18n 合并在过滤后
H43. desktop-understanding.md 八处（:157/:185/:239/:243/:388/:438/:460/:464）capabilities.pi/BackendExtensions 旧桶模型 + "dsh sync() 降级 no-op"——实际 11 轴能力面，sync 对无快照内核照常产出中立基线
H44. session-flow.md "continue 第八意图"整段（:59-61/:185/:431/:444-451/:482/:533 + §10.2）——continue 不在 BaseBackend、两后端无此方法、SessionStore.continue 不存在、dsh session/continue 无调用方；续跑=发消息（纯插件层）；与 glossary/directory-structure 的 continue? 幽灵成员（H6）同源
H45. session-flow.md:230-231 "31 个命令闭联合"且列含 fork/clone/get_fork_messages/export_html——联合实 29 个、这四个全不在（forkless 已删）（与 H4/H20 同源）
H46. session-flow.md:348/:537 withNeutralEntry "翻译器代投 entryAppended"当现存机制——已删（test:316 注释），现状主侧写穿 writeThroughMessageEnd（session-store.ts:1451/:3002），entryAppended 降级回填/补漏（:1406-1412 注释明说）
H47.（两篇共通最大漂移）desktop-understanding.md:390-397 + session-flow.md:406-420 "renderer applyEvent 纯函数 per-messageId patch、entryAppended 两段制水合"——实际前端已重构为中立层镜像(neutralChange→applyNeutralChange 归约)+执行态叠加层(applyOverlayEvent 只管流式占位/工具登记)；per-messageId 内容 patch 已不存在
M45. session-flow.md:439 "先 abortBash 再 abort 壳侧顺序"（实况收编进 backend.abort，壳内核无关——与 desktop-kernel 组 M22 同源互证）；:187/:293 capabilities.pi 探测、capabilities.dsh={missing,onMissing}（实 thinking 轴）；:199 ensureForSend "必须停旧起新"（实两根正交轴：supportsRuntimeSetModel 热切在位则原地热切）；:488 switchKernel gate 锁死（实已启用 true，与 H38 同源）；:61/:59 resume? 核心（并入 H5）
M46. desktop-understanding.md:98 SessionStore 构造签名（agentDir 参数已无、kernelFacts getter 新增）；:192 "bus 会话恒 pi、KERNEL_IDS[0]"（实父会话继承+soleProc）；:248/:442 asPi/piSend（已退役为 faceOf/viaFace）、clone 归壳（session-store.ts:2736 中立层复制+pendingSeed）
L7. desktop-understanding.md:420/:480 "双入口不到 120 行"（实 176 行）；session-flow.md:404 preload 桥（已退位，WS push）；session-flow.md:289 initialize 传 maxTokens（握手未传）

### 追加（主线复核死面）
L8. packages/shared/src/domain/contributions.ts:449 的 `export type SlotName`（27 名联合、含 4 预留名）**零 import**——registry 的 arraySlots、查询 hooks 都不消费它；core-design.md:515 自称"四个预留名尚无贡献接口"。它是"看起来是契约的死类型"；教程文档（core-design/new-plugin）把它当"槽位全集"引用，实际运行时唯一权威是 registry/registry.ts 的 20 个 arraySlots + 特殊槽。建议：或删 SlotName，或改为从 PluginContributes 派生的纯投影并注明

### CLAUDE.md 组（subagent 全审 + 主线抽验坐实）
- 与主线自查重叠确认：KernelId 旧模型（:361/:391/:59）、resume 核心（:9/:630/:685）、31 命令（:137/:155/:325/:369/:693）——坐实 H2/H3/H4
H48. BackendCapabilities「十一个轴」计数漂移——实际 12 成员（+systemPrompt?: boolean，backend.ts:378，r50 落地）；CLAUDE.md:90/:475 两处列举均漏 systemPrompt
H49. §7.3:501 systemPrompts 槽「dsh 走 cordis」——dsh/minimal/probe4 目录 systemPrompt 零消费（静默缺面而非"走 cordis"）；只有 pi 声明 systemPrompt:true
H50. §7.3 槽位清单（19 项）漏已实现的 composerTop/composerVoice（goal/voice-input 真实贡献中）
M47. CLAUDE.md:321-338 §6.1 目录树漏 probe4/（真实内核目录）与 kernel/ 根下两个跨内核契约测试（seed-transcription.test.ts/tool-filter-axis.test.ts，文件头明说放顶层因要 import 三个内核）；§6.2 pi/backend 清单漏 rpc-adapter.ts/resync.ts/pi-legacy-sessions.ts；§6.2 model/ 漏 known-tools.ts
M48. 代码侧守卫漏洞（文档审计照出）：scripts/dependency-audit.mjs:183/:289 两处 KERNEL_DIRS/KERNEL_IDS 硬编码 ["pi","dsh","minimal"] **不含 probe4**——检验⑧互引/⑪自包含/⑫内核名前缀都漏守 probe4 目录；与"加内核=零改动"的叙述矛盾（新内核的越界 import 无人拦）
M49. CLAUDE.md:8 术语表 dsh 插件树举例「llm-deepseek」——生产代码零引用（仅测试文件），dsh-config-source 活跃插件是 subagent/compaction-basic/credentials-local；CLAUDE.md 未提 dsh 侧统一适配插件 my-harness-fit-dsh-extension（对称信息缺失）
M50. §9.4:630 "3 个默认成员（capabilities/configDepPaths/sessionId）"——sessionId 实为 getter 默认（abstract-backend.ts:61），写法口径偏；与 §6.2/pi/backend 相关计数注记建议同批理清
（另：CLAUDE.md 大量"核过为真"——十三检验、50 插件、npm scripts、双入口、事件总线、已知偏离自陈（THEME_TOKEN_DEFAULTS/roleToPrompt 仍真）等主线亦独立复核过）

### design 插件渲染组（54 篇亲审）
H51. session-row-badges.md:320/:381——以现状口吻引 "goal-controller.ts:49 模块级单例 + :74 __resetGoalStoreForTests" 作为成熟先例；实际 goal 已迁会话作用域槽（goal-controller.ts:9-25 头注释把模块级单例列为四个串台病灶；__resetGoalStoreForTests 全仓消失）。该文引它论证行级数据源的抗重挂载设计，根基已被推翻
M51. session-row-badges.md:674 "ask 插件目前没有 locales，硬编码十余处中文"——实际 ask 已有四语 locales + 56 处 t()；文档据以立项的"既存债"不存在
M52. echo-attachments-persist.md 整篇现在时描述"头行 custom 域 {items} 持久化"——机制已全链路退役（echoAttachments 全仓 0 命中；qa 还教第三方"能蹭上"）；review-plugin.md:8/:76/:111-116/:144/:152/:189 同伤（sendSuffix 部分仍真）
M53. plugin-decoupling.md §4.1 有过期横幅但 §5.1 的 review:* 六通道现状已落地收回未标注；§5.2/5.3 onSent 回调方案实际落地为 lastSendNonce 侧通道（形态偏离未注）
L9. design-principles.md:447-450 引 docs/desktop/、docs/DESIGN.md 旧路径（已迁 legacy/）；dynamic-layout.md:3、session-header-custom.md、web-service-architecture.md 同种；docs/plugins/insight/blind-review.md:23 引不存在的 docs/plugins/blind-review.md（实为 docs/legacy/）；note-plugin.md 建议加"已被 stickers 吸收"横幅；panel-style-system.md --panel-* → sidepanel 改名未标
- 该组的 session-row-badges 终裁与主线一致：机制未落地=合法设计先行；需修的是两条过期先例 + 文首"提案未落地"总注

---
## 交叉验证轮（6 组对抗性证伪，2026-10-02 第二轮）

### 总判定
55 条抽验断言：约 84% 完全确认。**推翻本报告初版断言 3 条**（已回写终版）：
- ❌→✅ H 附注"AbstractBackend 15 个 abstract"：实数 **14**（初版把 abstract-backend.ts:37 的 stale 注释当证据；该注释本身进 §3 stale 清单）
- ❌→✅ "PiBackend implements 8 个面"：实数 **9**（CLAUDE.md:369 "九个"本来是对的）——该发现撤销
- ❌→✅ "glossary.md:78 '以代码 14 条 abstract 为准' 是错句"：该句是对的（实数 14），撤销；glossary 真错在 :15 "4 缺面默认"（应 3）与 :11 "六域"

### 口径收窄（4 条）
- "任何 audit 不扫 CLAUDE.md"→ ref-audit.mjs:34 明确扫 CLAUDE.md/README（只验 §N）；准确说法是"退役符号/语义漂移无守卫覆盖 CLAUDE.md"
- docs/README "旧文档关系"段 6 项中 **5** 项已迁，**docs/design/ 是冤案**（现行权威）
- 同名 legacy↔现行文档 **10 对**（严格同名口径），非 14；互指路径 docs/plugins/i18n.md 本身 404
- 22 处代码注释死路径中 docs/desktop 实测 **0** 处；legacy 同形对应只对 docs/core 10 处成立（modules 8 处与 05-plugin-i18n 4 处是直接删除未归档，d1fc9dea9）

### 升格/新事实（5 条）
- runBash **前端也无门**（usePluginContext 从未暴露 bash 面）+ **capability-axis-consumers.test.ts:58 守卫测试引用不存在的门** + gateway 无 per-channel 策略——升格为"全链路无门"
- session-store.ts:2239——setModel 对**有历史会话**已直走 switchKernel（"锁死"整句不成立，行为边界反转）
- audit 脚本漏 probe4 是 **⑧⑪⑬ 三处齐漏**（:183/:289/:404）
- audit:docs 假绿豁免量化：**118/425=27.8%** 命中完全依赖判据②（thin-shell 11 处等 17+ 份文档）；前缀锚定修法经回归实验不误伤真横幅（红 0→43 全为假绿揭开）；RETIRED `sessions.pi` 子串撞 i18n 键前缀的假红风险（sessions-list.md:27/:146）
- 行号锚 **1893 处**零守卫，抽验 4/4 全漂（788-797→923-926、748-756→882、1549 行→1686、67-68→363）
- SessionStore 构造 **8 参**（questionStore 是第 8 参，第 3 参 kernelFacts getter）
- README"分区字号 slider"部分存在（三 tab 各一 range：sidebar/sidepanel/timeline FontScale）；"三处宽度 slider"仍纯属虚构（宽度只有 layout-engine 拖拽手柄）
- 新 stale 代码注释：abstract-backend.ts:37"15 条"（实 14）、dsh-methods.ts:9"26 个"（实 21）、rpc-types.ts:4/:88"31 个"（实 29）

### 交叉验证产物
复现脚本与全量输出在 /tmp/adv-xcheck/（repro-banner.mjs 与真实脚本 425 命中/0 违规完全对齐，可作回归基线）
