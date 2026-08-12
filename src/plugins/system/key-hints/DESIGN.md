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

类似 tmux 前缀键的语义：

- **单击 `**：250ms 窗口后进入导览模式（按下即有准备看标记的时间）；
- **双击 ``（窗口内再按一次）**：视为"想输入 ` 字符"，把单个 ` 插入当前焦点输入框，
  不进入模式。

窗口判定用物理键 `e.code === "Backquote"`，不受输入法/大小写影响（中文输入法下该键
输出 · 也能命中）。导览模式激活期间前缀键不参与（退出走 Esc）。

为什么需要双击语义：` 一旦被用作触发键，用户就永远无法在输入框里输入 ` 字符。双击
放行解决了这个问题——按两次等于输入一个，是 tmux 前缀键的通行做法。

## 4 hint 分配：前缀唯一 + 区分大小写

### 4.1 字符表

`a-z` + `A-Z` 共 52 个单字符 hint，**区分大小写**（a 与 A 是两个不同 hint）。

### 4.2 前缀唯一（prefix code）

任意两个 hint 不互为前缀。这样按键序列不会歧义：输入过程中按前缀过滤候选，按完整个
hint 必然唯一命中。

单字符 52 个够用时全部单字符。超出时从字符表**尾部让位** h 个字符作为双字符组的首字符：
单字符池与双字符首字符池不相交（让位出去的字符不再作为单字符），前缀唯一性由构造保证。
总容量 52 + 51×h，h=2 时到 154——虚拟列表只渲染视口内元素，实际命中数远低于此，超过
154 的部分不分配。

`assignHints(count)` 是纯函数（无 DOM 依赖），可裸单测。

## 5 交互状态机

```
inactive ──触发(keyhints:toggle / 前缀键单击)──▶ active
  ▲                                                │
  │                                                │ 按字母:前缀过滤
  │                                                ▼
  │                                            匹配中(typed)
  │                                                │ 唯一完整命中
  │                                                ▼
  │                                           el.click() + 重扫
  │                                                │
  └──── Esc / 点击导览层外 ◀────────────────────────┘
```

- **进入**：扫描 `body *`，过滤出可点击（button/a[href]/select/summary/option/非输入型
  input/语义 role/onclick 属性/可聚焦）且未禁用、可见、在视口内的元素；嵌套去重（元素
  的可点击祖先已在集合则跳过它——点祖先即可）；按文档序分配 hint。
- **过滤**：按字母键累积 typed，命中前缀的候选保持高亮，不匹配的变暗；无匹配则清空
  typed 重来。
- **触发**：typed 完整等于某个 hint（前缀唯一保证此时必然唯一）→ `el.click()` →
  **保持模式并重扫**。重扫吸收 DOM 变化（点击模型按钮后 Radix 菜单打开，菜单项进入
  候选，可继续用 hint 选模型；选完菜单关闭再重扫，继续切思考深度……）。连续操作不用
  反复进出模式。
- **退出**：Esc；点击导览层（提示条/徽标）之外的任意处；再次触发组合键。
- **滚动**：capture 滚动监听 + 120ms 防抖重扫——徽标位置随滚动重算，新进入视口的元素
  获得 hint，滚出去的消失。

## 6 键盘独占

导览模式激活期间，keydown 用 window capture + `stopImmediatePropagation` 独占：
字母键不落到页面（焦点若在 composer 输入框，不能一边导览一边打字）。组合键/功能键
（`e.key.length !== 1`）放行——`mod+shift+]` 切模型、`mod+shift+'` 再次切换导览等
照常工作。

## 7 边界与取舍

- **不覆盖未可见元素**：display:none、祖先不可见、视口外都不参与（用户只操作当前屏幕）。
- **disabled 不参与**：`disabled` / `aria-disabled="true"` 过滤。
- **输入型控件不参与**：textarea、文本类 input、contentEditable 的"点击"语义是聚焦输入，
  不是动作，不给 hint（checkbox/radio/按钮型 input 保留）。
- **触发是原生 click()**：对 button/a/role=button/Radix trigger 都有效；触发后保持模式
  由重扫吸收动态 UI。
- **不迁移 keybindings 动作**：本插件不实现任何业务动作，只做"按键 → 点击元素"。组合键
  动作仍归 keybindings 管（单源）。
- **前缀键误触窗口**：输入框里单按 ` 会在 250ms 后进入导览模式。这是 tmux 前缀键的固有
  权衡，双击放行已覆盖"要输入 `"的场景；窗口期内再按一次即安全。

## 8 目录

```
key-hints/
  DESIGN.md            # 本文
  plugin.json          # languages 槽
  core/
    hints.ts           # 纯函数：assignHints(前缀唯一) + isClickable/isDisabled/isVisible
    hints.test.ts      # assignHints 单测：容量/前缀唯一性
  renderer/
    index.tsx          # export Overlay（导览模式状态机 + 前缀键监听）
    key-hints.css      # 徽标/高亮/提示条样式（主题 token，不写死颜色）
  locales/             # i18n 资源（插件自持有）
```
