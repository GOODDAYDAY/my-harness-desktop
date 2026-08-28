# 薄壳架构：机制与内容的边界，以及这套纪律如何落地

my-harness-desktop 是一个多内核（pi + dsh 同级）AI agent 桌面壳。它最核心的一条架构主张可以用一句话说清：**壳只提供机制，内容全部外挂；壳的功能含量趋近于零。** 这句话不是口号，是一套可执行的纪律——它有判据、有物理分区、有 grep 检验、有 lint 强制，违反任何一条都能被一个不熟悉代码库的人当场指认。

- 本文是论证，不是盘点。它的目的是回答四个问题：**为什么壳必须薄**（不是偏好，是变更隔离的物理需要）、**薄到什么程度**（功能含量趋近于零，但机制必须强）、**机制与内容的边界在哪**（一条判据、两个问法）、**这套纪律如何在真实代码里落地**（每个论断落到具体文件、函数、类型名）。

- 本文的结论以代码为准。历史文档 `docs/desktop/008-thin-shell.md`、`docs/design/plugin-isolation-principles.md`、`docs/design/design-principles.md` 论述了同一批原则，但它们的部分路径已陈旧（旧术语"底座"指 pi 内核、旧目录 `core/`+`api/`+`client/` 已重构为 `src/server/`+`src/web/`+`src/plugins/`+`packages/`）。本文的每个落点都指向当前仓库里真实存在的文件与符号，不引用已经不存在的路径。

- 先说清楚几个贯穿全文的术语，避免反复解释：**壳** = `packages/shared`（圆心）+ `src/server`（壳后端）+ `src/web`（前端）里的机制代码；**壳插件** = `src/plugins/` 里 50 个（六域 insight/manager/project/sessions/system/themes）及第三方目录里的内容层代码；**内核** = pi 与 dsh 两个同级 agent 运行时；**圆心** = `packages/shared/src/domain/`，纯类型 + 纯函数、零依赖；**中立契约** = `BaseBackend` 等壳向内核索要的最小意图集合；**槽位** = 壳预定的挂载点。

---

## 1 判据：机制与内容的分界线

薄壳的本质问题只有一个：**一段代码该留在壳里，还是该推出去？** 答案不是靠感觉，是靠一条判据的两个问法。这两个问法不需要架构知识，新人也能当场回答。

### 1.1 一条判据、两个问法

- **问法一：一年后这东西会不会换？** 会换，推出去；不会换，才考虑留在壳里。这个问法的妙处在于它切在"会变"这个物理事实上，而不是切在"现在看起来重不重要"这个主观判断上。

- **问法二：拿掉它，系统还能不能启动？** 能启动，它就是可选的，推出去；不能启动，它才是机制，留在壳里。这两个问法要**同时满足**——"不会换"只是必要条件，"拿掉就启动不了"才是充分条件。只满足一条不够。

- 判据在代码里的直接体现是 `packages/shared/src/domain/contributions.ts` 顶部那行注释："圆心拥有的稳定契约"。这个文件 590 行，定义了 `SlotName` 联合、`PluginManifest`、`PluginContributes` 和约 20 个贡献项接口，但它一个 import 都没有——它定义的是"壳和壳插件之间交互的形状"，这个形状换了技术栈、换了内核、换了 UI 框架都不会变，所以它留在圆心。

### 1.2 判据的四个推论

判据本身只有一句话，但把它推到边界案例上，能推出四条没有中间态的铁律。旧文档 `docs/desktop/008-thin-shell.md` §2.3 把这几条边界案例讲得最透：

- **"这个以后可能会加一种新形态" → 会换，推出去。** 犹豫本身就是推出去的信号。真正不会换的东西，你问这个问法时不需要犹豫。

- **"这个现在只有一种，但理论上可以有别的" → 会换，推出去。** 内核是这句话的典型样本：pi 曾经是唯一内核，dsh 的接入证明"内核"是一个抽象、pi 只是它的一个实现。`packages/shared/src/domain/kernel.ts` 里 `KernelId = "pi" | "dsh"` 和 `KERNEL_IDS = ["pi", "dsh"]` 就是这个抽象的直接证据——加第三个内核只在这里加一个字面量，编译器逼着所有 `switch(kernel)` 补全。

- **"这个虽然不变，但拿掉它系统也能跑" → 可选的，推出去。** 某个特定的渲染组件、某个特定的管理页，都属于这一类——壳不知道它存在也能正常启动。

- **"这个拿掉系统就不能启动，而且不会换" → 留在壳里。** 加载器、槽位契约、中立契约、权限沙箱、生命周期、事件总线，全部落在这一格里（§2 逐条展开）。

### 1.3 token key 合规，token 值违规

机制与内容的边界，落到最细的粒度是"key 和值"的区分。这条区分是整个薄壳纪律里最容易误判、也最能一眼判的一条。

- **壳渲染时必然出现查询标识**：`theme["color.primary"]`、`i18n.t("timeline.toolExecuting")`。这些是 **key**，是稳定不变的查询契约，不算"写死"。`packages/shared/src/domain/slots/theme-tokens.ts` 里的 `THEME_TOKEN_KEYS` 数组就是这份 key 清单——`color.bg`、`color.fg`、`font.size.base`、`spacing.md` 等 50 多个 token key 是契约，它们列在圆心里是对的。

- **违规的是写死 key 背后的值**：`"#89b4fa"` 是颜色值，`"工具执行中"` 是文案原文，它们是会变的内容。key 是契约、值是内容，性质完全不同。主题插件在 `src/plugins/themes/*/plugin.json` 里给 `THEME_TOKEN_KEYS` 的每个 key 填值，语言插件在 `src/plugins/system/i18n/locales/` 里给每个 i18n key 填文案——壳只持有 key，从不持有值。

- 这条边界的唯一已知偏离在 `theme-tokens.ts` 的 `THEME_TOKEN_DEFAULTS`：它是一份"低保真兜底"色值（`"color.bg": "#0e0e11"` 等），语义是主题插件损坏/缺失时防白屏，不是 dark 主题的复制。文件注释里明确写了"与 dark 主题的精值无关""不加新 token 值、不追对齐具体主题"，并记录了历史漂移 3 处的根因是"外层把兜底误读为 dark 复制"。这是圆心内容泄漏的历史残留，标注演进，不推翻铁律。

### 1.4 为什么必须这么极端

薄壳纪律之所以不设中间态，是因为内容会变、机制相对稳定，而"把会变的焊死在壳里"的代价是指数级的。

- 把文案焊死在壳里，意味着每次改一句"工具执行中"的措辞，都要动壳、都要发版、都要全量回归；把文案推给语言插件，改文案只动 `src/plugins/system/i18n/locales/` 下的 JSON，壳一行不动。同样的推理适用于配色（改主题动 `src/plugins/themes/*/plugin.json`）、渲染（改时间线动 `src/plugins/sessions/timeline/`）、管理页（改管理动 `src/plugins/manager/`）。

- 更隐蔽的代价是**分支爆炸**：一旦壳开始"如果这是 pi 的就……"地识别内核身份，每加一种内核形态就多一条分支，每条分支都是 bug 温床。这个推理在 §4（无特权差异）里展开，但它和"内容会变"是同一条根——**内容会变和"内容有多种形态"是同一件事的两种表达**，都指向"壳不该知道具体内容是什么"。

---

## 2 壳里放什么：六件机制

能留在壳里的东西，必须同时满足"一年后不会换"和"拿掉就不能启动"两个条件。满足这两个条件的只有六类：加载器、槽位契约、中立契约、事件总线、权限沙箱、生命周期管理。这六类东西的共性是：它们是"让功能能挂上来"的能力，不是"挂上来之后干什么"的功能。

### 2.1 加载器

加载器是壳的心脏——没有它，一切壳插件都挂不上来，系统空转。

- **发现**：`src/server/application/loader/discover.ts` 的 `discoverPlugins(rootDir, source)` 递归扫描一个根目录，深度上限 3，含 `plugin.json` 且 `manifest.id` 非空字符串的目录即插件，不再深入。这个函数 63 行，没有任何 `if (builtin)` 分支——内置目录和用户目录走同一个函数，只有 `source` 参数不同。

- **注册**：`src/server/application/loader/registry.ts` 的 `PluginRegistry` 聚合发现结果。它用一个通用容器 `ArraySlot<T>` 承载 20 个结构相同的数组类槽位，`registerOne` 遍历 `arraySlots` 映射通用注册，`unregister` 通用注销——加一个新数组类槽位只需在 `arraySlots` 加一行 + 加一个字段 + 加一个查询方法（开闭原则）。

- **组装**：`src/server/bootstrap/assemble.ts` 里四行调用把四目录接进来：`registry.registerAll(discoverPlugins(builtinDir, "builtin"))` → `installed` → `user` → `project`。注册序即优先级序，低优先级先注册、高优先级后注册，后注册者覆盖先注册者（§4.1）。

### 2.2 槽位契约

槽位是壳和壳插件之间的接口定义。"有槽位契约"这件事不会变，留在壳里；每个槽位的形状随版本演进，但演进的载体是圆心契约，不是散落的实现。

- 槽位契约的完整定义在 `packages/shared/src/domain/contributions.ts`：`SlotName` 联合列了 27 个槽位名（`languages`/`themes`/`sidePanel`/`sidebar`/`mainView`/`titlebar`/`settings`/`settingsGroups`/`messageRenderers`/`fileActions`/`fileIcons`/`messageActions`/`blockRenderers`/`codeBlockRenderers`/`sessionGroupings`/`composerPolicies`/`composerAttachments`/`composerActions`/`composerStats`/`composerTop`/`composerVoice`/`systemPrompts`/`fontPresets` + 四个预留名 `management`/`cardRenderers`/`viewers`/`commands`），`PluginContributes` 接口把每个槽名映射到对应贡献项数组。

- 槽位契约的关键性质是**声明式**：`ThemeContribution` 的 `tokens: Record<string, string>`、`LanguageContribution` 的 `resources: Record<string, string> | string`、`SettingsGroupContribution` 的 `fields: SettingsFieldDecl[]`——插件只贡献数据，不写逻辑。`settingsGroups` 槽尤其典型：插件纯声明式地往"通用设置页"挂一框字段，`type: "boolean" | "enum" | "int"` 声明控件类型，由通用页的通用渲染器渲成 UI，插件零渲染代码。

### 2.3 中立契约

中立契约是壳和内核之间的接口定义——"壳只认一份中立契约、内核各交一个适配器"这件事不会变，留在圆心。

- 中立契约的完整形状在 `packages/shared/src/domain/backend.ts` 的 `BaseBackend` 接口：`kernel`/`alive`/`sessionId` 三个只读属性 + `start`/`stop`/`onEvent`/`sendMessage`/`abort`/`setModel`/`setSessionName`/`getTree`/`getEntries`/`bookmark`/`deleteBookmark`/`seed` 十四条必实现意图 + `resume?`/`continue?`/`listTools?`/`answerQuestion?` 四个可缺面意图 + `setThinkingLevel`（思考强度设置，dsh 显式降级抛错）+ `capabilities`（内核专属能力探测面，`{ pi?: unknown; dsh?: DshCapabilities }`）。

- 关键的设计判断是**什么不进契约**：`steer`/`followUp`/`onExtensionUI`/思考档位清单与循环切换，这些 pi 专属能力不进 `BaseBackend`，它们挂在 `capabilities.pi` 扩展面上，壳经能力探测"有则用、无则降级"。`packages/shared/src/domain/sessions.ts` 的 `PiExtensions` 接口（约 18 个方法）就是这块扩展面的形状。

- 更值得注意的是一个**反面判断**：`fork` 不在 `BaseBackend` 里。`backend.ts` 顶部注释写明了原因——"内核是单线执行器：只物化当前活跃那条 lineage，分叉是壳在中立层的纯操作"。fork 是壳的 `SessionTreeApi.fork(parentLineageId, boundary)`（`sessions.ts`），不是内核的进程操作。这条边界把"会话怎么分叉"从"内核怎么存会话"里彻底切开：内核只负责物化一条 lineage，分叉是壳在中立坐标系里的纯投影（`backend.ts` 的 `projectLineageTree` 纯函数），pi 的 `parentId` 树和 dsh 的 session forest 是同一棵 lineage 树的两种存储。

- 中立契约之外，还有两个正交接口：`SessionCatalog`（每内核跨会话目录/CRUD 的中立面）和 `KernelModelSource`（每内核模型清单的 `listModels()`）。三者分三块：`BaseBackend` 是 per-session 的进程+分支句柄，`SessionCatalog` 是 per-kernel 的跨会话存储，`KernelModelSource` 是 per-kernel 的模型清单——壳分别依赖这三个抽象，没有一个依赖具体内核。

### 2.4 事件总线

事件总线是壳和壳插件之间、壳插件之间的消息通道。通道的实现可以换，但"有一个通道"这件事不会变。

- 实现是 `packages/react/src/event-bus.ts` 的 `EventBusImpl` 单例 `eventBus`。它在 renderer 侧运行、不跨进程。channel 由代码级 `export const channels` 声明，框架加载 renderer module 后读 `module.channels` 自动注册（`src/web/app/plugins-host.ts` 的 `eventBus.registerChannels`）。

- 总线区分两种原语：`emit` 是发布/订阅，只能发自己声明过的 channel（`isChannelOwnedBy` 校验），payload 缓存供 `replayLast` 回放；`invoke` 是定向分派，调别的插件拥有的 channel，无订阅者时入 `pendingInvokes` 队列、首个订阅者挂载时恰好一次投递。`emit` 和 `invoke` 的语义差别是状态广播 vs 一次性命令，混用会出 bug。

- 框架系统事件用 `system:` 前缀（`emitSystem`），插件订阅不需要 `dependsOn`。`src/web/app/plugins-host.ts` 末尾把 main 侧的 `onSettingsChanged`/`onRefreshRequested`/`onSystemChanged` 桥接成 `system:settingsChanged`/`system:refreshRequested`/`system:systemThemeChanged`——main 进程的事件经 IPC 到 renderer，再经 renderer 总线 `emitSystem`，插件看到的始终是 renderer 侧的统一通道。

### 2.5 权限沙箱

壳插件是不可信代码，壳必须提供隔离和权限校验。"需要隔离"这件事不会变，留在壳里；具体的安全策略是会变的，推到各层实现。

- 权限模型分三层，形状定义在 `packages/shared/src/domain/context.ts` 的 `PluginContext`：**核心默认**（config/prefs/themes/sessions/i18n/models/kernels/notification，所有插件可用）、**声明能力**（`fs:project`/`git:read`/`git:write`/`llm:oneshot`/`sessions:bus`/`rpc:bash`，需在 `plugin.json` 的 `permissions` 字段声明）、**用户手势驱动**（dialog，由手势触发默认放行）。

- 权限校验的落地在 `src/server/application/loader/registry.ts` 的 `hasPermission` 和 `assertPermission`：后者先查 manifest 是否存在、再查权限是否声明，未声明即抛 `插件 ${pluginId} 未声明权限 ${permission}`。各 IPC 域共用这两个方法，不在每个 handler 文件各写一份（框架管通用）。

- 进程隔离是权限沙箱的另一半：内核是独立子进程（pi 经 JSONL RPC、dsh 经 JSON-RPC），renderer 跑在 Chromium 渲染进程，`contextIsolation` 与 `nodeIntegration` 是 Electron 层保证的。圆心只留中性契约，不知道也不关心"这个内核/插件有没有权限"。

### 2.6 生命周期管理

插件的 activate/deactivate/dispose、配置文件的读写和锁——是所有插件都需要的底层能力，不会换。

- 生命周期实现是 `src/server/application/lifecycle/index.ts`：`activate`（注册 → 加载 → 挂 skills/piExtension/dshExtension → 清 error 态）、`deactivate`（撤注册 → 摘扩展 → 通知组件卸载）、`reloadPlugin`（deactivate + rediscover + activate）、`disablePlugin`/`enablePlugin`（写 disabledPlugins 配置 + deactivate/activate）、`uninstallPlugin`（先 `canDeactivate` 检查，再撤注册）。

- 生命周期里有两个关键的机制细节。其一，`checkDependents` 反向依赖检查：卸载 A 前扫描所有插件，谁声明了 `dependsOn: ["A"]` 谁就是依赖方，阻止"拆掉 B 让依赖 B 的 A 崩掉"。其二，`collectComponentNames` 收集一个插件的所有 component 名，卸载时传给 `notifyPluginUnloaded`，让 renderer 侧摘掉已注册的组件——`reportLoadFailure` 在 renderer 上报加载失败时撤回贡献注册，避免出现"main 注册表昭告了贡献、renderer 却无组件可注册"的孤儿 Tab。

- 配置读写是生命周期的一部分：`src/server/application/config/config-file.ts` 提供 `withDirLock`/`readJsonFile`/`writeJsonFile`/`appendJsonlLine`/`readBinaryFile`/`writeBinaryFile` 六个原语，`withDirLock` 用 proper-lockfile 锁目录串行化并发写。`src/server/application/config/config-store.ts` 的 `ConfigStore` 在这些原语之上实现统一项目级配置通道：一个插件一个文件、两层浅合并（全局兜底 + 项目级 diff）、per-file 写队列防 ELOCKED、`assertValidPluginId` 用正则 `PLUGIN_ID_RE` 防路径逃逸。

---

## 3 壳里不放什么：内容全部外挂

"壳里不放什么"的判据比"壳里放什么"宽松——只需满足"会变"或"可替换"之一，就推出去。这一节逐条把内容推到它该去的地方。

### 3.1 文案 → i18n 插件

壳里不允许出现任何写死的用户可见文案，文案全部由语言插件贡献。

- 文案的落点是 `src/plugins/system/i18n/locales/{locale}/*.json`，键值对形式，如 `"shell.settings": "设置"`。壳代码里只出现 `t("shell.settings")`，不出现 `"设置"` 或 `"Settings"`。

- 证据在 `src/plugins/sessions/timeline/plugin.json` 的 `contributes.languages`：这个插件贡献了 16 条 `LanguageContribution`（4 个 namespace × 4 个 locale），每条指向 `./locales/{locale}/{namespace}.json`。timeline 的中区渲染代码大量使用 `t("timeline.xxx")`，但没有一处写死中文/英文原文。

- **退化行为是这条铁律的试金石**：删掉 i18n 插件，壳照常启动，所有界面文案退化为 key 原文。i18next 配的 `fallbackLng: "en"` 也没有资源可回——壳没有"默认英文文案"，因为所有文案都是外挂。退化成 key 不是 bug，是设计——它证明壳确实没内嵌文案，一旦失去语言插件，它诚实地告诉你"我缺了这部分内容"。旧文档 `008-thin-shell.md` §1.1 把这条讲得最透。

### 3.2 配色 → 主题插件

壳里不允许出现写死的颜色十六进制，配色全部由主题插件贡献。

- 配色的落点是 `src/plugins/themes/*/plugin.json` 的 `contributes.themes`。`ThemeContribution` 的 `tokens: Record<string, string>` 把 `THEME_TOKEN_KEYS` 里的每个 key 填上值。主题插件是纯 JSON 声明，没有任何代码逻辑。

- 壳侧只认 token key。`theme-tokens.ts` 定义了 key 清单 + `DERIVED_TOKENS`（`border.color`、`font.size.*` 等派生 token，插件显式赋值会记警告并忽略）+ `CONTRAST_PAIRS`（需校验 WCAG AA 对比度的颜色对）。主题合并逻辑在 `src/server/application/theme/merge.ts`，它从注册表拿 `themesRegistry()`，不 import 任何主题数据——换主题是换 JSON，合并逻辑一行不动。

- 一个诚实的偏离要记录在案：`src/web/login-gate.ts` 和 `src/web/bootstrap.ts` 里存在写死的 hex 颜色（`#101014`、`#e6e6ea` 等）和内联样式。这是登录门和启动错误横幅——它们在**任何插件加载之前**渲染，此时主题插件还没贡献 token，无法消费 `var(--color-*)`。这是"机制自带的引导 chrome"，是有界例外，但严格讲仍是壳里写死了颜色，应标注为演进待收（引导 chrome 也应该有自己的内置 token 源，而不是裸 hex）。

### 3.3 渲染 → 渲染插件

壳里不允许出现"如果工具名是 bash 就渲染成终端"这类业务分支，渲染逻辑全部由渲染插件承担。

- 最标志性的案例是时间线渲染。`contributions.ts` 里 `MainViewContribution` 的注释直接记录了这段历史："此前 message-list 焊在 shell（内容焊死内核，违反 §7.2'时间线渲染→timeline 插件'）。开 mainView 槽：壳只留空中区容器 + 按槽查组件渲染，时间线内容外挂 timeline 插件。"

- 落地后：timeline 插件经 `mainView` 槽贡献 `{ id: "timeline", component: "TimelineView", order: 100 }`（见 `src/plugins/sessions/timeline/plugin.json`），壳的中区容器只做一件事——查 `mainView` 槽、取 `component` 名、渲染它。换掉 timeline 插件，壳的中区就是一片空白，换个新的消息渲染插件就换一种呈现方式。壳既不认识"消息气泡"，也不认识"思考块"，它只认识"mainView 槽上有贡献"。

- 同样的机制延伸到更细的粒度：`blockRenderers` 槽按块类型（`thinking`/`toolCall`/`text`/`userText`/`divider`）分发渲染器，`codeBlockRenderers` 槽按围栏语言（`mermaid`/`puml`）分发渲染器，`messageActions`/`fileActions` 槽往消息行/文件上下文贡献动作按钮。渲染的知识全部归贡献方，壳只提供挂载点和按槽查询的机制。

### 3.4 内核存储 → 内核后端

壳不读任何内核的存储格式，存储全部退进内核后端。

- pi 的会话是 JSONL 文件 + `parentId` 树，dsh 的会话是 append-only 日志 + session forest。这两种存储格式都是内核专属的，壳一个都不碰。`backend.ts` 的 `BaseBackend.sessionId` 注释写死了这条："壳经此读取，不自行按内核身份拼内核会话 id"，pi 的 `sessionId` 是 JSONL 文件路径、dsh 的是不透明 id，壳只把它当 token 回传，不解析。

- `SessionCatalog` 接口是这条边界的正面落点：`rename`/`updateHeader`/`deleteSessions`/`copy`/`readToolConfig`/`readCustom`/`contextProbeTokens`/`newSessionId`/`projectionPath`/`rawFilePath`/`projectStats`/`getTree`/`bookmark`/`deleteBookmark`——这些跨会话操作的 pi 答案是文件读写 + parentId 树，dsh 答案是 JSON-RPC，都退进各自的 catalog 适配器，壳只认中性类型。

- 一个常被问到的具体问题（"会话为什么用 JSONL 而不是数据库"）的答案是这条纪律的直接推论：选 JSONL 是 pi 后端内部的取舍，不是壳的契约；壳只认不透明 `sessionId` 和 `LineageTree`，pi 后端存 JSONL、dsh 后端存 append-only 日志，壳都不关心。

### 3.5 内核专属能力 → 内核扩展面

内核的专属能力不进中立契约，挂在内核扩展面上，"有则用、无则降级"。

- pi 的多路并发（`steer`/`followUp`）、自动重试（`abortRetry`）、快捷循环切模型（`cycleModel`）、上下文压缩（`compact`）、HTML 导出（`exportHtml`）——这些是 `PiExtensions` 接口里的 18 个方法，dsh 没有这些面。

- 壳访问这些能力的方式是能力探测，不是内核身份硬分支。`src/server/application/sessions/session-store.ts` 的 `asPi(proc)` 方法：`const pi = proc.backend.capabilities.pi; if (!pi) throw new Error("当前后端不支持 pi 专属命令")`。它在 `backend.capabilities.pi` 上探测，dsh 无此面就抛错降级，代码里没有 `if (kernel === "pi")`。

- 思考强度是"专属能力分半"的教科书案例：**设置**（`setThinkingLevel`）进了中立契约（`BaseBackend` 里是必实现方法，dsh 侧继承 `AbstractBackend` 的缺面默认抛"当前内核不支持思考强度切换"）；**档位清单与循环切换**（`getThinkingLevels`/`cycleThinkingLevel`）仍留在 pi 扩展面。要么将来给 dsh 写 cordis 插件补面，要么永久降级——但绝不静默吞掉。

---

## 4 无特权差异

无特权差异有两个对象：壳插件和内核。守不住这条，薄壳就守不住——因为特权是复杂度炸弹，每一条"特殊对待"的分支都是 bug 温床。

### 4.1 内置壳插件 = 第三方壳插件

内置插件和第三方插件走同一套加载器、同一套契约、同一套权限，优先级最低、可被覆盖。

- **同一套加载器**：`discoverPlugins` 没有 `if (builtin)` 分支，内置目录和用户目录走同一个函数，只有 `source` 参数不同（`discover.ts` 顶部注释明说"内置与第三方平等：同一扫描逻辑，无 if(builtin) 分支"）。

- **同一套覆盖语义**：`PluginRegistry` 的 `ArraySlot.removeById` 按 `contribution.id` 清同 id 旧项，`registerOne` 在 push 前先 `removeById`。bootstrap 的注册序 `builtin → installed → user → project` 保证后注册者（更高优先级 source）覆盖先注册者。这段逻辑是通用的，没有"如果是 builtin 源就跳过"的判断——`removeById` 只认 id，不认 source。

- **同一套权限**：权限校验走 `registry.assertPermission(pluginId, permission)`，内置和第三方都查 manifest 的 `permissions` 字段，没有"内置插件默认放行"的路径。

- **"不可卸载"不是特权，是 manifest 声明**：`lifecycle/index.ts` 顶部注释写死了这条——"不可卸载由 manifest 的 protected 字段声明，内核不硬编码插件 id"。`canUninstall` 读 `manifest.protected`，plugin-manager/i18n/theme 各自在 `plugin.json` 声明 `protected: true`。这是数据，不是特权分支。

- **两条检验**：其一，删掉任何一个内置插件，壳照常启动，只是少了那块功能（删 timeline，中区显示"mainView 槽无贡献"）。其二，把内置插件复制到用户目录，它以更高优先级覆盖内置版——因为 user 的 source 序高于 builtin。

### 4.2 pi = dsh

pi 和 dsh 同级，谁也不比谁更"内建"。壳不该有任何"识别 pi 并特殊对待"的代码路径。

- 内核身份单源在 `packages/shared/src/domain/kernel.ts`：`KernelId = "pi" | "dsh"` 一处定义，全仓其他地方的 `"pi" | "dsh"` 字面量都是从圆心 re-export 或窄化，不复刻联合。`sessions.ts` 里的 `isKernelId` 是读回已持久化内核 id 的窄化守卫，不是散落的内核身份。

- 内核身份的**运行时路由**只有一处合法落点：组装根。`assemble.ts` 的 `baseBackendFactory.create` 里 `if (opts.kernel !== "dsh") return createPiBackend(...)`——这是把中立契约和具体实现绑起来的工厂闭包，是"接口与实现相遇"的唯一地点。除此之外，会话意图链路上不允许出现 `if (kernel === "pi")`，理想形态是 `backend.capabilities.pi` 能力探测。

- 内核专属配置不进契约，由工厂闭包捕获：`cliPath`/`cordisConfig`/`apiKey`/`env` 这些内核专属 spawn 参数都在 `assemble.ts` 的 `baseBackendFactory` 和 `sessionCatalogFactory` 闭包里拼装，`BackendCreateOptions` 只收中性字段（`cwd`/`agentDir`/`kernel`/`provider`/`model`/`neutralSessionId`/`systemPromptPaths`/`systemPromptTexts`/`ephemeral`/`maxTokens`）。

- **检验**：把 `src/server/kernel/dsh` 删掉、把 dsh 内核禁掉，壳照常启动，只是少了 dsh 那份能力；换内核 = 换适配器，壳和壳插件一行不改。

### 4.3 为什么特权是复杂度炸弹

守无特权差异不是洁癖，是规模门槛。

- 一旦壳开始"特殊对待"某个插件或内核，就意味着多了一套加载逻辑、多了一套优先级判断、多了一条"如果这是 pi 的就……"的分支。每条分支都要测试，每条分支都随插件/内核数量膨胀。

- VSCode 是这条纪律的工业级样本：它的内置扩展和第三方扩展平等，语言包、主题、默认渲染器全是扩展而非硬编码。这是它能撑起上万扩展生态的原因之一——不平等的系统到不了那个规模。my-harness-desktop 借的是这套纪律，不是它的 API 形状（那是为代码编辑器优化的）。

---

## 5 槽位是纯函数渲染

槽位渲染是"薄壳 + 内核无关"在 UI 层的直接表达：**给定同一条中性事件流，怎么画与内核无关。** 内核差异在事件层由适配器抹平，不在渲染层由壳插件抹平。

### 5.1 槽位契约的三段式

槽位贡献的范式是三段式，全仓一致：**domain 契约 → registry 注册 → renderer hook 查询 → 消费方按名分发**。

- `contributions.ts` 定义贡献项形状（domain 契约），`registry.ts` 的 `PluginRegistry` 聚合（registry 注册），`packages/react` 的槽位查询 hook + `getPluginComponent` 按 `component` 名从模块 exports 里取组件（renderer 查询），消费方（timeline/文件树/sessions-list）查槽渲染。

- 组件自动匹配是这条范式里最关键的一环：插件只 `export` 组件，不调任何 `registerXxxComponent` 函数。`src/web/app/plugins-host.ts` 的 `loadBuiltin`/`loadThirdParty` 拿到 module 后调 `registerPluginComponents(mod, manifest.contributes)`，框架读 manifest 的 `contributes.*[].component` 字段，在 module exports 里找同名组件。两层校验：TypeScript 编译期保证 export 名存在，框架加载期保证 manifest 的 component 名和 export 匹配，找不到立即报错。

- `packages/react/src/plugin-modules.ts` 的 `asReactComponent` 是这套机制的一个关键补丁：它不只认 `typeof exp === "function"`，还认带 `$$typeof` 的 exotic 组件（memo/forwardRef/lazy 包装的导出），否则 memo 包装的组件会被静默丢弃、消费方落兜底（会话流 markdown 长期退化为纯文本的根因）。

### 5.2 渲染纯函数的落地

壳插件的渲染逻辑里不该出现内核身份分支——这是可检验的，不是口号。

- timeline 插件消费的是 `sessions.onEvent` 投喂的 `SessionEvent` 中性事件流（`packages/shared/src/domain/events/session-state.ts`），不管这事件来自 pi 的 JSONL 还是 dsh 的 JSON-RPC。内核事件由各自的翻译器（`src/server/kernel/pi/protocol/event-translator.ts`、`src/server/kernel/dsh/backend/dsh-event-translator.ts`）投成中性事件，翻译器是喂线，不是第二套语义。

- 三条内核无关不变量（`design-principles.md` 原则 6）是这条纪律的可检验标准：① 壳不读任何内核的存储；② 壳只认中性事件；③ 壳的渲染是纯函数。违反任何一条，壳就偷偷依赖了某个内核。判据：会话意图链路上出现 `if (kernel === "pi")` 或 `asPi()` 类型守卫，就是一处泄漏。

- 统计是这个原则的正面案例：轮数、step 数、token、上下文占用这些统计量由壳从中性事件**自己算**（`session-store.ts` 的 `dispatch` 里 messageStart 记时、messageEnd 用 output tokens 除以耗时算 TPS），不向内核要统计。内核只负责吐中性事件，壳拿同一份事件流做统计——两种内核下统计逻辑完全一致（原则 32）。

### 5.3 能力拉平三分法

壳看到 pi 和 dsh 的差异时，三条出路按优先级，绝不允许静默缺面：

- **适配器翻译**（内核有"同一个语义、只是形状不同"）：发消息/中断/切模型是契约层硬性拉平，三态事件 ↔ `assistant/chunk` 增量是形状翻译，parentId 树 ↔ session forest 是 lineage 投影。判断标准一句话：内核有没有"同一个语义、只是形状不同"的对应物。

- **内核插件补面**（形状翻译不了的能力缺失）：给缺能力的内核写内核插件。pi 侧是装进进程的 TS 扩展（统一为 `my-harness-fit-pi-extension`），dsh 侧是 Cordis 插件（`DshConfigSource.addPlugin` 写 cordis.yml）。最小成本是启用现成插件（`dsh-subagent`、`dsh-compaction-basic`）。

- **显式降级**（补不了）：壳把能力入口隐藏/置灰 + tooltip，不静默、不伪造成功。典型是 pi 的 `steer`/`followUp`/`onExtensionUI` 在 dsh 下——`composerVoice` 槽的注释也写了"无贡献时 composer 显示禁用态占位麦克风（'待接入'提示，不静默、不伪造）"。

- **唯一不允许的状态是静默缺面**：壳调了某个内核没有的能力，既不翻译、不补面、不降级，而是静默吞掉或假装成功。`AbstractBackend` 的四个缺面默认（`listTools` 返回 null、`answerQuestion`/`continue`/`setThinkingLevel` 抛错）正是把"缺面"变成"显式信号"的机制——null 或抛错都让壳走降级，而不是假装成功。

---

## 6 依赖只向内：洋葱

薄壳的所有纪律里，依赖方向是根。圆心是稳定的业务本质，外层是会变的细节，依赖箭头永远指向圆心。这条规则不解释、不通融、没有例外。

### 6.1 圆心是什么

圆心是"拿掉所有会变的东西之后还剩什么"。换了内核、换了框架、换了协议之后，系统里还剩下什么不会变？那就是圆心。

- 圆心的物理位置是 `packages/shared/src/domain/`。验证方式很简单：打开这个目录下任何一个文件，看 import 列表——`contributions.ts`（590 行）、`backend.ts`（338 行）、`context.ts`（359 行）、`sessions.ts`、`kernel.ts`、`events/session-state.ts`……全部是 `interface`/`type`/纯函数定义，没有一个外部包 import（`node:fs`、`electron`、`react`、任何内核实现都没有）。

- 圆心装四样东西：**槽位契约**（`contributions.ts`）、**中立契约**（`backend.ts` 的 `BaseBackend`/`SessionCatalog`/`KernelModelSource` + `kernel.ts` 的 `KernelId`/`LineageTree`）、**中性类型**（`events/session-state.ts` 的 `SessionEvent`/`NeutralMessage`/`ModelInfo`）、**纯函数**（`backend.ts` 的 `projectLineageTree`、`contributions.ts` 的 `derivePluginTags`/`resolvePluginTags`）。

- 判断一个东西是不是圆心，用"换壳测试"：明天把 pi 换成 dsh、把 Electron 换成 Tauri、把 React 换成 Vue、把 SQLite 换成 PostgreSQL，这个东西还在不在？还在，它是圆心；不在了，它是外层。中立契约在——不管内核是 pi 还是 dsh，"发消息/中断/切模型/分叉/读 lineage"不变。pi 的 `steer` 不在——它是 pi 专属，换成 dsh 就没有了。

### 6.2 物理分区

依赖只向内不靠自觉，靠物理隔离——目录结构本身就是第一道防线，比 code review 抓违规可靠得多。当前仓库的分区是：

- `packages/shared/src/domain/`（圆心）：零依赖，物理上 import 不了 `electron`/`react`/任何内核。`packages/shared/src/index.ts` 是发布面，只有 `export * from "./domain/..."` 一行逻辑都没有的 re-export——契约单源，概念在圆心定义一次，外层只 import 或 re-export。

- `src/server/`（壳后端）：`application/`（用例编排：loader/registry、sessions/session-store、models、i18n、skills、theme、config、lifecycle）、`kernel/`（内核层：`core/` 是 `AbstractBackend` + `KernelManager` 基类骨架，`pi/`/`dsh/` 是两个实现，`factories/` 是接口与实现绑定的注册表）、`client/`（流出适配器：fs/git/npm/remote）、`controllers/`（网关 handler）、`bootstrap/`（组装根 `assemble.ts`）、`transport/`+`host/`+`routing/`+`remote/`（前后端分离新增的 HTTP/WS/鉴权）。

- `src/web/`（前端）：`app/plugins-host.ts`（renderer 模块加载）、`stores/`（运行时状态）、`components/`（槽壳组件）、`kernel/`、`transport/`。

- `src/plugins/`（内容层）：50 个壳插件，按六域分组。`packages/react/`（发布面）：`usePluginContext`/`event-bus`/`plugin-modules`/`plugin-id-context` 加 React 组件。

- 依赖方向检验（§6.3 展开）是物理的：`core/domain` 里有任何外部包 import → 违规；`application/` 里有对 `kernel/{pi,dsh}` 具体实现的非 type-only import → 违规；`plugins/` 里有对 `src/server`/`src/web` 内部的 import → 违规（壳插件只从 `@my-harness-desktop/shared` 和 `@my-harness-desktop/react` 引用类型和 API）。

### 6.3 依赖倒置连通内外

需要跨层协作时，接口定义在内层、实现在外层，启动期注入。换运行时只换实现，内层一行不改。

- **内核后端**（最核心的落地）：`session-store` 不 `new PiBackend()`，持有 `BackendFactory` 接口（圆心契约，`backend.ts`）。`PiBackend`/`DshBackend` 实现 `BaseBackend`（`src/server/kernel/pi/backend/pi-backend.ts`、`src/server/kernel/dsh/backend/dsh-backend.ts`），实现在内核层，组装在 `assemble.ts`。换内核只换适配器，application 和 domain 一行不改。

- **模型合流**：`src/server/application/models/model-catalog.ts` 的 `ModelCatalog` 持 `KernelModelSource[]`，`assemble.ts` 里 `new ModelCatalog([new PiModelSource(modelsStore), dshConfigSource])`。加第三个内核 = 加一个 `KernelModelSource` 实现，`ModelCatalog` 一行不改。

- **内核版本管理**：`KernelManager` 基类（`src/server/kernel/core/kernel-manager.ts`）管 pi/dsh 共用的"装/查/状态合成"机制，只依赖 `KernelSpec` + `KernelRuntime` 接口，不 import 具体内核。`PiKernelManager`/`DshKernelManager` 填数据（`PI_SPEC`/`DSH_SPEC`）+ 行为差异（`postInstall`/`installPlugin`）。`KernelRuntime` 接口由 `client/npm/kernel-runtime.ts` 实现（`installNpm` + `fetchRegistryVersions`），`KernelManager` 不直接 `spawn("npm")`。

- **路径注入**：`config-store`、`pi-settings-store` 不直读 `process.cwd()`/`process.env.HOME`，路径由 `bootstrap` 注入。`ConfigStore` 的构造函数收 `{ userDir, getProjectDir }`，`getProjectDir` 是注入的函数，`assemble.ts` 里绑定为 `() => sessionStore.getActiveCwd()` 的闭包。内核专属 spawn 参数（`cliPath`/`cordisConfig`/`apiKey`）同样不进契约，由 `assemble.ts` 的工厂闭包捕获。

- **构造与执行分开**是依赖倒置的推广形态：`session-store` 不再拼 `--session`/`--append-system-prompt`/`--no-session`，改传中性 `BackendCreateOptions`（构造）；内核专属 args 的拼装收进工厂闭包（执行）。`RpcAdapter` 构造命令对象但不 spawn 进程，`subprocess-lifecycle` 管进程生命周期，两者经 `SubprocessHandle` 接口连接。

### 6.4 继承 + 实现：机制复用 vs 能力拉平

多内核下，"接口 + 两个平行实现"会让重复代码（缺面抛错、装/查机制）各写一份。解法是"接口 → 抽象基类 → 具体实现"三段式，但这条线有一个关键的边界别混淆。

- 三段式的实际形状（路径以代码为准）：

  ```
  packages/shared/src/domain/backend.ts   BaseBackend（接口，契约）
        ▲ implements
  src/server/kernel/core/abstract-backend.ts  AbstractBackend（骨架 + 缺面默认）
        ▲ extends
  src/server/kernel/pi/backend/pi-backend.ts   PiBackend（override pi 能力 + PiCapabilities 扩展面）
  src/server/kernel/dsh/backend/dsh-backend.ts DshBackend（继承缺面默认 + override dsh 能力）
  ```

- `AbstractBackend` 的精确形状（读 `abstract-backend.ts` 原文）：14 条 `abstract` 必实现意图（`kernel`/`alive`/`start`/`stop`/`onEvent`/`sendMessage`/`abort`/`setModel`/`setSessionName`/`getTree`/`getEntries`/`bookmark`/`deleteBookmark`/`seed`）+ 4 条缺面默认（`listTools` 返回 null、`answerQuestion`/`continue`/`setThinkingLevel` 抛错）+ 3 个默认成员（`capabilities={}`/`configDepPaths=[]`/`sessionId` 取 ctx）。`resume?` 不在基类——dsh 覆盖、pi 不实现，属可选意图。

- 三条纪律：**基类只 import 圆心，绝不 import 具体内核**（它是机制，不是内容）；**子类只填差异**（数据 + override 缺面方法，pi 和 dsh 处处相反的会话模型/事件形状/fork 语义保持 abstract，不硬塞基类）；**组装归 bootstrap**（`createPiBackend`/`createDshBackend` 在 `src/server/kernel/factories/kernel-factories.ts`，core 一行不 import 具体实现）。

- **边界（关键）**：基类解决的是**实现复用**（怎么少写重复的缺面抛错），不产生新能力；**能力拉平**（怎么让壳无感）靠内核插件（§5.3）。两者正交——别把"抽了基类"当成"拉平了能力"。抽基类是代码卫生，拉平能力是补内核缺口，一个是壳内部的复用，一个是壳对外部内核的补偿。

---

## 7 纪律如何落地：检验方式

原则定了不等于执行了。薄壳纪律的落地靠三层：grep 判别气味（新人也能判）、lint 强制（违规过不了 build）、自检（删插件/换内核）。这一节把检验变成可操作的清单。

### 7.1 grep 判别气味：内容泄漏

这是给新人的自检工具——不需要懂架构，打开文件扫一遍就能判。

- **气味一：写死的颜色十六进制。** 在壳目录里 grep `#[0-9a-fA-F]{3,8}`。实测结果：`packages/shared/src/domain/` 无命中（唯一例外是 `theme-tokens.ts` 的 `THEME_TOKEN_DEFAULTS`，已标注为兜底偏离）；`src/server/application/` 无命中；`src/web/` 命中 `login-gate.ts` 和 `bootstrap.ts`（引导 chrome，§3.2 已记录）。找到壳的机制文件里有 hex 值，就是内容泄漏。

- **气味二：写死的用户可见文案。** 在壳目录里 grep 中文字符（`[\x{4e00}-\x{9fff}]`）或英文句子。`packages/shared/src/domain/` 里命中的几乎全是注释（注释不是用户可见文案，不违规）和 `working-phase.ts`/`file-icons.ts` 里的枚举语义。真正的红线是**渲染路径上的字面量**——如果某个 `src/server/application/` 或 `src/web/components/` 文件里出现一段会显示给用户的中文，就是违规。

- **气味三：针对具体内核/业务类型的 if-else。** 在会话意图链路上 grep `if (kernel === "pi")` 或 `asPi()`。实测：`session-store.ts` 里的 `asPi` 是经 `backend.capabilities.pi` 的能力探测（§3.5），不是内核身份硬分支；`assemble.ts` 的 `if (opts.kernel !== "dsh")` 是组装根的唯一合法分叉点（§4.2）。如果这两处之外再出现内核身份分支，就是泄漏。

### 7.2 lint 强制：三条插件的红线

`eslint.config.js` 把三条插件的红线编进了 `no-restricted-syntax`，违规连 build 都过不了。

- **拦截 `window.pi` 直访**：`MemberExpression[object.name='window'][property.name='pi']`，message 是"禁止直接访问 window.pi，使用 usePluginContext() 拿受控 API"。这条规则只对 `src/plugins/**/*.{ts,tsx}` 生效——插件零容忍，`packages/react/src/plugin-context.ts` 内部实现不受限（它本来就该调 `window.kernel`）。

- **拦截 `const PLUGIN_ID =`**：`VariableDeclarator[id.name='PLUGIN_ID']`，pluginId 应由 `PluginIdContext` 自动注入，不手写常量。这堵住的是"pluginId 字面量和 manifest id 手写两遍、改一处忘一处"的定时炸弹。

- **拦截 `usePiApi` 和 `registerXxxComponent`**：前者是废弃的裸 API 入口，后者是手写组件注册（框架从 manifest 自动匹配）。四条规则合起来，把插件逼到唯一合法形态：`usePluginContext()` 拿能力、export 组件不注册、pluginId 从 Context 来。

- 另有一组 IPC 通道名单源的 lint 规则（`ipcMain.handle`/`ipcRenderer.invoke` 的字面量参数），但它的作用域是 `src/shell/electron-main/**`（已重构前的路径），属于历史遗留配置，其精神（通道名单源）仍在 `src/server/controllers/` 里以其他方式维持。

### 7.3 自检：删插件、换内核

判据的两个问法本身就是自检——它们不依赖任何外部知识。

- **删插件自检**：把任何一个内置插件从 `src/plugins/` 删掉，壳照常启动，只是少了那块功能。删 timeline，中区显示"mainView 槽无贡献"；删 i18n，所有文案退化为 key 原文。删哪个都不崩——因为壳不依赖任何具体插件存在。

- **换内核自检**：把 `src/server/kernel/dsh` 删掉、把 dsh 内核禁掉，壳照常启动，只是少了 dsh 那份能力。换内核 = 换适配器，壳和壳插件不动。这是"壳是机制、内核是内容"的最终试金石。

- **覆盖自检**：把内置插件复制到用户目录（`~/.my-harness-desktop/plugins/`），它以更高优先级覆盖内置版。`ArraySlot.removeById` 按 id 清旧项、bootstrap 注册序保证后注册者高优先级——这段通用覆盖语义就是"无特权差异"的机制保证。

---

## 8 QA

**Q：为什么壳不直接用 VSCode 的扩展 API，而是自己造一套插件体系？**

VSCode 的扩展 API 是为代码编辑器设计的，my-harness-desktop 是 AI coding agent 的桌面壳。借的是它的架构纪律（薄壳 + 槽位契约 + 无特权差异），不借它的 API 形状——那是为代码编辑器优化的（webview、workspace、language provider），而 my-harness-desktop 的槽位是会话列表、设置页、主题、时间线，为对话式桌面应用优化。`SlotName` 联合里的 27 个槽位名就是证据。

**Q：两个壳插件往同一个槽位挂了同样的东西，怎么办？**

按优先级选。四级来源 `builtin < installed < user < project`，同级按声明顺序，先声明的先选。确定性，不随机。机制在 `ArraySlot.removeById`：push 前按 `contribution.id` 清同 id 旧项，bootstrap 的注册序保证后注册者（高优先级 source）覆盖先注册者。所以第三方插件可以只改一个扩展名的图标、不必整批重声明（`fileIcons` 槽的覆盖语义）。

**Q：壳插件 A 真的需要壳插件 B 的数据，怎么办？**

通过事件获取。B 通过 `ctx.events.emit("b:event", payload)` 发布，A 在 manifest 声明 `dependsOn: ["b"]`，然后 `ctx.events.on("b:event", handler)` 订阅。不通过共享 store 互读写，不直读对方的配置文件。如果 A 加载时 B 已经 emit 过了，用 `{ replayLast: true }` 回放最近一次 payload。这是插件间唯一合法通道。

**Q：为什么内核是被壳管理的资源，而不是一个壳插件？**

内核是一个独立子进程，有自己的生命周期、配置、版本管理、插件树、会话模型。它不是"挂在壳槽位上的一个功能"，而是"壳通过中立契约和适配器管理的外部能力"。把它当壳插件会模糊边界——壳插件是"被壳加载的代码"，内核是"被壳管理的进程"。在洋葱里，内核和 git、文件系统是同一层抽象（都是被管理的资源），都经依赖倒置接入。`src/server/kernel/` 和 `src/server/client/` 的并列关系就是这条边界的物理表达。

**Q：壳插件声明了权限但用户不授权，怎么办？**

壳插件功能受限但不崩溃。权限校验在 main 进程的 IPC 边界——`registry.assertPermission(pluginId, permission)` 在 handler 里抛错，IPC 边界直接拒绝，壳插件收到错误自己决定怎么呈现。未声明的能力不是"静默降级"（那会伪造成功），而是显式报错，调用方要么补声明、要么换实现。

**Q：`fork` 为什么不在 `BaseBackend` 中立契约里，而在壳的 `SessionTreeApi` 里？**

因为 fork 是壳在中立层的纯操作，不是内核的进程操作。`backend.ts` 注释写死了这条："内核是单线执行器：只物化当前活跃那条 lineage，分叉是壳在中立层的纯操作。" 内核只负责物化一条 lineage，分叉是壳经 `projectLineageTree` 纯函数把入口级树投影成 lineage 树，再经 `SessionTreeApi.fork` 在中立坐标系里操作。把 fork 塞进 `BaseBackend` 会让内核承担它不该承担的会话模型职责——壳和内核的边界会糊掉。

**Q：`asPi()` 出现在 `session-store.ts` 里，这是不是内核身份泄漏？**

不是。`asPi` 的实现是 `proc.backend.capabilities.pi` 探测，不是 `if (kernel === "pi")` 硬分支。它访问的是 pi 扩展面（`PiExtensions`/`PiBackendExtensions`），dsh 无此面时 `capabilities.pi` 为 undefined，`asPi` 抛"当前后端不支持 pi 专属命令"——这是显式降级，不是按内核身份分流。真正的内核身份分支只允许出现在组装根（`assemble.ts` 的工厂闭包），因为那是接口与实现相遇的唯一地点。判据是：能力探测是"有则用、无则降级"，内核身份分支是"是 pi 就 A、是 dsh 就 B"——前者是机制，后者是内容。

**Q：这套纪律适用于别的项目吗？**

通用原理（判据、依赖只向内、机制与内容分离、无特权差异、能力拉平三分法）适用于任何需要插件化、分层、多后端/多内核的系统。具体落地（槽位契约的 27 个槽名、中立契约的 `BaseBackend` 形状、四件套插件目录、`packages/shared`/`src/server`/`src/web` 的物理分区）是 my-harness-desktop 这个项目的执行方式——别的项目可以借鉴判据，但不该照抄落点。原则是通用的，执行是特化的。
