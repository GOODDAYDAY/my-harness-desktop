# 会话头行扩展：custom-pi-desktop 通用设置通道

pi-desktop 的插件经常有会话级的信息要存——timeline 的显示偏好、git-review 的过滤规则、session-bookmarks 的标注。这些信息和会话本身同生共死：会话在，信息在；会话删了，信息该跟着没。问题是现在没有一个通用通道让插件往会话文件里塞自己的东西。每个插件想存会话级设置，要么自己找土办法，要么走 `updateHeader` 往 header 里硬加枚举字段——后者要改四处代码（`domain/sessions.ts` 的类型定义、`application/sessions/session-scanner.ts` 的写入分支、`shell/electron-main/preload.ts` 的 IPC 参数、`shell/electron-main/index.ts` 的 IPC handler），内核被迫认识每种设置的语义。

方案很直接：在 header 里开一个 `custom-pi-desktop` 字段，所有插件的会话级设置都往这一个字段里塞，框架提供通用读写，内核不感知里面装了什么。

## 1. 问题：插件往哪存会话级信息

### 1.1 场景

插件有会话级的信息要持久化。这不是跨会话的全局配置（那种该走 `~/.pi-desktop/` 下的配置文件），而是绑在某个具体会话上的、跟着这个会话生灭的信息。几个真实场景：

- timeline 插件想记住"这个会话里用户折叠了哪些工具执行条"——下次打开同一会话，折叠状态恢复。
- git-review 插件想记住"这个会话评审时过滤了哪些文件类型"——换次对话还在。
- session-bookmarks 已经在用 `updateHeader` 存 pinned/archived，但那是内核枚举字段，不是插件能自由扩展的。

这些信息的共同特征：生命周期和会话一致。会话文件被删除，信息自动消失，不需要额外清理；会话文件被复制到另一台机器，设置跟着走。

### 1.2 现有 HeaderPatch 的问题

header 第一行当前长这样：

```json
{"type":"session","id":"abc-123","timestamp":"2026-07-29T...","cwd":"/Users/.../project","name":"修复登录bug","pinned":true,"toolConfig":{"mode":"custom","enabledGroupIds":["read"]}}
```

type/id/timestamp/cwd 是 pi 底座（pi-desktop 管理的独立 AI agent 子进程，负责创建会话文件和写入基础字段）在创建会话时写的，桌面端不碰。name/pinned/archived/toolConfig 是桌面端通过 `updateHeader` patch 进去的——但每加一种新设置，都要改四个地方：

- `domain/sessions.ts` 的 `HeaderPatch` 类型加字段定义。
- `session-scanner.ts` 的 `updateSessionHeader` 加 `if ("xxx" in patch)` 分支。
- `preload.ts` 的 IPC 参数类型加字段。
- `electron-main/index.ts` 的 IPC handler 透传。

toolConfig 走通了这条路，但它是靠把工具组配置的语义焊进内核才走通的——`HeaderPatch` 里有 `toolConfig?: SessionToolConfig | null`，scanner 里有专门的处理分支。如果 timeline 想存折叠状态、git-review 想存过滤规则，难道每种都给 HeaderPatch 加一个枚举字段、给 scanner 加一个分支？内核会越来越胖，每加一种设置都要发版改内核。这和"内核只有机制，内容全部外挂"的纪律冲突——toolConfig 是内容，不该焊在内核里。

### 1.3 为什么是 header 第一行

JSONL 文件的结构是：第一行 session header，后续每行是会话条目（消息、模型变更、压缩记录等）。第一行是整个文件里位置最稳定的锚点——`content.split("\n")[0]` 一行代码拿到，不用扫全文。最后一行也固定，但会随着新消息追加而不断变化，不适合做写入后相对稳定的设置存储。

body 里的 `type:"custom"` 条目理论上也能存东西，但它的位置不固定——可能在整个文件的任何一行，要读它得从头扫到尾。而且 body 里的条目语义是"会话过程中发生了什么"（事件流的一部分），不是"这个会话的设置是什么"（元数据）。设置是元数据，该在 header 里，和 name/pinned/archived 同层。

会话文件的自包含性是另一个理由。header 里的设置跟着文件走——复制会话文件到另一台机器、迁移到另一个目录，设置都在文件里，不需要额外的配置库做关联。如果设置存在别处（比如一个全局数据库按 sessionId 索引），删会话时要单独清理孤儿数据，迁移时要导出导入——全是不该有的复杂度。

已有基础设施也是现成的。`updateHeader` 已经实现了行级 patch（只改第一行，其余行原样保留），`withDirLock`（已有的目录级文件锁机制，保证同一目录下的文件操作串行化）已经防了并发写冲突，IPC 通道 `session:updateHeader` 已经注册。插件不需要新的文件操作、新的锁、新的 IPC——复用已有的就行。

## 2. 方案：custom-pi-desktop 单字段 + 框架通用读写

### 2.1 一个字段装所有

在 header 里新增一个 `custom-pi-desktop` 字段，类型是 JSON object。所有插件的会话级设置都塞进这一个字段，按 pluginId 做 key 隔离。结构长这样：

```json
{
  "type": "session",
  "id": "abc-123",
  "timestamp": "2026-07-29T...",
  "cwd": "/Users/.../project",
  "name": "修复登录bug",
  "pinned": true,
  "custom-pi-desktop": {
    "timeline": { "collapsedToolIds": ["call_001", "call_003"] },
    "git-review": { "filterMode": "staged", "excludeGlobs": ["*.lock"] }
  }
}
```

每个插件在自己的 pluginId 下放自己的结构化数据。timeline 存折叠的工具条 id 列表，git-review 存过滤模式，各管各的，互不干涉。key 是 pluginId——这是个天然的命名空间，插件之间不会撞 key，因为插件 id 本身是唯一的（加载器在注册时校验）。

为什么不是一个字段对应一个插件（`timeline: {...}`、`git-review: {...}` 作为 header 的顶层字段）？因为 header 是一个 flat object，插件数量不确定。如果每个插件在 header 顶层占一个字段，header 的字段列表会无限膨胀，扫描列表时每次都要 parse 一堆不认识的字段。收进一个 `custom-pi-desktop` 子对象里，header 顶层字段数固定，扫描器只多读一个字段，其余字段不受影响。

### 2.2 框架提供通用读写

插件不需要自己拼路径、自己读文件、自己加锁、自己处理"旧文件没这个字段"的回退。框架提供两个 API，挂在 `SessionsApi` 上（`SessionsApi` 是 `domain/sessions.ts` 中定义的会话生命周期接口，插件经 `usePluginContext(pluginId)` 拿到绑定后的上下文，上下文里的 `sessions` 属性就是这个接口的实现）：

- **读**：`getCustomData(sessionPath, pluginId)` → 返回 `unknown | null`。框架读 header 第一行，取 `custom-pi-desktop[pluginId]`，没有就返回 null。`pluginId` 就是插件自己的 id——`usePluginContext(pluginId)` 调用时传入的值，和 `plugin.json` 里的 `id` 字段一致。
- **写**：`setCustomData(sessionPath, pluginId, data)` → 写自己的 key，不影响其他插件的 key。`data` 传 null 表示删除自己这个 key。框架读出整个 `custom-pi-desktop` 对象，patch 掉 `pluginId` 对应的 key，写回 header。

为什么不直接用现有的 `updateHeader({custom: {"my-plugin": data}})`？因为 `updateHeader` 对 `custom` 字段做的是**整体替换**——传入的 `custom` 对象会整个覆盖掉 header 里原有的 `custom-pi-desktop`，其他插件写的数据会被覆盖。`setCustomData` 做的是 **key 级合并**：框架先读出当前完整的 `custom-pi-desktop` 对象（里面可能有别的插件的数据），只修改目标 key，再整体写回。这依赖 `withDirLock` 保证读-改-写是一个原子操作：同目录下不会有两个插件同时读到旧值再各自写回。

### 2.3 内核不感知内容

内核对 `custom-pi-desktop` 的处理和对 `toolConfig` 的处理是根本不同的。

`toolConfig` 当前的处理方式：`HeaderPatch` 里有 `toolConfig?: SessionToolConfig | null`，scanner 里有 `if ("toolConfig" in patch)` 专门分支，IPC handler 专门透传 toolConfig。内核认识 `SessionToolConfig` 的结构——知道它有 `mode` 和 `enabledGroupIds`，知道 null 语义是"删字段"。这是内核感知内容。

`custom-pi-desktop` 的处理方式：`HeaderPatch` 里加一个 `custom?: Record<string, unknown> | null`（`| null` 表示可以传 null 删除整个 `custom-pi-desktop` 字段），scanner 的处理是通用的——拿到 patch 里的 key-value，merge 进 header 的 `custom-pi-desktop` 对象，不管 key 叫 `timeline` 还是 `git-review`，不管 value 是 `{collapsedToolIds: [...]}` 还是 `{filterMode: "staged"}`。内核只做"读-改-写"的机制动作，不做"理解 value 里有什么"的内容判断。

这条线的意义在于：新插件要存会话级设置时，零内核改动。插件在自己的代码里定义数据结构，调 `setCustomData(path, "my-plugin", myData)` 就完事了。domain 不加类型、scanner 不加分支、preload 不加字段、IPC 不加 handler。内核的 `custom-pi-desktop` 通道是一次性建好的基础设施，之后所有插件共用。

## 3. 机制设计

### 3.1 数据结构

`custom-pi-desktop` 是一个 JSON object，key 是 pluginId，value 是插件自己的结构化数据。框架把它当作不透明的 blob——存的时候不知道里面有什么，取的时候原样返回。

```json
"custom-pi-desktop": {
  "timeline": { "collapsedToolIds": ["call_001", "call_003"] },
  "git-review": { "filterMode": "staged", "excludeGlobs": ["*.lock"] }
}
```

框架侧只需要在 `HeaderPatch` 里加一个字段：

```typescript
// domain/sessions.ts
export type HeaderPatch = {
  name?: string;
  pinned?: boolean;
  archived?: boolean;
  toolConfig?: SessionToolConfig | null;
  custom?: Record<string, unknown> | null;  // 新增：通用插件设置通道
};
```

注意这里没有为每个插件定义类型。`custom` 是 `Record<string, unknown>`——框架不认识 value 的结构，插件自己定义自己的数据形状，自己负责序列化和反序列化。这和 `toolConfig` 不同——`toolConfig` 的类型 `SessionToolConfig` 是定义在 domain 里的，内核知道它有 `mode` 和 `enabledGroupIds`。`custom` 里的东西，内核一无所知。

这里需要划一条边界：内核不是"什么内容都不能有"。`name`/`pinned`/`archived` 是内核展示层通用需要的字段——sessions-list 插件读 `pinned` 做置顶分组，读 `archived` 做归档分组。这些字段继续走枚举，定义在 `HeaderPatch` 里。内核"不感知内容"的边界划在"插件私有设置"上：只有某个插件自己关心的会话级信息，走 `custom` 通道；所有展示层插件共用的会话元数据，走枚举字段。边界判断标准就一条——这个字段是"内核展示层需要理解的"还是"某个插件私有的"。

### 3.2 写路径

插件写入走这条链路：

```
插件 ctx.sessions.setCustomData(sessionPath, "my-plugin", data)
  → IPC "session:setCustomData"
  → scanner 读 header → patch custom-pi-desktop[pluginId] → 写回 header
  → withDirLock 保证原子性
```

scanner（`application/sessions/session-scanner.ts`，负责会话文件的扫描和读写）的写操作分三步：

1. 读出 header 第一行的完整 JSON。
2. 取出 `custom-pi-desktop` 对象（没有就初始化为 `{}`），设置 `[pluginId] = data`。data 是 null 就删掉这个 key。
3. 把修改后的 header JSON 写回第一行，其余行原样保留。

三步包在 `withDirLock` 里。锁粒度是目录（cwd 桶），不是单个文件——同目录下多个会话文件的 header 写操作会串行化。对于"用户手动改设置"这种低频写场景，串行化没有感知。

写操作的关键是 **key 级合并**。插件 A 写 `custom-pi-desktop["timeline"]` 时，框架先读出当前完整的 `custom-pi-desktop` 对象（里面可能有 `git-review` 的数据），只修改 `timeline` 这个 key，再把整个对象写回。不是整体替换——整体替换会让并发写的插件互相覆盖。

### 3.3 读路径

读比写简单，不需要锁——直接读第一行，取 `custom-pi-desktop[pluginId]`：

```
插件 ctx.sessions.getCustomData(sessionPath, "my-plugin")
  → IPC "session:getCustomData"
  → scanner 读 header 第一行 JSON
  → 返回 custom-pi-desktop[pluginId]，没有就返回 null
```

旧文件没有 `custom-pi-desktop` 字段时，读到的是 `undefined`，返回 null。插件拿到 null 就知道"这个会话还没存过我的设置"，按默认值处理。不需要迁移旧文件——字段是可选的，缺失就是缺失，读到 null 走默认逻辑。

扫描会话列表时，`listSessions`（scanner 中扫描某 cwd 下所有会话文件的函数）已经在读每个文件的首行。`custom-pi-desktop` 作为一个字段会在 parse 时一并出现，但 scanner 不把它放进 `SessionInfo`（`domain/sessions.ts` 中定义的会话列表项类型，包含 path/id/cwd/name/pinned/archived/created/modified/lastMessage）——列表扫描只需要展示字段，插件私有设置按需单独读。如果把所有插件的 custom 数据都塞进 `SessionInfo`，列表响应会膨胀——一个 cwd 桶（按工作目录分组的会话文件目录，目录名由 `cwdToBucketName` 函数从 cwd 路径生成）下几百个会话文件，每个文件带 N 个插件的设置，列表加载就慢了。

### 3.4 合并语义

合并发生在两个层面。

**key 级合并**（框架负责）：多个插件写同一个 `custom-pi-desktop` 对象时，框架保证每个插件的 key 独立——A 写 A 的 key，B 写 B 的 key，互不覆盖。通过 read-modify-write 在 `withDirLock` 内完成：框架读出全量 `custom-pi-desktop`，只改目标 key，再写回。

**value 级合并**（插件负责）：插件自己 value 内部怎么更新，框架不管。timeline 想往 `collapsedToolIds` 数组里加一个 id，不是框架的事——插件自己读出当前 value，修改数组，写回整个 value。框架提供的是 key 级的读写原语，不是 value 级的 deep merge。deep merge 的语义在不同数据结构上差异巨大（数组是追加还是替换？null 是删除还是保留？），框架不应该替插件做这个决定。插件自己的数据结构，插件自己最清楚怎么合并。

## 4. 与现有字段的关系

### 4.1 底座字段不动

`type`、`id`、`timestamp`、`cwd` 是 pi 底座在创建会话时写入的。`custom-pi-desktop` 是桌面端写入的，字段名不撞，互不影响。即使 pi 底座未来版本往 header 加新字段，只要不叫 `custom-pi-desktop`，就不冲突。

这条隔离是自然的：底座写的字段和桌面端写的字段是两套独立的内容，字段名不重叠。底座不知道桌面端往 header 里塞了什么，桌面端也不改底座写的字段。`updateHeader` 的 patch 语义保证只改传入的字段，不动其余字段——patch `{custom: {"timeline": {...}}}` 时，type/id/timestamp/cwd 原样保留。

### 4.2 内核枚举字段保留

`name`、`pinned`、`archived` 继续走 `HeaderPatch` 枚举字段。它们不是某个插件的私有数据，而是所有展示层插件共用的会话元数据——sessions-list 读 `pinned` 做置顶分组，读 `archived` 做归档隐藏，读 `name` 做列表显示。如果这些字段挪进 `custom-pi-desktop`，sessions-list 就要读 `custom-pi-desktop["sessions-list"]`——等于让一个展示层插件走插件私有通道读它自己需要的通用字段，语义不对。

### 4.3 toolConfig 去向

toolConfig 是当前唯一焊在内核里的插件级会话设置。它有完整的类型定义（`SessionToolConfig` 在 `domain/sessions.ts`）、专门的 scanner 分支、专门的 IPC（`session:readToolConfig`）。它实质上是 `custom-pi-desktop` 机制的前身——证明了"插件往 header 里塞结构化设置"这条路能走通。

toolConfig 处于边界地带：它由 tool-manager 插件写入，但 timeline 插件也读它做"软过滤"（根据 toolConfig 决定哪些工具条显示）。这不是纯粹的插件私有数据，有跨插件消费的需求。但它的语义是 tool-manager 的配置，timeline 只是按只读方式消费——和 `pinned` 这种"所有展示层插件共用的元数据"不同。

推荐渐进路线：

- 先建 `custom-pi-desktop` 通道，toolConfig 不动——不碰正在跑的东西。
- tool-manager 插件自行迁移：写入时双写（同时写顶层 `toolConfig` 和 `custom-pi-desktop["tool-manager"]`），读取时优先读新位置、回退旧位置。
- 确认所有活跃会话文件都已有新位置数据后，再从内核移除 `toolConfig` 枚举字段和专门分支。

每一步都可回退，不会因为迁移导致旧会话的工具过滤设置丢失。这条路慢一点，但不会坏东西。

## 5. 边界和约束

### 5.1 header 大小

每次扫描会话列表，scanner 要读每个文件的首行并 JSON.parse。一个 cwd 桶下可能有几百个会话文件，header 太大会拖慢列表加载。

约束是软的：header 只放元数据级的小设置，不放大块数据。每个插件的 custom 数据控制在合理范围内——比如 timeline 存折叠的工具条 id 列表，一个会话里十几条，每个 id 几十字节，总共一两 KB，没问题。但如果某个插件想存几十 KB 的东西，它不该放 header——应该自己建文件，header 里只存引用路径。

这个约束不靠框架强制，靠插件自律。框架可以在 `setCustomData` 时做一个大小检查——如果序列化后整个 `custom-pi-desktop` 超过某个阈值（比如 8 KB），打一条 warning 日志。但不拒绝写入——拒绝会让插件功能不可用，而 warning 能在开发阶段暴露问题。

### 5.2 写冲突与锁粒度

`withDirLock` 的锁粒度是目录（cwd 桶），不是单个文件。同目录下多个会话文件的 header 写操作会串行化。

对于"用户手动改设置"的场景，这完全够用——人手动操作频率极低。需要注意的潜在场景是某个插件在高频写入：比如 timeline 在每次工具执行后都更新折叠状态。如果同一 cwd 桶下有多个活跃会话同时写 header，会串行等待。但实际情况是用户通常在一个 cwd 下只开一个活跃会话，多会话并存的场景下也只有一个在活跃写入。

如果未来真的出现高频写瓶颈，优化方向是把锁粒度从目录降到文件级——`withDirLock` 接受文件路径参数，用文件级锁替代目录级锁。但这是未来优化，不是当前阻塞项。

### 5.3 旧文件兼容

没有 `custom-pi-desktop` 字段的旧会话文件，两种情况都能自然处理：

- 读取时：`getCustomData` 读到 header 没有 `custom-pi-desktop` 字段，返回 null。插件走默认逻辑，不需要特殊处理。
- 写入时：`setCustomData` 发现 header 没有 `custom-pi-desktop` 字段，自动创建 `{}` 再写入。第一次写入时初始化。

不需要批量迁移旧文件。每个旧文件在被某个插件第一次写入时自动获得 `custom-pi-desktop` 字段，没被写过的旧文件永远没有这个字段——也没关系，读取时返回 null 就行。JSON 的无 schema 特性在这里是优势：加字段不需要迁移，旧文件不认新字段就忽略，新文件不认旧字段也忽略。

### 5.4 和 body 里的 custom 条目的区别

JSONL body 里可以有 `type:"custom"` 的条目（比如 plan-mode-state 这类扩展私有状态）。它和 header 的 `custom-pi-desktop` 容易混淆，但完全是两个东西：

- body 的 `type:"custom"` 条目是**会话过程中的状态快照**——记录"当时发生了什么"。位置不固定，可能在整个文件的任何一行，可能有多条。`sessionEntryToNeutral`（`domain/events/session-state.ts` 中的条目映射函数，把 JSONL 行转成中性消息）把它归类为隐藏层（返回 null，不进时间线渲染）。
- header 的 `custom-pi-desktop` 是**会话级设置的锚点**——记录"这个会话的设置是什么"。位置固定在第一行，只有一个。不随会话进展变化，只有用户主动改设置时才变。

两者各管各的：body 的 custom 条目适合存"会话进行中的运行时状态"（每次工具执行后追加一行），header 的 `custom-pi-desktop` 适合存"跨会话打开需要恢复的配置"（打开旧会话时读出来用）。一个插件如果同时有运行时状态和持久设置，两个地方都用——状态写 body，设置写 header。

## 6. QA

**Q1：插件绕过 `setCustomData`，直接调 `updateHeader({custom: {"my-plugin": data}})` 会怎样？**

会出问题。`updateHeader` 对 `custom` 字段做的是整体替换——传入的对象会整个覆盖掉 header 里原有的 `custom-pi-desktop`，其他插件写的数据丢失。`setCustomData` 做的是 key 级合并，保证只改自己的 key。框架不在 `updateHeader` 里防这个——`HeaderPatch.custom` 是 `Record<string, unknown> | null`，框架无法区分调用方是想"整体替换"还是"改一个 key"。约束靠文档约定和代码审查：插件写 custom 数据走 `setCustomData`，不直接调 `updateHeader`。如果未来发现这条约束经常被踩，可以在 `updateHeader` 里检测 `custom` 字段并打 warning，但当前不强制。

**Q2：`withDirLock` 的内部实现是什么？这个设计文档能依赖它保证并发安全吗？**

`withDirLock` 是已有的目录级锁机制（定义在 `application/config/config-file.ts`），不是本文档引入的。它的实现是文件锁——在目标目录下创建锁文件，通过文件系统原子操作保证排他性。本设计文档依赖它保证 `setCustomData` 的 read-modify-write 原子性，但不改它的实现。如果 `withDirLock` 本身有 bug（比如锁文件残留导致死锁），那是已有基础设施的问题，不是本设计的引入风险。

**Q3：session-bookmarks 写 pinned/archived，但这两个字段是"共用元数据"——一个特定插件写"共用"字段，这合理吗？**

这是现有的设计，不是本设计文档引入的问题。pinned/archived 走枚举字段是因为 sessions-list、timeline 等多个展示层插件都要读它们做分组/过滤，它们是会话的通用属性。session-bookmarks 是当前唯一写入它们的插件，因为它提供了置顶/归档的 UI 入口。如果未来另一个插件也需要写 pinned/archived，它直接调 `updateHeader({pinned: true})` 就行——枚举字段的写入不需要走 `custom` 通道。这条不对称（有些设置走枚举，有些走 custom）的判断标准在 §3.1：字段是"所有展示层插件共用的"还是"某个插件私有的"。

**Q4：一个插件往 `custom-pi-desktop` 里存了大量数据（比如几十 KB），会怎样？**

框架不拒绝写入，但会拖慢会话列表扫描。每次 `listSessions` 要读每个会话文件的首行并 JSON.parse，header 太大意味着每个文件的 parse 开销增大。当前约束靠插件自律——header 只放元数据级的小设置（几百字节到几 KB），大块数据该有自己的文件。框架可以在 `setCustomData` 时做大小检查，序列化后整个 `custom-pi-desktop` 超过 8 KB 打 warning，但不拒绝写入。这是开发阶段的信号机制，不是运行时的硬限制。

**Q5：同一个会话文件被两个 pi-desktop 实例同时打开（比如两台机器挂载了同一个网络盘），custom 数据会冲突吗？**

会。`withDirLock` 是本地文件锁，不跨机器。两台机器同时写同一个会话文件的 header，后写的会覆盖先写的。这不是 `custom-pi-desktop` 独有的问题——`name`/`pinned`/`archived` 也有同样的问题。会话文件本身不是为多机并发编辑设计的，它是单机单会话的文件。如果未来需要多机协作，那是会话文件模型的变更，不是 custom 通道的问题。

**Q6：toolConfig 迁移期间，旧版本读不到新版本写的 `custom-pi-desktop["tool-manager"]`，怎么办？**

不会。迁移策略是双写——新版本同时写顶层 `toolConfig` 和 `custom-pi-desktop["tool-manager"]`。旧版本只读顶层 `toolConfig`，读得到。只有当内核移除 `toolConfig` 枚举字段后（迁移完成），旧版本才读不到——但那时旧版本已经不该再用了。双写期间有一小段数据冗余（同一个设置存了两份），这是过渡期的代价，不是 bug。
