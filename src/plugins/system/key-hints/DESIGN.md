# 按键导览插件设计（key-hints）

> 本文回答"为什么这么做、边界在哪、取舍是什么"；代码回答"字段叫什么、调用链怎么走"。
> 两者不重复——本文讲为什么，代码讲怎么做。

## 1 要解决的问题

键盘流用户操作 pi-desktop 时，绝大多数交互（模型下拉、思考深度、消息动作、侧栏列表……）
都只能鼠标点击。keybindings 插件解决了"组合键 → 事件"的映射，但只覆盖已暴露 channel 的
动作；页面上还有大量未 channel 化的按钮（菜单项、列表项、开关……）无法键盘触达。

本插件提供 **Vimium 式按键导览（link hints）**：按触发键进入导览模式，页面上所有可点击
元素高亮并在左上角显示字母标记；按字母键即触发对应元素的点击。用户从头到尾不用碰鼠标。

## 2 放置决策：独立插件，不塞进 keybindings

keybindings 的核心原则是"不实现任何动作，只做组合键 → invoke channel 的映射"（其
DESIGN.md §7）。导览模式是直接操作 DOM 的动作（扫描、分配、触发点击），机制完全不同，
塞进去会污染 keybindings 的纯映射模型。

所以本插件独立存在，但与 keybindings 通过 channel 对接：

- key-hints 声明 `keyhints:toggle` channel，Overlay 常驻订阅；
- keybindings 默认绑 `mod+shift+'` → invoke `keyhints:toggle`；
- 用户想换触发键，在快捷键设置页改绑即可，key-hints 代码零改动。

这个对接方式完全复用 keybindings 的既有模型，两侧独立演化：keybindings 保持纯映射，
key-hints 负责导览模式本身的交互。

## 3 两种触发方式

### 3.1 组合键（keyhints:toggle channel）

keybindings 默认绑定 `mod+shift+'`（mac = ⌘⇧'，win/linux = Ctrl+Shift+'）→ invoke
`keyhints:toggle`。Overlay 收到后翻转激活状态。多键触发同一功能天然支持：bindings 数组
里多条绑定指向同一 channel 即可（设置页添加），机制零改动。

### 3.2 前缀键 `（Backquote，中文键盘即 · 键）

分两种情况，无双击判定：

- **输入态（焦点在 textarea/input/contentEditable）**：` 完全放行——就是普通字符，
  单击即输入，**永不进入导览**。想输入反引号零摩擦（markdown 代码块直接打）。
- **非输入态按 `**：立即进入导览模式（无双击判定，零延迟）。

窗口判定用物理键 `e.code === "Backquote"`，不受输入法/大小写影响（中文输入法下该键
输出 · 也能命中）。导览模式激活期间前缀键不参与（退出走 Esc）。

**可配置**：` 前缀键在设置页（key-hints 设置）可关闭——`backquote: false` 后该键完全
恢复为普通字符，只剩组合键触发。默认开启；关闭场景：键盘上没有该键/不习惯/与其他
工具冲突。

为什么不要双击：最初设计是 tmux 式"单击进导览、双击输入 `"——但输入态直接放行后，
想输入 ` 去输入框单击就有，双击语义变成多余的负担（还要区分单击/双击的窗口，慢速
双击会误进）。去掉双击后交互最简：输入框里 ` 是字符，输入框外 ` 是导览。

## 4 hint 分配：数字优先区 + 前缀唯一

### 4.1 数字优先区（侧栏）

侧栏容器（`[data-sidebar-style]`，框架 sidebar 根标记）内的元素——会话列表、项目列表——
是"索引心智"区域，分配**数字 hint（1-0）**：按 1 就是第一个会话，比字母直觉。

数字容量 10 个；侧栏元素超过 10 时，超出的并入字母池（与其余元素按文档序统一分配）。
前缀唯一性跨组保持：数字（1-0）与字母（a-z A-Z）首字符不相交。

### 4.2 字母区：前缀唯一（prefix code）

侧栏之外的元素分配字母 hint：`a-z` + `A-Z` 共 52 个单字符，**区分大小写**（a 与 A 是
两个不同 hint）。

任意两个 hint 不互为前缀。单字符 52 个够用时全部单字符；超出时从字符表**尾部让位**
h 个字符作为双字符组的首字符：单字符池与双字符首字符池不相交（让位出去的字符不再作为
单字符），前缀唯一性由构造保证。总容量 52 + 51×h，h=2 时到 154——虚拟列表只渲染视口内
元素，实际命中数远低于此，超过 154 的部分不分配。

`assignHints(count)` / `assignDigits(count)` 是纯函数（无 DOM 依赖），可裸单测。

## 5 交互状态机

```
inactive ──触发(keyhints:toggle / 前缀键)──▶ active
  ▲                                                │
  │                                                │ 按字母:前缀过滤
  │                                                ▼
  │                                            匹配中(typed)
  │                                                │ 唯一完整命中
  │                                                ▼
  │                                      click()/focus() → 退出(点一下即消失)
  │                                                │
  └──── Esc / 点击导览层外 / 视图切换 ◀─────────────┘
```

- **进入**：扫描 `body *`，过滤出可点击（button/a[href]/select/summary/option/非输入型
  input/语义 role/onclick 属性/可聚焦）且未禁用、可见、在视口内的元素；嵌套去重（元素
  的可点击祖先已在集合则跳过它——点祖先即可）；按文档序分配 hint。
- **过滤**：按字母键累积 typed，命中前缀的候选保持高亮，不匹配的变暗；无匹配则清空
  typed 重来。
- **触发**：typed 完整等于某个 hint（前缀唯一保证此时必然唯一），**触发后直接退出导览**
  （点一下即消失）。目标分两类：
  - **动作目标**（button/a/role 等）：`el.click()`——侧栏切会话、打开下拉菜单、消息动作……
    点完导览消失，视觉干净；要连操作再进一次（` 或组合键，很便宜）。
  - **聚焦目标**（textarea/文本 input/contentEditable）：`el.focus()`——会话框输入、搜索框
    聚焦，退出后直接打字。
  - **视图切换也退出**：activeView（聊天 ↔ 设置）变化时自动退出——旧徽标悬在新视图上
    无意义（切设置后按钮不跟着动就是这个 bug 的场景）。

  为什么触发后不保持模式：最初设计是"触发后保持模式重扫"以便连续操作，但①视图切换/菜单
  打开后旧徽标不更新的坑；②"点一下直接消失"更符合直觉（Vimium 默认行为）；③重进导览
  的成本就是按一下触发键。取舍后触发即退。
- **退出**：Esc；点击导览层（提示条/徽标）之外的任意处；再次触发组合键。
- **输入态 Esc 退出**：焦点在可编辑元素时按 Esc 移出焦点（`blurActiveEditable`），回到
  页面键盘态（可 ` 进导览）。用 window bubble 监听——React 组件的自身 Esc 语义（关搜索/
  关菜单/关 rewind）在合成事件里先执行，组件 stopPropagation 则事件到不了这里，不冲突；
  IME 组合中按 Esc 是取消候选，isComposing 放行。导览模式内 Esc 一次性退出导览 + 输入态。
- **滚动**：滚轮/触摸板原生可用（不拦截）；capture 滚动监听 + 120ms 防抖重扫——徽标位置
  随滚动重算，新进入视口的元素获得 hint，滚出去的消失。
- **键盘滚动**：导览模式下 `PageUp/PageDown`、`↓/↑`、`Home/End`、`Space` 滚动视口中心最近
  的可滚动容器（`findScrollContainer`：`elementFromPoint(视口中心)` 向上找
  scrollHeight > clientHeight 的祖先，回退文档根）——设置页多层滚动区域时滚"当前看的那个"，
  手不离键盘。

## 6 键盘独占

导览模式激活期间，keydown 用 window capture + `stopImmediatePropagation` 独占：
字母键不落到页面（焦点若在 composer 输入框，不能一边导览一边打字）。组合键/功能键
（`e.key.length !== 1`）放行——`mod+shift+]` 切模型、`mod+shift+'` 再次切换导览等
照常工作。

## 7 边界与取舍

- **不覆盖未可见元素**：display:none、祖先不可见、视口外都不参与（用户只操作当前屏幕）。
- **数字优先区识别**：侧栏识别用 `[data-sidebar-style]`（框架 sidebar 根标记）。这是
  对框架 DOM 语义标记的最小依赖——属性是"侧栏"的声明性标识，比写死 class 名稳；若框架
  将来重构去掉该属性，数字优先区退化为纯字母分配，功能不坏。
- **disabled 不参与**：`disabled` / `aria-disabled="true"` 过滤。
- **输入控件是聚焦目标**：textarea、文本类 input、contentEditable 的"点击"语义是聚焦
  输入——它们也有 hint，触发 = 聚焦 + 退出导览，直接打字（这是"会话框输入"的键盘入口）；
  checkbox/radio/按钮型 input 是点击目标。hidden 排除。
- **React onClick div 兜底**：React 的 onClick 不产生 DOM onclick 属性，会话列表行、
  列表项等是 `<div onClick>` 无 role/tabIndex——`cursor: pointer`（UI 惯例必配）兜底识别。
  副作用是 hint 可能偏多（hover 也配 pointer 的元素），嵌套去重 + 前缀过滤兜底。
- **拖拽容器排除**：dnd-kit sortable 等拖拽容器是 `role=button` 但点击无动作（click()
  无效）——`aria-roledescription` 含 sortable/draggable 的元素排除。否则它被识别后，
  嵌套去重会把内部真正可点击的目标（便签卡片本体等）吞掉，用户按 hint 没反应。
- **opacity:0 视为不可见**：hover 才显示的装饰按钮（`opacity-0 group-hover:opacity-100`）
  默认不分配 hint（不可见即不可操作）；hover 后可见，滚动/重进导览重扫后可达。
- **触发是原生 click()**：对 button/a/role=button/Radix trigger 都有效；触发后保持模式
  由重扫吸收动态 UI。输入控件走 focus() + 退出。
- **不迁移 keybindings 动作**：本插件不实现任何业务动作，只做"按键 → 点击元素"。组合键
  动作仍归 keybindings 管（单源）。
- **前缀键与输入**：输入态（焦点在可编辑元素）` 完全放行，单击即输入，永不进导览；
  非输入态按 ` 立即进导览。无双击判定——想输入 ` 去输入框单击即可。

## 8 目录

```
key-hints/
  DESIGN.md            # 本文
  plugin.json          # settings 槽 + languages 槽
  core/
    hints.ts           # 纯函数：assignHints(前缀唯一)/assignDigits(数字优先区) + isClickable/isDisabled/isVisible
    hints.test.ts      # assignHints/assignDigits 单测：容量/前缀唯一性/跨组不相交
  renderer/
    index.tsx          # export Overlay(导览状态机 + ` 前缀键监听) + KeyHintsSettings
    settings.tsx       # 设置页：` 前缀键开关 + 触发方式说明
    key-hints.css      # 徽标/高亮/提示条样式（主题 token，不写死颜色）
  locales/             # i18n 资源（插件自持有）
```
