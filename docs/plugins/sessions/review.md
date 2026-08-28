# review：会话内联评论插件技术文档

## 1 定位：选区锚定的异步反馈，收集与投递分离

- review 是 my-harness-desktop 的**内置壳插件**，物理目录 `src/plugins/sessions/review/`，`plugin.json` 里 `id: "review"`、`version: "0.4.9"`、`tier: "official"`。它只 import `@my-harness-desktop/react` 和 `@my-harness-desktop/shared` 两个发布面，是洋葱最外层的内容插件，与 timeline、message-blocks 同层不同域。
- 它解决的问题一句话说清（`plugin.json` 的 `description`）：**选中会话流里的文字片段，附上意见，随下一条消息一次性发给模型**。展开是 `docs/design/review-plugin.md` §1 的三条弯路——复制原文手动拼（六步打断节奏）、口头指代（"上面那段"对模型是高歧义指令）、直接放弃（反馈粒度停在"大方向"级）。三条弯路断在同一个点上：**引用与评论的绑定靠人肉维护**。review 的答案是把这个绑定机器化——选区即锚、快照即上下文、下一条消息即投递时刻。
- 这个抽象不是"给长回复挑错"的专用件，而是**选区锚定的反馈收集，收集与投递分离**的三要素：锚定在快照上（不是行号/序号，会话滚几十屏快照不漂移）、收集零打断（一个动作登记、马上接着读）、投递合并成一条（多条意见拼成一块随正文发出，模型在同一条消息里拿到正文与批注的对应关系）。
- 边界必须和四个近邻划死（`review-plugin.md` §1.3）：**blind-review** 评审对象是会话外的文件、评委是多个 agent；**git-review** 对象是 git 工作区 diff；**session-bookmarks** 只存锚点给自己回头找、不产出反馈；**rewind** 改的是"我当时说了什么"并重打一轮。review 专管"人给模型看的批注"——不评会话外产物、不替人做评审。
- 功能范围以低保真原型（多轮迭代定稿）为需求基准：评论的长期留存、跨会话检索、对工具卡片整体的评论按钮都不在范围。下面每一节都是在"这个基准之内，机制怎么做"的展开。

## 2 插件清单：`plugin.json` 逐字段

- 顶层字段七个：`id`（review）、`version`（0.4.9）、`tier`（official，对应圆心 `PluginTier`）、`displayName`/`description`（中文文案，管理页展示）、`tags: ["conversation"]`、`renderer: "./renderer/index.tsx"`、`dependsOn: ["timeline"]`。
- `dependsOn: ["timeline"]` 是**生命周期护栏，不控制加载顺序**（CLAUDE.md §8.2）。它表达的是"review 消费 timeline 拥有的 channel，所以 timeline 必须在线"。它拦的是停用/卸载：用户想停用 timeline，框架会因 review 依赖它而挡住；反方向不成立——timeline 不声明依赖 review，因为 review 是可选项，删掉 review 时 timeline 照常跑（无特权差异铁律二）。注意它**不拦加载期失败**：timeline 加载失败时 review 的 invoke 会抛"channel 未注册"，review 侧 try/catch 静默降级（§7 详述）。
- `contributes` 下四个槽位，是 review 全部声明式贡献：

```jsonc
"languages": [ /* 8 条:review.shell + review.settings × zh-CN/en/zh-TW/de */ ],
"settingsGroups": [
  { "id": "reviewBasket", "titleKey": "settings.groupReview", "order": 30,
    "fields": [ { "key": "reviewBasketVisibleCount", "type": "int", "default": 5,
      "titleKey": "settings.reviewBasketVisibleCount",
      "descKey": "settings.reviewBasketVisibleCountDesc", "options": [3, 5, 8, 10] } ] }
],
"composerAttachments": [ { "id": "review-basket", "component": "ReviewBasketBar" } ],
"blockRenderers": [ { "id": "review-aux", "block": "auxBlock", "names": ["review"], "component": "ReviewAuxBlock", "order": 100 } ]
```

- **明确不贡献 messageActions**。这是 review 与 message-blocks 的关键分野，也是读它 manifest 时最容易先入为主的误判：messageActions 槽（圆心 `MessageActionContribution`，`contributions.ts` 第 170–181 行）是"消息行上的动作按钮"（重试/复制/收藏），挂的是**消息级**入口；review 的入口是**选区级**（划词浮条），语义不匹配。`review-plugin.md` §4.1 把这一点写成了设计结论：原型迭代否掉的两种槽内形态（右上角动作条按钮、消息左缘 gutter 按钮）本质都是消息级入口，与"选区级唤起"不匹配，所以 review 对 messageActions、titlebar、sidePanel 等槽位**零贡献**。
- **唤起侧零槽位**：划词浮条不属于任何槽位表面，它是 Selection API 几何位置的附属物。它走的是另一条挂载路径——`renderer/index.tsx` 命名导出 `Overlay` 组件，由框架的 Overlay 机制挂载（§4 详述），manifest 里没有任何一项声明它。
- `settingsGroups` 这条贡献项值得单独说：它是**纯声明式**的，`id: "reviewBasket"` 挂到"通用"设置页，通用渲染器按 `fields` 声明渲成一个数字档位下拉框，review 插件零渲染代码。字段值落通用页 `general.json`，save/dirty/分层/广播走既有框架管线（`SettingsGroupContribution` 契约，`contributions.ts` 第 45–54 行）。**但注意一个已知缺口**：这条声明渲染出的 `reviewBasketVisibleCount` 字段当前**没有被 renderer 消费**——`basket-bar.tsx` 第 18 行硬编码 `basketVisibleCount = 5`，注释写明"reviewBasketVisibleCount 配置迁移前先定值（配置归位 review 自读，演进）"。这是"配置已归位声明、读取尚未归位"的演进态（§9 汇总）。

## 3 数据模型与圆心契约

review 的数据分三层：插件内自持的篮子状态、经通道投递的附件 payload、经消息 content 落盘的 aux 块。三层各自的形状、唯一源、生命周期都不同，混着读会错。

### 3.1 `ReviewComment`：自包含的评论条目

- 唯一定义在 `renderer/review-basket-store.ts` 第 7–14 行：

```ts
export interface ReviewComment {
  id: string;          // crypto.randomUUID(),篮内寻址键
  messageId?: string;  // 被评消息当前渲染期 id,仅用于"点击跳原文"
  quote: string;       // 选区文本快照,唤起时固化,超 500 字符截断
  comment: string;     // 意见文本,多行纯文本
  createdAt: number;   // 排序锚点(升序),与发言顺序一致
  updatedAt: number;
}
```

- 每条评论必须脱离消息现场依然成立，因为投递发生在未来某个不确定时刻，而那时原文可能已经滚动、追加、被压缩。六个字段按"投递所需最小集"裁剪：`quote` 是**快照不是指针**——会话滚几十屏、消息被 compaction 摘要替换，评论的指向依然自包含；`messageId` 入篮即固化、不回填不追踪，锚失效后"跳原文"静默降级（`review-plugin.md` §3.1 + QA1）。
- 刻意没有的字段：行号、DOM 偏移、rect 坐标——任何指向"现场"的指针都会随会话流漂移。`sessionKey` 不是字段而是篮子 Map 的分桶键；编号（①②③）不是字段，是数组下标的展示形态。

### 3.2 `ReviewBasketState`：模块级 zustand store，按会话分桶

- 唯一源在 `renderer/review-basket-store.ts` 第 16–23 行：`baskets: Map<string, ReviewComment[]>` 加上四个动作 `addComment` / `updateComment` / `removeComment` / `clearBasket`，用 `zustand` 的 `create` 建在**模块级**。
- **模块级是渲染归位的直接结果**：归位前（`docs/design/plugin-decoupling.md` §5 的旧形态）评论篮子的 UI 焊在 timeline 里、状态经六个 `review:*` 通道来回路由；归位后 Overlay（选区浮层）与 BasketBar（composer 附件组件）分处两个 React 子树，但它们要共享同一份篮子状态，于是把状态提升到模块级 store——两个组件各自 `useReviewBasketStore((s) => ...)` 订阅，owner 内部直调自己的状态，不再经 timeline 路由回执。
- **内存态，不落盘**（`review-plugin.md` §3.2）：篮子是"下一条消息的附件"，生命周期短于一次应用运行。落盘会引入过期引用问题——隔夜草稿指向的消息可能已被压缩、会话可能已删除。刷新页面丢草稿是可接受代价；"发送失败保留"针对的是进程活着时的 RPC reject/进程退出，不是应用重启。
- **分桶键**：`sessionKey = currentNeutralSessionId ?? (currentCwd ? \`new:${currentCwd}\` : "")`（`index.tsx` 第 134 行）。与 SessionStore 的 procs key 同规则，保证"评论跟随它所属的会话，不串台"。`new:` 桶只在"新会话首发已渲染、水合未到达"的毫秒级 IPC 窗口内有内容，迁移规则极窄：仅当上一桶键以 `new:` 开头且当前拿到真实 sessionPath 时，把上一桶迁入新桶（`index.tsx` 第 267–280 行）。path→path（打开旧会话、rewind fork）一律不迁——fork 后评论滞留原会话是写明的取舍。

### 3.3 `ComposerAttachmentPayload`：通道 payload，圆心唯一源

- 唯一定义在 `packages/shared/src/domain/contributions.ts` 第 234–243 行：

```ts
export interface ComposerAttachmentPayload {
  sessionKey: string;
  items: Array<{ id: string; messageId?: string; seq: string; quotePreview: string; comment: string }>;
  promptFragment?: string;
  editorActive?: boolean;
}
```

- 这是 `timeline:composerAttachments` 通道的 payload 形状，**圆心是唯一源，timeline 与 review 共用**（timeline `index.tsx` 第 99–101 行注释明确"timeline 不再本地定义"）。字段语义：`items` 是"待发送附件"清单（贡献方定义字段、消费方只挂载不解释）；`promptFragment` 是发送时拼进 prompt 的文本（review 块）；`editorActive` 是贡献方"编辑器打开"的互斥信号。
- 契约注释里"channels 已随渲染归位删除（编辑/删除动作在贡献方组件内部直调自己状态，不再经 timeline 路由回贡献方）"是理解整个数据流的关键——归位前 payload 还带一个 `channels` 字段（回调 channel 名集合），归位后删了，因为交互动作全部回到 review 自己的组件里，不需要 timeline 回传。
- **`editorActive` 是当前未被消费的字段**：review 仍把它发出去（`index.tsx` 第 154 行 `editorActive: editor != null`），但 timeline 的渲染归位后已不再读取它做互斥——timeline `index.tsx` 第 815–817 行注释写明"附件渲染互斥由贡献方组件内部自管（编辑器/内联编辑都归 review），timeline 不再处理"。而 review 自己侧也未真正 enforce（`basket-bar.tsx` 没读 `payload.editorActive`）。这是一个"字段在契约、生产方照发、消费方不读"的 stale 态（§9 汇总）。

### 3.4 `AuxBlock` / `AuxBlockParser`：圆心结构化块契约

- 唯一源在 `packages/shared/src/domain/aux-blocks.ts`（零依赖，§1.3 契约单源）。两个接口 + 一个纯函数：

```ts
export interface AuxBlock { type: string; data: unknown; start: number; end: number; }
export interface AuxBlockParser { id: string; parse(text: string): { blocks: AuxBlock[] } | null; }
export function parseUserBlocks(text: string, parsers: AuxBlockParser[]): { main: string; blocks: AuxBlock[] }
```

- `AuxBlock` 只认 `type` + 泛型 `data`，不感知任何具体块的形状——内核是机制（识别 + 派发），块类型全是内容（review 块、skill 块、未来任意块各是一个插件实例）。`start`/`end` 由 parser 精确给出（`matchAll` 的 `m.index`），这是 `aux-block-mechanism.md` §3.1 "契约硬化"的落点：机制按区间切片剥离块，不再用 `indexOf` 猜边界——两条内容完全相同的块各有唯一区间，切片互不干扰。
- `parseUserBlocks` 汇总所有 parser 结果：按 `start` 排序（文本顺序保真），按 `[start, end)` 区间切片剥离得 `main`（压缩连续空行再 trim）。组合场景（skill 块 + review 块共存）天然正确，与解析器注册顺序无关。
- `ReviewAuxData`（`index.tsx` 第 51–54 行）是 review 块 `data` 的本地形状：`{ count: number; items: { seq: string; quote?: string; comment: string }[] }`。渲染时 `ReviewAuxBlock` 把它从 `aux.data` 里 `as` 出来（第 92 行）。

## 4 三个 UI 表面与一个模块级 store

review 的 UI 分三块，物理分布：`Overlay`（划词浮条 + 选区监听）和 `FloatingCommentEditor`（新建评论浮动输入卡）在 `renderer/index.tsx` 里，`ReviewBasketBar`（评论篮）在 `renderer/basket-bar.tsx` 里。三块共享 `review-basket-store.ts` 的模块级 store。

### 4.1 `Overlay`：零槽位、零 channel 的自渲染挂载点

- `renderer/index.tsx` 第 117 行 `export function Overlay()` 是 review 的**后台常驻挂载点**。它不在任何槽位里，manifest 里没有一条 contribution 声明它——它靠框架的 Overlay 机制挂载：`plugins-host.ts` 加载 module 后，`plugin-overlays.tsx`（`packages/react/src/plugin-overlays.tsx`）遍历已加载插件，发现命名导出 `Overlay` 就挂进主 React 树，用 `PluginIdContext.Provider value={pluginId}` 包裹 + 独立 `ErrorBoundary` 兜底。这把 `review-plugin.md` §4.1 的"零可见槽插件需要执行入口"问题收敛成了框架能力（session-colors 的手写 `renderOverlay` 先例已迁移到该机制）。
- `Overlay` 内部做三件事：订阅选区（`document.addEventListener("selectionchange")`）、维护浮条/编辑器的 portal 定位、调 `pushState` 把篮子状态推给 timeline。
- **选区监听**（第 169–209 行）：`onSelChange` 判定有效选区三条件——`!sel.isCollapsed`、`sel.toString().trim()` 非空、`msgOfSelection(sel)` 能通过 `[data-message-id]` 往上找到消息元素。有效则取 `getRangeAt(0).getBoundingClientRect()` 定位浮条、缓存最近有效选区到 `lastSelRef`；无效则起 400ms `hideTimer` 宽限后隐藏浮条。这 400ms 宽限是流式场景的根因修复：**streaming 重渲染会瞬时摧毁选区（DOM 替换），塌陷不立即隐藏**，期间选区恢复（流式 chunk 间隙）按钮就保住；同时 `lastSelRef` 缓存最近有效选区，保证浮钮点击时活选区已死也能取到引用文本。
- `msgOfSelection`（第 110–115 行）：从 `sel.anchorNode` 出发向上 `closest("[data-message-id]")`，这是 review 摸 timeline DOM 的唯一锚点契约（`review-plugin.md` §4.2 改动点 4，timeline 的 MessageRow 根节点补 `data-message-id`）。
- **两个浮层共存**（第 282–316 行）：划词按钮（选区右上，`createPortal` 到 `document.body`，`onMouseDown preventDefault` 防选区塌缩——这是整条唤起链路唯一反直觉的实现点）+ 新评论编辑器（选区正下方）。浮条定位按选区 rect 收敛进视口边界。

### 4.2 `FloatingCommentEditor`：新建评论浮动输入卡

- 组件在 `index.tsx` 第 322–369 行，锚定选区正下方（不是消息块末尾）。上面一行灰字斜体显示完整引文快照，下面 textarea 输入。
- **键位语义（两段式，2026-08-06 修订定稿）**：`Enter`（非 shift、非 IME composing）= 确认入篮 + 焦点移交 composer（随后 composer 里 Enter 发送）；失焦 = 仅入篮（有内容提交、无内容取消）；`Esc` = 取消。没有提交按钮——键位与 rewind 内联框的肌肉记忆不重学。
- **终结动作幂等闸**（第 332 行 `doneRef`）：Enter 确认后焦点移交 composer，textarea 同步失焦会再触发一次 onBlur 提交路径——无闸时同一评论入篮两次。`submit`/`cancel` 谁先到谁生效，回声作废。
- draft 收在本组件 state，提交/取消才动状态——打字零事件流量；`key` 随锚定消息与引文变化即重置，切目标不串草稿。

### 4.3 `ReviewBasketBar`：composer 附件槽组件

- 组件在 `renderer/basket-bar.tsx`，props 契约 `ComposerAttachmentProps`（`packages/react/src/composer-attachments.ts` 第 9–11 行：`{ payload: ComposerAttachmentPayload }`）。它由 timeline 经 `composerAttachments` 槽查出来渲染（§7.1），props 由 timeline 传入 `payload={matched}`。
- 渲染逻辑：`items = payload.items ?? []`，空则返回 `null`（空篮子完全收起不占像素）。每条评论一行横排：`seq`（accent 色加粗）→ `❝quotePreview`（muted 斜体截断，点击跳原文）→ `→` → `comment`（点击进就地编辑）→ `✕`（删除）。底部"清空全部"按钮。
- **就地编辑**（第 39–72 行）：点击意见区展开 textarea（预填 `item.comment`），Enter/blur 提交 `updateComment(payload.sessionKey, item.id, comment)`、Esc 取消。IME 检查 `!e.nativeEvent.isComposing` 与浮层编辑器、timeline composer 既有检查一致——缺检查时拼音没打完就被提交。
- **点击引文跳原文**（第 36 行）：`ctx.events.invoke("timeline:scrollTo", { messageId: item.messageId! })`，try/catch 兜底（timeline 不在场静默）。这是发送前编辑态的回看需求——与消息里引用条"无跳转"（§6.3）的区别在于：篮子里是待发送的编辑态，需要回看被评位置；消息里是已发送的静态呈现，quote 原文就在正上方气泡流里。
- **已知缺口**：第 18 行 `basketVisibleCount = 5` 硬编码，未接 `settingsGroups` 声明的 `reviewBasketVisibleCount` 配置（§2、§9）。

### 4.4 篮子 store 的四个动作

- `addComment(sessionKey, c)`：`next.set(sessionKey, [...list, c])`——不可变更新，替换整个 Map。
- `updateComment(sessionKey, commentId, comment)`：map 命中 id 则 `{ ...c, comment, updatedAt: Date.now() }`。
- `removeComment(sessionKey, commentId)`：filter 掉命中 id 的项。
- `clearBasket(sessionKey)`：`next.set(sessionKey, [])`——注意是**置空数组而非删除键**，篮子 UI 靠 `items.length === 0` 收起。

## 5 它贡献的槽位

review 一共贡献四个槽位（languages / settingsGroups / composerAttachments / blockRenderers），外加一个零槽位的 Overlay 挂载点。这一节逐个说清楚"贡献了什么、谁来消费、props 契约是什么"。

### 5.1 `composerAttachments` 槽：评论篮的渲染器契约

- manifest 声明 `{ id: "review-basket", component: "ReviewBasketBar" }`，契约在圆心 `ComposerAttachmentContribution`（`contributions.ts` 第 221–228 行）：`{ id, component, order? }`。
- **同名两个机制，必须区分**（`contributions.ts` 第 220 行注释、`plugin-decoupling.md` §5.2）：`timeline:composerAttachments` 是**数据通道**（保留，review → timeline 的挂载命令，管数据送达）；`contributes.composerAttachments` 是**渲染器契约**（新增，管谁来画）。一个管数据送达，一个管渲染归属——归位后 timeline 只认"composer 有 attachments 渲染器"，不认 review。
- 消费方是 timeline：`useComposerAttachments()`（`packages/react/src/composer-attachments.ts`）查槽，timeline `index.tsx` 第 708–715 行取第一个贡献组件作为 `AttachmentRenderer`，第 1256–1258 行 `{matched?.items?.length && AttachmentRenderer ? <AttachmentRenderer payload={matched} /> : null}` 渲染。谁的数据谁画：review 贡献组件、timeline 只挂载。
- **组件匹配走 plugin-modules 而非 componentRegistries**：`getPluginComponent(c.pluginId, c.component)`（`plugin-modules.ts` 第 31 行）在 module exports 里同步查同名导出。所以 `ReviewBasketBar` 只需在 `renderer/index.tsx` 顶层 `export { ReviewBasketBar }`（第 9 行），不经过任何 register 函数。

### 5.2 `blockRenderers` 槽：review 引用条渲染器

- manifest 声明 `{ id: "review-aux", block: "auxBlock", names: ["review"], component: "ReviewAuxBlock", order: 100 }`。
- `block: "auxBlock"` 是 `BlockRendererContribution.block` 的开放字符串扩展（`contributions.ts` 第 469 行，五种内置词汇 `"thinking" | "toolCall" | "text" | "userText" | "divider"` + `(string & {})`）。`names: ["review"]` 匹配块 `type`——这是 auxBlock 块的二键解析里 `name` 的角色（§7.3）。
- 消费方是 timeline 的 `block-renderer.tsx`：`BlockRenderer` 对 `auxBlock` 块类型取 `name = block.aux.type`（第 21 行），经 `resolveBlockRenderer(items, "auxBlock", "review")` 解析出 `review-aux` 项，`<Comp aux={block.aux} />`（第 44–46 行）。props 契约 `{ aux: AuxBlock }`。
- 与 skill 块（skill-manager 插件的 `auxBlock/skill`）是**同一渲染抽象的两种数据形态**（`aux-block-mechanism.md` §8）：共享引用条视觉（muted 小字、右对齐），review 条逐条摊开、skill 条一行摘要。这条分界是机制（解析/派发）与内容（渲染形态）分离的证明——改形态只动渲染器，机制一行不改。

### 5.3 `settingsGroups` 槽：评论篮可见条数

- 见 §2。纯声明式，通用设置页渲染，字段值落 `general.json`。已知缺口：renderer 未消费。

### 5.4 `languages` 槽：八个语言资源项

- 两个命名空间 `review.shell` / `review.settings` × zh-CN / en / zh-TW / de 四语言。归属尺子一把：key 的消费者在 review 的哪个组件，key 就在 review 的 `locales/`。
- `shell.json` 六个 key：`shell.comment`（浮条按钮文案"评论"）、`shell.placeholder`（浮层编辑器 placeholder，含键位提示）、`shell.clearAll`（清空全部）、`shell.reviewCount`、`shell.reviewPromptHeader`（aux 块的模型侧引导语）。
- `settings.json` 三个 key：`settings.groupReview`、`settings.reviewBasketVisibleCount`、`settings.reviewBasketVisibleCountDesc`。
- **`shell.reviewCount` 是死 key**：grep 全仓只在 `locales/*/shell.json` 里出现，renderer 没有任何消费点——它是旧折叠卡形态（显示"评论 N 条"）的残留，引用条形态回归后不再需要（§9 汇总）。

## 6 aux 块合成：构造 / 解析 / 转义同源

review 块是 review 对 aux 块机制（`docs/design/aux-block-mechanism.md`）的一个实例。它带结构化数据（条目列表），渲染不是"显示一坨文本"而是"渲染条目列表"。

### 6.1 块格式与构造：`buildReviewBlock`

- 构造函数在 `index.tsx` 第 43–49 行：

```ts
function buildReviewBlock(comments: ReviewComment[], promptHeader: string): string {
  if (comments.length === 0) return "";
  const items = comments.map((c, i) =>
    `<item seq="${numOf(i)}" quote="${escapeAttr(c.quote)}">${escapeText(c.comment)}</item>`);
  return `<pi-review>\n${promptHeader}\n${items.join("\n")}\n</pi-review>`;
}
```

- 产出格式：

```
<pi-review>
以下是用户对之前回复的评论,请据此修改:
<item seq="①" quote="被评论的代码原文摘录">评审意见一</item>
<item seq="②" quote="另一段原文">评审意见二</item>
</pi-review>
```

- `seq`/`quote` 是 `item` 的**属性**，评论文本是 `item` 的**内容**。编号用 `numOf`（第 18–19 行）：`NUMS = ["①".."⑨"]`，第 10 条起降级为 `"10"`、`"11"` 纯数字（`NUMS[i] ?? String(i + 1)`）。
- **`promptHeader` 是模型侧引导语**（i18n key `shell.reviewPromptHeader`，第 41 行注释、`aux-block-mechanism.md` §6.2）：在 items 之前一行、**不在 `<item>` 里**——解析器的 `itemRe` 只匹配 `<item>…</item>` 条目，引导语对渲染层透明、只对模型可见。这是"补上语义提示又不干扰引用条展示"的落点：裸 `<pi-review>` 块里模型只看到一串 seq/quote 属性，没有一句话告诉它"这是用户对之前回复的评论"。
- **转义对称**（第 30–38 行）：`escapeText` 转义 `&` `<` `>`，`escapeAttr` 在 `escapeText` 基础上再转义 `"`，`unescape` 逆序还原。评论文本走 `escapeText`、quote 属性走 `escapeAttr`——评论里恰好出现 `<item` 字样也会被转义成 `&lt;item`，不会被条目正则误匹配（`aux-block-mechanism.md` QA）。
- 构造与解析同源：`buildReviewBlock` 产出的文本格式是 parser 的输入契约，两者在同一文件里同步演进。模板配置（`promptHeader`/`itemTemplate`）已退役——模板自由度与解析器强耦合，用户把模板改成任意格式解析器就认不出来，恢复模板等于把"剥离失败即裸显"的老 bug 请回来（`aux-block-mechanism.md` §6.3）。

### 6.2 解析器：`auxParsers` 代码级声明

- `index.tsx` 第 59–86 行 `export const auxParsers: AuxBlockParser[] = [{ id: "review", parse(text) { ... } }]`。
- `parse` 用两个正则 `matchAll` 扫描：
  - 外层 `/<pi-review>\s*([\s\S]*?)\s*<\/pi-review>/g` 提取全部完整块，`m.index` 填 `start`、`m.index + m[0].length` 填 `end`（契约硬化，不再让机制猜边界）。`\s*` 放宽换行硬依赖，拼接格式微调不再裸显。
  - 内层 `/<item seq="([^"]*)"(?: quote="([^"]*)")?>([\s\S]*?)<\/item>/g` 提取条目，`quote` 存在才 `unescape`，`comment` `unescape(...).trim()`。
- 产出 `AuxBlock[]`：每个块 `{ type: "review", data: { count: items.length, items } satisfies ReviewAuxData, start, end }`。无匹配返回 `null`（契约要求）。
- **注册路径**：`plugins-host.ts` 第 41–45 行加载 module 时 `Array.isArray(mod.auxParsers)` 即 `registerAuxParsers(auxParsers)` 进 `packages/react/src/aux-block-parsers.ts` 的注册表，并记录 `pluginAuxParserIds`；`onUnloaded`（第 120–124 行）按记录的 id 摘除。与 channels 同生命周期。

### 6.3 消费与渲染：`parseUserBlocks` → 引用条

- timeline `blocks.ts` 的 `decomposeMessage(message, auxParsers)` user 分支（第 27–39 行）：`stripToolLimitNote` 剥掉工具限制前缀 → `parseUserBlocks(text, auxParsers)` 得 `{ main, blocks }` → `main` 非空 push `{ type: "userText", text: main }` → 每个 block push `{ type: "auxBlock", aux: b }`。
- **纯评论消息**（正文留空、只有块）：`main` 为空但 `blocks.length > 0` 时 push `{ type: "userIntent" }`（第 37 行）——给一个真实用户气泡占位，引用条在其下方，消息行不悬空。这个占位气泡由 message-blocks 的 `CommentsOnlyBubble`（`block: "userIntent"`）渲染"仅评论"（§7.4）。
- `block-renderer.tsx` 第 44–46 行 auxBlock 分支 `<Comp aux={block.aux} />`，`ReviewAuxBlock`（`index.tsx` 第 91–108 行）把 `aux.data as ReviewAuxData` 解出 `items`，逐条渲染 `seq`（accent）+ `❝quote`（斜体截断）+ `→` + `comment`，`flex justify-end mt-1` 右对齐、逐条可见。无展开态、无点击跳转（`aux-block-mechanism.md` §8.2）。
- 兜底：`PlainBlockFallback` 对 auxBlock 不渲（`block-renderer.tsx` 第 61–62 行）——无短文本可显示，不裸显标签原文。

### 6.4 数据真相源：`content` 是唯一真相源

- review 块**不是** content 之外的第二数据源，它就在 `message.content` 里。落点是 `session-store.ts` 的 `sendMessage` 第 531–535 行：

```ts
const sendText = [finalText, opts?.sendSuffix].filter(Boolean).join("\n");
// 乐观 content 直接放全文(含 sendSuffix 拼装块)……
get().appendOptimisticUser(sendText, sendText);
```

- `appendOptimisticUser` 第一个形参写进 `content`、第二个写进 `__sendText`——两个都传 `sendText`，content 自此就是全文。这修掉了 `aux-block-mechanism.md` §5.1 的"三态分裂"：旧实现 content 只有正文、块只在 `__sendText` 里，导致"发送当轮丢块、重开回块、resync 回块"的三种命运。现在乐观态/水合态/落盘态/重开态用同一条数据，渲染层只有 `parseUserBlocks` 一条解析路径。
- 旧的 echo 头行镜像机制（`echoMirrorBySession`/`ECHO_HEADER_DOMAIN`/`hashSendText` 等）**已全链路退役**（`aux-block-mechanism.md` §9）——echo 的本质是"content 之外的第二数据源"，正是三态分裂的旧形态。不兼容不兜底：旧会话文件里 `\n\n---\n` 格式的 review 数据按正文显示，新格式是唯一格式。

## 7 与其他插件交互

这是 review 文档的重心。review 的几乎全部运行时行为都建立在"消费 timeline 的槽和 channel"上，它自己一个 channel 都不拥有。下面逐条拆清楚它和每个协作方的关系、依赖方向、以及 invoke/emit 语义的选择依据。

### 7.1 与 timeline 的 `composerAttachments`：槽 + 通道的完整闭环

- **依赖方向单向**：review `dependsOn: ["timeline"]`，timeline 不声明依赖 review。归位前（`plugin-decoupling.md` §5）是行为上的环——review 依赖 timeline 的 composer 挂载，timeline 依赖 review 的篮子数据（六个 `review:*` 通道来回 invoke）；归位后 review 单边依赖 timeline（它的组件挂在 timeline 的槽上），依赖图单向、清晰。
- **数据流四步**：
  1. review 的 `Overlay.pushState`（`index.tsx` 第 136–157 行）在**每次篮子变更或编辑器状态变更时** `ctx.events.invoke("timeline:composerAttachments", payload)` 推全量快照。`payload` 四字段：`sessionKey`、`items`（id/seq/quotePreview/comment 的数组）、`promptFragment`（`buildReviewBlock(comments, t("shell.reviewPromptHeader", ...))` 每次重算）、`editorActive`。
  2. timeline `index.tsx` 第 179–185 行 `ctx.events.on("timeline:composerAttachments", (payload) => setAttachments(payload))` 缓存最近一次快照。
  3. timeline 第 703–704 行 `matched = att && att.sessionKey === curKey ? att : null`——**sessionKey 对齐才生效**，切会话瞬间的时序错位不会把 A 会话的评论误拼进 B 会话（`review-plugin.md` §4.3）。
  4. timeline 第 1256–1258 行渲染 `<AttachmentRenderer payload={matched} />`，`ReviewBasketBar` 收到 payload 画篮子。
- **为什么是 invoke 不是 emit/on**（`review-plugin.md` §4.4，`event-bus.ts` 的语义）：`emit` 校验调用方拥有 channel（越权抛错），review 不拥有 `timeline:composerAttachments`，用 emit 会被拒；`invoke` 只校验 channel 已被某已加载插件注册、调用方不需要权属——review 作为调用方 invoke timeline 拥有的 channel 天然放行。且 timeline 恒在、review 可缺，注册方必须是在场的一方（timeline），这是"谁拥有表面、谁可缺"的对称设计。
- **状态推送制而非请求-响应**：invoke 没有返回值，timeline 无法在发送瞬间回问 review。所以 review 把"每次变更的全量快照"推给 timeline——`promptFragment` 随每次篮子变更重新拼装并随快照推送，timeline 永远消费最近一次推送，无漂移窗口。
- **发送拼装**（timeline `doSend` 第 821–858 行）：`sendSuffix: src?.promptFragment` 传给 `store.sendMessage`。发送成功才 `setAttachments(null)`（第 851 行）——清篮的时机在 timeline 侧，但清篮的动作其实是 review 的 `Overlay` 订阅 `lastSendNonce` 触发的（§8）。

### 7.2 `timeline:focusComposer` 与 `timeline:scrollTo`：两个单向 invoke 命令

- 这两个 channel 都归 timeline 拥有（timeline `index.tsx` 第 20 行 channels 导出），review 只 invoke、不订阅。
- **`timeline:focusComposer`**：review `confirmAndFocus`（第 227–230 行）在评论确认入篮后 `ctx.events.invoke("timeline:focusComposer", {})`——两段式发送的"随后 composer 里 Enter 发送"需要把焦点移交到输入框。timeline 第 1021–1028 行订阅后 `document.querySelectorAll("[data-timeline-composer]")` 取最后一个 focus（dock 的 composer 在 DOM 序最后）。
- **`timeline:scrollTo`**：review `basket-bar.tsx` 第 36 行点击引文区时 `invoke("timeline:scrollTo", { messageId })` 跳原文。timeline 第 491–506 行订阅，`scrollToMessageId` 在 visibleMessages 里找 id、Virtuoso `scrollToIndex` 平滑滚动；目标不在当前渲染范围则写 `pendingScrollRef` 等水合。
- 两处 invoke 都 try/catch 兜底：timeline 不在场（加载失败/被绕过 dependsOn 禁用）时静默降级——`confirmAndFocus` 退化为"仅入篮、焦点不动"，`scrollTo` 退化为不跳。这与 timeline 侧订阅 review 可能缺席的 channel 时同样 try/catch 对称（`review-plugin.md` Q3）。

### 7.3 aux 块注册与 blockRenderers 派发：与 skill 块同机制不同实例

- review 的 `auxParsers` 经 `plugins-host.ts` 进 `aux-block-parsers.ts` 注册表，timeline `blocks.ts` 的 `decomposeMessage` 经 `getAuxParsers()` 拿全部解析器喂 `parseUserBlocks`。**解析器是纯函数，卸载后残留无害**（不匹配任何新文本）。
- 派发复用既有 blockRenderers 槽：`BlockRenderer` 对 auxBlock 取 `name = block.aux.type`（"review"），`resolveBlockRenderer` 二键解析命中 `{ block: "auxBlock", names: ["review"] }` 的贡献项。`auxBlock` 是开放字符串类型 + `names` 匹配块 type，是机制侧零新增的复用——机制不认识 review，只认 `auxBlock` 块类型 + `review` 名字。
- **与 skill 块的对照**：skill 块是 skill-manager 插件实例（`auxBlock/skill`），review 块是 review 插件实例（`auxBlock/review`）。两者在 `parseUserBlocks` 里按 `start` 排序合并，组合场景（同一条消息里 skill 块 + review 块共存）天然正确——skill parser 的 args 捕获非贪婪 + 前瞻 `(?=\n<|$)` 在 `<pi-review>` 前停住，review 块留给 review parser 独立提取（`aux-block-mechanism.md` §4.1 + QA）。
- **无特权差异的天然降级**：删掉 review 插件，`auxParsers` 注册表里没有 review parser，`parseUserBlocks` 不识别 `<pi-review>`，块按正文裸显；删掉 skill-manager 同理。机制不受影响，谁删谁降级。

### 7.4 与 message-blocks 的 `userIntent`：纯评论消息的占位气泡

- 纯评论发送（正文为空、只有 review 块）时，`decomposeMessage` 产出 `{ type: "userIntent" }` 占位块。这个占位由 message-blocks 的 `CommentsOnlyBubble`（`block: "userIntent"`，`src/plugins/sessions/message-blocks/plugin.json`）渲染，文案 `shell.commentsOnly`（"仅评论"）。
- 这是 review 与 message-blocks 唯一的间接接触点，且**不是 review 发起的**——review 只产出数据（块），占位气泡是 timeline 的 `decomposeMessage` 机制 + message-blocks 的内容渲染。review 不知道 message-blocks 的存在。
- 设计语义（`blocks.ts` 第 35–37 行注释）：纯评论消息正文留空，给一个真实用户气泡占位、引用条在其下方——消息行不悬空，用户确认"发出去了"。

### 7.5 依赖图与事件图：一句话总结

- **依赖图单向**：review → timeline（`dependsOn`）。timeline 不依赖 review。
- **事件图**（消息方向仍是双向，但"单向"指依赖方向不是消息方向，`plugin-decoupling.md` §5.2 图 2）：review invoke `timeline:composerAttachments`（挂篮子）、`timeline:focusComposer`（聚焦）、`timeline:scrollTo`（跳原文）；timeline 经槽查 `ReviewBasketBar` 组件（渲染归属）+ 传 payload（挂载数据）。交互动作（编辑/删除/清空）全在 review 自己组件内直调自己 store，不再经 timeline 回传。

## 8 数据流全景：划词 → 入篮 → 发送 → 清篮 → 引用条

把前七节串起来，一次完整交互走如下路径（每个环节标注落点文件/函数）：

- **① 划词唤起**：用户在 timeline 消息文本拖出选区 → `Overlay` 的 `selectionchange` 监听（`index.tsx` 第 174–197 行）判定有效选区 → 浮条 portal 出现在选区右上 → 点击浮条（`onFloatClick`，第 232–262 行，`preventDefault` 保选区）→ 取活选区或 `lastSelRef` 缓存 → 固化 `quoteText`（`truncate` 到 500 字符）→ `setEditor` 打开 `FloatingCommentEditor`。
- **② 入篮**：用户在浮层编辑器输入 → Enter 或失焦有内容 → `confirmAndFocus`（第 227–230 行）→ `addComment`（第 212–223 行）`crypto.randomUUID()` 生成 id、`addCommentToStore(sessionKey, comment)` 写模块级 store → `invoke("timeline:focusComposer")` 焦点移交 composer。
- **③ 推快照**：`addComment` 触发 store 变更 → `Overlay` 的 `pushState` effect（第 159 行 `useEffect(() => { pushState(); }, [pushState])`）重跑 → `buildReviewBlock(comments, promptHeader)` 拼装 review 块 → `invoke("timeline:composerAttachments", payload)` 推全量快照 → timeline `setAttachments` 缓存 → `<ReviewBasketBar payload={matched} />` 渲染评论篮。
- **④ 发送**：用户点发送（正文可空）→ timeline `doSend`（第 821 行）→ `store.sendMessage(currentCwd, text, { sendSuffix: src?.promptFragment })` → `session-store.ts` 第 531 行 `sendText = [finalText, sendSuffix].join("\n")` → 第 535 行 `appendOptimisticUser(sendText, sendText)`（content 直接含块）→ 第 552 行 `prompt(sendText, ...)` 发内核 → 第 579 行 `lastSendNonce++`。
- **⑤ 清篮**：`lastSendNonce` 递增 → `Overlay` 第 163–167 行 effect 侦测到 `lastSendNonce !== 0` → `clearBasket(sessionKey)` 清空当前会话桶 → 触发 `pushState` 再推一次空快照 → timeline 收到空 items → 篮子收起。timeline 侧第 851 行 `setAttachments(null)` 也是同一发送成功路径的收尾（两处收尾协同，前者清状态、后者清挂载）。
- **⑥ 渲染引用条**：内核回放消息 → `decomposeMessage` user 分支 `parseUserBlocks(text, auxParsers)` 剥出 review 块 → `main` 空则 `userIntent` 占位、否则 `userText` 正文 → `auxBlock` 块 → `BlockRenderer` `resolveBlockRenderer` 命中 `review-aux` → `<ReviewAuxBlock aux={...} />` 逐条渲染引用条。
- **发送失败的保留语义**（`review-plugin.md` §2.4）：`sendMessage` 失败（RPC reject/进程退出）时 `lastSendNonce` 不递增、`clearBasket` 不触发、timeline 不 `setAttachments(null)`——篮子原样保留。abort 不在失败清单里：`prompt` 写 stdin 微秒级 resolve，`lastSendNonce` 回执先于任何 abort 落地，abort 只停生成、不撤回已投递的评论。

## 9 已知缺口与 stale 标注

按 CLAUDE.md §5.3 的熵增清理标准，review 当前有四处"注释/契约与代码不一致"或"声明了但未接"的缺口，写文档时一并标注，避免后来者读到注释信以为真：

- **`editorActive` 互斥信号未被消费**。契约 `ComposerAttachmentPayload.editorActive`（`contributions.ts` 第 242 行）注释仍写"timeline 用于挂载区内互斥"，review 也照发（`index.tsx` 第 154 行），但 timeline 渲染归位后已不再读它（`index.tsx` 第 815–817 行注释"互斥由贡献方组件内部自管"），而 review 侧 `basket-bar.tsx` 也没真正 enforce——`basket-bar.tsx` 第 11–12 行注释说"浮层编辑器打开时本组件不展开内联编辑"，但组件只收 `{ payload }` 却从未读 `payload.editorActive`。互斥是注释声明的，不是代码执行的。处置建议：演进——要么在 `basket-bar.tsx` 里真读 `payload.editorActive` 关掉 `editingId`，要么从契约删字段、清注释。
- **`reviewBasketVisibleCount` 配置未接**。manifest `settingsGroups` 声明了字段并在通用设置页渲染，但 `basket-bar.tsx` 第 18 行硬编码 `basketVisibleCount = 5`（注释自标"演进"）。用户改了设置不生效。处置：演进——`basket-bar.tsx` 经 `ctx.config` 或 `general.json` 读 `reviewBasketVisibleCount` 兜底 5。
- **`shell.reviewCount` 死 key**。四语言 `locales/*/shell.json` 都有，全仓无消费点。旧折叠卡"评论 N 条"文案的残留。处置：演进——随下一次 i18n 清理删除。
- **`AttachmentRenderer` 未包 `PluginIdContext.Provider`**。timeline `index.tsx` 第 1256–1258 行渲染 `<AttachmentRenderer payload={matched} />` 时没有像 composerActions/composerStats/composerTop（第 720–728、732–740、748–756 行）那样包 `<PluginIdContext.Provider value={c.pluginId}>`。`ReviewBasketBar` 里的 `usePluginContext()` 因此解析到 timeline 的 pluginId 上下文（timeline 的 mainView 由 `layout-engine.tsx` 第 120 行包 Provider）。当前**恰好无害**——`ReviewBasketBar` 只用 `ctx.events.invoke`（invoke 的 callerId 仅用于错误文案，不校验权属），没碰 `ctx.config` 等 pluginId 绑定面；但这是潜伏的不一致，哪天 `ReviewBasketBar` 要用 `ctx.config` 读配置就会错认成 timeline。处置：演进——与 composerActions 对齐，给 AttachmentRenderer 补 Provider 包裹。

## 10 QA

**Q1：评论发送当轮为什么以前不显示引用条？现在什么时候可见？**

以前 `session-store.ts` 的 `sendMessage` 是 `appendOptimisticUser(text, sendText)`——content 只放正文、块只在 `__sendText` 里，水合又保留乐观 content，块到不了渲染层。改后是 `appendOptimisticUser(sendText, sendText)`（第 535 行），content 直接放全文（含 `sendSuffix` 拼装块）。现在发送当轮、水合后、重开会话、resync 后四处形态一致——发送成功那一刻用户就看到引用条，不用等落盘回放。

**Q2：用户编辑了一条评论（点击意见区 → 内联 textarea 打开 → 打字中），还没提交就按了发送键，发送的 `promptFragment` 包含刚才打的草稿吗？**

不包含。内联编辑草稿收在 `basket-bar.tsx` 的 `draft` state（第 14 行），只有 Enter 提交或失焦有内容（第 46–59 行）才调 `updateComment` 写 store、触发新快照推送。timeline 消费的是最近一次**已提交**版本的 `promptFragment`。用户直接按发送等于丢弃草稿，与"输入框打字一半直接关窗口"一致。

**Q3：review 插件被禁用/卸载后，timeline 上还显示评论篮 chips 吗？点 ✕ 会怎样？**

不会长期显示。`plugins-host.ts` 的 `onUnloaded` 会 `eventBus.unregisterPlugin("review")` 并 `unregisterAuxParsers`，timeline 第 187 行 `useEffect(() => { setAttachments(null); }, [_pluginsNonce])` 在 `pluginsNonce` 变化时清空附件缓存。存在一个时序窗口（onUnloaded 到 nonce 广播之间 timeline 还持旧 payload），此时点 ✕ → `invoke` 一个已注销的 channel 会抛错，review 侧 try/catch 静默——chips 随 nonce 刷新自然消失。已知边界，不是 bug（`review-plugin.md` Q3）。

**Q4：review 自己一个 channel 都不拥有（`channels = [] as const`），那它的插件间通信全靠 invoke 吗？它凭什么能 invoke 别人的 channel？**

对，review 是纯 invoke 调用方。它 invoke 的 `timeline:composerAttachments`/`timeline:focusComposer`/`timeline:scrollTo` 全归 timeline 拥有（timeline `index.tsx` 第 20 行）。能 invoke 的依据是 `eventBus.invoke(callerId, channel, payload)`（`event-bus.ts` 第 134 行）只校验 channel 已被某已加载插件注册、**不校验调用方权属**——这正是 invoke 与 emit 的分野：emit 只发自己声明的 channel（发布/订阅），invoke 调别人的 channel（定向命令）。review 的正确性由 `dependsOn: ["timeline"]` 保证 channel 先注册、try/catch 兜底 timeline 缺席。

**Q5：评论篮按会话分桶，`new:` 桶是什么？两个未落盘的新会话会串篮吗？**

`new:<cwd>` 是"新会话壳"的临时桶键（与 SessionStore 的 procs key 同规则）。真实时序下两个未落盘新会话串篮的概率趋近于零：新会话窗口无消息可选、无从产生评论，首发瞬间 `startNewChat` 即生成真实 sessionPath，`new:` 桶的唯一非空来源是"首发已渲染、水合未到达"的毫秒级 IPC 窗口，水合时迁入真实桶（`index.tsx` 第 267–280 行的极窄迁移规则：仅 `new:` 前缀迁、path→path 不迁）。

**Q6：评论内容里含 `<`、`>`、`&`、`"` 这些字符，会破坏块结构吗？**

不会。构造侧 `buildReviewBlock` 用 `escapeText`/`escapeAttr` 转义，解析侧 `unescape` 还原。评论里恰好出现 `<item` 会被转义成 `&lt;item`，不会被条目正则误匹配（`aux-block-mechanism.md` QA）。代价是模型看到的块里含实体（`&lt;` 等）——这是 XML 结构化的代价，换取解析确定性；引导语补足了"这段是什么"的语义，实体对模型的干扰可接受。

**Q7：正文恰好手输 `<pi-review>` 或 `<skill` 字样怎么办？会被误判成块吗？**

残缺标签按正文处理。解析器要求完整标签形态——`<pi-review>` 必须配 `</pi-review>` 闭合，review 的 itemRe 要求 `<item seq="..." …>…</item>` 完整结构。用户手输完整标签块的概率趋近于零；真撞上了，引用条也是合理展示（`aux-block-mechanism.md` QA）。

**Q8：`editorActive` 这个字段到底还在不在用？为什么契约里还有它？**

字段还在契约里（`ComposerAttachmentPayload.editorActive`）、review 还在发（`index.tsx` 第 154 行），但 timeline 和 review 两边都没消费它——timeline 渲染归位后互斥"由贡献方组件内部自管"，而 `basket-bar.tsx` 也没真读 `payload.editorActive`。这是"字段在契约、生产方照发、消费方不读"的 stale 态，§9 第一条已标注处置建议（演进）。
