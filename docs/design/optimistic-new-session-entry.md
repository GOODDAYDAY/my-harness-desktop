# 乐观新建会话条目

点「+」新建会话（或冷启动 / 切目录进入「新对话」态）时，左侧会话列表顶部立即出现一个高亮的「新对话」占位条目——让用户一眼看到「当前上下文是一个全新的、尚未落盘的会话」，而不是等首条消息发出、会话文件落盘、列表重拉之后才看到反馈。首条消息落盘后，占位条目消失，由真实会话条目接管。

## 0 问题与背景

### 0.1 现状：点「+」列表零反馈

`sessions-list` 的 `newSession()` 当前只做两件事：

```ts
const newSession = async (): Promise<void> => {
  setCurrentSessionPath(null);
  setSessionTitle(null);
  await useSessionStore.getState().startNewChat(currentCwd);
};
```

`currentSessionPath` 置 null（清高亮）、`startNewChat` 清空视图投影（`setContext(cwd, null)` + 清 `messages/snapshot/stats`）。**列表本身（`sessionInfos`）一个字不变**——因为列表数据源是框架扫描会话文件得到的 `sessionInfos`，而新会话此时还没有文件。

结果是：点「+」之后，列表里没有任何一行被高亮，也没有任何条目表示「当前上下文是新对话」。要等用户发出首条消息 → main `ensureForSend` 生成会话文件路径 → `sessionStart` 事件 → 框架重拉列表 → 新条目才出现。中间的 spawn 延迟（tsx dev pi 约 1~2s）里，列表是「死」的。

### 0.2 现有乐观模式

列表里已有两处乐观模式，本方案是第三处、同一层：

- **乐观选中**（`select()`）：点击瞬间同步写 `currentSessionPath`/`sessionTitle`，不等 IPC，失败回滚。
- **乐观移除**（`removing` 集合）：归档/删除点击瞬间把行从渲染树摘掉（播 exit 动画），权威重拉后清标记。

本方案延续同一纪律：**`sessionInfos` 是框架维护的权威数据源，插件只在其上做渲染投影，不改 store、不回退到插件侧拉取**。

## 1 判定信号

占位条目出现的充要条件：

```ts
const showOptimistic =
  !loading &&                 // sessionInfos 已拉取(防首帧闪烁)
  !!currentCwd &&             // 已打开目录
  currentSessionPath === null && // 「新对话壳」:尚无会话文件绑定
  !query;                     // 搜索态不显示(占位无 name/lastMessage 可匹配)
```

`currentSessionPath === null` 精确表达「新对话壳、尚无会话文件绑定」，它出现在三处、也只该出现在这三处：

- 点「+」→ `newSession()` → `setCurrentSessionPath(null)`。
- 冷启动 → `startNewChat(lastCwd)`（`currentSessionPath` 初始即 null，且 `setContext(cwd, null)` 不 dispatch `sessionStart`）。
- 切目录 → projects 插件 `setCurrentSessionPath(null)` + `startNewChat(dir)`。

打开历史会话后 `currentSessionPath` 必为真实路径（`openSession` 显式写 + main 权威 `sessionStart` 水合），故占位不显示。

### 1.1 与 timeline 空态的区别（关键，别混淆）

timeline 用「无 `role === "user"` 消息」判定空态（`timeline/renderer/index.tsx:887`）；列表用 `currentSessionPath === null` 判定占位。二者不冲突，且**必须**不同：

- **打开一个空的历史会话**：文件存在、`currentSessionPath` 非 null → timeline 显示空态（无 user 消息），列表显示真实条目（高亮）——正确，因为那是一个真实文件。
- **新对话壳**：`currentSessionPath` null、无 user 消息 → timeline 显示空态，列表显示乐观占位——正确。

如果列表也用「无 user 消息」判定占位，打开空历史会话时会误把真实条目替换成占位，丢掉了「这是一个真实文件」的事实。所以列表的判据必须是 `currentSessionPath === null`，不是消息内容。

## 2 渲染

占位行渲染在列表最顶部、所有分组（pinned / 时间档 / archived）之上，不走 `GroupBlock`/`SortableRow`——它不可分组、不可拖拽、不进 `customOrder`。

```tsx
<AnimatePresence mode="popLayout">
  {showOptimistic && (
    <motion.div key="new-chat" layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <NewChatRow onClick={() => void newSession()} />
    </motion.div>
  )}
  {groups.map((g) => (/* 既有 GroupBlock */))}
</AnimatePresence>
```

`NewChatRow` 是 `SessionRow` 的极简版，视觉与正常行同构（同 `--sidebar-row-*` token），但：

- 标题 = `t("sessions.newChat")`（新增 i18n key，文案「新对话」）。
- 副标题 = 空（行高对齐正常行）。
- 图标 = 空心 `MessageSquare`（idle：新对话尚未运行；active 行用 active 背景/边框/阴影高亮，图标仍空心区分「无进程」）。
- 无右键菜单、无 hover 操作区、无未读点、无子会话展开。
- 点击 = 幂等 `newSession()`（与「+」同语义，重复点击无副作用）。
- 稳定 key = `new:${currentCwd}`（代码库既有哨兵，见 `session-store.ts` / `ui-store.ts` 的 `new:${cwd}` 用法），`data-session-path` 同值便于调试。

## 3 生命周期与迁移

1. 进入新对话态 → 占位出现（active 高亮）。
2. 用户发首条消息 → renderer `sendMessage` 乐观回显 + `prompt` → main `ensureForSend` 生成会话路径 + `dispatch(sessionStart, sessionFile = path)`。
3. renderer `initSessionStore.onEvent` 收到 `sessionStart` → `setCurrentSessionPath(path)`；框架 `onKernelEvent` 收到 `sessionStart` → 重拉列表 → `sessionInfos` 含新文件。
4. `currentSessionPath` 非 null → 占位消失；真实条目以 active 态出现（阶段由真实路径 key 的事件推进）。

第 2 步有个 key 迁移要交代清楚（这是「占位阶段恒 idle」的根因）：

- `ensureForSend` 里 `sessionStart` 用 `this.activeProcKey`（此刻仍是 `new:${cwd}`）dispatch，`sessionKey = new:${cwd}`。
- 随后 `start()` 把 `activeProcKey` 迁到生成的会话路径，`createProc` 的事件闭包按 `proc.key`（= 真实路径）路由，所以 `messageStart` 等后续事件 `sessionKey = 真实路径`。

对占位行的影响：`sessionStart` 在 `advancePhase` 里是 no-op（default 分支返回 prev），而真正推进阶段的事件（`messageStart`/`agentStart`…）都挂在真实路径 key 下——彼时占位已因 `currentSessionPath` 非 null 而消失。因此占位行不需要接入 `phaseByPath`/`lastEntryByPath`/`readState`，阶段恒 idle、未读恒 false。

## 4 边界

- **搜索态**（`query` 非空）：不显示占位——搜索语义是「在已有会话里找」，占位无 `name`/`lastMessage` 可匹配。
- **loading**：不显示——避免 `sessionInfos` 未拉取时的首帧闪烁。
- **发送首条消息失败**（`sendMessage` 在 `prompt` 前返回 `{ok:false}`，如模型偏好回灌失败）：无文件、`currentSessionPath` 仍 null → 占位保留，正确（用户仍在全新会话）。
- **连续点「+」**：`newSession` 幂等，占位保持。
- **空目录**（`filtered.length === 0`）：占位出现时抑制「暂无会话」空态——因为「当前新对话」本身就是可见内容，再叠「暂无会话」会自相矛盾。空态条件由 `filtered.length === 0` 收紧为 `filtered.length === 0 && !showOptimistic`。

## 5 归属与不变量

纯渲染层派生（插件本地），不触碰任何既有契约：

- 不新增框架 store 字段——`currentSessionPath`/`currentCwd`/`sessionInfos` 都是既有字段。
- 不改圆心契约、不改内核、不改 main——占位是插件在权威数据之上的渲染投影。
- `sessionInfos` 权威数据源不动，与 `removing`（乐观移除）、`select`（乐观选中）同一层。

三条内核无关不变量（§7.5）继续成立：壳不读内核存储（占位不读任何文件）、只认中性事件（占位不消费内核专属形状）、渲染是纯函数（给定同一条 `sessionInfos` + `currentSessionPath`，占位显示与否与内核无关）。

## 6 落地清单

| 文件 | 改动 |
|---|---|
| `src/plugins/sessions/sessions-list/renderer/index.tsx` | 新增 `showOptimistic` 判定 + `NewChatRow` 组件 + 顶部渲染；空态条件加 `!showOptimistic` |
| `src/plugins/sessions/sessions-list/locales/{zh-CN,zh-TW,en,de}/sessions.json` | 新增 `sessions.newChat` key |
