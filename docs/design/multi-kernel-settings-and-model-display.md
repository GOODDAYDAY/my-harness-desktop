# 内核设置页与模型展示：多内核的 UI 落地

- 这是 `multi-kernel-shell.md` 的 UI 落地篇。那篇立了抽象（内核 / 中立契约 / 适配器 / 壳），本篇回答「用户怎么看见 pi 和 dsh 是两个同级内核」：设置页怎么管、模型清单怎么摆、会话流怎么标内核、以及——最重的一块——怎么让「会话流是壳的、内核随时可换」。前者讲「为什么壳内核无关」，本篇讲「内核身份怎么进 UI 而不泄进壳的机制层」，再把「内核可替换」从一句口号变成可操作的五步切换。

- 本文要解决的四个具体问题，一句话各一句：**设置页三个插件是 pi 的形状**（Pi / PI 拓展 / 模型各占一个入口，dsh 没有入口）；**模型清单只扫 pi**（`toModelInfos` 只读 `~/.pi/agent/models.json`，dsh 的模型看不见）；**会话流没有内核身份**（唯一的内核标是空态那个硬编码 `PiLogo`，且只认 pi）；**会话锁死内核**（一条会话一旦在 pi 下开了，就不能换成 dsh，除非新开会话）。

- 四个问题同源：**「内核」这个身份，从来没有作为一个一等概念进过 UI 层**。设置页按 pi 的存储形状散成三个入口、模型清单按 pi 的配置文件扫、会话流按 pi 的 logo 画、会话按「哪个内核 spawn 的」锁死——全是「pi 的身份漏进了壳插件」。本文把「内核」提成一等身份：设置页一个内核一个入口、模型清单按内核合流打标、会话流按当前会话的内核显标、会话本身成为「内核无关的中性流 + 可换的内核运行时」。

- 低保证原型（视觉参照）：仓库根 `settings-merge-prototype.html`，顶部切「设置页 / 会话页」。本篇的一切 UI 决策以它为基线，代码实现照它落地。原型已定稿的点：设置页 PI/DSH 各三 TAB、模型下拉按内核分组 + 每条前缀标、空态大 logo ⬡/🐋 随模型切换、assistant 消息头小内核标。

- 本文的边界：只管「内核身份进 UI」这一件事。底座后端的 `BaseBackend`/`DshBackend`/`createDshBackend` 的接线、会话标识中性化、bookmark/resume 收编这些，是 `multi-kernel-shell.md` 和 `base-interface-lineage.md` 的范畴，本文只引用其结果、不重复展开。跨内核切换（§3.6）会踩到这些机制的边，但本文只定义「切换需要它们提供什么」，不重新设计它们。

## 0. 术语表

- 先一次性交代本文反复使用的名词，避免后文每处都解释。有出处的标出处，本文新造的标「本文」：

  - **内核（kernel）**：一个自洽的 agent 运行时，自带插件树、会话模型、能力集。pi 和 dsh 各是一个（`multi-kernel-shell.md` §2.1）。
  - **壳（shell）**：my-harness-desktop 的薄壳，拥有槽位/渲染/布局/事件总线等机制（`multi-kernel-shell.md` §5）。
  - **中立契约（contract）**：壳需要内核提供的「最小意图」集合，六条：`sendMessage` / `abort` / `fork` / 会话标识 / 流式事件 / `setModel`（`multi-kernel-shell.md` §3）。
  - **适配器（adapter）**：内核专属形状与中立契约之间的翻译层，每个内核一个（`multi-kernel-shell.md` §4）。
  - **壳插件（shell plugin）**：挂在壳槽位上的 UI 插件，只 import `@my-harness-desktop/contract` / `@my-harness-desktop/react`。
  - **内核标（kernel badge，本文）**：模型/会话身份前挂的小图标。pi 用 ⬡ 几何标（`PiLogo`），dsh 用 🐋 鲸鱼标（`DshLogo`，DeepSeek 官方 mark）。内核标是「内核身份进 UI」的原子单位，全文四处复用同一份。
  - **会话头（session header）**：会话自带的元数据（谁建的、哪个内核、哪个项目），内核归属记在这里（`multi-kernel-shell.md` §6.6）。
  - **中性消息流 / transcript（本文沿用 lineage 概念）**：壳持有的「会话到目前的消息」的结构化中性表示。是「会话是壳的、内核可换」的真相源（§3.6）。
  - **seed / import（本文）**：内核「从一段中性历史起步」的能力。pi 现状只有 bookmark/resume，dsh 只有 resume；「吃整段中性历史」是两侧都要补的新命令（§3.6）。
  - **缺面（missing capability）**：内核根本没有某个能力、找不到可翻译对应物（`multi-kernel-shell.md` §4）。处置：降级或补面。
  - **展示分组（display grouping，本文）**：settings 槽的一层纯展示机制——一个入口聚合若干子项、渲染成顶部 TAB，子项各自保留 config/save，机制零改动（§3.1）。
  - **model-catalog（本文）**：`core/application` 里合流 pi/dsh 两路模型、打内核标、产出 `ModelInfo[]` 的编排单元（§3.3）。
  - **currentModel / defaults**：timeline 现有的「当前模型」与「默认模型」解析（`defaultProvider`/`defaultModel` 来自 settings.json）。本文的「默认内核 = 默认模型的内核」直接复用这两个概念，不新造（§2.5）。

- 术语纪律：本文刻意不用「底座」这个词——它在 my-harness-desktop 里既指「被管理资源」、又暗含「pi 那一套」，两个意思混在一起，讲不清「同级」。凡原文可能写「底座」的地方，本文统一写「内核」；「底座文件」（`~/.pi/agent/` 前缀）这类历史遗留叫法，只在引用既有代码/契约时原样保留，避免改名造成歧义。

## 1. 问题

### 1.1 设置页三个入口是 pi 的形状

- 现状 `src/plugins/manager/` 下三个插件各占一个 settings 槽：

| 插件 | settings id | 标题 | component | 数据 | saveMode |
|---|---|---|---|---|---|
| `pi-manager` | `pi` | Pi | `PiManagerPage` | `~/.pi/agent/settings.json` | framework（deep 合并） |
| `extension-manager` | `extensions` | PI 拓展 | `ExtensionManagerPage` | —（走 `ctx.extension`） | manual |
| `pi-model-manager` | `models` | 模型 | `ModelManagerPage` | `~/.pi/agent/models.json` | framework（replace） |

- 这三个入口本是「一个内核（pi）的管理面」，却因为历史演进被拆成三个平铺的 settings 项。追溯原因：它们不是同一时期长出来的——先有 `pi-manager` 管内核版本和 settings.json，后来模型管理独立成 `pi-model-manager`，再后来拓展管理独立成 `extension-manager`。三个插件各自长大，谁也没回头把「它们其实是一个内核的三块」这件事收拢。结果用户的心智是「我在三个地方管三件事」，而不是「我在管 Pi 这一件事」。

- 更关键的是：这套形状是 **pi-only** 的。settings.json、models.json、extension 全是 pi 的专属存储。dsh 来了之后，如果照抄一遍，就是「六个入口（pi 三个 + dsh 三个）」，熵增翻倍——而且 dsh 的三块跟 pi 的三块形状还不同（dsh 没有 models.json，模型在 `settings.yaml` 的 `llm-deepseek`（单 route `deepseek-official`）+ `llm-pi-ai.providers`（多路由 dict），cordis.yml 作 base 兜底），照抄会抄出一个四不像。

- 深层病根：settings 槽的「入口」粒度被当成了「插件」粒度，而不是「内核」粒度。一个内核的管理面本该是一个入口（内部再分 TAB），现状却是一个插件一个入口。本文要纠正的是这个粒度错位：入口的粒度对齐「内核」，不是「插件」。

### 1.2 模型清单只扫 pi

- 会话页的模型下拉，数据源只有一条：`timeline/renderer/index.tsx` 的 `toModelInfos` 读 `ctx.modelsConfig.get<ModelsConfig>()`，即 `~/.pi/agent/models.json`。dsh 的模型（`settings.yaml` 的 `llm-deepseek` + `llm-pi-ai.providers`，cordis.yml 兜底）根本不进这个清单。

- 展开看现状链路（`timeline/renderer/index.tsx`）：

  - `toModelInfos(cfg)`（第 61 行）遍历 `cfg.providers`，把每个 provider 下的 models 展开成 `ModelInfo`（`provider/id/name/reasoning/contextWindow/maxTokens`）。
  - 数据来源在 `refreshExternals`（第 220 行附近）：`Promise.allSettled([ctx.piSettings.get(), ctx.modelsConfig.get<ModelsConfig>()])`——一个拿默认模型，一个拿模型清单。
  - `modelsConfig` 指向 `~/.pi/agent/models.json`（pi 的专属文件）。

- 后果：即便 dsh 后端已能 spawn、能对话（`createDshBackend` 骨架已在 `backend-factories.ts`），用户在模型下拉里也选不到 dsh 的模型——「换内核」这件事在 UI 上没有任何抓手。模型清单的「单内核」和底座的「多内核」对不上，是本文要补的缝。

- 一个容易被忽略的连带：`toModelInfos` 这个函数本身活在 timeline 插件里，它「知道」模型长什么样（`ModelsConfig` → `ModelInfo`）。按「机制与内容分离」，模型清单的组装是机制（所有内核共用），不该由某个壳插件自己实现。本文把「扫模型 + 打标」上收到 `core/application` 的 model-catalog，timeline 只消费结果——这既是补 dsh 的第二路，也是把「扫模型」从 timeline 手里收回来的一步（§3.3、§4.2）。

### 1.3 会话流没有内核身份

- 会话流（timeline）里唯一和「内核」沾边的视觉，是新会话空态中央那个硬编码的 `PiLogo` SVG（`timeline/renderer/index.tsx:882`）。它写死 pi 的形状，换 dsh 也不变。

- 其余地方都没有内核身份：

  - **模型下拉**（`composer.tsx` 第 262 行）只显示模型名（`currentModel.name || currentModel.id`），没有内核标；下拉列表（第 268 行）按 `groupByProvider` 分组，只有 provider 名，没有「这个 provider 属于哪个内核」。
  - **消息流**：assistant 消息没有「这条由哪个内核的哪个模型生成」的标识。用户看一条回复，无法判断它是 pi 还是 dsh 生成的。
  - **空态 logo**：写死 `PiLogo`，且只在新会话空态出现一次，会话一旦有消息，这个 logo 就消失，内核身份也随之消失。

- 后果：用户无法从界面上判断「当前这个会话跑在 pi 还是 dsh 上」。这在 pi-only 时代无所谓（反正只有一个内核），但多内核之后，同一个壳里同时跑 pi 会话和 dsh 会话，没有内核标，用户会在「我这条消息到底谁回的」上产生困惑——尤其在跨内核切换（§3.6）之后，同一条会话里前后可能是不同内核生成的，没有逐条标识就分不清。

### 1.4 会话锁死内核

- 现状（`bootstrap/index.ts:110`）`baseBackendFactory.create` 写死 `createPiBackend`——每开一个会话，spawn 的都是 pi。`createDshBackend` 虽已存在（`backend-factories.ts`），但没有任何 UI 让它被选中。会话一旦建立，内核就定了，且没有任何「换内核」的路径。

- 这不是「还没接 dsh」那么简单。更深的问题是：**会话和内核是焊死的**。会话的真相源是内核的存储（pi 是 JSONL 文件、dsh 是 session log），壳只是把这个存储投影出来。要「换内核」，就得把会话的真相源从「内核的存储」换成「壳的中性流」，再把中性流重新落到新内核上——这是「会话是壳的、内核可换」的全部含义。本文 §3.6 立的正是这一层。

### 1.5 四个问题是一件事

- 四个问题同源：**「内核」这个身份，从来没有作为一个一等概念进过 UI 层**。设置页按 pi 的存储形状散成三个入口、模型清单按 pi 的配置文件扫、会话流按 pi 的 logo 画、会话按「哪个内核 spawn 的」焊死——全是「pi 的身份漏进了壳插件」。

- 本文把「内核」提成一等身份：设置页一个内核一个入口、模型清单按内核合流打标、会话流按当前会话的内核显标、会话本身成为「内核无关的中性流 + 可换的内核运行时」。四处改的是同一件事的四个面。判据是同一个：**壳代码里出现「if 内核 === pi」的分支，就是一处泄漏**（`multi-kernel-shell.md` §5.7 的原话，本文把它从「后端」搬到「UI」再执行一遍）。

## 2. 决策

- 这几条是需求确认过的结论，实现照此执行，不再摇摆。每条写清「结论 / 理由 / 被否掉的替代方案 / 边界」，替代方案是决策的镜子——为什么没走那条路，和为什么走了这条路一样重要。

### 2.1 内核判别 = 按配置文件来源，不加 config 字段

- **结论**：一个模型属于哪个内核，由「它从哪个内核的配置文件扫出来」决定，不往 models.json / cordis.yml 里加 `kernel` 字段。pi 扫出来的归 pi，dsh 扫出来的归 dsh。

- **理由**：两个内核的配置文件本来就是两套（pi 的 `~/.pi/agent/models.json`，dsh 的 cordis.yml），来源本身就是最可靠的内核标识。加 `kernel` 字段是冗余的，还会在两个内核之间制造「字段没写/写错了」的漂移——pi 的 models.json 里不会有 `kernel: "dsh"`，但一旦有了 `kernel` 字段，就有人会问「它漏了怎么办」「两个文件里写不一致以谁为准」。来源判别把这些问号全部消灭：来源只有一个，答案只有一个。

- **被否掉的替代方案**：① 在 config 里加 `kernel` 字段——冗余 + 漂移，上面已否；② 用 provider 名猜内核（如 provider 含 "deepseek" 就归 dsh）——猜是 bug 温床，两个内核都可以有任意 provider 名，猜错就是静默串内核；③ 维护一张「provider → 内核」的映射表——第三处漂移源，且新加一个 provider 就要改表。

- **边界**：判别发生在扫描器（model-catalog）内部，是「读哪路就标哪路」的局部事实；`ModelInfo.kernel` 是结果字段（§3.2），不是 config 输入字段。两者不冲突——来源是「怎么得出来的」，`kernel` 是「得出来的结果」，前者是过程、后者是投影。

### 2.2 会话内核 = 从模型反推，不放独立 PI/DSH 切换

- **结论**：输入框里不单独放一个「PI / DSH」内核切换。用户选哪个模型，内核跟着走：选鲸鱼模型 ⇒ 这个会话就是 dsh。模型下拉因此成为「内核 + 模型」二合一的单一控制点。

- **实现补充（模型下拉底部的内核 TAB，§3.5）**：模型下拉列表底部放一条 `pi` / `dsh` TAB，它只是「把列表收窄到所选内核」的**纯展示过滤**，不改变「选模型即定内核」的单控制点原则。点 TAB 只切列表可见范围，不产生「内核选了 dsh 但模型还停在 pi」的非法中间态——打开下拉时 TAB 默认回到当前模型所属内核。这条 TAB 与被否掉的「独立 PI/DSH 切换」的区别在位置与语义：它在模型下拉内部、且只过滤可见列表，不在工具栏另设一个能把会话内核切到非法态的控制点。TAB 放在底部并固定（清单独立滚动），避免切换内核时清单高度变化带动 TAB 跳动。

- **理由**：内核是模型的上一级分类，用户的心智是「我要用 DeepSeek 的模型」而不是「我要把底座切成 dsh 再选模型」。两个控制点（内核切换 + 模型下拉）会制造「先切内核再选模型」的两步心智，且两个控制点之间还会出现「内核选了 dsh 但模型还停在 pi 的 gpt-4o」这种非法中间态。合并成一个控制点，非法态从根上不存在——选了模型，内核就唯一确定了。

- **被否掉的替代方案**：① 独立 PI/DSH 切换 + 独立模型下拉——两步心智 + 非法中间态；② 先选内核、模型下拉收窄到该内核——多了「切内核」这个动作，且和「选模型」的语义重叠；③ 什么都不显式选、靠「默认内核」配置决定——把「选内核」这个会话级决策压成一个全局配置，丢失会话级灵活性（§2.5 会说明「默认」只决定起点，不替代会话级选择）。

- **边界**：这是 `multi-kernel-shell.md` §6.6「选内核 = 开新会话时选一次」的收窄——「选内核」不再是一个独立动作，被折叠进「选模型」。但「内核归属记会话头」不变：会话建立后，头里记的是「哪个内核 + 该内核下的哪个模型」，两者一起定（§3.6 展开会话内跨内核切换时，这个「记」会变成「可改写」）。

### 2.3 DSH 配置 = 内核原生

- **结论**：dsh 的配置不新建 `~/.dsh/models.json`，也不塞进 `~/.pi/agent/` 下。它落 dsh 的原生配置。实测 deepseek-harness 确认 dsh 有两处原生配置面：

  1. **settings 文档**：`~/.dsh/settings.yaml`（默认，harness home `$DSH_HOME` / `~/.dsh` 下，由 `@deepseek-ai/dsh-settings-file` 提供）——「DSH 内核 + 配置」TAB 的配置部分编辑它。
  2. **插件组成**：`cordis.yml`——哪些 Cordis 插件在跑、每个插件的 config（出厂 base，读作兜底）。模型的**用户可编辑面**在 `settings.yaml` 的 `llm-deepseek`（单 route `deepseek-official`：`apiKeyEnv`/`baseURL`/`models`）+ `llm-pi-ai`（`providers` 多路由 dict：每 route `apiKeyEnv`/`displayName`/`api`/`baseURL`/`models`），配套环境变量 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 及每个 route 自己的 `apiKeyEnv`。dsh 官方解析链 = schema 默认 → cordis base → 用户 settings 分节。

- **理由**：「内核原生」是「内核自管」的推论。dsh 的 settings 文档是它自己读的（`ctx.settings` 经 `dsh-settings-file` 提供），dsh 的插件树是它自己加载的（cordis.yml）。壳若另建一份 `~/.dsh/models.json`，就等于在 dsh 的原生配置之外再造一个「壳的影子配置」，dsh 不认它、它还得和 dsh 原生配置同步——双份真相，必漂移。

- **被否掉的替代方案**：① 新建 `~/.dsh/models.json`——影子配置，双份真相；② 塞进 `~/.pi/agent/` 下某个 dsh 子文件——把 dsh 的配置挂到 pi 的地盘，命名和语义都错位；③ 把 dsh 的模型**形状**归一成 pi 的 `ModelsConfig`（单文件 `providers` 顶级 dict、`provider` 字段内嵌）——归一 = 逼 dsh 学 pi 的形状，丢 dsh 的 Cordis 插件树价值（`multi-kernel-shell.md` §1.4 明令禁止「翻译层让 dsh 装 pi」）。**注意区分**：dsh **有** provider 路由（官方 `dsh-llm-pi-ai` 的 schema 就是 `providers: Record<string, PiAiProviderProfile>`，每个 route 有 `apiKeyEnv`/`displayName`/`api`/`baseURL`/`models`；`dsh-llm-deepseek` 另注册一个固定 route `deepseek-official`），被禁的是「把 dsh 这套路由 shape 套成 pi 的 `ModelsConfig` 形状」，**不是**「dsh 有 provider」——「消费 dsh 原生的 provider 路由」是消费而非翻译，是被鼓励的。

- **边界**：两边形状不同是「内核原生」的必然结果，壳不做归一。「DSH 模型配置」TAB 编辑 dsh 的 provider 路由——`llm-deepseek`（固定 route `deepseek-official`，字段 `apiKeyEnv`/`baseURL`/`models`）+ `llm-pi-ai`（`providers` 多路由 dict，每 route 有 `apiKeyEnv`/`displayName`/`api`/`baseURL`/`models`）。形状跟 dsh 官方 schema 走，不套 pi 的 `ModelsConfig`。读者若在本文看到「pi 的模型」和「dsh 的模型」形状不同，不是设计缺陷，是决策。

### 2.4 内核标

- **结论**：pi 用现有 `PiLogo`（⬡ 几何标，已存在于 `packages/react/src/widgets/plugin-icon.tsx`）；dsh 用 🐋 鲸鱼标，DeepSeek 官方 mark，取 simple-icons 的 `deepseek.svg`（单 path、`currentColor`、`viewBox 0 0 24 24`），直接按 `PiLogo` 的写法加一个 `DshLogo`。

- **理由**：`PiLogo` 已经是 pi 的既成标识（空态 logo + 设置页「pi」图标都在用），dsh 需要一个同级的标识，二者形成「⬡ vs 🐋」的对称视觉。用 DeepSeek 官方 mark 而不是自造，因为用户的心智里「DeepSeek = 鲸鱼」已经成立，用官方 mark 是「消费而非翻译」（CLAUDE.md §3.1）——不自造一个用户不认识的形状。

- **被否掉的替代方案**：① 用 lucide 里某个现成图标（如 `Fish`、`Waves`）代指 dsh——lucide 没有「DeepSeek 鲸鱼」，用近似图标会制造「这到底是啥」的认知成本；② 两个内核都用文字标（"PI"/"DSH"）——文字在 14px 的 badge 里辨识度差，且没有「品牌感」；③ 给 pi 也换一个新标——pi 的 ⬡ 已深入人心，换掉是负资产。

- **边界**：内核标是「身份标识」不是「功能图标」。它不参与 lucide 的 `ICONS` 映射（`resolvePluginIcon` 不加 `dsh`），走 `PluginIcon` 里 `name === "pi"` / `name === "dsh"` 的两条专线。四处复用（设置页入口、模型下拉分组/条目、空态 logo、消息头）共用同一份 SVG path，不复制（§3.4）。

### 2.5 默认内核 = 默认模型的内核，不单设配置

- **结论**：不新增「默认内核」配置项。默认内核 = 默认模型所属的内核（§2.2 的直接推论：内核由模型派生，所以「默认」也由模型派生）。默认模型沿用现有机制（settings.json 的 `defaultProvider`/`defaultModel`，timeline 的 `defaults` 解析）。

- **理由**：这是 §2.2 的对称推论，也是一致性的必然要求。如果内核由模型派生，却又要一个独立的「默认内核」配置，就会出现「默认内核 = pi，但默认模型是 deepseek-v4-pro（dsh）」的自相矛盾。默认内核只能是默认模型的派生量，不能是独立量。独立配置是「多此一举 + 制造矛盾」。

- **被否掉的替代方案**：① 新增「默认内核」配置项（`multi-kernel-shell.md` §2.7 曾建议「默认 pi 是一个配置」）——上面已否，制造矛盾；② 硬编码「新会话默认 pi」——pi-only 特权残留，dsh 会话永远要手选，和「同级」矛盾；③ 默认内核 = 上次用的内核——引入「上次」状态，又一个要持久化的偏好，且「上次」不是「默认」的语义。

- **边界**：空态显标据此定——有默认模型 → 亮默认模型的内核（⬡ 或 🐋）；没有任何默认模型 → 两个内核都展示（⬡ + 🐋），不硬挑一个。「默认」只决定起点（新会话空态亮哪个、模型下拉初始选中哪个），不替代会话级选择（§2.2）。

- **对 `multi-kernel-shell.md` 的纠正**：那篇 §2.7 写的「默认也要显式化（默认 pi 是一个配置）」在本文被收窄为「默认 = 默认模型的内核，不单设配置」。不是推翻那篇，是把它的「默认」从「独立配置」落实为「派生量」——那篇只要求「默认要显式化」，本文定了「显式化的方式」。

## 3. 设计

- 本章是全文主体。每一节回答一个「怎么落地」，落到具体文件、具体字段、具体签名。读者读到这里，应该能据此直接开工，不需要再回头翻代码。

### 3.1 设置页：一个内核一个入口，入口内三 TAB

- 目标形态：设置列表里「PI」「DSH」两个入口并列（其余通用/主题/插件/Skills/工具/语言不动）。每个入口顶部三个 TAB：

| 入口 | TAB 1 | TAB 2 | TAB 3 |
|---|---|---|---|
| PI | Pi（内核 + 配置） | PI 拓展 | 模型配置 |
| DSH | DSH（内核 + 配置） | DSH 拓展 | DSH 模型配置 |

- PI 的三个 TAB 对应现状三个插件的组件，内容原样迁入（`PiManagerPage` / `ExtensionManagerPage` / `ModelManagerPage`）；DSH 三个 TAB 与 PI 同构，内容各自原生。四个子块各自的「数据 + save 语义」在合并前后**一字不改**，改的只是它们从「三个平铺入口」变成「一个入口的三个 TAB」。

- **关键张力**：settings 框架的机制是「一个 settings item = 一个 configFile = 一份 dirty/save」，而一个「PI」入口底下是三个不同的数据面（settings.json / ctx.extension / models.json）。硬塞进一个组件、让框架只注入一份 `config`，会把三份 dirty/save 压成一坨——所以**只合并展示，不合并 config**。

- **解法（展示分组，config 不动）**：settings 槽只加一层「展示分组」——一个入口声明它聚合若干个子项，渲染成「顶部 TAB 条 + 当前 TAB 的 pane」。每个 TAB 就是一个既有的 settings item，保留自己的 `configFile` / `saveMode` / dirty/save，机制零改动；框架做的只是「把三个本来平铺的 item，画成一个入口的三个 TAB」。

  - 用户看到：一个 PI 入口、三个 TAB；
  - 内部真相：三个 settings item 各自管自己的 config/save，一行持久化逻辑不改；
  - 「DSH」入口复用同一套展示分组——「一个内核 = 一个入口 = 一组 TAB」。

- 不引入「入口组件自管 TAB（manual）」的退路：那会把 dirty/save 逻辑重新摊回插件，违反「框架管通用」（CLAUDE.md §3.3）。展示分组是纯展示层，不动任何 config 语义。

- **manifest 形状**（这是本节的核心，钉死声明长什么样）：现状一个 settings item 的声明是扁平的 `{ id, title, icon, component, configFile?, configMerge?, saveMode?, order }`。展示分组不破坏这个扁平形状，只加一个可选聚合字段。两种候选：

  - **候选 A（group 字段）**：settings item 增加 `group: "<groupId>"`，同 group 的多个 item 在侧栏折叠成一个入口，入口名取 group 的首项（或一个显式 group 声明）。优点：不引入新结构，只在侧栏聚合；缺点：聚合的「入口名/图标」和「TAB 顺序」要从成员项推导，不够显式。
  - **候选 B（parent 声明）**：新增一个「父项」概念，父项声明 `children: [itemId...]`，子项照旧平铺声明。父项只负责「入口名 + 图标 + TAB 顺序」，子项负责「内容 + config」。优点：入口名/TAB 顺序显式，父项不碰 config；缺点：多一层「父项 vs 子项」的区分。

- **本文取候选 B 的一个最小变体**：不为父项新增 `parent`/`children` 的跨文件引用（那会引入「项之间互相引用」的解析复杂度），而是**让一个 settings item 的 `tabs` 数组直接内嵌子项声明**。即：入口 item 声明 `tabs: [subItem, subItem, subItem]`，每个 subItem 的形状与现有扁平 item 完全一致（`component` + `configFile` + `saveMode` + ...）。框架渲染入口时，画 TAB 条 + 当前 subItem 的 pane，每个 subItem 走现有 per-item 的 config/dirty/save 机制。这样：

  - 父项不另存一份 config 语义（它的 `configFile` 为空，只是一个「壳」）；
  - 子项复用现有 SettingsPane 的 config 注入（`config`/`dirty`/`onChange` 三个 prop 原样）；
  - 「DSH」入口同构声明，零新机制。

- **渲染流**（settings-page.tsx 的改动点）：现状 `SettingsPane` 对一个 item 渲染「标题条 + `<Comp config dirty onChange>`」。展示分组后，渲染分两层：

  1. 入口层：侧栏 `items` 里，有 `tabs` 的 item 渲染为一个入口（一个 ListItem + 图标 + 标题）；点它 → 右栏切到该入口。
  2. TAB 层：右栏该入口渲染「TAB 条（按 `tabs` 顺序）+ 当前 TAB 的 pane」。当前 TAB 的 pane 就是现有 `SettingsPane`（复用 `mountedIds` 的懒挂载 + `display:none` 保活的「切 TAB 不重 mount」契约，见 settings-page.tsx 第 244 行注释）。

- **dirty/save 语义不变**：现状「有 dirty 时切 tab / 返回对话弹窗拦截」「确定改动 / 取消改动」「设为全局 / 移除项目覆盖」这套框架浮层，逻辑挂在「当前激活的 settings item」上。展示分组后，「当前激活项」从「入口 item」变为「入口内的当前 TAB（= 一个子 item）」，浮层照旧读当前子 item 的 `configFile`/`dirty`/`saveMode`。即：浮层逻辑一行不改，只把「activeId」的粒度从入口下推到 TAB。三个 TAB 各自独立 dirty——切 TAB 时若当前 TAB 有 dirty，照样弹拦截，和现状三个独立入口的拦截行为一致。

- **入口图标与标题**：PI 入口图标 = `icon: "pi"`（现 `PiLogo`），DSH 入口图标 = `icon: "dsh"`（新 `DshLogo`，§3.4）。TAB 的标题沿用各自原 settings item 的标题（Pi / PI 拓展 / 模型；DSH / DSH 拓展 / DSH 模型配置），i18n key 沿用或新增，不硬编码中文（铁律一）。

- **本节为什么值这么多笔墨**：这是全文唯一一处「动 settings 壳」的改动，也是最容易做坏的——一旦把 config 语义混进展示分组，三个数据面的 save/dirty 就会串。所以本节把「展示」和「config」的边界钉死：展示分组只动侧栏渲染 + TAB 条，config 注入、dirty/save、浮层、拦截全部按子 item 原样复用。

### 3.2 模型身份：`ModelInfo.kernel`，来源派生

- 圆心 `ModelInfo`（`src/core/domain/events/session-state.ts` 第 8 行）加一个字段 `kernel: "pi" | "dsh"`。这是中性判别子，不进任何配置文件，由扫描器在「从哪个来源扫出来」时赋值（pi 源 → `"pi"`，dsh 源 → `"dsh"`）。

- 现状 `ModelInfo` 字段：`provider / id / name / reasoning? / contextWindow? / maxTokens? / input?`。加 `kernel` 后，`provider + id` 仍是一个内核内的唯一键，`kernel + provider + id` 才是全局唯一键。全文所有「按模型查找」的地方，从「`provider`+`id` 匹配」升级为「`kernel`+`provider`+`id` 匹配」（§3.3 展开同名冲突）。

- 契约单源：`ModelInfo` 在圆心定义一次，外层（timeline 的 `toModelInfos`、composer、session-store 的 `toModelInfo`、`context-binding.ts` 的映射）只 import / re-export，不另写本地版。`kernel` 字段一进圆心，所有消费方同步拿到。特别注意 `core/protocol/context-binding.ts` 的 `toModelInfo(pi: Model)`（第 27 行）——它把底座的 `Model` 映射成 `ModelInfo`，现在要补 `kernel`。这个映射只服务 pi 后端，所以 `kernel` 在此写死 `"pi"`；dsh 后端的模型不走这个映射，走 §3.3 的 dsh reader，`kernel` 写 `"dsh"`。两条线各自在「来源」处赋值，圆心不关心赋值逻辑，只持有字段。

- 为什么是 `"pi" | "dsh"` 字面量联合，而不是 `string`：判别子联合让编译器在「新增内核」时强制补全所有 `switch (model.kernel)` 的分支。如果写成 `string`，加第三个内核时，所有 `if (kernel === "pi")` 的分支静默漏掉新内核。字面量联合是「漏改就编译不过」的第一道防线（与 CLAUDE.md §1.3 契约单源同源）。

- `kernel` 的语义边界：它只回答「这个模型属于哪个内核」，不回答「这个内核现在能不能用」「这个内核有没有在跑」。后两个是运行时状态，不是模型身份，不该塞进 `ModelInfo`。谁要用「内核可用性」，去查运行时（§3.6 的会话头 / §6.2 的 dsh 未配置态），不往 `ModelInfo` 上加 `available` / `running` 字段。

### 3.3 模型扫描合流：两路来源合成一张表

- 现状只有一路：`ctx.modelsConfig.get<ModelsConfig>()` → `toModelInfos`（pi 的 models.json）。新增第二路：读 dsh 原生配置（`settings.yaml` 的 `llm-deepseek` 单 route + `llm-pi-ai.providers` 多路由），产出一份 `ModelInfo[]`，`kernel="dsh"`。

- 两路来源形状不同，各自一个 reader：

  - **pi reader**：读 `~/.pi/agent/models.json`，展开 `providers[*].models[*]` 成 `ModelInfo`（现状 `toModelInfos` 已有，逻辑上收），`kernel="pi"`。这条线是「现状搬家」不是「新写」。
  - **dsh reader**：读 dsh 原生配置的 provider 路由（`llm-deepseek` → route `"deepseek-official"`；`llm-pi-ai` → `providers` dict 每个 route），展开各 route 的 `models` 成 `ModelInfo`（`provider` 取 route key；`id`/`name` 取 model id/name；`kernel="dsh"`）。

- 合流点：一个「模型清单」能力，向调用方返回 `ModelInfo[]`（pi + dsh 合并、带 kernel）。落点：`core/application` 里一个 `model-catalog`（合流 + 打标），IPC/plugin-context 暴露一条 `ctx.kernels.listModels()`（或等价接口）；timeline 的 `toModelInfos` 改为消费这个合流结果，不再自己扫 pi。

- **为什么上收到 `core/application`，而不是留在 timeline**：`toModelInfos` 现在活在 timeline 插件里，它「知道」`ModelsConfig` 长什么样——这是「机制」（扫模型）漏进了「内容」（timeline 插件）。多内核之后，扫模型是「所有内核共用」的机制，该收进 `core/application` 的编排层（与 session-store、model-store 同级）。timeline 只消费「扫好的 `ModelInfo[]`」，不自己扫。这是「框架管通用」在模型清单上的落实。

- **同名冲突**：两个内核可能有同名 provider/model（如都叫 `gpt-4o`）。`kernel` 字段就是消歧的键——模型下拉按 `kernel` 分组，同组内再按 provider 分组，同名的两条靠内核标区分，不跨内核去重。这一条和 `multi-kernel-shell.md` §3 的边界情况「两个内核同名模型——模型名是内核各自的，壳不跨内核比对」一致，本文把它从「契约层」落到「UI 层」：不跨内核去重 = 下拉里同名两条都出现、各带各的标。

- **reader 的失败语义**：pi reader 读不到 models.json（文件缺失/解析失败）→ 现状 `modelsConfig.get` 兜底成空 `ModelsConfig`（`providers: {}`），返回空清单，不报错（pi 未配置模型的正常态）。dsh reader 读不到任何 provider 路由（`llm-deepseek` + `llm-pi-ai` 都无）→ 返回空清单 + 一个显式「dsh 未配置模型」的信号（不是空数组了事，UI 要能区分「dsh 没装」和「dsh 装了但没配模型」，§6.2）。两个 reader 的失败语义不同，因为「pi 没配」和「dsh 没配」对用户的意义不同：前者是历史常态，后者是「你要用 dsh 就得先配」。

- **缓存与刷新**：模型清单是「读一次、变化时刷新」的读多写少数据。现状 timeline 靠 `system:configFileSaved`（按 path 匹配 models.json）单点通知重拉（timeline index.tsx 第 249 行）。合流后，刷新触发点从「models.json 保存」扩展为「models.json 保存」+「cordis.yml 保存」两个信号。model-catalog 不自己起轮询（事件驱动，不轮询，CLAUDE.md §3.6），只在收到信号时重读。

### 3.4 内核标组件：`PluginIcon` 加 `DshLogo`

- `packages/react/src/widgets/plugin-icon.tsx` 加 `DshLogo`（鲸鱼 SVG，`currentColor`、`viewBox 0 0 24 24`），`PluginIcon` 里 `name === "dsh"` 命中它，与 `name === "pi"` 命中 `PiLogo` 对称。`resolvePluginIcon` 不加 `dsh`（消费方要的是「内核标」不是 lucide 图标，走 `PluginIcon`）。

- 现状 `plugin-icon.tsx` 结构：`ICONS: Record<string, LucideIcon>` 映射 lucide 图标，`PiLogo` 是一个内联 SVG 组件，`PluginIcon` 里 `if (name === "pi") return <PiLogo/>` 提前返回，否则查 `ICONS[name] ?? Puzzle`。加 `DshLogo` 后，`PluginIcon` 顶部变成 `if (name === "pi") ... ; if (name === "dsh") return <DshLogo/>`。这是纯增量，不影响任何现有图标。

- `DshLogo` 的实现要点：

  - 单 `<path>`，`d` 就是 simple-icons `deepseek.svg` 的 path（鲸鱼，官方 mark）；
  - `fill="currentColor"`，`viewBox="0 0 24 24"`——与 lucide 同口径，`className` 传 `size-4`/`size-5` 控制尺寸，颜色随 CSS `color`；
  - `aria-label="dsh"`，与 `PiLogo` 的 `aria-label="pi"` 对称（可访问性不省）。

- **复用处**：设置页 DSH 入口图标、模型下拉的分组标题 + 每条模型前缀、空态大 logo、assistant 消息头小标。四处同一份 `DshLogo`，不复制 SVG path。唯一例外：空态大 logo 需要「大尺寸」的 `DshLogo`，靠 `className="size-full"`（填满父容器）实现，不是另一份 SVG。

- 鲸鱼 SVG 的来源与合规：取自 simple-icons 的 `deepseek.svg`（GitHub `simple-icons/simple-icons`），这是 DeepSeek 官方品牌 mark 的社区标准化版本，单色、可自由缩放。把它内联进 `plugin-icon.tsx`（不引用外部 CDN），保证离线可用、随壳分发。若后续 DeepSeek 官方发布更权威的 logo 资产，替换 `DshLogo` 的 `d` 即可，消费方无感——这是「内核标」作为「内容」的应有之义（内容可换，机制不动）。

### 3.5 会话流内核身份：三处显标，一处跟随

- 会话流要三处显标、一处跟随。三处显标是「哪里能看到内核」；一处跟随是「它们读的是同一个来源，改模型即三处同步切换」。

- **空态大 logo**（现状 `timeline/index.tsx:882` 的硬编码 `PiLogo`）改成内核感知：读当前会话的内核，pi 画 `PiLogo`、dsh 画 `DshLogo`。内核按 §2.5 定——有默认模型亮默认模型的内核，没有默认模型则两个内核都展示（⬡ + 🐋）。这是「用鲸鱼模型后，空态 PI 标变鲸鱼」的直接落地。

- **模型下拉**（`composer.tsx`）：`groupByProvider` 之上加一层 `groupByKernel`——先按 kernel 分「PI / DSH」两组，每组标题 + 每条模型前缀内核标。选中项在触发按钮上也显示内核标（不只是模型名）。现状 `groupByProvider`（composer.tsx 第 416 行）按 `provider` 分组的 `Map` 改成先按 `kernel` 分组的嵌套 `Map<kernel, Map<provider, ModelInfo[]>>`，渲染时两层遍历。

  - **落地的呈现形式是「底部内核 TAB」而非整表两组铺开**：下拉内容底部一条 `pi` / `dsh` TAB（两个内核都有模型时出现），点 TAB 把清单收窄到该内核，上面只铺该内核的 provider → models；单内核时不显示 TAB、直接铺清单。TAB 固定底部（`flex-col`，清单区 `overflow-y-auto` 独立滚动、`flex-shrink:0` 的 TAB 条），切换内核时清单高度变化由清单区自身吸收、不带动 TAB 跳动。宽度同样稳定：两个内核的清单叠在同一个 `display:grid` 单元格（`gridArea: 1/1`），非激活内核 `height:0 + overflow:hidden + visibility:hidden` 只占宽不占高——下拉宽度始终取两个内核清单的最大值，切换内核宽度不跳。打开下拉时 TAB 重置回当前模型所属内核（`onOpenChange` → 清 `modelKernel` state，`tabKernel` 回落 `currentModel.kernel` → 首个内核）。这仍是 §2.2 的「纯展示过滤」，不引入独立内核切换。

- **assistant 消息头**（新增，现状没有）：每条 assistant 消息头部加「内核标 + 模型名」小标，标识「这条由哪个内核的哪个模型生成」。落点定 **timeline 行级 chrome**（`MessageRow` assistant 分支直接画，不走 block-renderers 槽）——它是会话元数据（与 composer 显示模型名同类），不是可插拔内容块；槽机制留给真正的内容块。`MessageRow` 的 assistant 分支（timeline index.tsx 第 1117 行）在 `renderBlocks()` 之前加一行 `<div className="msg-head"><KernelBadge kernel model/></div>`。

- 三处（空态 logo / 下拉 / 消息头）读的是同一个「当前内核」，由「当前会话所选模型的内核」决定（§2.2），改模型即三处同步切换。这条「一处跟随」的实现要点：三处都从 `currentModel.kernel` 取，不各自维护一份「当前内核」state——维护两份就是漂移的温床（`multi-kernel-shell.md` §5.5 的「路由只认一个不透明标记」在 UI 层的同款：内核身份只认 `currentModel.kernel` 一个来源）。

- **消息头里显示「模型名」还是「内核标」还是两者**：两者都显示——`[🐋] deepseek-v4-pro`。只显示内核标，用户知道「这是 dsh」但不知道「dsh 的哪个模型」；只显示模型名，用户知道「deepseek-v4-pro」但不知道「它是 dsh 的」。两者并列才是完整身份。原型（settings-merge-prototype.html 的会话流 mock）已按「内核标 + 模型名」定稿，代码照此。

### 3.6 跨内核切换：会话流是壳的，内核随时可换

- 需求方向：不要「一条会话锁死一个内核」。会话流应该是 **my-harness-desktop 的会话流**（中性真相源），内核是随时可换的运行时，用户能在 pi ↔ dsh 之间来回切。为此要「抽象一层方法」——把「会话」从「内核的会话」里提出来。这正是 `multi-kernel-shell.md` 中立契约的兑现。

- 这层抽象的形态：

  - **会话 = 稳定 id + 中性消息流**（壳持有，真相源）；**内核 = 运行时**（spawn + 适配器 + 它自己的会话模型）；**切换 = 换运行时 + 把中性流 seed 到新内核**。

- 切换五步：① `abort` 收掉在飞回合 → ② 快照当前中性 transcript（壳已有中性消息流，缺的是一份「可 seed 的权威快照」）→ ③ stop 旧内核 → ④ spawn 新内核 + 就绪 → ⑤ 把 transcript seed 到新内核 + 重绑会话 id（壳的会话 id 稳定，内核侧 session-id 是适配器私有，切换时换绑，记进会话头）。

- 三块新能力（两侧都要补面/新写）：

  1. **中性 transcript 导出**：壳把「会话到目前的中性消息流」物化成一份可再入的快照（不是渲染态，是结构化 NeutralMessage 列表）。
  2. **seed / import 能力**：内核从「一段中性历史」起步。pi 现状只有 bookmark/resume（文件拷贝锚点），dsh 只有 resume（fork 子会话）；「吃整段中性历史」是两边都要补的新命令。
  3. **会话 id 重映射**：切换后同一会话在新内核上有新 session-id，壳把它记进会话头（「当前内核 + 该内核的会话 id」），下次续接按头路由。

- 硬骨头（诚实标注，不藏）：

  - 在飞回合必须先 abort 收尾，切换才能开始；
  - 工具调用/结果是内核侧产物（pi 的 bash、dsh 的工具卡），跨内核重放要定边界：默认「user 消息 + assistant 文本」跨内核，工具内部不重跑（新内核把它们当历史显示，不重新执行）；
  - fork 树跨内核不一一映射（pi 文件内分叉 vs dsh 子会话）：第一期只支持「无 fork 的线性 lineage」上切换，有 fork 的会话先降级（提示先回到某个分叉点）。

- 这是「多内核壳」的最终形态，单独一期（§5.4）。它建立在「会话标识中性化」「bookmark/resume 收编」「lineage」这些已落地/进行中的中性化工作之上——那些正是「抽象一层」的半成品，本期把它们接成「可切换」。

- **五步的详细展开**（这是本节的核心，把每一步的输入/输出/失败语义钉死）：

  1. **abort 收尾**：如果当前有流式生成（`streaming === true`），先 `abort()` 并等它落定（收尾成一个「已停止」的 assistant 消息，不丢已生成的文本）。这一步的必要性：切换要快照 transcript，不能带着一条「还在流」的消息快照——否则 seed 到新内核后，这条消息是「半截」还是「完整」说不清。失败语义：abort 超时（内核卡死）→ 走 stop 的 kill 链（关 stdin → 1s → SIGTERM → 2s → SIGKILL），transcript 里这条消息标「已停止」。
  2. **快照 transcript**：把当前中性消息流物化成 `NeutralMessage[]`。这不是把 renderer 的渲染态 dump 出来，而是调 session-store 的既有 `getEntries(lineageId)`（已返回 `NeutralMessage[]`）——它是「可再入的权威快照」的现成来源。快照的粒度：`NeutralMessage`（user 文本 + assistant 文本 + 工具调用/结果块）。工具块在此要不要截掉，见下方「工具边界」。
  3. **stop 旧内核**：走 SubprocessHandle 的 stop 链，旧适配器随之断开、pending 意图全报错（`multi-kernel-shell.md` §4.11 的「适配器跟着内核走」）。
  4. **spawn 新内核 + 就绪**：按新内核的 spawn 命令起进程，等就绪信号（pi 的探测、dsh 的 initialize）。就绪前不发 seed（`multi-kernel-shell.md` §2.6「就绪后才发意图，否则意图落空」）。
  5. **seed + 重绑**：把快照的 `NeutralMessage[]` 交给新内核的 seed 能力，让它从这段历史起步；新内核返回它的 session-id（pi 的新文件路径 / dsh 的新子会话 id），壳把它写进会话头，替换旧 session-id。此后 `sendMessage` 走新适配器。

- **工具边界（诚实标注的硬骨头之二展开）**：跨内核重放时，工具调用/结果是内核侧产物。pi 的 `bash` 工具卡和 dsh 的工具卡，虽然投成同一条中性「工具调用/结果」块，但它们的「再执行」语义完全不同——dsh 无法重新执行 pi 的 bash 命令，pi 也无法重新执行 dsh 的工具。所以默认边界是：**「user 消息 + assistant 文本」跨内核，工具块不跨**。具体：快照 transcript 时，工具调用/结果块保留（让新内核的历史里有「曾经用过工具」的记录，用户能看到完整上下文），但 seed 时把它们当作「只读历史」投喂，新内核不重新执行；后续新消息若需要用到之前的工具产物，由用户/内核自行在消息里补，壳不替它「重跑」。

- **fork 边界（硬骨头之三展开）**：pi 的 fork 是文件内分叉（`parentId` 树），dsh 的 fork 是子会话。一个带 fork 树的会话，它的 lineage 树在两个内核里的形状不同，无法一一映射。所以第一期只支持「无 fork 的线性 lineage」上切换——即用户还没 fork 过的单线会话。有 fork 的会话，切换入口降级为「提示先回到某个分叉点（或用 bookmark/resume 另开）」，不硬切。这是「能补面就补、补不了就显式不支持」的缺面纪律（`multi-kernel-shell.md` §4）。

- **「抽象一层」和已有半成品的关系**：这一步不是从零开始。最近一批提交已经把地基铺了一半——`BaseBackend`（`domain/backend.ts`）把「底座该提供什么」抽成中性接口、`DshBackend`/`PiBackend` 是两个实现、`bookmark/resume` 收编到后端、`lineage` 坐标系已立。本文要的「seed」是这条线上新补的一个意图：`getEntries` 已经有（导出 transcript），缺的是「把 transcript 再喂回去」的 `seed`。所以「抽象一层」的增量其实比看起来小——大头在「seed 能力」和「会话 id 重映射」，前者的 `getEntries` 半边已存在。

### 3.7 API 契约签名

- 本节把 §3.2–3.6 牵出的接口钉死签名，作为「圆心 → application → api → 插件」四层的对齐面。签名用中性 TypeScript 类型表达，圆心定义、外层 re-export（契约单源）。

- **模型清单（model-catalog 的输出）**：

  ```ts
  // core/domain —— ModelInfo 加 kernel（§3.2）
  interface ModelInfo {
    provider: string;
    id: string;
    name: string;
    kernel: "pi" | "dsh";   // 新增
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    input?: string[];
  }

  // core/application —— model-catalog 合流结果
  interface ModelCatalog {
    listModels(): Promise<ModelInfo[]>;        // pi + dsh 合并、带 kernel
    listModelsByKernel(k: "pi" | "dsh"): Promise<ModelInfo[]>;
  }
  ```

- **dsh 模型配置读写（DSH 模型配置 TAB 用）**：

  ```ts
  // dsh 原生 provider 路由形状（非 pi 的 ModelsConfig）——对齐官方 dsh-llm-deepseek / dsh-llm-pi-ai schema
  interface DshModelSpec {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
  }
  interface DshProviderProfile {
    apiKeyEnv?: string;        // 凭证引用（环境变量名），官方 credentialRef；缺省 DEEPSEEK_API_KEY
    displayName?: string;      // 配置面显示名，缺省 = route key
    api?: string;              // wire protocol（openai-completions / anthropic-messages / ...）
    baseURL?: string;
    models: DshModelSpec[];
  }
  // dsh 的 provider 分两块：llm-deepseek 一个固定 route "deepseek-official"（无 displayName/api）；
  // llm-pi-ai 一个 providers dict（key = route）。
  // IPC：dsh:models.get() → DshProviderProfile[]；dsh:models.set(provider, detail)
  ```

- **seed 能力（§3.6 的新意图，进 BaseBackend）**：

  ```ts
  // core/domain/backend.ts —— BaseBackend 增补
  interface BaseBackend {
    // ... 既有 sendMessage/abort/fork/getTree/getEntries/bookmark/resume/deleteBookmark
    /** 从一段中性历史起步；返回新内核侧的 session 标识（不透明）。 */
    seed(history: NeutralMessage[]): Promise<string>;
  }
  ```

  - `seed` 的语义：让内核开一个「已含这段历史」的新会话，返回该会话的内核侧 session-id。pi 的补面实现 = 把 history 写进一个新 JSONL 文件（头行 + 条目）；dsh 的补面实现 = spawn 后一次性把 history 经 `session/seed`（或等价）灌进去。两侧各自在适配器内补面，壳只见 `seed(history) → sessionId`。

- **会话头重绑（§3.6 第 5 步）**：会话头里「内核归属 + 该内核的 session-id」成为一对可改写字段。现状会话头记的是 pi 的文件路径（`multi-kernel-shell.md` §1.2 的泄漏），中性化后记的是「不透明 session-id + kernel」。切换时写回新值。这个「会话头」的读写是 session-header 机制的范畴（`session-header-custom.md`），本文只消费「头里能存 kernel + session-id」这个事实，不重新设计头机制。

- **插件上下文（renderer 侧消费面）**：timeline / 设置页插件经 `usePluginContext()` 拿到的，是上面接口的受控投影。不新增「裸窗口 API」，统一走 PluginContext 分层（pluginId 绑定层 / 系统级 API 层 / 事件层），守薄壳（CLAUDE.md §8.1）。`ctx.kernels.listModels()` 是系统级 API（所有插件可用，不需权限声明，与 `ctx.models`、`ctx.sessions` 同级）；`dsh:models.get/set` 若有敏感字段（apiKey），按「敏感字段过滤在协议翻译层」推给外层处理，圆心契约不含 apiKey 的明文往返（§8 安全）。

### 3.8 数据流与时序

- 本节用文本时序图把三处关键链路画清楚。箭头写「谁 → 谁」，括号写「数据」。没有真正的 mermaid（设计文档用文字即可，代码里再落）。

- **链路一：打开会话页，模型下拉铺出两路模型**：

  ```
  timeline 挂载
    → ctx.kernels.listModels()                    （renderer → main IPC）
      → model-catalog.listModels()
        → pi reader 读 ~/.pi/agent/models.json    （kernel="pi"）
        → dsh reader 读 settings.yaml llm-deepseek + llm-pi-ai   （kernel="dsh"）
        → 合并 ModelInfo[]                        （带 kernel）
      ← 返回 ModelInfo[]
    → composer 按 kernel 分组渲染下拉             （⬡ 组 / 🐋 组）
    → 空态 logo 按 defaultModel.kernel 渲染       （§2.5）
  ```

- **链路二：选鲸鱼模型，三处内核标同步切**：

  ```
  用户点「🐋 deepseek-v4-pro」
    → pickModel(m)                                （m.kernel === "dsh"）
      → ctx.models.setModel(m.provider, m.id)     （走当前内核的 setModel；新会话则先定内核）
      → setDefaults({ provider, modelId })        （timeline 现有逻辑）
    → currentModel 更新为 m
    → 空态 logo 读 currentModel.kernel → DshLogo
    → 下拉触发按钮读 currentModel.kernel → 🐋 标
    → assistant 消息头读 currentModel.kernel → 🐋 标
  ```

- **链路三：跨内核切换（§3.6 五步）**：

  ```
  用户点「切到 dsh」
    → ① abort()（若有流式）→ 等落定
    → ② history = sessionStore.getEntries(lineageId)   （NeutralMessage[]）
    → ③ stop 旧内核（pi 子进程 kill 链）
    → ④ spawn 新内核（dsh --profile）+ initialize 就绪
    → ⑤ newSessionId = backend.seed(history)            （dsh 侧补面）
        → 会话头写回 { kernel: "dsh", sessionId: newSessionId }
    → 后续 sendMessage 走新适配器；三处内核标切 🐋
  ```

- 三条链路的共同纪律：**内核身份只认一个来源**（链路一/二是 `currentModel.kernel`，链路三是会话头），三处显标各自订阅，不各自持有 state。谁要在 renderer 里另起一个 `currentKernel` state，就是泄漏（§3.5 末段、`multi-kernel-shell.md` §5.7）。

## 4. 落点与依赖方向

- 依赖只向内（`core/domain` → `core/application` → `api`/`client` → `plugins`），每处改动标清层，越界即违规。本节给到文件级。

### 4.1 圆心 `core/domain`

- `events/session-state.ts`：`ModelInfo` 加 `kernel: "pi" | "dsh"`（§3.2）。零依赖，纯类型。这是唯一动圆心的点。

- `backend.ts`：`BaseBackend` 增补 `seed(history: NeutralMessage[]): Promise<string>`（§3.7）。这是圆心契约的一条新意图，纯接口，实现归外层。

### 4.2 编排 `core/application`

- 新增 `model-catalog`（或并入现有 sessions/model 编排）：合流 pi / dsh 两路模型、打 kernel 标，产出 `ModelInfo[]`。它依赖两个 reader（§3.3）与 `core/protocol` 的中性类型，不碰 electron / react / 具体存储。

- dsh 模型 reader 依赖「读 dsh 原生配置的 provider 路由（`settings.yaml` 的 `llm-deepseek` + `llm-pi-ai.providers`，cordis.yml 兜底）」——这是 dsh 原生配置，读取实现落 `client/dsh`（外部资源），application 只依赖一个「读 dsh 模型清单」的接口（依赖倒置），不自己碰 settings.yaml/cordis.yml 解析。

- `sessions/session-store.ts`：跨内核切换的编排（§3.6 五步）落这里——它是「会话意图的编排中心」，切换是会话级编排，不是插件的事。`seed` 调用、会话头重绑、stop/spawn 顺序，都在 session-store 内，插件只发一个「切内核」的意图。

- `protocol/context-binding.ts`：`toModelInfo` 补 `kernel: "pi"`（pi 后端专用映射，§3.2）。

### 4.3 流入 `api`

- `api/ipc` + `api/preload`：暴露合流后的模型清单（`ctx.kernels.listModels()` 或等价），以及 dsh 模型配置的读写（`dsh:models.get/set`，供「DSH 模型配置」TAB 用）。这些 handler 经 `register*(ctx)` 注入依赖，不直读进程环境。

- `api/renderer`：settings 页的展示分组渲染（§3.1）落这里的 `components/settings-page.tsx` 壳；`PluginIcon` 的 `DshLogo` 落 `packages/react`（发布面）。这两处是「壳」的机制改动，不是插件改动。

### 4.4 流出 `client`

- `client/dsh`：读 `settings.yaml` `llm-deepseek` + `llm-pi-ai` 的 reader + 写回（供 DSH 模型配置 TAB）；`seed` 的 dsh 补面实现（把 NeutralMessage[] 灌进 dsh）。这是 dsh 原生配置与能力的出口，与 `client/pi` 的 models.json 读写、pi 侧 `seed` 补面对称。

- `client/pi`：pi reader 现状已有（经 `ctx.modelsConfig`）；`seed` 的 pi 补面实现（把 NeutralMessage[] 写成新 JSONL 文件）。pi 侧增量小，主要是 `seed` 补面。

- `client/npm`：DSH 内核版本 / 拓展的安装复用这里（`kernel-runtime` 的 npm spawn + registry 查询，§6.3 已确认 npm 同构）。

### 4.5 内容 `plugins`

- `manager/`：三个插件合并为「一个内核一个入口」（展示分组，§3.1）。PI 入口三个 TAB 复用现有三组件；新增 DSH 入口三个 TAB（DSH 模型配置 TAB 先接 §4.4 的 reader，DSH 拓展/版本切换 TAB 接 npm 机制，内容可最小可用）。插件只 import `@my-harness-desktop/contract` / `@my-harness-desktop/react`，不 import `@/core`、`@/client`。

- `sessions/timeline`：`toModelInfos` 改消费合流清单；composer 下拉按 kernel 分组 + 前缀标；空态 logo 改内核感知；assistant 消息头加内核标（§3.5）。

- **依赖方向检验（逐条，违规即返工）**：`core/domain` 零新增 import；`core/application/model-catalog` 不 import `electron`/`react`，对 cordis.yml 的读取走依赖倒置接口；`client/dsh` 不 import `react`/`../api`；`plugins/manager` 和 `plugins/sessions/timeline` 无 `@/core`、`@/client` import；`api` 不 import `bootstrap`。这几条是 CLAUDE.md §6.3 的物理检验，落地时 CI 或 grep 可查。

## 5. 分期落地

- 按「先圆心类型 + 图标，再设置页合并，然后模型合流 + 会话流显标，最后跨内核切换」的顺序，每期可独立验证、独立提交：

### 5.1 阶段一：圆心类型 + 内核标

- `ModelInfo.kernel` 进圆心；`PluginIcon` 加 `DshLogo`（鲸鱼）。纯增量，无行为变化，先立类型和图标两个「地基」。验证：build + 单测，`ModelInfo` 与 `DshLogo` 可 import。

- 详细任务：

  - `events/session-state.ts` 加 `kernel` 字段；`context-binding.ts` 的 `toModelInfo` 补 `kernel: "pi"`。
  - `plugin-icon.tsx` 加 `DshLogo` + `name === "dsh"` 命中。
  - 单测：`toModelInfo` 产出的 `ModelInfo.kernel === "pi"`；`DshLogo` 渲染不抛错。

### 5.2 阶段二：设置页合并 + DSH 入口

- settings 框架加展示分组（§3.1）；三个插件合并成 PI 入口三 TAB；新增 DSH 入口三 TAB（DSH 模型配置 TAB 先接 §4.4 的 reader，内容可最小可用）。验证：设置页 PI/DSH 各三 TAB 可切、dirty/save 语义与合并前一致（pi 回归）。

- 详细任务：

  - settings-page.tsx 加「入口 + TAB 条 + 子项 pane」渲染，`activeId` 粒度下推到 TAB。
  - manifest 加 `tabs` 声明形状（§3.1 候选 B 最小变体）。
  - PI 入口：三组件迁入三 TAB；DSH 入口：三 TAB 骨架 + DSH 模型配置接 cordis.yml reader。

### 5.3 阶段三：模型合流 + 会话流显标

- `model-catalog` 合流两路；timeline `toModelInfos` 换源；composer 按 kernel 分组 + 前缀标；空态 logo 内核感知；assistant 消息头加内核标。验证：pi 下行为不变（回归），dsh 下模型下拉能选鲸鱼、空态/消息头/下拉三处显标同步切换。

- 详细任务：

  - `core/application/model-catalog` + pi/dsh 两个 reader（dsh reader 经依赖倒置接口调 `client/dsh`）。
  - IPC/plugin-context 暴露 `ctx.kernels.listModels()`。
  - timeline 换源、composer 两层分组、空态 logo 内核感知、消息头内核标。

### 5.4 阶段四：跨内核切换（抽象一层）

- 落地 §3.6：中性 transcript 导出 + 内核侧 seed/import 能力 + 会话 id 重映射；会话流切内核 = 五步切换。第一期只支持「无 fork 的线性 lineage」上切换。验证：pi → dsh 切过去、dsh → pi 切回来，消息流续接正确、会话头内核归属正确；有 fork 的会话按降级路径提示。

- 详细任务：

  - `BaseBackend.seed` 进圆心；pi/dsh 两侧补面。
  - session-store 加「切内核」编排（五步）。
  - 会话头重绑（kernel + session-id）。
  - UI 挂「切内核」入口（模型下拉里选另一内核的模型即触发，§2.2）。

### 5.5 每期提交即文档

- 每期一个 commit，message 含「改了什么 / 为什么 / 架构依据 / 运行时验证」四要素（CLAUDE.md §5.4）。圆心类型改动单独一 commit，避免和 UI 混在一个 diff 里。

## 6. 边界情况与风险

### 6.1 同名 provider/model 跨内核

- 两个内核同名模型（都叫 `gpt-4o`）：靠 `kernel` 字段消歧，下拉按内核分组，同名的两条各带各的标。`setModel(provider, model)` 契约不变——内核在会话建立时已定，路由到哪个适配器由会话头决定，不靠模型名猜。

### 6.2 dsh 模型清单为空 / 无 `llm-deepseek` 与 `llm-pi-ai`

- dsh reader 读不到任何 provider 路由（`llm-deepseek` 和 `llm-pi-ai.providers` 都无）时，返回空清单 + 显式「dsh 未配置模型」态，不静默当 pi 处理。DSH 模型配置 TAB 给出「去配模型」的入口。

### 6.3 DSH 拓展 / 内核版本 = npm 包，不是缺面；仅模型测试是缺面

- 实测 deepseek-harness 确认：「DSH 拓展」= Cordis 插件 = npm 包（`@deepseek-ai/dsh-*`，cordis.yml 的 `name:` 字段），「DSH 内核」= npm 包 `@deepseek-ai/dsh`（bin `dsh`，当前 `0.1.0-rc.5`）。两者与 pi 同构——pi 的内核是 npm 包、pi 的拓展是 npm/git/file 源。所以「DSH 拓展」「DSH 内核版本切换」**复用现有 npm 机制**（`client/npm` 的 kernel-runtime + 既有拓展安装器），不是缺面。

- 真正缺面的是「DSH 模型测试」：dsh 侧没有 pi 的 `testModel` 命令。处置与 `multi-kernel-shell.md` §4 一致：能补面就补，补不了就显式「不支持」+ 降级，不在 UI 里假装有。

### 6.4 迁移与回滚

- 设置页合并是纯 UI 重组，三个插件的持久化文件（settings.json / models.json / 各拓展状态）不动、不迁移。回滚 = 把入口拆回三个 settings item，数据原地不受影响。模型清单合流是纯读合流，不写任何新配置，回滚零成本。跨内核切换写会话头（kernel + session-id），回滚 = 停用切换入口，已切过的会话按头里的新 session-id 续接，数据不丢。

## 7. 验收标准

- **设置页**：PI 一个入口、三个 TAB 可切，内容与合并前三插件一致；DSH 一个入口、三个 TAB；两入口并列，其余设置项不受影响；dirty/save 在 pi 上回归全绿。
- **模型清单**：pi + dsh 两路模型合成一张表，每条带 `kernel` 标；pi-only 环境（无 dsh）行为与现状一致。
- **会话流**：模型下拉按内核分组、每条前缀标；选鲸鱼模型后，空态 logo、下拉选中项、assistant 消息头三处内核标同步切鲸鱼；pi 模型下三处切回 ⬡。
- **跨内核切换**：pi ↔ dsh 来回切，消息流续接正确、会话头内核归属正确；有 fork 的会话降级提示。
- **依赖纪律**：`core/domain` 零新增 import；`plugins/` 无 `@/core` / `@/client` import；`ModelInfo.kernel` 单源在圆心。

## 8. 决策记录

- 本章是 §2 决策 + 需求方确认的留痕，一次说清「定了什么、为什么、谁定的」，后来者不用考古聊天记录。

1. **设置页合并落法**：展示分组——内部三份 config 不动，settings 槽只加一层「一个入口聚合多个子项、渲染成 TAB」（§3.1）。
2. **assistant 消息头内核标落点**：timeline 行级 chrome（§3.5）。
3. **会话内跨内核切换**：要支持，走 §3.6 的「抽象一层」，列为 §5.4 阶段四；第一期只支持线性 lineage。
4. **DSH 拓展 / 内核版本切换**：都是 npm 包（内核 `@deepseek-ai/dsh`、拓展 `@deepseek-ai/dsh-*`），与 pi 同构，复用现有 npm 机制，不是缺面（§6.3）。仅「DSH 模型测试」是缺面，降级占位。
5. **默认内核**：不单设配置，默认内核 = 默认模型的内核（§2.5）；没有默认模型时空态两个内核都展示。

## 9. 测试计划

- 本文的分期（§5）每一期都要有可独立运行的测试。本节按「单测 / 集成 / 回归」三层给测试用例清单，验收（§7）里的每一条都能落到一个或多个用例上。测试的纪律与 `multi-kernel-shell.md` §6.5 一致：壳的集成测试要参数化跑在 pi 和 dsh 两个后端上，全绿且壳插件代码零改动——那是「壳内核无关」的可检验形式。

### 9.1 单测（圆心 + 纯函数）

- `toModelInfo`（`context-binding.ts`）：给定底座 `Model`，产出 `ModelInfo.kernel === "pi"`；`provider/id/name` 透传不变；`input?` 透传。
- model-catalog 的合流纯函数：给定 pi reader 结果 + dsh reader 结果，合并出的 `ModelInfo[]` 每条的 `kernel` 与来源一致；同名 `provider/id` 两条不互相去重、各带各的 `kernel`。
- `groupByKernel`（composer）：给定混合 kernel 的 `ModelInfo[]`，分组结果按 kernel 分两组、组内按 provider 分组；空清单不炸。
- `DshLogo` / `PiLogo`：渲染不抛错、`aria-label` 正确、`currentColor` 生效（快照测）。
- `seed` 的 pi 补面：给定 `NeutralMessage[]`，写出的 JSONL 文件头行 + 条目可被 `getEntries` 读回、语义等价（round-trip）。

### 9.2 集成（跨层链路）

- 模型清单链路：`ctx.kernels.listModels()` 在「只有 pi 配了模型」时返回 pi 的 `ModelInfo[]`（kernel=pi）；「pi + dsh 都配了」时返回两路合并；「dsh 未装」时返回 pi 一路 + dsh 空态信号，不报错、不吞 pi。
- 设置页展示分组：PI 入口三个 TAB 切一遍，每个 TAB 的 config 读写落在各自 configFile（settings.json / models.json / 拓展状态），互不串写；切 TAB 时当前 TAB 有 dirty → 弹拦截，取消后 dirty 保留、确定后写回。
- 会话流三处显标：选 pi 模型 → 三处（空态 logo / 下拉选中项 / 消息头）都 ⬡；选 dsh 模型 → 三处都 🐋。改模型即三处同步，无中间态。
- 跨内核切换：pi 会话切到 dsh，`getEntries` 的历史在新 dsh 会话里可见，后续 `sendMessage` 走 dsh；再切回 pi 同理。会话头里 kernel + session-id 两次切换后正确。

### 9.3 回归（pi 行为不变）

- pi-only 环境（不装 dsh）跑现状全部既有测试：模型下拉、默认模型解析、composer 切模型/思考深度、设置页三入口（合并后三 TAB）的 save/dirty/拦截——全部行为与合并前一致。这条是「展示分组只动展示」的直接验证。

### 9.4 参数化后端跑法

- 与 `multi-kernel-shell.md` §6.5 呼应：把「会话流三处显标」「跨内核切换」两组集成测试参数化——同一套断言，先 `createPiBackend` 跑、再 `createDshBackend` 跑。差异只在适配器，壳插件代码零改动。若某条用例在 dsh 上红，先分清是「dsh 缺面」（§6.3 已列）还是「壳漏了内核身份」（§12 反模式），后者才是本文要修的。

### 9.5 测试夹具

- pi 侧：临时目录写一份最小 `models.json`（一个 provider、两个 model）+ 一份 `settings.json`（含 `defaultProvider/defaultModel`）。
- dsh 侧：临时目录写一份最小 `cordis.yml`（含 `llm-deepseek` + 一个 model）+ 伪造 `DEEPSEEK_API_KEY`。dsh 集成测试若无法起真进程（无网络/无 key），用 mock transport（`JsonRpcTransport` 的假实现）验证 seed/resume 的调用参数，不依赖真模型。
- 鲸鱼标：快照测固定 `DshLogo` 的 `d` path 字符串，防误改。

## 10. 安全与权限

- 本节处理「内核身份进 UI」带进来的凭证与越界面。纪律与 CLAUDE.md §4.6 一致：安全动作是会变的策略，推到外层；圆心只留中性契约。

### 10.1 apiKey 与 baseUrl

- dsh 的 `apiKeyEnv` 是凭证引用（环境变量名，官方 credentialRef），dsh 模型配置 TAB 要能写它对应的密钥字面值。凭证不进圆心契约的明文往返：圆心/application 只声明「需要读/写 dsh 的 llm 配置」这个接口（§3.7 的 `DshProviderProfile`），apiKey 的脱敏、加密、不回显，在协议翻译层 / IPC 边界处理。renderer 侧拿到的 apiKey 是「可写、不回显明文」（或只显示「已设置」态），与现状 pi 的 apiKey 处理（`FieldInput` 的 secret 显隐，pi-model-manager）对齐。

- 凭证的落盘位置是 dsh 原生（环境变量 / cordis.yml 的 `apiKeyEnv` 指向 env 名，不是明文 key）。壳写凭证时写 env 侧，不把明文 key 写进 cordis.yml（`apiKeyEnv: DEEPSEEK_API_KEY` 是「key 名」不是「key 值」，符合 CLAUDE.md「token key 合规、token 值违规」的口径）。

### 10.2 路径圈禁

- 模型清单合流要读 pi 的 `~/.pi/agent/models.json` 和 dsh 的 cordis.yml / `~/.dsh/settings.yaml`。这三条读路径是「内核原生配置」，但要防越界：dsh reader 读 cordis.yml 时，路径限定在 dsh 的 harness home（`$DSH_HOME` / `~/.dsh`）或显式声明的 cordis.yml 路径，不开放「任意路径读 cordis.yml」的口子。写回同理，`dsh:models.set` 只写 dsh 原生配置路径，越界抛错——与现有 config-file 路径白名单（`~/.my-harness-desktop/`、`~/.pi/agent/`）同款纪律，dsh 配置是第三类白名单前缀。

### 10.3 权限声明

- `ctx.kernels.listModels()` 是系统级 API（读模型清单，无副作用），所有插件可用，不需权限声明——与 `ctx.models`、`ctx.sessions` 同级。`dsh:models.set`（写 dsh 原生配置）涉及凭证，走声明能力（`permissions` 声明）或收窄为「只在 DSH 模型配置 TAB 内可用」的框架通道，与 pi 的 `models.json` 写面同权。不新增「任意插件都能写任意内核配置」的通用口。

## 11. 性能与资源

### 11.1 模型清单的读与刷新

- 模型清单是「读多写少」：打开会话页读一次，配置变化时刷新。合流后两路 reader 的读是「一次 `listModels()` 触发两个文件读」（pi models.json + dsh cordis.yml），冷启动多一个文件读，可忽略。刷新走事件驱动（`system:configFileSaved` 按 path 匹配 models.json / cordis.yml），不轮询、不 sleep（CLAUDE.md §3.6）。禁止「打开会话页先 sleep 等 dsh 就绪再读模型」——dsh 没起也能读 cordis.yml（它只是配置文件，不依赖 dsh 进程），没有就绪时序问题。

### 11.2 子进程数

- 「一个内核 = 一个子进程」不变（`multi-kernel-shell.md` §2.6）。模型清单合流**不额外 spawn 进程**——读 pi models.json 和 dsh cordis.yml 都是文件读，不起 pi/dsh 进程。跨内核切换（§3.6）是「stop 旧 + spawn 新」，任一时刻仍是单进程，不叠加。谁要为了「读 dsh 模型」就 spawn 一个 dsh，是性能反模式（§12）。

### 11.3 跨内核切换的代价

- 切换 = abort（若有流式）+ stop 旧进程 + spawn 新进程 + seed。代价主要是「spawn + 就绪」的冷启动（与开新会话同量级），外加「seed 一段历史」的写入。对长会话（历史很长），seed 的写入量随历史线性增长——这是「会话可切换」的固有成本，不是可优化点。优化方向留给将来（如增量 seed / 快照复用），本期不做，但要在验收里记「长会话切换不超时」（§7 已含）。

## 12. 反模式与陷阱

- 本节是「别怎么做」的清单。每条都是本文落地时最可能踩的坑，提前钉死，避免返工。判据统一：**壳代码里出现「if 内核 === pi」的分支，就是一处泄漏**（`multi-kernel-shell.md` §5.7）。

### 12.1 内核身份双 state

- 反模式：renderer 里另起一个 `currentKernel` state，和 `currentModel.kernel` 并存，两处各自更新。后果：改模型时忘了同步 `currentKernel`，三处显标（§3.5）里有一处还停在旧内核。正解：内核身份只认 `currentModel.kernel` 一个来源，三处显标各自订阅它，不持有第二份 state（§3.5 末段）。

### 12.2 硬编码 pi logo

- 反模式：把空态 logo 从 `PiLogo` 换成「`if (kernel === "pi") PiLogo else DshLogo`」写死在 timeline，但忘了它是 `PluginIcon` 的同一份。后果：以后加第三个内核，timeline 里的 logo 分支漏改，空态还显示 pi。正解：空态 logo 用 `PluginIcon name={kernel}`（`"pi"`/`"dsh"`），内核标与 `PluginIcon` 的映射单源（§3.4），加内核只加一处 `PluginIcon` 分支。

### 12.3 config 语义混进展示分组

- 反模式：做「一个入口三 TAB」时，为了让框架注入 config，把三个子项压成一个组件、框架只注入一份 `config`。后果：三份 dirty/save 串成一坨，保存 settings.json 时把 models.json 也写了，或反之。正解：展示分组只动渲染，config 注入/dirty/save 按子 item 原样复用（§3.1）——「只合并展示，不合并 config」这句话是本节的第一道防线。

### 12.4 静默串内核

- 反模式：dsh reader 读不到 cordis.yml 时返回空，模型下拉就只显示 pi，用户以为「没有 dsh 模型」。后果：dsh 没配置被静默吞掉，用户永远不知道为什么选不到 DeepSeek。正解：dsh 未配置是「显式态」不是「空态」——DSH 模型配置 TAB 给「去配 cordis.yml」的入口（§6.2）。

### 12.5 用 provider 名猜内核

- 反模式：`if (provider.includes("deepseek")) kernel = "dsh"`。后果：pi 里也能配一个叫 `deepseek-official` 的 provider（用户随便起名），猜错就静默串内核。正解：内核由来源判别（§2.1），`kernel` 是扫描器在「读哪路」时赋的值，不由 provider 名反推。

### 12.6 为了读 dsh 模型 spawn 一个 dsh

- 反模式：`listModels()` 里为了拿 dsh 的模型，spawn 一个 dsh 进程去问。后果：打开会话页就起一个常驻进程，慢且浪费；而且「读模型」和「跑会话」的职责混了。正解：dsh 模型从 cordis.yml 文件读（它是配置，不依赖 dsh 进程），spawn 只在「要跑会话」时发生（§11.2）。

## 13. 与既有机制的交互

- 本文的改动不是孤岛，要贴着 my-harness-desktop 既有的几条机制走。本节列清「哪些复用、哪些要协调、哪些刻意不碰」。

### 13.1 config-file 分层

- pi 的 `~/.pi/agent/` 前缀是「底座文件，不分层」（settings-page.tsx 的 `isBaseFile`）。dsh 的 cordis.yml / `~/.dsh/settings.yaml` 同理——它们是内核原生配置，**不分层**（不做 `<cwd>/.my-harness-desktop/` 项目级覆盖）。分层机制是壳的 config 通道（`~/.my-harness-desktop/`）的语义，内核原生配置不在其列。这条要在 settings-page 里显式处理：DSH 入口的子项 `configFile` 落在 `~/.dsh/` / cordis.yml，走「底座文件不分层」的分支，不显示「设为全局 / 移除项目覆盖」按钮。

### 13.2 save/dirty/拦截

- 展示分组后，「未保存拦截」「确定/取消改动」这套浮层的粒度从「入口」下推到「TAB」（§3.1）。要协调的点：浮层读 `activeItem` 的 config/dirty，现在 `activeItem` 是「当前 TAB 的子 item」，不是「入口 item」。框架里 `activeId` 的语义要从「settings item id」变成「settings item id + 子 TAB 索引」的复合键，浮层逻辑本身不改。这是一处隐蔽的改动点，最容易漏——漏了就是「切 TAB 不拦截 dirty」。

### 13.3 事件总线

- 模型清单刷新靠 `system:configFileSaved`（按 path 匹配）驱动（§3.3）。跨内核切换后，要广播一个「内核已切」的系统事件（`system:kernelChanged` 或复用既有 `system:sessionChanged`），让三处显标（§3.5）和依赖内核身份的订阅方同步。事件的 payload 只带「会话 id + 新内核」这类中性信息，不带内核专属形状。事件是「机制」，广播内核身份切换是机制该做的，不是插件各自轮询。

### 13.4 会话头

- 跨内核切换的「会话 id 重绑」记会话头（§3.6 第 5 步）。会话头机制（`session-header-custom.md`）是既有租户，本文是它的第三个租户（前两个：模型/思考深度、其他 desktop 私有域）。头里新增「kernel + session-id」域，写读走域级浅合并，不动头机制本身。

### 13.5 刷新信号

- `refreshSignal` 是框架的刷新机制（settings-page 的刷新按钮 +1）。模型清单合流后，`refreshSignal` 触发的重读要同时重读两路（pi + dsh），不只重读 pi。这是一个「换源」时容易漏的半边——只改 reader 不改 refresh 触发，会导致「点刷新后 dsh 模型还是不更新」。

## 14. i18n 与文案清单

- 新增 UI 文案全部走 i18n key（铁律一：key 合规、值由语言插件贡献），不硬编码中文。本节列新增 key，值在语言插件（system/i18n 或各插件 locales）落地。

| key（示意） | 含义 | 出现处 |
|---|---|---|
| `settings.dsh` | DSH 入口标题 | 设置页侧栏 |
| `settings.pi` | PI 入口标题（沿用现状 `pi`） | 设置页侧栏 |
| `settings.dshKernel` | DSH TAB1「DSH（内核 + 配置）」 | TAB 条 |
| `settings.dshExtensions` | DSH TAB2「DSH 拓展」 | TAB 条 |
| `settings.dshModels` | DSH TAB3「DSH 模型配置」 | TAB 条 |
| `dsh.models.unconfigured` | 「dsh 未配置模型，去配 cordis.yml」 | DSH 模型配置 TAB 空态 |
| `dsh.models.title` | DSH 模型配置标题 | DSH 模型配置 TAB |
| `kernel.badge.dsh` / `kernel.badge.pi` | 内核标的 aria-label / tooltip | 消息头 / 下拉 |
| `kernel.switch` | 「切到 dsh / 切到 pi」动作 | 跨内核切换入口 |
| `kernel.switch.linearOnly` | 「有分支的会话暂不支持切换」降级提示 | §3.6 fork 边界 |
| `kernel.switch.seeding` | 切换中的进度文案 | §3.6 第 5 步 |

- 命名约定：内核相关 key 统一 `kernel.` 前缀（跨内核共用的机制文案）、`dsh.` 前缀（dsh 专属内容文案）、`settings.*`（设置页框架层文案，与现状一致）。文案不写死「Pi」/「DeepSeek」的品牌词进 key，品牌词是值、由语言插件给。

## 15. 跨内核切换的状态机与失败恢复

- §3.6 给了五步，本节把它落成一个明确的状态机 + 失败恢复。切换不是「点了就成功」的原子操作，是五步的序列，任何一步失败都要能停在一个可解释、可恢复的状态，不留「半切」的僵尸会话。

### 15.1 状态

- `idle` → `aborting`（有流式）→ `snapshotting` → `stopping` → `spawning` → `seeding` → `idle`（完成，新内核）。每一步进入前记录「切到哪一步了」，失败时据此回滚或重试。

### 15.2 各步的失败语义

- `aborting` 失败（内核卡死）：走 stop 的 kill 链强制收，transcript 里当前消息标「已停止」，继续后续步（不因 abort 卡死就放弃切换，但要在 UI 提示「切换前强制停止了上一轮」）。
- `snapshotting` 失败（`getEntries` 报错）：内核会话读不出来，切换中止，留在旧内核，报「无法读取会话历史」。
- `stopping` 失败：理论上 kill 链最终必终止（关 stdin → SIGTERM → SIGKILL），若仍不终止，切换中止、报「旧内核进程无法停止」。
- `spawning` 失败（新内核起不来）：切换中止，留在旧内核（旧内核已 stop，需重新 spawn 旧内核恢复，或报「切换失败，会话待恢复」）。
- `seeding` 失败（新内核拒绝 seed）：切换中止，新内核进程关掉，尝试重 spawn 旧内核恢复；报「新内核无法接续历史」。

### 15.3 并发与幂等

- 切换期间（非 `idle`）禁止再触发切换——「切到一半又切」会叠两个 stop/spawn 序列，session-id 重绑两次，头里写的是谁说不清。UI 在非 `idle` 态把切换入口置灰（与「流式中停按钮置灰」同款）。
- 幂等：`seed(history)` 应可重入（同 history 重跑得到新的独立 session-id，不破坏已有会话）——这是补面实现时的纪律，避免「重试 seed 却复用旧 session-id」的竞态。

### 15.4 恢复的目标状态

- 任何一步失败，目标状态是「要么留在旧内核可继续聊，要么干净地停在新内核的空态，绝不落在『两边都有半截会话、头里指向一个不存在的 session-id』」。这个目标状态的判据：会话头里的 session-id 必须指向一个真实存在的内核会话；不满足就回滚到「旧内核 + 旧 session-id」（或显式「待恢复」态，绝不静默）。

## 16. 实现要点速写

- 本节给「怎么开工」的最小代码速写。不是完整实现，是钉死形状与结构的示意——读者据此知道「第一步该写哪个文件、长什么样」。真实实现照 §3 的完整设计展开，本节只做「形状锚」。

### 16.1 设置页展示分组的 manifest 与渲染

- manifest 形状（候选 B 最小变体，§3.1）：

  ```jsonc
  // src/plugins/manager/pi-manager/plugin.json（合并后，示意）
  {
    "id": "pi-manager",
    "contributes": {
      "settings": [
        {
          "id": "pi", "title": "Pi", "icon": "pi", "order": 0,
          // 入口本身不挂 configFile；config 全在 tabs 里
          "tabs": [
            { "id": "pi-kernel", "title": "settings.piKernel", "component": "PiManagerPage",
              "configFile": "~/.pi/agent/settings.json", "configMerge": "deep" },
            { "id": "pi-ext", "title": "settings.piExtensions", "component": "ExtensionManagerPage",
              "saveMode": "manual" },
            { "id": "pi-models", "title": "settings.piModels", "component": "ModelManagerPage",
              "configFile": "~/.pi/agent/models.json", "configMerge": "replace" }
          ]
        }
      ]
    }
  }
  ```

  - 关键：入口项不挂 `configFile`（它是纯壳），三个 `configFile`/`saveMode` 全在 `tabs` 里，各自独立。DSH 入口同构，`tabs` 里是 DSH 三子项。

- 渲染（settings-page.tsx 改动示意）：

  ```tsx
  // 侧栏：有 tabs 的 item 渲染成一个入口；无 tabs 的照旧渲染成一个平铺项
  // 右栏：激活入口时，渲染 TAB 条 + 当前 TAB 的 SettingsPane
  const entry = items.find(i => i.id === activeEntryId);
  const activeTab = entry?.tabs?.[activeTabIndex];
  // activeTab 就是一个普通 settings item，交给现有 SettingsPane 渲染
  <SettingsPane item={activeTab} active config={configs.get(activeTab.id)} dirty={dirties.get(activeTab.id)} ... />
  ```

  - 核心洞察：`activeTab` 复用现有 `SettingsPane`（config 注入、懒挂载、display:none 保活全复用），框架只多画一层「TAB 条 + 当前 TAB 索引」。`activeId` 的语义从「item id」变成「入口 id + tab index」复合键，浮层读 `activeTab` 的 config/dirty。

### 16.2 model-catalog 文件结构

  ```
  core/application/models/model-catalog.ts    # 合流 + 打标，产出 ModelInfo[]
  core/application/models/pi-model-reader.ts   # 读 pi models.json → ModelInfo[]（kernel="pi"）
  core/application/models/dsh-model-reader.ts  # 依赖 DshModelSource 接口，不碰 settings.yaml/cordis.yml
  client/dsh/dsh-model-source.ts               # DshModelSource 实现：读 settings.yaml llm-deepseek + llm-pi-ai
  ```

  ```ts
  // core/application —— 依赖倒置：application 只依赖接口，实现落 client/dsh
  interface DshModelSource {
    listModels(): Promise<DshModelSpec[]>;       // 读 settings.yaml provider 路由的 models
    getProviders(): Promise<DshProviderProfile[]>;
    setProvider(provider: string, detail: DshProviderProfile): Promise<void>;
  }
  ```

- 合流纯函数（可裸单测）：

  ```ts
  function mergeCatalogs(pi: ModelInfo[], dsh: ModelInfo[]): ModelInfo[] {
    return [...pi.map(m => ({ ...m, kernel: "pi" as const })),
            ...dsh.map(m => ({ ...m, kernel: "dsh" as const }))];
  }
  ```

### 16.3 seed 的补面协议

- pi 补面（`client/pi`）：

  ```
  seed(history: NeutralMessage[]): Promise<string>
    = 写一个新 JSONL 文件（头行 {type:"session", ...} + 每条 NeutralMessage 序列化条目）
    → 返回文件路径（= 内核侧 session-id，走 pi 的「会话标识 = 文件路径」现状）
  ```

- dsh 补面（`client/dsh`）：

  ```
  seed(history: NeutralMessage[]): Promise<string>
    = transport.request("session/seed", { history })
    → 返回 { sessionId }
  ```

- 两侧签名对齐 `BaseBackend.seed(history) → string`（§3.7），壳只见中性历史进、不透明 id 出，不关心 pi 是写文件、dsh 是发 JSON-RPC。

## 17. 迁移与演进

### 17.1 pi-only → 多内核的迁移故事

- 现状是 pi-only：`bootstrap/index.ts:110` 写死 `createPiBackend`，设置页三个 pi 入口，模型清单只扫 pi。迁移分四段，每段用户可见的增量不同：

  1. **阶段一（圆心类型 + 图标）**：用户无感——只是圆心多了 `kernel` 字段、图标库多了鲸鱼。这是「先立地基、不惊动任何人」。
  2. **阶段二（设置页合并 + DSH 入口）**：用户第一次看见「PI」和「DSH」并列——虽然 DSH 的三个 TAB 可能还没接满，但「两个同级内核」的骨架立起来了。pi 用户行为不变（三个入口变成三个 TAB，位置变了、内容没变）。
  3. **阶段三（模型合流 + 会话流显标）**：用户第一次在模型下拉里看见 🐋 组，选了之后空态/消息头变鲸鱼。这是「内核身份进 UI」的完成——此刻还是「每个会话一个内核」，但用户已经能「看见」内核。
  4. **阶段四（跨内核切换）**：用户第一次能在同一条会话里 pi ↔ dsh 来回切。这是「多内核壳」的最终形态——会话是壳的，内核是运行时。

- 迁移的「回滚」每段独立：阶段一/三纯增量、回滚零成本；阶段二回滚 = 拆回三个入口；阶段四回滚 = 停用切换入口，已切会话按头续接不丢。全程不搬数据——`multi-kernel-shell.md` §6.6 的「迁移从不搬数据，只搬归属」在本文 UI 层同样成立。

### 17.2 演进路线图（本期之后）

- 本期（§5 四阶段）是「多内核 UI」的第一刀，明确定义「不做」的东西，留给将来：

  - **第三个内核**：`kernel` 是 `"pi" | "dsh"` 字面量联合。加第三个内核 = 联合加一个字面量 + `PluginIcon` 加一个分支 + 一个 reader + 一个 spawn + 一个适配器。编译器会逼着补全所有 `switch (kernel)` 分支——这是 §3.2 选字面量联合而非 `string` 的直接红利。
  - **fork 树的跨内核切换**：本期只支持线性 lineage（§3.6）。fork 树在两个内核里形状不同，要「树的重建」——将来若做，是 `seed` 的升级（seed 一段带 fork 结构的 lineage 森林），不是本期。
  - **增量 seed**：长会话切换的 seed 写入量随历史线性增长（§11.3）。将来可做「快照复用 + 增量」优化，本期不做。
  - **默认内核的显式配置**：§2.5 定了「默认内核 = 默认模型的内核，不单设配置」。若将来用户想要「显式设一个默认内核」而不借道默认模型，再考虑——但按 §2.5 的理由，那会制造矛盾，大概率不做。

## 18. 与 dsh 原生侧的对接契约

- 本节列 dsh 侧（`DshBackend` → JSON-RPC 传输 → dsh 子进程）的方法映射，供「跨内核切换 / 模型配置」落地时对照。现状 `DshBackend`（`src/core/application/sessions/dsh-backend.ts`）已接线五操作 + 树/条目/书签/续接，`seed` 是新增。

| `BaseBackend` 方法 | dsh JSON-RPC method | 现状 |
|---|---|---|
| `start()`（initialize） | `initialize`（cwd/provider/model/maxTokens） | 已接 |
| `sendMessage(text, images?)` | `session/prompt`（contentBlocks） | 已接（images 缺面降级） |
| `abort()` | `session/abort` | 已接 |
| `setModel(provider, modelId)` | `session/setModel` | 已接 |
| `fork(parent, boundary?)` | `session/fork`（parentSessionId/boundarySeq） | 已接 |
| `getTree(sessionId)` | `session/getTree` | 已接 |
| `getEntries(lineageId)` | `session/getEntries` | 已接 |
| `bookmark(lineageId, boundary)` | `session/bookmark` | 已接 |
| `resume(anchor)` | `session/resume` | 已接 |
| `deleteBookmark(anchor)` | —（未接线） | 缺面 |
| `seed(history)` | `session/seed`（新增） | 待补面 |

- dsh 侧的「seed」是本文要往 dsh 原生侧提的一个新方法。它的语义：给定一段 `NeutralMessage[]`，dsh 开一个「已含这段历史」的新会话，返回 sessionId。dsh 的 append-only 会话模型天然适合「灌一段历史再继续」——历史就是前缀事件流，seed = 把前缀事件流一次性写进新会话。这是 dsh 相对 pi 的一个顺风：pi 的 seed 要「写文件头 + 逐条序列化」，dsh 的 seed 更接近「前缀拷贝」（和它的 fork 前缀拷贝同源）。

- dsh 原生侧还有一处「能力缝」要在本文消费：`sdk-jsonrpc-server` 是 dsh 的 JSON-RPC 服务端（`examples/jsonrpc-agent/cordis.yml` 第一个插件），它定义了 `session/*` 方法集。`seed` 要加到这个方法集里——这是 dsh 侧（deepseek-harness）的改动，不是 my-harness-desktop 的改动。本文只定义「壳需要 `seed(history) → sessionId`」这个契约，实现归 dsh 侧；dsh 侧没给之前，`DshBackend.seed` 显式「不支持」，跨内核切换在 dsh 侧降级（§6.3 的缺面纪律）。

## 19. 术语补遗

- 正文术语表（§0）收了高频词，这里补正文里零散出现、未及解释的：

  - **JSON-RPC 传输**：`client/dsh/json-rpc.ts` 的行传输，消费 SubprocessHandle 收发 newline-delimited JSON-RPC。dsh 侧协议与 pi 的 31 命令闭联合不同，是标准 JSON-RPC 2.0（request 带 id、notification 无 id、response 回配对）。
  - **cordis.yml**：dsh 的插件组成配置，`name:` 字段是 npm 包名（`@deepseek-ai/dsh-*`），`config:` 是插件配置。dsh 的「拓展」和「模型」都在这里。
  - **harness home / `$DSH_HOME`**：dsh 的宿主目录（默认 `~/.dsh`），settings 文档 `settings.yaml` 默认落这里。
  - **llm-deepseek**：dsh 的 DeepSeek 模型适配插件（`@deepseek-ai/dsh-llm-deepseek`），注册一个固定 route `deepseek-official`，`models` 列表 + `apiKeyEnv`/`baseURL` 是它的 config。
  - **llm-pi-ai**：dsh 的通用 pi-ai 适配插件（`@deepseek-ai/dsh-llm-pi-ai`），`providers` 多路由 dict（key = route，每 route 有 `apiKeyEnv`/`displayName`/`api`/`baseURL`/`models`）。「DSH 模型配置」TAB 编辑的对象 = `llm-deepseek` 单 route + `llm-pi-ai` 多路由。
  - **`sdk-jsonrpc-server`**：dsh 的 JSON-RPC 服务端插件，定义 `session/*` 方法集，`seed` 要加在这里。
  - **能力缝（capability seam）**：dsh 的能力组织方式，一个能力 = 定义/提供/消费三角色（`multi-kernel-shell.md` §0）。`sdk-jsonrpc-server` 是「提供」，壳经 JSON-RPC 是「消费」。

## 附：关键代码位置索引

| 概念 | 位置 |
|---|---|
| 三个设置插件 | `src/plugins/manager/{pi-manager,extension-manager,pi-model-manager}/` |
| `ModelInfo` 定义 | `src/core/domain/events/session-state.ts` |
| 模型扫描（现状只 pi） | `src/plugins/sessions/timeline/renderer/index.tsx` `toModelInfos` |
| 模型下拉 | `src/plugins/sessions/timeline/renderer/composer.tsx` |
| 空态 PiLogo | `src/plugins/sessions/timeline/renderer/index.tsx:882` |
| `PluginIcon` / `PiLogo` | `packages/react/src/widgets/plugin-icon.tsx` |
| 后端工厂（写死 pi） | `src/bootstrap/index.ts:110`、`src/core/application/sessions/backend-factories.ts` |
| dsh 后端 | `src/core/application/sessions/dsh-backend.ts` |
| dsh 内核（npm 包） | `@deepseek-ai/dsh`（bin `dsh`，当前 `0.1.0-rc.5`） |
| dsh settings 文档 | `~/.dsh/settings.yaml`（`@deepseek-ai/dsh-settings-file`） |
| dsh 插件组成 / 模型配置 | deepseek-harness `cordis.yml`（插件 `name:` = `@deepseek-ai/dsh-*`，作 base 兜底）+ `settings.yaml`（`llm-deepseek` 单 route / `llm-pi-ai.providers` 多路由） |
| 鲸鱼 SVG 来源 | simple-icons `deepseek.svg`（`viewBox 0 0 24 24`） |

## 20. 常见问题（FAQ）

- 收本文落地时最可能被问的问题，答案照前面的设计，不另起新逻辑。读者对某处有疑问，先来这找，找不到再看对应章节。

**Q：为什么不直接把 dsh 的模型搬进 pi 的 models.json，省得合流？**
- 那是「翻译层让 dsh 装 pi」（`multi-kernel-shell.md` §1.4 明令禁止）。dsh 的模型在 dsh 原生配置里（`settings.yaml` 的 `llm-deepseek` 单 route + `llm-pi-ai.providers` 多路由，cordis.yml 兜底），形状是「provider 路由 dict（每 route 有 `apiKeyEnv`/`displayName`/`api`/`baseURL`/`models`）」，pi 的是「单文件 `providers` 顶级 dict（`provider` 字段内嵌）」。两边的 provider 概念同构、形状不同，搬进 models.json = 逼 dsh 学 pi 的形状，丢 dsh 的 Cordis 插件树价值。合流（各自原生、壳合成一张表）才是「消费而非翻译」。

**Q：seed 和已有的 resume 有什么区别？**
- `resume(anchor)` 是「从某个已存在的锚点继续」，锚点是内核侧自己造的东西（pi 的文件拷贝、dsh 的子会话）。`seed(history)` 是「从一段任意中性历史起步」，历史是壳给的、内核侧没有对应锚点。跨内核切换需要的是后者——把 pi 会话的历史灌给 dsh，dsh 侧根本没有对应的「锚点」可 resume，只能 seed。两者都进 `BaseBackend`（§3.7），但语义不同：resume 续「内核自己的会话」，seed 造「一段新历史」再续。

**Q：展示分组会不会把 settings 框架搞复杂？**
- 不会，恰恰相反。展示分组是「纯展示层」——`activeTab` 复用现有 `SettingsPane`（config 注入 / 懒挂载 / 保活全复用），框架只多画一层 TAB 条（§16.1）。config/dirty/save/拦截的机制一行不改。复杂的是「把 config 语义混进展示」的做法，本文明确否掉了（§3.1、§12.3）。

**Q：跨内核切换后，之前的工具调用结果还在吗？**
- 工具块在 transcript 里保留（用户能看到完整上下文），但不跨内核重跑（§3.6 工具边界）。新内核把它们当「只读历史」显示。后续若需要用到之前的工具产物，由用户/内核在消息里补，壳不替它重跑——因为 pi 的 bash 结果 dsh 无法重新执行，反之亦然。

**Q：为什么不加「默认内核」配置项？**
- 因为内核由模型派生（§2.2），「默认内核」和「默认模型」是同一个东西，另设一个独立的「默认内核」配置会制造「默认内核 = pi 但默认模型是 deepseek」的自相矛盾（§2.5）。默认内核 = 默认模型的内核，没有默认模型时两个内核都展示，不硬挑一个。

**Q：现在 bootstrap 写死 `createPiBackend`，dsh 会话怎么开？**
- 这是「还没接 dsh」的现状（§1.4）。阶段三/四会把「选内核」接到模型选择上——选鲸鱼模型 = 该会话用 dsh 后端（`createDshBackend`）。bootstrap 的 `baseBackendFactory.create` 从「写死 pi」改成「按会话头/所选模型的内核路由到 createPiBackend 或 createDshBackend」。路由只认一个「内核」标记，不出现 `if (kernel === "pi")` 之外的泄漏（§5.7 纪律）。

**Q：模型下拉里 pi 和 dsh 同名模型怎么办？**
- 各带各的标、不跨内核去重（§3.3、§6.1）。`kernel + provider + id` 是全局唯一键，同名两条靠内核标区分。选哪条，会话就归哪个内核——这是「从模型反推内核」的必然：同名模型名可以一样，内核标不一样，选哪条就定了内核。

## 参考

- `multi-kernel-shell.md`：内核 / 中立契约 / 适配器 / 壳的抽象，本文的父篇。
- `base-interface-lineage.md`：`BaseBackend` 与 lineage 坐标系，§3.6 的 `seed` 接在这条线上。
- `session-model-config.md`：pi 的会话级模型/思考深度配置，本文模型清单的 pi 侧来源。
- `session-header-custom.md`：会话头机制，§3.6 的会话 id 重绑记在这里。
- 仓库根 `settings-merge-prototype.html`：本文 UI 决策的视觉基线。
