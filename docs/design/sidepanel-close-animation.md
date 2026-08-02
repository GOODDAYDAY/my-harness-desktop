# 右面板板块尺寸模型 + 收起动画

> 状态：已实现 v2（id 键控权重模型；v1 = autoSaveId 位置键控，已废）
> 关联：`src/api/renderer/components/right-panel.tsx`（`RightPanelContent`）、
> `src/api/renderer/index.css`（`.sidepanel-panel-enter`）、react-resizable-panels `^2.1.9`

## 1. 尺寸模型：id 键控权重（v2 核心变化）

### 1.1 需求规则

用户规则：**任何时候都要平分**——多个 sidePanel 板块（收藏/文件/笔记…）在右栏
纵向单列瀑布流，高度初始恒 n 等分、增删后规则确定；同时**保留手动拖拽分隔条**。

"保留拖拽 + 恒平分"乍看矛盾，调和的方案是成熟的**比例权重模型**（iTerm2/
VSCode 面板组的标准做法）：

- 每个板块只持有**相对权重**，渲染尺寸 = 自身权重 / 全部渲染板块权重和 × 100%；
- 初始/新加入权重 = 现存均权 → 没被拖过时打开第 n 个板块就是精确 1/n 等分；
- 用户拖拽只改变权重比例，"平分"不再以"绝对相等"为判据，而以"比例守恒"为判据：
  增删板块时各板块的**相对比例不动**，新块拿平均份、删块空间等比归还。

### 1.2 v1 的问题：autoSaveId 位置键控存档

v1 用库的 `autoSaveId="right-panel-v"` 把布局落 localStorage，按"约束签名"
（panel 数量，不含 tab id）恢复：

1. **存档键不含板块身份**，按**位置**恢复——板块顺序/构成一变（开关、拖拽
   reorder），位置序和板块身份错位，旧布局被恢复到错误的新 panel 上。
2. 窗口遮挡时节流会让**动画中途**（closing panel 近 0）的布局落盘，重开按位置
   恢复出近 0 尺寸，谁落 index 0 谁吃 0——表现为"板块打不开"。
3. v1 为此叠了 `lastSizesRef` 记录 + "重开近 0 修复"巡检 effect 两级补丁：
   补丁的对象（位置键控存档）本身就是错的——这是症状修复不是根因修复。

### 1.3 v2：单一数据源 weightsRef，onLayout 单向回写

```
weightsRef: Map<panelId, weight>     // 唯一的布局意图数据源
渲染: Panel.defaultSize = sizeFor(id) = weight(id) / Σweight(全部 renderIds) × 100
回写: PanelGroup onLayout(sizes) → 按 renderIds 序写回 weightsRef
```

- **id 键控，不键位**：板块怎么重排/增删，权重始终跟着板块走。
- `onLayout` 是**唯一**回写点：初始化、拖拽、关闭动画中间帧都经它——关闭动画
  每帧缩放 closing panel，幸存者的"吸收后尺寸"逐帧自然写回权重，finishClose
  摘除关闭 id 的权重后按剩余权重归一 = 动画末布局，移除瞬间零跳变（直接吃掉
  v1"移除瞬间 defaultSize 快照"那段状态的必要性）。
- **删掉 autoSaveId 与两级补丁**：`lastSizesRef`、"重开近 0 修复"巡检、
  `defaultSizes` state 及"恢复后清空" effect 全删；旧 localStorage 键
  `react-resizable-panels:right-panel-v` 成死数据，不再读写。

### 1.4 三种操作的确定规则

| 操作 | 规则 |
|---|---|
| 加板块 | 新权重 = 现存均权（Σw/n）。未拖过：精确 1/(n+1)；拖过后：新块拿平均份，旧块间比例不动 |
| 删板块 | 摘除其权重，剩余按各自权重归一等比放大——比例守恒 |
| 拖拽 | 库 onLayout 把新布局按 renderIds 序回写成 id 权重 |
| 重开同板块 | 权重已摘 → 视新加入，拿均权（不记忆上次关闭时尺寸） |
| 冷启动 | 权重表空 → 全部均权 → 恒平分（"任何时候都要平分"的落地语义） |

### 1.5 取舍：尺寸不跨会话持久化

手动拖动的比例只在当前窗口会话内有效，重启恢复平分。理由：需求语义就是
"任何时刻从平分出发"；比例记忆的正收益小，而持久化引入的"存档时机/错位/
修复补丁"复杂度已被证明是 v1 的复杂度黑洞。演进：如确需持久化，直接落
`weightsRef` 到 configFile（键控无错位问题），不需要回退 autoSave。

## 2. 收起动画（沿用 v1 决策）

### 2.1 目标形态

1. 该板块在原位置开始平滑收矮——内容同步变暗。
2. 相邻板块（上下）由布局引擎平滑吸收腾出的空间，平滑扩张。
3. 该板块高度归零，从 PanelGroup 移除。其余板块尺寸此时已被布局引擎推到
   目标值，移除瞬间无跳变。

### 2.2 设计决策与原理

**决策一：高度动画交给 PanelGroup 布局引擎做，不自造 CSS 高度动画。**

react-resizable-panels 的尺寸分配 = flex-grow 百分比。单个 panel 高度用
CSS 动画会和 PanelGroup 的布局计算打架。`ImperativePanelHandle.resize(percentage)`
立即设置该 panel 的百分比尺寸，PanelGroup 布局引擎自动把腾出的空间分给
相邻 panel——消费库的既有行为，不自造轮子（§3.1 消费而非翻译、§3.5）。

**决策二：动画时序用 rAF 驱动，不用 `panel.collapse()`，不用 CSS keyframes。**

`collapse()` 动画完成没有回调，靠它就要用 setTimeout 赌时长（v0 就是这么赌的，
还赌错了：赌 240ms 但 exit keyframes 只有 120ms）。rAF 链的**结束帧是确定性
完成信号**，不赌库实现、不赌 CSS 时长（§3.6 事件驱动纪律）。每帧
`handle.resize(startSize × (1 − easeInOutCubic(t)))`，240ms。

**决策三：closing panel 保持原位（修"幽灵跳到末尾"）。**

渲染列表用 `renderIds` state 维护 panel id 顺序，closing id 保持**原位**，
经 reconcile 插回上帧位置（算法见 §3.1）。

**决策四（v2 替换 v1）：移除瞬间的尺寸恢复来源从"瞬时快照 defaultSizes
state"改为"weightsRef 归一的 defaultSize"。**

v1：finishClose 在移除同一 updater 里遍历 panelRefs 快照幸存者尺寸，塞进
`defaultSizes` state，移除后一帧以 defaultSize 精确恢复，恢复完清空。

v2：onLayout 每帧回写权重（§1.3），finishClose 只需摘权重——后续 re-render
的 defaultSize 归一结果天然等于动画末布局。效果相同，状态少一级
（state → ref 纯推导），且不再受"快照与渲染同一 commit"的时序约束。

### 2.3 确定性完成信号，不是赌注

rAF 链由自己控制：结束帧是确定性完成信号。同时把 v0 的 `setTimeout(240ms)`
赌注一并清掉。

### 2.4 视觉序列

1. 原位置平滑收矮，内容变暗（closing 变体 opacity 0.5 + CSS transition）并裁切；
2. 相邻板块平滑扩张；
3. 高度归零 → 移除。三段同帧推进。

## 3. 实现面

### 3.1 状态机

```
renderIds    : string[]                 // PanelGroup 渲染的 panel id 顺序（活跃 ∪ closing）
closingIds   : string[]                 // 正在收起的 id
weightsRef   : Map<string, number>(ref) // 尺寸模型单一数据源：panel id → 权重
startSizes   : Map<string, number>(ref) // 各 closing panel 的动画起始尺寸，取消时精确恢复
```

渲染列表 = `renderIds`；渲染变体 = id 在活跃集合里 → 活跃，否则 → closing
变体（panel `collapsible collapsedSize={0} minSize={0}`，内容区 overflow-hidden）。

`sizeFor(id)`（defaultSize 数据源）：遍历**本批 renderIds**，缺权重的 id 以均权
幂等填充（同一渲染内所有 panel 共享同一分母），返回 `weight/Σ × 100`。

`syncWeights(sizes)`（PanelGroup `onLayout`）：按 `renderIdsRef.current` 序把
`sizes[i]` 写回 `weightsRef`——库布局变化的唯一回写点。

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

- DURATION：240ms（entry 用 `--motion-duration-normal: 200ms`，exit 略慢一点
  让高度收起从容）。
- ease：`easeInOutCubic`（rAF 链里的 t 映射）。
- 已知缺口：DURATION/ease 不进 CSS token 体系（rAF 在 JS 里）——演进可加
  motion token。

### 3.3 边界

- closing 期间再点同一 strip 图标（重新激活）：主 effect 检出 reopened id →
  从 closingIds 移除 → cancel effect `cancelAnimationFrame` 停 rAF，`resize`
  回 startSizes 记录的起始尺寸；onLayout 随之把权重写回，权重无需手动恢复。
- 关闭完成：rAF 结束帧 finishClose——`resize(0)`、`weightsRef.delete(id)`、
  从 renderIds 与 closingIds **同步移除**。closingIds 不清会导致重新激活时
  reconcile 把同一 id 插入两次（duplicate key）。
- closing 期间拖其他 handle：拖动能正常动（rAF 每帧 getSize 重读）。
- **组内只剩一个 panel**：主 effect 走 instant 路径——直接过滤移除，不进
  closing/rAF 流程。两层原因：①库 imperative `resize()` 对单 panel 组算出的
  pivot 是 `[-1, 0]`，`adjustLayoutByDelta` 断言 `initialLayout[-1]` 直接抛错
  白屏；②instant 直接移除避免 reconcile 与 finishClose 在同一批更新里互相
  抵消形成"移而不除"无限循环。单 panel 恒 100%、无邻居可吸收，动画本无意义。
- **多 tab 同关（其余 panel 先收完、组内剩本 panel）**：tick 内守卫检测
  panelRefs.size ≤ 1 → 终止 rAF、finishClose 直接移除。
- **closing 流程里的全部 setState 必须幂等（G-20260802-01）**：主 effect 的
  依赖含 `closingIds`，内容没变却返回新引用会让 effect 自触发、动画全程每秒
  数百次空转；空转帧持过期闭包与 rAF 结束帧的移除更新同批竞合，曾造成
  "缩到 0 的是最上面的板块 + 240ms 周期无限循环"。修复：全部
  setClosingIds/setRenderIds 内容无变化时返回原引用（`sameIds` 浅比较）。该
  纪律与尺寸模型无关，v2 继续适用。
- 全部 tab 一次性关闭（`activeTabs → []`）：renderIds 全 closing，全部原位
  收起到 0，最终 PanelGroup 空 → 落空态分支。

### 3.4 已知缺口（演进，显式标注）

- 进入侧保持现状 `.sidepanel-panel-enter` CSS fade-in——演进可用 rAF 从 0
  对称 expand，本次范围只做收起侧。
- DURATION / ease 不进 CSS token 体系——演进可挂 motion token。
- 板块比例不跨会话持久化（§1.5）——需要时落 weightsRef 到 configFile 即可。
- 旧 localStorage 键 `react-resizable-panels:right-panel-v` 成死数据——无害，
  不主动清。

## 4. v1 → v2 diff 摘要

| 点 | v1 | v2 |
|---|---|---|
| 尺寸数据源 | autoSaveId 位置键控存档 + 关闭瞬时 defaultSizes state 快照 | weightsRef id 键控权重，defaultSize 归一推导 |
| 加板块布局 | 库重分配 + autoSave 恢复（结果不确定） | 新块均权，旧块比例不动 |
| 删板块布局 | autoSave 恢复失败 → 全量重分 + defaultSize 快照精确恢复 | 摘权重 → 剩余等比放大，零跳变 |
| 布局持久化 | localStorage（可毒化） | 不持久化；会话内有效 |
| 防御补丁 | lastSizesRef 记录 + 重开近 0 巡检效应 | 无（根因类随 autoSaveId 被消除） |
| 拖拽 | 保留 | 保留（onLayout 单向回写权重） |
