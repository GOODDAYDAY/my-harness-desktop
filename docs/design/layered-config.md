# 文件级分层配置覆盖：框架级项目配置 fallback 机制

> **本文已被 [unified-project-config.md](unified-project-config.md) 升格取代**：分层机制（main 构造路径、relPath 校验、项目级/全局两层）保留并落地为框架自用通道，但默认姿态从"插件可选 API"翻转为"统一项目级配置通道"——项目级默认、全局兜底，且读语义从本文的"文件级整份覆盖"演进为"顶层 key 浅合并（项目级只存 diff）"。本文保留作历史设计脉络。

configFile 是 my-harness-desktop 框架级通用 JSON 读写通道——插件调 `window.pi.configFile.get(path)` 读一个 JSON 文件，`set(path, data, mode)` 写一个 JSON 文件，不需要声明权限，所有插件都能用。这条通道有一条安全门控：路径白名单只放行 `~/.my-harness-desktop/` 和 `~/.pi/agent/` 两个前缀，插件传进来的路径如果不在这两个前缀下，main 进程直接拒绝。

白名单的存在是有原因的。configFile 是无权限的核心默认能力——没有 `permissions` 声明，没有 `assertPermission` 门控，所有插件上来就能调。如果放开任意路径，任何插件都能读写文件系统上任何位置的 JSON 文件，等于绕过了 `fs:project` 的只读沙箱。session-bookmarks 当初就是这么干的：用它读写项目目录下的 `<cwd>/.my-harness-desktop/bookmarks/`，在白名单加上之前，configFile 是一个事实上的万能文件读写后门。白名单堵掉了这个口子。

但白名单堵出了一个缺口：插件读不到项目目录下的配置了。

## 1. 问题：白名单与项目目录的矛盾

### 1.1 三种绕路，三种不统一

白名单上线之后，需要"项目级配置"的插件各自找路绕过，目前有三种做法并存，没有一种是对的。

**tool-manager 和 timeline 撞墙。** 这两个插件直接把 `currentCwd` 拼进路径：`${cwd}/.my-harness-desktop/config/tool-groups.json`。当 cwd 是 `/Users/user/toy` 时，拼出的路径是 `/Users/user/toy/.my-harness-desktop/config/tool-groups.json`——不在 `~/.my-harness-desktop/` 前缀下（`~` 展开是 `/Users/user/.my-harness-desktop/`），白名单直接拒绝，IPC handler 抛 `configFile 路径越界`。这是报错日志里的第一个错误来源。tool-manager 的设计文档（`docs/design/tool-manager-design.md:201`）其实标注了这条约束，但实现没遵循——插件代码里用了 cwd 相对路径，而不是设计文档建议的 cwd-hash 方案。

**session-bookmarks 被"逼"成了 cwd-hash。** 它把 cwd 做了一个 hash，拼成 `~/.my-harness-desktop/plugins-data/session-bookmarks/<cwd-hash>/index.json`。路径在白名单内，不会撞墙。但代价是配置不在项目目录里——书签数据和项目分离了，git 追踪不到，换机器带不走。cwd-hash 方案的本质是把"项目级配置"降级成了"全局存储 + cwd 隐式映射"——路径上看起来在 `~/.my-harness-desktop/` 下很安全，但数据语义上和项目是绑定的，只是物理上分开了。如果书签本来就是桌面级数据，cwd-hash 恰好歪打正着；但其他插件（如工具组）的配置天生是项目级的，cwd-hash 会把本该跟项目走的数据强行搬到用户目录下。

**blind-review 选了纯全局。** 它的配置固定在 `~/.my-harness-desktop/config/blind-review.json`，没有项目级的概念。能跑，但用户没法按项目定制提示词——所有项目共用同一份配置。

三种做法对应三个插件，三种路径策略，三种安全假设。问题不在于哪个插件"做错了"，而在于框架缺了一个机制，逼着每个插件自己发明轮子。

### 1.2 根因：安全模型与项目级配置的冲突

根因是安全模型和项目级配置的需求在打架。

configFile 的安全模型是：插件传路径，main 校验路径在白名单内。这个模型的隐含假设是"配置都在 `~/.my-harness-desktop/` 或 `~/.pi/agent/` 下"——对全局配置来说没问题，但项目级配置天然在项目目录里（`<cwd>/.my-harness-desktop/`），这个目录的绝对路径取决于 cwd，不在白名单的固定前缀下。

如果放开白名单让任意 cwd 路径进来，就回到了"configFile 是万能后门"的老问题。如果保持白名单不变，插件就没法读写项目级配置。两条路都走不通——问题不在白名单的对错，而在于框架缺一个"安全地写到项目目录"的机制。

这个机制该由框架提供，不该由每个插件自己拼。现在三个插件的三种做法，本质是同一个逻辑——"先查项目级，没有查全局"——散落在三个地方各写一遍。这正是关注点没分离干净的表现：同一个关注点散落在多个插件里，该收进框架统一承担。

## 2. 定位：框架级分层能力

### 2.1 这是内核机制，不是插件功能

这个能力是内核机制，不是某个插件的功能。所有需要"按项目定制配置"的插件——tool-manager 的工具组、blind-review 的提示词、timeline 读工具组、未来任何想按项目覆盖的配置——都走同一个 API，同一个 fallback 逻辑，同一个安全校验。插件只传 `cwd` 和 `relPath`（相对于 `.my-harness-desktop/` 的路径），框架负责构造完整路径、执行 fallback、保证安全。

为什么不由插件自己解决？因为"先查项目级，没有查全局"这个逻辑如果由每个插件各写一遍，就是 CLAUDE.md §1.1 说的"同一逻辑在多个外部入口各写一遍"——判别气味三。三个插件的 fallback 逻辑大同小异，差别只在路径后缀，说明这是一个逻辑的三次复制，该收敛到框架一个实现，调用方只传参数。

### 2.2 与 configFile 通道的关系

这个能力是 configFile 的分层扩展，不是新通道。它走同一条物理链路：preload 暴露到 `window.pi.configFile`，经 IPC 到 main，main 复用已有的 `readJsonFile` / `writeJsonFile` 原语（定义在 `application/config/config-file.ts`）。不新增能力声明，不新增 `permissions` 字段——它是核心默认能力的一部分，和现有的 `configFile.get/set` 同级。

与 `ctx.config`（`window.pi.config.get/set`）的区别要讲清楚。`ctx.config` 是按 pluginId 隔离的 KV 存储，存在 `~/.my-harness-desktop/plugins-data/<id>/config.json`，没有"项目级"的概念。configFile 是路径驱动的文件读写，可以指向任意白名单内路径。本文档要加的是 configFile 的分层版本——路径由框架构造，分层逻辑由框架承担，插件不碰路径。

### 2.3 为什么是文件级覆盖不是配置合并

方案选择文件级覆盖，不是字段级 deep merge。

文件级覆盖的语义是：项目级文件存在，就用整份；不存在，就用全局整份。两份文件不会字段级合并。这和 deep merge 是两回事——deep merge 把两份 JSON 按 key 合并，处理数组、null、undefined 各有微妙边界，复杂且不可预测。

选文件级覆盖的理由是工具组这类数据的性质。工具组是列表型数据——项目级文件里如果只改了一个组，它就是"这个项目的完整组定义"，不是"在全局组定义上打补丁"。deep merge 会导致项目级删不掉全局条目（合并时全局的条目还在），这恰恰是当初 `tool-manager-design.md` 写 "replace 不是 deep" 的原因。文件级覆盖更简单、更可预测：项目级文件是 override，不是 patch。

但文件级覆盖并不意味着只有工具组能用。任何 JSON 配置——blind-review 的提示词列表、right-panel 的面板顺序——都可以用同一套分层语义。有些数据 deep merge 可能更合理，但那是调用方的事：调用方可以先 `getLayered` 拿到生效的那份，自己 merge 完再 `setProject` 写回去。框架只管"哪份文件生效"，不管"两份文件怎么合并"——构造和执行分开。

## 3. 设计：文件级覆盖

### 3.1 两层定义

分层只有两层，不多不少。

- **项目级**：`<cwd>/.my-harness-desktop/<relPath>`。cwd 是用户打开的项目目录，relPath 是相对 `.my-harness-desktop/` 的子路径，比如 `config/tool-groups.json`。项目级文件跟着项目走，git 可追踪，换机器带走。
- **全局级**：`~/.my-harness-desktop/<relPath>`。和现有 `configFile.get/set` 的白名单路径一致。全局级是所有项目共享的默认配置。

两层用同一个 relPath——`config/tool-groups.json` 对应项目级 `<cwd>/.my-harness-desktop/config/tool-groups.json` 和全局级 `~/.my-harness-desktop/config/tool-groups.json`。relPath 是两层之间的对齐键：同一个 relPath 在两层各有一个候选文件，框架按优先级选一个。

不设第三层。没有"用户级 > 项目级"的嵌套覆盖——两层够了，三层是过度设计。如果未来真的需要（比如多项目组的场景），在现有两层基础上加一层是扩展，不是重构。

为什么不走 cwd-hash？cwd-hash 把项目级配置存在 `~/.my-harness-desktop/` 下用 hash 关联项目，路径合法、不撞白名单，但有两个根本缺陷。第一，配置和项目物理分离——不在项目目录里，git 追踪不到，换机器带不走，团队共享不了。工具组配置是"这个项目的完整组定义"，它天生属于项目，不该被搬到用户目录。第二，fallback 逻辑散在每处——每个插件自己 hash cwd、自己构造路径、自己 fallback 到全局，同一个逻辑写 N 遍。新方案把配置放回项目目录，把 fallback 逻辑收进框架，两个问题同时解决。

### 3.2 读 API：getLayered

```typescript
// preload → IPC → main
configFile.getLayered(cwd: string, relPath: string): Promise<Record<string, unknown> | null>
```

main 收到 `cwd` 和 `relPath` 后：

1. 构造项目级路径 `join(cwd, ".my-harness-desktop", relPath)`，`existsSync` 检查。存在 → 读它，返回整份。
2. 项目级不存在 → 构造全局级路径 `join(HOME_DIR, ".my-harness-desktop", relPath)`，`existsSync` 检查。存在 → 读它，返回整份。
3. 两层都不存在 → 返回 `null`。

返回值区分 `null`（两层都没有）和 `{}`（文件存在但内容为空或损坏）。`readJsonFile` 在文件损坏时返回 `{}`，`getLayered` 调用它时沿用这个行为——项目级文件损坏不会 fallback 到全局级，而是返回 `{}`（等同于"项目级文件存在，内容为空"）。这个选择是有意的：文件损坏不是"不存在"，不该静默 fallback 掩盖问题。

### 3.3 写 API：setProject

```typescript
configFile.setProject(cwd: string, relPath: string, data: Record<string, unknown>, mode: "deep" | "replace"): Promise<Record<string, unknown>>
```

写固定写到项目级——`join(cwd, ".my-harness-desktop", relPath)`。不设 `scope` 参数让调用方选写哪层。理由是：在"项目级覆盖全局级"的模型里，项目级是 override 层，override 就该明确写到 override 层。如果调用方想写全局默认，用现有的 `configFile.set("~/.my-harness-desktop/<relPath>", data, mode)` 就行——那个 API 已经能写全局。

`mode` 参数和现有 `configFile.set` 一致：`"replace"` 整份覆盖，`"deep"` 深合并。这个 mode 管的是"写到同一份文件时怎么合并"，不是"两层之间怎么合并"。调用方写项目级文件时，是覆盖整份（replace）还是在已有项目级文件上做字段合并（deep），由 mode 决定。两层的 fallback 逻辑只在读时发生，写时不涉及。

`setProject` 内部复用已有的 `writeJsonFile`（`application/config/config-file.ts:40`），包括 `mkdirSync({ recursive: true })` 确保目录存在、`withDirLock` 串行化并发写。这些原语已经经过验证，不重新实现。

### 3.4 清除覆盖：clearProject

```typescript
configFile.clearProject(cwd: string, relPath: string): Promise<void>
```

删项目级文件。删除后，下次 `getLayered` 会 fallback 到全局级。这是"放弃项目级定制、回退到全局默认"的操作。

实现是 `fs.unlink` + try-catch：文件不存在不报错（等同于"已经是全局级"）。不删全局级文件——`clearProject` 只管清除 override，不管删默认配置。如果调用方想删全局级，用 `window.pi.fs.removePath`（需要 `fs:project` 权限）。

### 3.5 API 总览

| API | 作用 | 路径构造 | 复用原语 |
| --- | --- | --- | --- |
| `configFile.get(path)` | 读全局 JSON（现有，不变） | 插件传完整路径，白名单校验 | `readJsonFile` |
| `configFile.set(path, data, mode)` | 写全局 JSON（现有，不变） | 插件传完整路径，白名单校验 | `writeJsonFile` |
| `configFile.getLayered(cwd, relPath)` | 分层读：项目级 > 全局级 | main 构造两层路径 | `readJsonFile` |
| `configFile.setProject(cwd, relPath, data, mode)` | 写项目级 | main 构造项目级路径 | `writeJsonFile` |
| `configFile.clearProject(cwd, relPath)` | 删项目级（回退到全局） | main 构造项目级路径 | `fs.unlink` |

三个新 API 都在 `window.pi.configFile` 命名空间下，和现有的 `get/set` 并列。插件代码里只改方法名和参数——从 `configFile.get(${cwd}/.my-harness-desktop/...)` 改成 `configFile.getLayered(cwd, ...)`，不换命名空间，不改 import。

## 4. 安全模型

### 4.1 路径由 main 构造，不由插件传入

三个新 API 的安全前提和现有 configFile 相反。现有 `configFile.get/set` 是插件传完整路径，main 校验路径在白名单内——攻击面是"插件可以尝试传任意路径"。新 API 是插件只传 `cwd` 和 `relPath`，main 内部拼完整路径——插件不接触完整路径，攻击面是"relPath 能不能逃逸出 `.my-harness-desktop/` 目录"。

这意味着新 API 不走 `resolveConfigFilePath` 白名单校验。白名单是给"插件传完整路径"这个模型设计的；新 API 的路径由 main 构造，模型不同，安全措施也不同。

### 4.2 relPath 约束

relPath 是相对路径，main 在 `join(cwd, ".my-harness-desktop", relPath)` 时构造完整路径。约束有三条：

- **不含 `..`**。`relPath` 里出现 `..` 意味着试图逃逸 `.my-harness-desktop/` 目录——比如 `../../etc/passwd` 拼出来的路径指向项目目录之外。main 校验 `relPath` 的每个 path segment 都不是 `..`。
- **不是绝对路径**。`relPath` 如果以 `/` 开头，`path.join` 会忽略前面的 cwd，直接指向根目录。main 校验 `relPath` 不以 `/` 开头、不以盘符开头（Windows）。
- **不含 `~`**。`~` 在新 API 里没有意义——路径由 main 构造，不需要插件做 `~` 展开。出现 `~` 说明调用方传错了。

校验在 main 侧做，不在 preload 做——preload 是 renderer 进程的隔离桥，安全门控必须在 main 进程的 IPC 边界。

### 4.3 cwd 信任

新 API 信任 renderer 传来的 cwd。这和现有 `fs:listDir`（`index.ts:413`）、`sessions:list`（`index.ts:367`）的做法一致——它们都接收 renderer 传来的 cwd，不校验 cwd 是否在某个"可信目录列表"里。

这个选择有意为之。my-harness-desktop 的威胁模型是"插件是本地半可信代码"——插件运行在用户设备上，不是远程不可信代码。用户通过 dialog 选择项目目录，cwd 就是用户信任的目录。如果要收紧到"main 维护可信 cwd 集合、dialog 选择时记录"，那是另一个安全增强的话题，不在这个设计文档的范围内。当前和已有的 `fs:listDir` 保持一致的信任级别。

### 4.4 为什么不新增权限声明

新 API 不要求插件在 `plugin.json` 的 `permissions` 里声明新权限。理由是这些操作的范围已经由机制本身限定了：

- `getLayered` 读 `<cwd>/.my-harness-desktop/` 和 `~/.my-harness-desktop/` 下的 JSON 文件——和现有 `configFile.get` 的白名单范围等价，只是多了项目级路径。
- `setProject` 写 `<cwd>/.my-harness-desktop/` 下的 JSON 文件——写权限范围限定在项目目录的 `.my-harness-desktop/` 子目录内，不能写到项目其他地方。
- `clearProject` 删 `<cwd>/.my-harness-desktop/` 下的单个文件——同上，范围限定。

这些操作都限定在 `.my-harness-desktop/` 子目录内。`.my-harness-desktop/` 是 my-harness-desktop 的专属配置目录，不是项目的源码目录。在 `.my-harness-desktop/` 下读写 JSON 配置文件，不会影响项目的源代码和构建产物。风险和现有 `configFile.get/set` 在同一级别，不需要额外的权限声明。

如果未来发现 `.my-harness-desktop/` 下的配置读写有更细粒度的管控需求（比如只允许特定插件写特定子路径），可以在 main 侧加注册表校验——但那是在已有的路径约束之上加策略，不是加权限声明。当前不需要。

## 5. 与现有 configFile 的关系

### 5.1 旧 API 不动

现有的 `configFile.get(path)` 和 `configFile.set(path, data, mode)` 完全不动。它们的白名单逻辑、`resolveConfigFilePath` 校验、IPC handler 都保持原样。已有插件如果只读全局配置（比如 right-panel 读 `~/.my-harness-desktop/config/general.json`），不需要改任何代码。

### 5.2 新 API 是分层扩展

三个新 API（`getLayered`、`setProject`、`clearProject`）是 configFile 通道的分层扩展。它们和旧 API 共享同一个 `window.pi.configFile` 命名空间、同一组 `readJsonFile` / `writeJsonFile` 原语、同一个 IPC 通道（preload → main）。区别只在路径构造方式和 fallback 逻辑：

- 旧 API：插件传完整路径，main 校验白名单。
- 新 API：插件传 cwd + relPath，main 构造路径，做 fallback。

两组 API 各管各的场景。全局-only 配置（blind-review 当前状态）继续用旧 API，不需要迁。需要项目级覆盖的配置用新 API。一个插件可以混用——blind-review 可以继续用 `configFile.get` 读全局默认，同时用 `setProject` 写项目级覆盖，再用 `getLayered` 读生效的那份。但更干净的做法是统一用 `getLayered`：没有项目级文件时它等价于读全局，行为一致。

### 5.3 迁移优先级

迁移是渐进的，不是一刀切。优先级排序：

1. **tool-manager + timeline**——最优先，当前在报错，必须修。
2. **blind-review**——可选，不报错但能获得项目级定制能力。
3. **session-bookmarks**——后做，不阻塞。书签有 JSON 和 JSONL 两种文件，`setProject` 只管 JSON，JSONL 副本走 `fs:project`。
4. **right-panel**——不需要迁移，纯全局配置。

具体代码改动见 §6.3。

## 6. 落地线索

### 6.1 main 侧：3 个新 IPC handler

在 `shell/electron-main/index.ts` 现有 `config-file:get/set` handler 之后，加三个新 handler。路径常量复用已有的 `HOME_DIR`、`PI_DESKTOP_DIR`（`index.ts:89-90`）。

relPath 校验写成一个独立函数，三个 handler 共用：

```typescript
function resolveRelPath(cwd: string, relPath: string): { project: string; global: string } {
  if (relPath.startsWith("/") || relPath.includes("~"))
    throw new Error("relPath 不能是绝对路径或含 ~");
  if (relPath.split(sep).includes(".."))
    throw new Error("relPath 不能含 ..");
  return {
    project: join(cwd, ".my-harness-desktop", relPath),
    global: join(PI_DESKTOP_DIR, relPath),
  };
}
```

三个 handler：

```typescript
ipcMain.handle("config-file:getLayered", (_e, cwd: string, relPath: string) => {
  const { project, global } = resolveRelPath(cwd, relPath);
  if (existsSync(project)) return readJsonFile(project);
  if (existsSync(global)) return readJsonFile(global);
  return null;
});

ipcMain.handle("config-file:setProject", async (_e, cwd: string, relPath: string, data, mode) => {
  const { project } = resolveRelPath(cwd, relPath);
  await writeJsonFile(project, data, mode);
  return readJsonFile(project);
});

ipcMain.handle("config-file:clearProject", (_e, cwd: string, relPath: string) => {
  const { project } = resolveRelPath(cwd, relPath);
  try { unlinkSync(project); } catch {}
});
```

`readJsonFile` / `writeJsonFile` 从 `application/config/config-file.ts` import，不重新实现。`unlinkSync` 用 Node 内置的 `fs`。

### 6.2 preload：暴露到 window.pi.configFile

在 `shell/electron-main/preload.ts` 的 `configFile` 对象里（`preload.ts:134`），在现有 `get`/`set` 之后加三个方法：

```typescript
configFile: {
  get: (path: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke("config-file:get", path),
  set: (path: string, data: Record<string, unknown>, mergeMode: "deep" | "replace"): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke("config-file:set", path, data, mergeMode),
  // 分层 API（新）
  getLayered: (cwd: string, relPath: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke("config-file:getLayered", cwd, relPath),
  setProject: (cwd: string, relPath: string, data: Record<string, unknown>, mode: "deep" | "replace"): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke("config-file:setProject", cwd, relPath, data, mode),
  clearProject: (cwd: string, relPath: string): Promise<void> =>
    ipcRenderer.invoke("config-file:clearProject", cwd, relPath),
},
```

不需要在 `domain/context.ts` 的 `PluginContext` 接口里加类型——configFile 是直接挂在 `window.pi` 上的，不经过 `usePluginContext` 绑定。插件直接调 `window.pi.configFile.getLayered(...)` 或经 `usePiApi()` 拿到的 api 对象调。

### 6.3 适配点

迁移按优先级排：先修撞墙的，再迁移绕路的，纯全局的可选。

**tool-manager**（`plugins/tool-manager/renderer/index.tsx`）——最优先，当前在报错。

- `index.tsx:63`：`api.configFile.get(${cwd}/.my-harness-desktop/config/tool-groups.json)` → `api.configFile.getLayered(cwd, "config/tool-groups.json")`
- `index.tsx:68`：`api.configFile.set(${cwd}/.my-harness-desktop/config/tool-groups.json, initial, "replace")` → `api.configFile.setProject(cwd, "config/tool-groups.json", initial, "replace")`
- `index.tsx:80`：`api.configFile.set(${cwd}/.my-harness-desktop/config/tool-groups.json, { groups: newGroups }, "replace")` → `api.configFile.setProject(cwd, "config/tool-groups.json", { groups: newGroups }, "replace")`

`load` 函数里的 fallback 逻辑（`index.tsx:64-69`）需要调整：`getLayered` 返回 `null` 时写预设组。原来是在 `data` 为空或不合规时写，现在 `getLayered` 返回 `null` 表示两层都没有，写预设组的语义更清晰。

**timeline**（`plugins/timeline/renderer/index.tsx`）——同步修，当前在报错。

- `index.tsx:189`：`pi.configFile.get(${cwd}/.my-harness-desktop/config/tool-groups.json)` → `pi.configFile.getLayered(cwd, "config/tool-groups.json")`

**blind-review**（`plugins/blind-review/renderer/index.tsx`）——可选，不报错但能获得项目级定制能力。

- `index.tsx:230`：`window.pi.configFile.get("~/.my-harness-desktop/config/blind-review.json")` → `window.pi.configFile.getLayered(cwd, "config/blind-review.json")`。需要从 `useUiStore` 拿 `currentCwd` 传进去。

**session-bookmarks**（`plugins/session-bookmarks/renderer/index.tsx`）——后做，不阻塞。书签有 JSON 和 JSONL 两种文件，`setProject` 只管 JSON，JSONL 副本走 `fs:project`。迁移时 `bookmarksDir` 函数（`index.tsx:31-34`）的 cwd-hash 逻辑去掉，改成 `joinPath(cwd, ".my-harness-desktop", "bookmarks")`，读写走 `getLayered/setProject`（JSON 部分）和 `fs:project`（JSONL 部分）。

## 7. QA

**Q1：项目级文件损坏时 `getLayered` 会 fallback 到全局吗？**

不会。`readJsonFile`（`application/config/config-file.ts:30`）在文件损坏（JSON parse 失败）时返回 `{}`，不抛异常。`getLayered` 在项目级路径 `existsSync` 为 true 时就读项目级——即使内容损坏也返回 `{}`，不会静默 fallback 到全局级。这是有意的：文件损坏不是"不存在"，静默 fallback 会掩盖问题，用户不知道自己的项目级配置坏了。如果希望损坏时 fallback，调用方可以在 `getLayered` 返回 `{}` 后自行判断是否为空对象再决定是否读全局。

**Q2：多个插件用同一个 relPath 会冲突吗？**

会，但这是调用方的责任。框架不按 pluginId 隔离 relPath——`config/tool-groups.json` 对所有插件都是同一条路径。如果两个插件往同一个 relPath 写不同的数据结构，后写的会覆盖先写的。但实际上这不太可能发生：relPath 由插件的语义决定（工具组用 `config/tool-groups.json`，盲审用 `config/blind-review.json`），不同插件的 relPath 天然不同。如果担心冲突，插件可以在 relPath 里带自己的命名空间前缀——比如 `config/tool-manager/tool-groups.json`。框架不强制，但约定推荐。

**Q3：cwd 为空（用户还没打开项目目录）时调 `getLayered` 会怎样？**

`resolveRelPath` 会拼出 `/.my-harness-desktop/<relPath>` 这样的路径——cwd 是空字符串时 `join("", ".my-harness-desktop", relPath)` 结果是 `.my-harness-desktop/<relPath>`（相对路径，相对 main 进程的工作目录）。这不会有安全问题（路径在 `.my-harness-desktop/` 下），但语义不对——读到的不是用户期望的项目配置。调用方应在 cwd 为空时不调 `getLayered`，框架不拦——和现有 `configFile.get` 在 path 为空时的行为一致（它会尝试读空路径对应的文件，失败返回 `{}`）。tool-manager 已经处理了这个场景：cwd 为空时显示空态提示"请先打开项目目录"。

**Q4：用户手动编辑了项目级 `.my-harness-desktop/config/tool-groups.json`，插件怎么感知变化？**

当前框架不监听 `.my-harness-desktop/` 下的文件变更。`getLayered` 每次调用都 `existsSync` + `readJsonFile`，读到的是磁盘上的最新内容——但如果插件把结果缓存在 React state 里，不会自动刷新。tool-manager 的 `useToolGroups` hook 在 cwd 变化时重新 `load`，但不会在文件被外部编辑时重载。如果需要实时感知外部编辑，框架可以在 main 侧加 `fs.watch` 监听 `.my-harness-desktop/` 目录变更并广播事件——但这是独立于本设计文档的增强，当前不包含。用户手动编辑后切到别的目录再切回来，会触发重新加载。

**Q5：`setProject` 的 mode 参数用 `"deep"` 时，和 `getLayered` 的"文件级覆盖不 merge"矛盾吗？**

不矛盾。`setProject` 的 `mode` 管的是"写到同一个文件时怎么合并"——`"replace"` 整份覆盖那个文件，`"deep"` 在那个文件的已有内容上做字段级合并。`getLayered` 的"文件级覆盖"管的是"两层之间选哪份"——项目级文件存在就用整份，不存在 fallback 到全局整份。两个 merge 在不同维度上：一个是文件内合并（写时），一个是文件间选择（读时）。调用方可以先用 `getLayered` 拿到生效的那份（可能是全局的），修改几个字段后用 `setProject(..., mode="deep")` 把修改合并写到项目级文件里——这时项目级文件只包含被改的字段，但 `getLayered` 读的时候会返回这份"部分覆盖"的项目级文件，不会 fallback 到全局。这意味着 `mode="deep"` 写出的项目级文件可能不是"完整配置"，而是"增量"——调用方需要自己决定这是不是想要的语义。

**Q6：`clearProject` 删了项目级文件后，如果全局级也不存在，`getLayered` 返回什么？**

返回 `null`。`clearProject` 只删项目级文件，不影响全局级。如果两层都不存在，`getLayered` 的第 3 步返回 `null`。调用方应处理 `null` 的情况——通常是用内置默认值初始化，就像 tool-manager 在 `getLayered` 返回 `null` 时写入预设工具组。`null` 和 `{}` 的区别是：`null` 表示"两层都没有配置文件"，`{}` 表示"文件存在但内容为空或损坏"。

**Q7：为什么不在白名单里直接加 `<cwd>/.my-harness-desktop/` 前缀？**

两个原因。第一，白名单校验的是插件传进来的完整路径——如果允许 `<cwd>/.my-harness-desktop/`，插件可以传任意 cwd 拼出来的路径，比如 `cwd="/etc"` 拼出 `/etc/.my-harness-desktop/`，等于能写任意目录。白名单是固定前缀匹配，cwd 是运行时变量，两者不兼容。第二，现有 `configFile.get/set` 是"插件传路径"模型，新 API 是"框架构造路径"模型——两个模型的安全假设不同，混用一套白名单会模糊边界。新 API 的安全由 `resolveRelPath` 的 relPath 校验（无 `..`、无绝对路径、无 `~`）保证，不走白名单，因为攻击面不同。
