# 右面板板块收起动画重设计

> 状态：已实现
> 关联：`src/api/renderer/components/right-panel.tsx`（`RightPanelContent`）、`src/api/renderer/index.css`（`.sidepanel-panel-enter`）、react-resizable-panels `^2.1.9`

## 1. 问题：多板块时收起动画"不好看"

### 1.1 现状机制（代码注释 G-20260201-03）

`RightPanelContent`（`src/api/renderer/components/right-panel.tsx`）用
react-resizable-panels `^2.1.9` 的 `PanelGroup direction="vertical"` 垂直堆叠
多个激活的 sidePanel tab，每个 tab 一个 `Panel`，相邻间一个 `PanelResizeHandle`。

tab 关闭（strip 图标再点一次 → `activeSidePanelTabs` 移除该 id）时，Panel 瞬间从
PanelGroup 消失、没有过渡。当前的过渡 trick（代码注释 G-20260201-03）：

1. effect 发现某 id 从活跃集合消失 → 加入 `exitingIds` 快照。
2. exiting panel 由 `exitingItems.map(...)` 追加到 `PanelGroup` **末尾**，
   播 `.sidepanel-panel-exit` keyframes（纯 opacity 淡出）。
3. `setTimeout(240ms)` 后从 `exitingIds` 移除，Panel 真正卸载。

### 1.2 "不好看"的三个叠加根因

**根因一：幽灵跳到末尾（视觉错位，最刺眼）**

`exitingItems.map(...)` 把 exiting panel 追加渲染到 `PanelGroup` **末尾**，
不在它原来的位置。收起中间板块时：该 panel 从中间瞬间消失 → PanelGroup
按百分比重分配、布局瞬间重排 → 幽灵 panel 出现在**列表末尾**淡出。
用户看到：中间的板块消失、下面的板块瞬间上跳闭合、末尾冒出一个板块
渐隐——布局跳变 + 幽灵错位淡出，错位感强烈。

**根因二：只有 opacity 淡出，没有高度收起**

exiting panel 在它原来的占位尺寸里原位淡出（`sidepanel-panel-out` 只动
opacity），240ms 后从 PanelGroup 移除时，剩余 panel 瞬间按百分比重分尺寸。
视觉上是一次跳变（中间闭合）+ 一个幽灵（末尾静态挂了 240ms 再渐隐消失）
+ 又一次跳变（末尾幽灵消失，剩余重分）。

**根因三：240ms setTimeout 是赌注，而且赌错了**

`setTimeout(…, 240)` 赌退出动画在 240ms 内播完——但 `.sidepanel-panel-exit`
用的是 `--motion-duration-fast: 120ms`。赌了两倍动画时长，幽灵 panel 在
动画播完后还多挂 120ms 才被卸载。违反 `CLAUDE.md §3.6` 事件驱动纪律：
setTimeout 是对时序的赌注。

## 2. 设计

### 2.1 目标形态

收起一个板块时的视觉序列：

1. 该板块在原位置开始平滑收矮——内容同步变暗。
2. 相邻板块（上下）由布局引擎平滑吸收腾出的空间，平滑扩张。
3. 该板块高度归零，从 PanelGroup 移除。其余板块的尺寸此时已被布局引擎
   推到目标值，移除瞬间无跳变。

三段视觉——原位收矮 + 内容渐隐 + 邻居平滑扩张——三段同帧推进。

### 2.2 设计决策与原理

**决策一：高度动画交给 PanelGroup 布局引擎做，不自造 CSS 高度动画。**

react-resizable-panels 的尺寸分配 = flex-grow 百分比。单个 panel 高度用
CSS 动画会和 PanelGroup 的布局计算打架（它管 flex-grow 和相邻分配）。
`ImperativePanelHandle.resize(percentage)` 立即设置该 panel 的百分比尺寸
（实证：类型名 `ImperativePanelHandle`），PanelGroup 布局引擎自动把腾出的
空间分给相邻 panel——**邻居平滑扩张正是库布局引擎的天职**。消费库的既有
行为，不自造 CSS 高度动画（§3.1 消费而非翻译、§3.5 不重复发明轮子）。

**决策二：动画时序用 rAF 驱动，不用 `panel.collapse()`（库内部动画），
不用 CSS keyframes。**

`panel.collapse()` 动画完成没有回调——库内部动画时长是实现细节，不可知。
要靠它就要用 setTimeout 赌时长——现有实现（G-20260201-03）就是这么赌的，
而且赌错了：赌 240ms 但 exit keyframes 只有 `--motion-duration-fast: 120ms`，
幽灵 panel 多挂 120ms。

rAF 链由自己控制：**结束帧是确定性完成信号**，不赌库内部动画时长、不赌
CSS keyframes 时长（§3.6 事件驱动纪律）。每帧
`handle.resize(startSize × (1 − easeInOutCubic(t)))`，240ms。
`panelRef.resize(pct)` 立即生效（无库内动画——动画由我的 rAF 驱动）。

**实证补充（移除瞬间的尺寸恢复）**：库移除 panel 时默认行为是"剩余均分"
（autoSaveId 的 panelKey 由 id 集合决定；id 集合变化 → localStorage 恢复
失败 → `calculateUnsafeDefaultLayout` 全量重分配，剩余 panel 随即重分）。
所以移除 closing panel 的瞬间，必须给活跃 panel 传
`defaultSize={移除瞬间记录的当前尺寸}`——库自身分配逻辑会先分配 defaultSize
做精确恢复，剩余 0 即无重分。这是本设计的最后一块：缺了它，不管收起到 0
的过程多流畅，移除瞬间的全量重分配仍然是一次跳变。

**决策三：closing panel 保持原位（修"幽灵跳到末尾"）。**

现有实现把 exiting panel 追加到 `PanelGroup` **末尾**（`exitingItems.map(...)`
渲染在 `orderedItems.map(...)` 之后）——收起中间板块时幽灵 panel 跳到
末尾淡出，布局瞬间重排。这不是淡出不好，是淡出+跳位叠加。

修正：渲染列表用 `renderIds` state 维护 PanelGroup 的 panel id 顺序，
closing id 保持**原位**。reconcile 算法：

```
next = [...activeIds]                        // 活跃顺序为骨架(含新增 id)
for (const cid of closingIds):
  if next.includes(cid): continue            // 重新激活的 id 已在骨架里,跳过防重复
  idx = prev.indexOf(cid)                    // closing 在上帧位置
  anchor = -1
  for i = idx-1 .. 0: j = next.indexOf(prev[i]); if j !== -1 { anchor = j; break }
  next.splice(anchor + 1, 0, cid)            // 找不到锚点插最前
```

已验证(prev=[A,B,C])：关 B+C → [A,B,C]；关 B 同时末尾新增 D → [A,B,D]；
关 A → 插最前。

### 2.3 确定性完成信号，不是赌注

rAF 链由自己控制：**结束帧是确定性完成信号**。这同时把现有实现的
`setTimeout(240ms)` 赌注一并清掉——那个赌注不仅赌（动画在 240ms 内播完），
而且赌错了（赌 240ms，但 exit keyframes 只有 `--motion-duration-fast: 120ms`，
幽灵 panel 多挂 120ms 才卸载）。

### 2.4 视觉序列

收起一个板块时：

1. 该板块在**原位置**开始平滑收矮——内容同步变暗（closing 变体 opacity 0.5
   + CSS transition）并随高度收起被裁切。
2. 相邻板块由 PanelGroup 布局引擎平滑吸收腾出的空间，平滑扩张。
3. 该板块高度归零，从 PanelGroup 移除。其余板块尺寸此时已被推到目标值，
   移除瞬间无跳变。

三段视觉同帧推进：原位收矮 + 内容变暗 + 邻居平滑扩张。

## 3. 实现面

### 3.1 状态机

```
renderIds    : string[]                 // PanelGroup 渲染的 panel id 顺序（活跃 ∪ closing）
closingIds   : string[]                 // 正在收起的 id
defaultSizes : Record<string, number>   // 移除瞬时：panel id → defaultSize，恢复后清空
startSizes   : Map<string, number>(ref) // 各 closing panel 的动画起始尺寸，取消时精确恢复
```

渲染列表 = `renderIds`；渲染变体 = id 在活跃集合里 → 活跃，否则 → closing
变体（panel `collapsible collapsedSize={0} minSize={0}`，内容区 overflow-hidden）。

reconcile（活跃顺序为骨架，closing id 插回上帧原位）：

```
next = [...activeIds]
for (const cid of closingIds):
  if next.includes(cid): continue            // 重新激活的 id 已在骨架里,跳过防重复
  idx = prev.indexOf(cid)
  anchor = -1
  for i = idx-1 .. 0: j = next.indexOf(prev[i]); if j !== -1 { anchor = j; break }
  next.splice(anchor + 1, 0, cid)            // 找不到锚点 → 插最前
```

已验证：prev=[A,B,C] 关 B+C → [A,B,C]；关 B 同时末尾新增 D → [A,B,D]；
关 D 新增 A → [A,B,D] → 关 A → 插最前 ✅。

### 3.2 动画参数

- DURATION：240ms（沿用现有 exit 时长的量级；entry 现用
  `--motion-duration-normal: 200ms`，exit 略慢一点让高度收起从容）。
- ease：`easeInOutCubic`（rAF 链里的 t 映射；视觉开窗）。
- 已知缺口：DURATION/ease 目前不进 CSS token 体系（rAF 在 JS 里）——
  演进可加 motion token。

### 3.3 边界

- closing 期间再点同一 strip 图标（重新激活）：主 effect 检出 reopened id
  （在 closingIds 但已回活跃集合）→ 从 closingIds 移除 → cancel effect
  cancelAnimationFrame 停 rAF，并 resize 回 startSizes 记录的起始尺寸精确恢复
  （库的 `expand()` 只对 collapsed panel 有效，rAF 中途尺寸不靠它恢复）。
- 关闭完成：rAF 结束帧 finishClose——resize(0)、记录其余 panel 尺寸到
  defaultSizes、从 renderIds 与 closingIds **同步移除**。closingIds 不清会
  导致重新激活时 reconcile 把同一 id 插入两次（duplicate key）。
- closing 期间拖其他 handle：拖动能正常动（rAF 每帧 getSize 重读，不缓存
  动态值以外的中间值）。
- 全部 tab 一次性关闭（`activeTabs → []`）：renderIds 全 closing，
  全部原位收起到 0，最终 PanelGroup 空 → 落空态分支。**无 defaultSizes
  需求**——空 PanelGroup 无 panel 可恢复，不需快照。
- 移除瞬间的系统行为：active panel 的 defaultSize 用**移除瞬间记录值**，
  恢复后立即清空 state（panel 常态不带 defaultSize）。defaultSizes 只在
  移除那一帧存在，不进入 autoSave/localStorage。

### 3.4 已知缺口（演进，显式标注）

- 进入侧保持现状 `.sidepanel-panel-enter` CSS fade-in——演进可用 rAF
  从 0 对称 expand，本次范围只做收起侧。
- DURATION / ease 不进 CSS token 体系（rAF 在 JS 里）——演进可挂 motion token。

## 4. 与现状的 diff 摘要

| 点 | 现状（G-20260201-03） | 本设计 |
|---|---|---|
| exiting 位置 | 追加到 PanelGroup **末尾** | **保持原位** |
| 高度 | 不变（只 opacity 淡出） | rAF 平滑收起到 0 |
| 邻居行为 | 两次瞬间重排 | 平滑吸收 |
| 完成信号 | `setTimeout(240ms)` 赌注（还赌错了：exit keyframes 只有 120ms） | rAF 结束帧，确定性 |
| 移除瞬间 | 剩余 panel 按 defaultSize=null 全量重分（跳变） | defaultSize=记录值精确恢复（无跳变） |
