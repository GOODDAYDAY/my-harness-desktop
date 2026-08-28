# key-hints：Vimium 式按键导览

key-hints 提供 Vimium 式按键导览（link hints）：按触发键进入导览模式，页面上所有可点击元素高亮并在左上角显示字母/数字标记，按标记即触发对应元素的点击（或聚焦输入框），手不离键盘触达任何按钮、菜单项、列表行。它的存在补上了 keybindings 的一个盲区——keybindings 只覆盖"已暴露 channel"的动作（组合键 → invoke channel），但页面上还有大量未 channel 化的按钮（菜单项、列表行、开关）无法键盘触达。key-hints 直接操作 DOM，扫描、分配标记、触发点击，机制与 keybindings 完全不同，所以独立成插件，两者经一个 channel 对接。

## 职责边界

key-hints 的职责窄而完整：**导览模式的全套交互**。扫描可点击元素、分配前缀唯一的标记、按标记前缀过滤匹配、唯一命中即触发。它不实现任何具体动作——触发 `click()` 或 `focus()` 后，动作本身由目标元素既有的事件处理器执行（打开菜单、切换开关、选中会话），key-hints 不复制任何业务逻辑。这与 keybindings 的"不实现任何动作，只做映射"是同一条纪律：快捷键/导览都是"给已有交互加一个新的触发源"，动作归属执行方。

- **纯函数层与渲染层分离**。`core/hints.ts` 是纯函数层——`assignHints`/`assignDigits`/`isClickable`/`isDisabled`/`isVisible` 不 import react、不碰 ctx，可裸单测（`core/hints.test.ts`）。`renderer/index.tsx` 是渲染层——`Overlay` 组件 + 扫描编排 + 键盘监听。这条边界让"标记分配算法"和"DOM 交互状态机"各自独立演化：算法改前缀唯一性构造，不碰 renderer 的 effect；renderer 改触发时机，不碰纯函数。

- **设计文档先行**。`DESIGN.md` 是这份代码的"为什么"，本文是它的独立展开。DESIGN.md 第 2 节写了独立成插件的决策（不塞进 keybindings），第 4 节写了数字优先区 + 前缀唯一的分配模型，第 5 节写了交互状态机。本文落到具体函数名和行号。

## 目录结构

```
src/plugins/system/key-hints/
  plugin.json          manifest：settings 槽 + languages 槽
  DESIGN.md            设计文档（为什么/边界/取舍）
  core/
    hints.ts           纯函数：标记分配 + 可点击/可见性判定
    hints.test.ts      纯函数单测
  renderer/
    index.tsx          Overlay（零可见常驻）+ 导览模式全套逻辑
    settings.tsx       KeyHintsSettings（` 前缀键开关）
    key-hints.css      徽标/高亮/提示条样式（全主题 token）
  locales/
    zh-CN/hints.json   文案 key（keyhints.*）
    zh-TW/ en/ de/     同构
```

有 `core/`（纯函数层，因为有可单测的算法），没有 `client/`、没有内核扩展。这是"有纯函数 + 有渲染 + 有样式 + 有文案"的中等复杂度壳插件形态，四件套用到前两件。

## plugin.json 逐字段

```json
{
  "id": "key-hints",
  "version": "0.1.0",
  "tier": "official",
  "displayName": "按键导览",
  "description": "Vimium 式按键导览：快捷键或 ` 键进入导览模式，所有可点击元素高亮并显示字母标记，按字母直接触发点击，手不离键盘",
  "tags": ["productivity"],
  "renderer": "./renderer/index.tsx",
  "contributes": {
    "settings": [
      { "id": "key-hints", "title": "按键导览", "icon": "mouse-pointer-click",
        "component": "KeyHintsSettings", "order": 56 }
    ],
    "languages": [ ... ]
  }
}
```

- **`settings` 贡献**。`component: "KeyHintsSettings"` 对应 `settings.tsx` 第 12 行 `export function KeyHintsSettings`。没有 `configFile` 字段——配置走 settings 槽框架托管的统一通道（零声明默认 `~/.my-harness-desktop/config/key-hints.json`，由框架按 pluginId 推导路径）。`order: 56` 排在 keybindings（55）之后。

- **无 `channels` 声明在 manifest，channel 在代码里**。`renderer/index.tsx` 第 21 行 `export const channels = ["keyhints:toggle"] as const`——channel 是代码级声明，框架加载 module 后读 `module.channels` 自动注册，不进 manifest。这是 §8.2 的"代码即声明"。

- **`channelMeta` 可选导出**。第 24–29 行 `export const channelMeta: Record<string, ChannelMeta>` 给 `keyhints:toggle` 挂了 `label`（"切换按键导览模式"）和 `description`，keybindings 设置页的动态事件列表据此显示可读描述。没有这个导出，channel 也能被列出（回退显示 channel 名），只是不可读。

## 标记分配算法（core/hints.ts 纯函数）

这是 key-hints 最值得读的部分——它解决了一个真实问题：**给 N 个目标分配互不歧义的单键标记**，且要区分大小写、前缀唯一。

- **字符表与容量**。`HINT_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"`（第 11 行）共 52 个，区分大小写（a 与 A 是两个不同 hint）。`DIGIT_CHARS = "1234567890"`（第 14 行）共 10 个，给侧栏/列表等"索引心智"区域。`MAX_SINGLE = HINT_CHARS.length = 52`（第 17 行）。`MAX_HINTS = 154`（第 21 行）是单次最多标记目标数。

- **`assignHints(count)` 的前缀唯一构造**（第 30–41 行）。`count <= 52` 时全部单字符（`HINT_CHARS.slice(0, n)`）。超出时从字符表**尾部让位** h 个字符作为双字符组的首字符——`while (MAX_SINGLE + (MAX_SINGLE - 1) * h < n) h++` 找最小 h，`s = MAX_SINGLE - h` 个单字符，剩下的 `n - s` 个用 `HINT_CHARS[s + floor(j/MAX_SINGLE)] + HINT_CHARS[j % MAX_SINGLE]` 拼双字符。关键不变量：**让位出去的字符不再作为单字符**，所以单字符池与双字符首字符池不相交，任意两个 hint 不互为前缀——按完整个 hint 序列必然唯一命中，不存在歧义。容量公式 `52 + 51h`，h=2 时到 154。

- **`assignDigits(count)`**（第 47–53 行）。给 count 个目标分配数字 hint，超 10 个的部分返回 `null`，调用方把超出的并入字母池统一分配。数字与字母首字符不相交（`1-0` vs `a-z A-Z`），前缀唯一性跨组保持。

- **`isClickable(el)` 的 duck-typing**（第 72–91 行）。判定顺序：`textarea` 是聚焦目标直接 true；`input` 排除 `type=hidden`（`INPUT_TYPES`）；`button`/`select`/`summary`/`option` 直接 true；`a` 需有 `href`；`aria-roledescription` 含 `sortable`/`draggable` 排除（dnd-kit 拖拽容器 role=button 但点击无动作）；`role` 在 `CLICKABLE_ROLES`（`button/menuitem/menuitemcheckbox/menuitemradio/checkbox/radio/switch/tab/option/link`）true；有 `onclick` 属性 true；`isContentEditable` true；`getComputedStyle(el).cursor === "pointer"` true（React onClick 的 div 不产生 DOM onclick 属性，但几乎都配 cursor-pointer）；`tabIndex >= 0` true。用属性 duck-typing 而非 `instanceof` 具体类，保证 node 测试环境 import 不炸。

- **`isDisabled` / `isVisible`**。`isDisabled`（第 94–99 行）：表单元素查 `.disabled`，其余查 `aria-disabled === "true"`。`isVisible`（第 105–117 行）：祖先链上任何 `display:none`/`visibility:hidden`/`opacity:0` 即不可见（含 hover 才显示的装饰按钮）；包围盒零宽高不可见；完全在视口外不参与（用 `viewport` 参数或 `window.innerWidth/Height`，可注入便于测试）。

## 渲染器：Overlay 的状态机

`renderer/index.tsx` 的 `Overlay` 是零可见常驻组件（框架 `PluginOverlays` 挂进主树 + 注入 pluginId），`return null` 之外全在 `useEffect` 里跑订阅。`active` state 控制导览模式，`targets`/`typed` state 是渲染用的镜像，`activeRef`/`targetsRef`/`typedRef` 是给窗口级监听读最新值的 ref（因为监听只在 active 变化时挂一次，闭包不能捕获旧值——这是"闭包旧值 bug"的根因修复，第 74–80 行注释点破）。

- **触发一：`keyhints:toggle` channel**（第 183–186 行）。`ctx.events.on("keyhints:toggle", () => setActive(a => !a))`。这个 channel 由 keybindings 默认绑 `mod+shift+'` invoke。用户改绑在 keybindings 设置页，key-hints 代码零改动。

- **触发二：`` ` `` 前缀键**（第 191–210 行）。物理键判定 `e.code === "Backquote"`（不受输入法/大小写影响），且 `metaKey/ctrlKey/altKey` 均 false。焦点在可编辑元素（textarea/input/contentEditable）时**完全放行**——`` ` `` 就是普通字符，单击即输入，永不进导览；非输入态按 `` ` `` 立即 `preventDefault + stopPropagation + setActive(true)`，零延迟、无双击判定。`backquoteEnabledRef.current` 是配置开关（设置页保存后重读）。

- **配置重读**（第 93–114 行）。`ctx.config.get<unknown>("backquote")` 读开关，`v !== false` 默认开；`system:configFileSaved` 订阅重读，保存即生效。`alive` 标志防 setState-after-unmount。

- **`rescan` 扫描编排**（第 118–167 行）。`document.querySelectorAll("body *")` 全量 → `isClickable && !isDisabled && isVisible` 过滤 → `closest(".kh-root")` 排除导览层自身 → **嵌套去重**（元素的可点击祖先已在集合，说明它是祖先的子件图标/文字，点祖先即可，第 127–136 行）→ **数字优先区**（`[data-sidebar-style]` 容器内元素拿数字 1-0，超出并入字母池）→ `assignHints(letterPool.length)` 分配字母 → 高亮 + 建徽标。`highlightedRef` 存已加 `kh-target` class 的元素集合，重扫时统一摘除旧高亮。

- **模式内键盘独占**（第 231–277 行）。capture + `stopImmediatePropagation`：`Escape` 退出（`preventDefault + stopImmediatePropagation + setActive(false) + blurActiveEditable()`）；`scrollKeyAct`（`PageUp/PageDown/ArrowUp/ArrowDown/Home/End/Space`）滚动 `findScrollContainer()` 找到的可滚动容器（`scrollBy` 视口 80%/30% 高度）；单字符 `[a-zA-Z0-9]` 进前缀匹配。**前缀匹配逻辑**：`next = typedRef.current + e.key`，`matches = targets.filter(x => x.hint.startsWith(next))`；0 匹配清空重来；1 匹配且 `matches[0].hint === next` 即唯一命中——聚焦目标 `focus()`（textarea/input/contentEditable）、动作目标 `click()`，然后 `setActive(false)` 退出；否则 `updateTyped(next)` 继续等下一键。触发后**直接退出不保持模式**（第 263–264 行注释：视图切换/菜单打开后徽标不更新是保持模式的坑，且重进导览很便宜）。

- **退出与重扫**。点击导览层外任意处退出（`mousedown` 监听，第 280–288 行，`closest(".kh-root")` 内不触发）；滚动防抖重扫（第 291–303 行，120ms 防抖，`capture: true, passive: true`）；视图切换退出（`activeView` 变化 `setActive(false)`，第 83–86 行，聊天 ↔ 设置切走后旧徽标悬在新视图上无意义）。

- **`blurActiveEditable` 与 IME**（第 49–55 行 + 173–180 行）。输入态按 Esc 移出焦点（`blur()`），回到页面键盘态可 `` ` `` 进导览。用 window bubble 而非 capture——React 组件的自身 Esc 语义（关搜索/关菜单）在合成事件里先执行，组件 `stopPropagation` 则事件到不了这里；`isComposing` 放行（IME 组合中 Esc 是取消候选不是退出输入态）。

## 一次导览的完整交互流

把"用户按 `` ` `` → 按字母触发点击"的全流程走一遍，能看到 key-hints 的状态机各层如何衔接。

- **进入导览**。用户非输入态按 `` ` ``，window capture 级 `onKey`（第 192 行）判断 `e.code === "Backquote"` 且无修饰键、`backquoteEnabledRef` 为 true、`activeElement` 不是可编辑元素，`preventDefault + stopPropagation + setActive(true)`。

- **扫描**。`active` 变 true 触发第 213 行的 effect，`rescan()` 扫描 `body *` 全部元素，`isClickable && !isDisabled && isVisible` 过滤，嵌套去重，侧栏元素分数字、其余分字母，`assignHints` 分配前缀唯一标记，`kh-target` 高亮 + 徽标渲染（`createPortal` 到 `document.body`）。

- **按字母**。用户按 `a`，第 231 行 effect 的 capture 监听 `stopImmediatePropagation` 吞掉，`typedRef.current + "a"` 得 `"a"`，`matches = targets.filter(x => x.hint.startsWith("a"))`。假设 `a` 是单字符 hint 唯一命中（`matches.length === 1 && matches[0].hint === "a"`），第 261 行触发：元素是 textarea/input/contentEditable 则 `focus()`，否则 `click()`，然后 `setActive(false)` 退出。假设 `a` 和 `ab` 都在 targets 里（前缀歧义），则 `updateTyped("a")` 继续等下一键，徽标里不以 `a` 开头的变暗（`kh-badge--dim`）。

- **退出清理**。`setActive(false)` 触发第 213 行 effect 的 cleanup：`highlighted` 集合里的元素逐个 `classList.remove("kh-target")`，`targetsRef` 清空，`updateTyped("")`。徽标随 `active === false` 时 `return null` 一起卸载（`createPortal` 的 JSX 不渲染）。

- **触发后的"重进很便宜"**。触发 `click()` 后不保持模式（第 263–264 行注释），因为菜单打开后 DOM 变化、旧徽标不再对位。但重进导览只要再按一次 `` ` `` 或组合键，`rescan()` 重扫新 DOM，新菜单项获得新标记。这是"不保持模式"取舍的另一面：牺牲了"连续点多个菜单项"的便利，换来了"徽标永远对位"的正确性。

## 样式：全主题 token

`renderer/key-hints.css` 用 `.kh-root`/`.kh-badge`/`.kh-target`/`.kh-hintbar` 四类，全部用主题 token（`var(--color-primary)`、`var(--color-surface)`、`var(--shadow-lg)`、`var(--radius-md)` 等），不写死任何颜色值。`.kh-root` 是 `position: fixed; inset: 0; z-index: 2147483000; pointer-events: none`——不拦截鼠标，点击外部退出走 `document mousedown` 监听。`.kh-badge` 是左上角徽标，`transform: translate(-3px, -3px)` 移到元素左上角外侧不遮挡内容。`.kh-badge--dim` 前缀过滤时变暗（`opacity: 0.3`）。`.kh-target` 用 `outline`（不占布局）高亮。z-index 用 2147483000 量级，压过所有 UI 层。

## 贡献的槽与 channel

- **`settings`**（`SettingsContribution`）：贡献「按键导览」设置页，`KeyHintsSettings` 只渲染一个 `` ` `` 前缀键开关 + 组合键触发说明（`settings.tsx` 第 12–41 行，两个 `SettingsSection`）。

- **`languages`**（`LanguageContribution`）：`keyhints.hints` 命名空间，key 前缀 `keyhints.*`。

- **channel `keyhints:toggle`**（声明，`channels` 数组 + `channelMeta`）：被 keybindings invoke 的切换入口。它只 `on` 不 `emit`、不 `invoke` 别人，是"被触发器"的角色。

## 与其他插件交互

- **被 keybindings 触发**。keybindings 的 `DEFAULT_BINDINGS` 第 28 行 `{ combo: "mod+shift+'", channel: "keyhints:toggle" }`。keybindings 按组合键 invoke，key-hints 订阅翻转。这是两个插件唯一的耦合点，通过 channel 解耦：key-hints 不 import keybindings，keybindings 不 import key-hints，只共享一个 channel 字符串 + `channelMeta` 描述。key-hints 的 `settings.tsx` 第 7–8 行注释明确写"两路互不依赖，关掉 ` 键仍有组合键可用"。

- **依赖框架状态**。`useUiStore((s) => s.activeView)` 读当前视图（聊天/设置），切走退出导览；`useUiStore` 是框架共享 store，key-hints 只读不写（共享 store 只读纪律）。

- **依赖 i18n**。`t("keyhints.*")` 经 i18n 插件合并的语言字典。

- **与 debug-bar 的机制对比**。两者都做 DOM 元素标注，但目的不同：debug-bar 是"点元素复制 outerHTML"（点框命中），key-hints 是"按字母触发点击"（不点框、靠字母键）。debug-bar 用 overlay 框 + 序号，key-hints 用 outline 高亮 + 徽标。这个对比说明：同一类 DOM 操作，交互目的不同，机制选择就不同，不存在该收敛的共享实现。

## 相关契约与类型落点

- `ChannelMeta`/`ChannelInfo`：`packages/shared/src/channel/channel-meta.ts:11/21`
- `PluginEventsApi`（`ctx.events.on`）：`packages/shared/src/domain/context.ts:229`
- `SettingsComponentProps`（`{ config, onChange }`）：`packages/react/src`（settings 槽组件 props 契约）
- `SettingsContribution`：`packages/shared/src/domain/contributions.ts:9`
- 零可见 Overlay 的框架消费：`packages/react/src/plugin-overlays.tsx` + `plugin-modules.ts`（`getPluginOverlay` 读 `module["Overlay"]`）

## QA

**Q：导览模式里按了一个字母，匹配到多个目标，我接着按第二个字母，但为什么有的候选变暗了？**

A：前缀过滤的可视化。`typed` 非空时，renderer 里 `dim = typed !== "" && !x.hint.startsWith(typed)`（`index.tsx` 第 314 行），不匹配当前前缀的徽标加 `.kh-badge--dim` 变暗（`opacity: 0.3`）。你按的字母序列是前缀，剩下的亮徽标是可能命中项，再按字母继续收窄，直到唯一命中触发或清空重来。

**Q：为什么侧栏的会话列表是数字标记（1、2、3），别处是字母标记？**

A：数字优先区设计。`rescan` 里 `el.closest("[data-sidebar-style]")` 判断元素在侧栏容器内（框架 sidebar 根标记），侧栏元素先拿 `assignDigits` 的数字 hint（1-0）——会话/项目列表是"索引心智"区域，数字比字母直觉（1=第一个会话）。数字容量 10，超出并入字母池。前缀唯一性跨组保持（数字 1-0 与字母 a-z A-Z 首字符不相交），见 `DESIGN.md` §4.1 和 `hints.ts` 第 47–53 行。

**Q：为什么超过 154 个可点击元素就不分配标记了？**

A：`MAX_HINTS = 154` 是单字符 52 + 双字符容量上限。前缀唯一构造的容量公式是 `52 + 51h`，h=2 时到 154（`assignHints` 第 21 行注释 + 第 30–41 行）。虚拟列表只渲染视口内元素，实际命中数远低于 154；真超出（`count` 被 `Math.min(count, MAX_HINTS)` 截断）的部分不分配。这是数学上限不是性能上限——要更多得引入三字符 hint，前缀唯一构造会更复杂，当前不需要。

**Q：我在输入框里想输入反引号（比如 markdown 代码块），会不会误触导览？**

A：不会。`` ` `` 前缀键的输入态守卫：`document.activeElement` 是 textarea/input/contentEditable 时直接 `return`（`index.tsx` 第 195–202 行），`` ` `` 作为普通字符正常输入。只有非输入态按 `` ` `` 才进导览。这就是为什么去掉了 tmux 式"单击进导览、双击输入 `"——输入态放行后，想输入 `` ` `` 去输入框单击就有，双击语义是多余负担（DESIGN.md §3.2）。

**Q：导览模式打开一个菜单后，菜单项能继续用字母触发吗？**

A：能。触发点击后 `setActive(false)` 退出（第 270 行），但如果你在退出前菜单已经渲染，重新进导览（`` ` `` 或组合键）会重扫，新渲染的菜单项获得新标记。代码注释点明"触发后直接退出不保持模式"正是为了避免"视图切换/菜单打开后徽标不更新"的坑——保持模式需要持续监听 DOM 变化重扫，成本高于"重进导览很便宜"。

**Q：key-hints 和 keybindings 都在监听全局键盘，会互相干扰吗？**

A：不会，分工清晰。keybindings 监听 window keydown 做"组合键 → invoke channel"映射；key-hints 只在 `active`（导览模式）时才挂 capture 级监听做字母前缀匹配，且导览模式的 `stopImmediatePropagation` 只拦截单字符和滚动键，组合键（含 mod+shift+' 再次切换导览）放行（第 253 行 `e.key.length !== 1 || !/[a-zA-Z0-9]/.test(e.key)` return）。非导览模式 key-hints 只挂两个轻量监听：`` ` `` 前缀键（capture）和 Esc 退出输入态（bubble）。两者不同时"吃掉"同一个键。
