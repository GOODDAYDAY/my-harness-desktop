# 表情包（stickers）壳插件技术文档

## 1 插件是什么、住在哪

stickers 是 my-harness-desktop 的一个**壳插件**，挂在 `src/plugins/project/stickers/` 下，域归类是 `project`（项目域）。它的功能一句话：**表情包贴纸的一键发送 + 两层（全局/项目）+ 一层内置的三层管理**。用户点卡片即把贴纸文本送进当前会话，贴纸的 banner 图随会话流展示；设置页里做增删改、拖拽排序、跨层迁移、zip 整体导入导出。`plugin.json` 里 `description` 原文是「表情包贴纸：点击卡片一键发送进会话（文本进 prompt、banner 图经会话流展示），内置随壳分发可删除 + 全局/项目两层可编辑」。

它属于壳的「内容层」而不是「机制层」，整条依赖链只向内指向两个发布面：`@my-harness-desktop/shared`（圆心类型 + 契约）和 `@my-harness-desktop/react`（PluginContext / hooks / 组件）。插件目录里没有任何 `import ... from '@/server/...'` 或 `import ... from '@/core/...'`——违反 §6.3 依赖方向检验的红线。物理结构是四件套（§7.7）里的**三件**，缺 `pi-extension/` 和 `dsh-extension/`：

```
src/plugins/project/stickers/
  plugin.json                          # manifest：5 组槽位贡献
  client/stickers-store.ts             # 数据层：三层并集读写的唯一出入口（423 行）
  client/stickers-store.test.ts        # zip 导入导出 + builtin 合并/写守卫的 vitest 单测
  renderer/index.tsx                   # 右面板 StickersPanel + 设置页 StickersSettings + 共享装载逻辑
  renderer/sticker-card.tsx            # 贴纸展示卡 StickerDisplay + 就地编辑器 StickerEditor
  renderer/sticker-composer-button.tsx # composerActions 槽按钮 + 网格选择器
  renderer/sticker.tsx                 # 便利贴视觉基座 StickerCard（倾斜/胶带/图钉）
  locales/{zh-CN,zh-TW,en,de}/stickers.json   # 文案 namespace stickers.notes
  locales/{zh-CN,zh-TW,en,de}/settings.json   # 文案 namespace stickers.settings
```

为什么没有 `pi-extension` / `dsh-extension`？因为 stickers 是**纯 UI 内容**，它不向任何内核补能力——它不出工具、不注入系统提示、不改会话模型，它只把「一段文本 + 一张可选展示图」交给 timeline 的发送动作。贴纸文本最终进内核 prompt 是借 timeline 的 `sendMessage`，banner 图则走中立层的 `display`（展示元数据）路径，两者都不需要 stickers 去碰内核。这一条在 `src/server/bootstrap/assemble.ts:196` 的注释里写死了：「纯 UI 内容，不进模型上下文，无 ensure* 开关」。

## 2 plugin.json：五组槽位贡献

`plugin.json` 顶层字段：`id: "stickers"`、`version: "0.10.0"`、`tier: "official"`、`displayName: "表情包"`、`renderer: "./renderer/index.tsx"`、`tags: ["productivity"]`。关键的是 `contributes` 里贡献了五个槽位，这是本插件全部接入点的声明面。

- **`sidePanel`**（1 项）：`id: "stickers"`、`label: "表情包"`、`icon: "sticker"`、`component: "StickersPanel"`、`order: 60`。右面板一个 Tab。契约类型 `SidePanelContribution` 在 `packages/shared/src/domain/contributions.ts:81`，本插件没声明 `revealOn`——它不靠别的 channel 触发揭示，用户手动点 Tab 展开。
- **`settings`**（1 项）：`id: "stickers"`、`component: "StickersSettings"`、`configFile: null`、`saveMode: "manual"`、`order: 60`。两个字段值得展开：
  - `configFile: null`：不声明框架管理的配置文件，所以设置页不显示「打开配置」按钮（`SettingsContribution.configFile` 注释 `contributions.ts:19`：`null=无配置文件(不显示打开按钮)`）。贴纸数据不落在单一 configFile，而是分散在全局层 + 项目层两个 config 文件的 `stickers` key（见 §3），走 `ctx.config` 通道而非 configFile 通道。
  - `saveMode: "manual"`：实时生效，无保存浮层、无 dirty 拦截。每一次增删改/拖拽/迁移都是即时落盘，`updateSticker` / `removeSticker` / `reorderStickers` 等函数内部直接 `await writeLayer(...)` 写回，不经过框架的 save/dirty 管线。这与 `SettingsContribution.saveMode` 的契约注释（`contributions.ts:23`：`"manual"=实时生效(无浮层,仅打开按钮)`）一致。
- **`composerActions`**（1 项）：`id: "stickers-picker"`、`component: "StickerComposerButton"`、`order: 10`。往 composer 底部工具栏贡献一个表情包快速入口按钮。契约类型 `ComposerActionContribution` 在 `contributions.ts:249`，只有 `id` / `component` / `order` 三个字段——按钮自持点击和弹窗，props 无。这是本插件与 timeline 的第一处交互面，§7 专节展开。
- **`languages`**（8 项）：两个 namespace 各四个 locale。`stickers.notes`（文案 namespace）+ `stickers.settings`（设置页标题 namespace），每个贡献 `zh-CN` / `zh-TW` / `en` / `de` 四个 `LanguageContribution`。契约类型 `LanguageContribution` 在 `contributions.ts:130`，`resources` 指向外部 JSON 相对路径，i18n 合并器启动时读进 i18next resources。

组件名 `StickersPanel` / `StickersSettings` / `StickerComposerButton` 不手写注册——框架加载 renderer module 后读 `contributes.*[].component`，在 module exports 里找同名组件自动注册（§7.4 组件自动匹配）。`renderer/index.tsx` 里 `export function StickersPanel`、`export function StickersSettings`，`sticker-composer-button.tsx` 里 `export function StickerComposerButton`，三个名字必须与 manifest 完全一致。

## 3 数据层：三层并集，非覆盖语义

`client/stickers-store.ts` 是本插件所有 IO 的唯一出入口，renderer 四个组件不直接碰 IPC（文件头注释：「全部 IO 的唯一出入口(设计 §2.4:组件不碰 IPC)」）。核心类型：

- `StickerItem`（`stickers-store.ts:19`）：`id: string`、`title?: string`、`content: string`、`banner?: string`、`order: number`、`createdAt: number`、`updatedAt: number`。`banner` 存**逻辑路径**（如 `~/.my-harness-desktop/stickers/banners/<id>.png`），不是 base64 不是绝对路径。
- `StickerLayer = "global" | "project" | "builtin"`（`:30`）。
- `WritableLayer = "global" | "project"`（`:33`）——`builtin` 只读，从可写层里抠出来。
- `LayeredSticker = StickerItem & { layer: StickerLayer }`（`:35`）——装载后每条贴纸带层标记。
- `Ctx = Pick<PluginContext, "config" | "configFile" | "dialog">`（`:39`）——数据层只依赖 PluginContext 的三个子面，不 import React。

### 3.1 三层各存哪、怎么读

三个常量钉死存储落点：

- `BANNER_DIR = "~/.my-harness-desktop/stickers/banners"`（`:42`）——banner 图文件目录，**恒全局**，不分层。
- `BUILTIN_MANIFEST = "~/.my-harness-desktop/stickers/bundled/stickers.json"`（`:45`）——内置表情包 manifest，壳启动时镜像的受管文件，只读。
- `REMOVED_BUILTIN_KEY = "removedBuiltin"`（`:49`）——用户删过的内置贴纸墓碑 key，存全局层 config。

读取函数映射关系：

- 全局层、项目层走 `readLayer(ctx, layer)`（`:91`），内部 `asStickers(await ctx.config.getScope(layer))`。`ctx.config.getScope` 是 `PluginConfigApi.getScope`（`packages/shared/src/domain/context.ts:205`）：读**某一层的原始快照**，不合并——这是并集型数据（一条贴纸只存在于一层、id 全局唯一、无遮蔽语义）区别于覆盖型配置（用 `all()`）的关键。`writeLayer`（`:95`）对称地用 `ctx.config.set("stickers", items, { scope: layer })`，`PluginConfigApi.set` 的 `scope` 参数显式指定写全局层还是项目层。
- 内置层走 `readBuiltinLayer(ctx)`（`:102`）：`ctx.configFile.get(BUILTIN_MANIFEST)` 读受管 manifest。它不走 `ctx.config`——因为内置数据不是插件的 config key，而是壳镜像出来的一份独立 JSON 文件。manifest 条目没有 `order` / 时间戳字段，所以 `order` 按数组下标赋、`createdAt`/`updatedAt` 赋 `0`（`:116-118`），并且**永不标脏、永不写回**。
- 墓碑走 `readRemovedBuiltin(ctx)`（`:127`）/ `writeRemovedBuiltin(ctx)`（`:134`），都是全局层 config 的 `removedBuiltin` key，容错：缺失/非数组 → 空集。

`asStickers`（`:65`）是宽容解析器，值得单列：只收 `content` 为 string 的条目（`typeof o.content !== "string"` 直接 continue，注意——纯图表情包 content 可以是空串，所以是判类型不是判非空）；`id` 非空 string 才用，否则 `crypto.randomUUID()` 补发并标 `dirty = true`（`:76`）；`title` 只收 trim 后非空的 string；`order` 缺省 `Number.MAX_SAFE_INTEGER`、时间戳缺省 `Date.now()`。脏层在 `loadStickers` 里立即写回，保证 id 稳定（后续编辑/排序按 id 操作）。

### 3.2 loadStickers：并集按 order 排序

`loadStickers(ctx)`（`:140`）是本插件的读真相源，三个视图（面板/设置页/输入框选择器）都调它。语义精确到行：

- `Promise.all([readLayer(global), readLayer(project), readBuiltinLayer, readRemovedBuiltin])` 并发读四路（`:141-143`）。
- 脏层立即写回（`:145-146`）：补发过 UUID 的层写一次，保证 id 稳定。
- 合并 global + project，`sort((a, b) => a.order !== b.order ? a.order - b.order : b.updatedAt - a.updatedAt)`（`:151`）——order 升序，同 order 按 updatedAt 倒序兜底。
- builtin 过滤墓碑后 `push(...)` 追加到合并结果**末尾**（`:152`）：「用户内容优先，系统默认垫后」。

这里有两个语义点必须写清楚，否则读代码会误读：

1. **不是配置式「同 key 覆盖」**。覆盖型配置（如主题 token）是两层浅合并、项目层覆盖全局层。贴纸是「一条只属于一层」——`moveLayer` / `moveToLayer` 是把条目本体从一层搬到另一层，不是两层各存一份再遮蔽。文件头注释明说「合并是"并集按 order 排序"，不是配置那种同 key 覆盖——一条贴纸只存在于一层，id 全局唯一，无遮蔽语义」。
2. **builtin 恒垫后**，不管它的 order 是 0。用户（global/project）内容永远排在用户可编辑的内置垫底之上。

### 3.3 写函数：每个都即时落盘

写函数都是「读 → 改 → `writeLayer` 写回」，无缓存、无延迟，也不重发事件（文件头注释：「写后 main 广播 settings:changed → 两侧视图订阅 system:settingsChanged 重读…故这里写完不重发事件、不做缓存」——广播由壳后端的 `config.set` handler 统一做，见 §5）。

- `createSticker(ctx, input, layer = "project")`（`:312`）：新条目默认落项目层（面板语义）；`layer === "builtin"` 直接抛错「内置表情包不可编辑」；order 取合并列表 `Math.max(...merged.map(n => n.order)) + 1`；有 banner 则 `writeBanner` 写图文件并把逻辑路径存进条目。
- `updateSticker(ctx, id, patch)`（`:331`）：`loadStickers` 找目标，`builtin` 直接 return；`patch.banner === null` 删 `next.banner`、`patch.banner` 对象则 `writeBanner` 换新图路径、缺省不动（`:339-341` 三态语义）。
- `removeSticker(ctx, id)`（`:347`）：builtin 记墓碑到全局层 `removedBuiltin`（不删随壳资产文件，升级壳新增的内置贴纸不受影响、用户删过的下次启动仍不回来）；非 builtin 从本层 filter 掉写回；**不删 banner 图文件**（注释 `:360`：「会话历史消息的展示仍引用它」）。
- `reorderStickers(ctx, orderedIds)`（`:365`）：拖拽后按新位置把合并列表重编号 `0..n-1`，按层拆回两层各写；builtin 先剔除——「其 order 不参与也不写回」。
- `moveLayer(ctx, id)`（`:379`）：条目本体（含 order、时间戳、banner 路径）原样搬到另一层，追加到目标层末尾。是 `moveToLayer` 的特例。
- `moveToLayer(ctx, id, targetLayer, targetIndex = null)`（`:402`）：拖拽跨区迁移，知道「搬到哪层的哪个位置」——`targetIndex` null/越界 = 追加末尾，否则 splice 到目标层第 targetIndex 个元素处，全列表重编号。builtin 方向（源或目标）都是 no-op。

### 3.4 banner 图：文件与条目分离

banner 图是「图文件 + 条目里的逻辑路径引用」两段式：

- `writeBanner(ctx, id, base64, mimeType)`（`:56`）：`IMAGE_EXT[mimeType] ?? "png"` 推扩展名，路径 `${BANNER_DIR}/${id}.${ext}`，`ctx.configFile.writeBinary(path, base64)` 写二进制。返回逻辑路径存进条目。
- 图存**全局数据根恒不分层**——文件头注释 `:10`：「banner 是交流机制、跨项目复用，所以不跟项目层走——删项目层条目，图文件还在」。这就是为什么 §3.3 的 `removeSticker` 不删图文件。

`configFile.readBinary` / `writeBinary` 是 `PluginContext.configFile`（`context.ts:324-330`）的两个方法，壳后端在 `src/server/controllers/config.ts:70-73` 注册，路径经 `resolveConfigFilePath` 白名单校验（只允许 `~/.my-harness-desktop/` 或 `~/.pi/agent/` 前缀，`:47-53`），base64 只存在于传输/内存（`:69` 注释）。`~/.my-harness-desktop` 是**逻辑前缀**，运行时经 `expandDesktopPath`（`src/server/application/config/paths.ts:28`）映射到当前数据根（打包态 `~/.my-harness-desktop`、dev 态 `~/.my-harness-desktop-dev`）。插件代码写死的是逻辑前缀常量，物理落点由壳后端展开——这是「逻辑前缀契约」的落地。

### 3.5 导入导出：zip 是主线，JSON/图片是遗留

真正接线到 UI 的是 zip 一对：

- `exportStickersZip(ctx)`（`:247`）：`loadStickers` 全量 → 每条包成 `{title, content, layer, banner}`（banner 是 zip 内相对路径 `banners/<id>.<ext>`）→ `files.unshift` 塞 `stickers.json`（UTF-8 安全编码，见下）→ `ctx.dialog.saveZip({ name, files, defaultFileName })`。保存对话框由 main 侧弹。
- `importStickersZip(ctx)`（`:276`）：`ctx.dialog.openZip()` 解包 → 找 `stickers.json` + 收集 `banners/` 图 → 逐条 `createSticker`。导入**总是新建不覆盖既有 id**，避免两机合并冲突。

`utf8ToBase64` / `utf8FromBase64`（`:237`、`:241`）：renderer 是 Chromium 环境没有 Node Buffer，用 `TextEncoder`/`btoa` 和 `TextDecoder`/`atob` 做 UTF-8 安全编码——zip 包里的 manifest 是 JSON 且可能含中文标题，`btoa` 直接吃非 Latin-1 字符串会崩，必须走 UTF-8。

**遗留代码（已不接线，别误当功能）**：`exportStickers`（JSON 版，`:169`）、`importStickers`（JSON 版，`:185`）、`importImages`（`:207`）、`exportStickerImages`（`:219`）四个函数在 store 里仍 export，但 `renderer/index.tsx` 的 import 清单（`:31-35`）只引了 `exportStickersZip, importStickersZip` 做导入导出，四个旧函数无任何调用点——是 zip 方案上线后没清掉的旧入口（JSON 导入导出被 zip 取代，`importImages`/`exportStickerImages` 是早期的图入口）。它们仍在编译面暴露，属 stale 代码，不参与运行时路径。

## 4 内置表情包：镜像 + 只读消费

内置贴纸的数据源头在 `assets/stickers/`：`stickers.json` 是 manifest（6 条：ping / worktree / commit / push / low html / `!!!!!`，每条 `{id, title, content, banner}`），`banners/` 是 6 张 gif。manifest 里 `banner` 的值已经是逻辑路径 `~/.my-harness-desktop/stickers/bundled/banners/<id>.gif`。

镜像机制在 `src/server/application/bundled/mirror.ts` 的 `mirrorManagedDir(sourceDir, targetDir)`（`:12`）：

- `existsSync(sourceDir)` 不存在则直接 return（源缺失不崩）。
- `mkdirSync(targetDir, { recursive: true })`。
- 先删：target 中 source 没有的条目 `rmSync(..., { recursive: true, force: true })`——**强制覆盖语义**，受管目录归壳所有。
- 后拷：source 每条 `cpSync(..., { recursive: true, force: true })` 整目录覆盖拷贝。
- `.` 开头条目（隐藏文件）不参与同步，与 scanner 的跳过规则一致（`:9`、`:16`）。

组装点在 `src/server/bootstrap/assemble.ts`：

- `:197` `const BUNDLED_STICKERS_DIR = join(MY_HARNESS_DESKTOP_DIR, "stickers", "bundled")`——数据根下的受管目录。
- `:198-200` `bundledStickersSource = opts.isPackaged ? join(process.resourcesPath, "my-harness-desktop-stickers") : resolve(process.cwd(), "assets/stickers")`——打包态读资源目录（pkg 把 `assets/stickers/` 拷贝到 `resources/my-harness-desktop-stickers`），dev 态读仓库 `assets/stickers`。
- `:566` `mirrorManagedDir(bundledStickersSource, BUNDLED_STICKERS_DIR)`——启动序列里同步镜像，不依赖用户先打开设置页（`:558-559` 注释：「放在启动序列而非等 IPC」）。

镜像到 `~/.my-harness-desktop/stickers/bundled/` 后，stickers 插件经 `readBuiltinLayer` 读 `BUILTIN_MANIFEST = "~/.my-harness-desktop/stickers/bundled/stickers.json"`。用户**不能改受管目录里的内容**——改了下次启动被覆盖回源。要改请 fork 到自己目录：mirror.ts 头部注释明说「受管目录归壳所有，用户要改请 fork 到自己的目录（自己的 skills 目录、自己的贴纸）」。stickers 的用户可写面是 global/project 两层，builtin 只能「删」（记墓碑）。

## 5 renderer：四个文件、三类视图

### 5.1 index.tsx：两个视图 + 共享装载

`renderer/index.tsx` 是插件主入口，export 两个槽位组件（`StickersPanel`、`StickersSettings`）和 channels 声明。共享逻辑收敛在三个函数里，两个视图复用：

- `useStickerTransfer(ctx, reload)`（`:46`）：zip 导入导出的共享逻辑——`busy` 忙态、`msg` 结果提示（3 秒 `flash` 自动消）、`doExport` / `doImport` 两个回调。失败原因可见不静默（`flash(\`导出失败: ${detail}\`)`）。
- `makeDragEnd(ctx, stickers, reload)`（`:94`）：拖拽结束 → `arrayMove` 重排 ids → `reorderStickers(ctx, next).then(reload)`。面板和设置页的拖拽重排是同一逻辑，收敛一处。
- `useStickers()`（`:111`）：两视图共享的装载/同步 hook，读 `useUiStore((s) => s.currentCwd)` 拿当前项目，`loadStickers(ctx)` 装贴纸。三个同步信号：`useEffect(() => void reload(), [reload])` 挂载即读；`system:settingsChanged` 订阅重读；`isActive` 激活时重读（面板反复显隐，广播只在挂载组件间生效）。**编辑中抑制重读**（`:136-139`）：`if (!editingRef.current) void reload()`——正在输入编辑器时广播到达不重读，避免把正在输入的编辑器顶掉。`editingRef` 是 ref 镜像 `editing` state，供订阅回调读最新值（闭包陷阱的根因修复）。

`sendSticker(ctx, sticker)`（`:147`）是发贴纸的唯一动作构造点：`const text = sticker.content.trim() || sticker.title?.trim() || ""`（纯图表情包 content 空时发标题兜底，标题也空发空文本交内核兜底），然后 `ctx.events.emit("stickers:send", { text, image: sticker.banner ? { src, title } : undefined })`。注意这里**只发事件、不自己调 sendMessage**——这是本插件与 timeline 解耦的核心，§7 展开。

`StickersPanel`（`:156`）是右面板：`PanelToolbar` + 搜索框 + `DndContext/SortableContext` 贴纸网格（`gridTemplateColumns: repeat(auto-fill, minmax(170px, 1fr))` 自适应 2/3/4 列）。点击卡片 = `send(n)`（`onActivate`），hover 浮钮提供「加入输入框」（`onFillComposer`）、复制、设全局/移项目、编辑、删除。`send` 的 `useCallback`（`:169`）有两个前置闸门：`if (streaming || !cwd) return`——streaming 中禁发（`streaming` 读 `useSessionStore((s) => s.streaming)`），cwd null 禁发（按钮 tooltip「先打开文件夹」）。`activateDisabledReason` 据此给禁用原因。

`StickersSettings`（`:430`）是设置页：顶栏搜索 + 导入/导出 zip + 新建按钮，下面是 `LayerSection layer="project"`、`LayerSection layer="global"`、`BuiltinSection` 三个区块。`LayerSection`（`:321`）用 `SettingsSection` 壳 + droppable 网格，支持拖入空白区跨区迁移（`useDroppable({ id: \`section-${layer}\`, data: { layer } })`）；`BuiltinSection`（`:391`）无 `+` 入口、不进 droppable、卡片不包 sortable，只可展开/发送/复制/删除。`onDragEnd`（`:458`）区分两种拖拽：`overLayer !== activeSticker.layer` 时走 `moveToLayer`（跨层迁移到具体位置），否则同层 `reorderStickers`。

### 5.2 sticker-card.tsx：展示卡 + 编辑器

`sticker-card.tsx` 是被面板和设置页共用的子组件文件。

- `bannerMime(banner)`（`:14`）：从路径扩展名推 mime，`IMAGE_MIME` 映射表，兜底 `image/png`。
- `useBannerDataUri(banner)`（`:21`）：hook 版，`ctx.configFile.readBinary(banner)` 读 base64 → `data:${mime};base64,${b64}`，`alive` 标志防卸载后 setState，文件缺失返回 null。
- `readBannerDataUri(ctx, banner)`（`:37`）：非 hook 版，事件/回调里读（填输入框时用），同逻辑。
- `useCopyFeedback(text)`（`:44`）：`navigator.clipboard.writeText` + 1.5s 勾态，卡片/设置页两处复用。

`StickerDisplay`（`:82`）是展示卡，props 有 14 个（`StickerDisplayProps` `:57`），每个对应一个可选操作：`onActivate`（面板主点击=发送）、`activateDisabledReason`（禁用原因 tooltip）、`onEdit` / `onDelete` / `onMoveLayer` / `onFillComposer`（hover 浮钮）、`expanded` / `onToggleExpand` / `onSend` / `sendDisabledReason`（设置页展开态操作行）、`hideHoverActions`（设置页网格不渲 hover 浮钮，一切操作收进展开态操作行）、`style`。卡内三区：左侧竖排标题（`writingMode: "vertical-rl"` 书脊式）、主体（banner 图 + 正文 3 行截断）、底部层徽标（「内置/全局/项目」+ tooltip 说明存储位置）。hover 浮钮 `!expanded && !hideHoverActions` 才渲（`:184`）。

`StickerEditor`（`:247`）是就地编辑器：banner 上传入口 `ctx.dialog.openImages()`（`DialogApi.openImages`，`packages/shared/src/domain/sessions.ts:486`，单张 10MB 上限注释在文件头 `:3`）+ 标题 + 内容 + 保存/取消。`StickerDraft`（`:232`）的 `banner` 是三态：`{base64, mimeType}`=新上传、`null`=移除、缺省=不动——`save` 回调里 `if (uploaded) draft.banner = uploaded; else if (removed) draft.banner = null`（`:272-273`）落到 store 的 `updateSticker` 三态语义。编辑器不歪不装饰（`<StickerCard>` 不传 `noteId`），「输入中的卡面要稳」。

### 5.3 sticker-composer-button.tsx：composerActions 槽按钮

`StickerComposerButton`（`:57`）是 composerActions 槽贡献的按钮组件，props 无（契约 `ComposerActionContribution` 只 `id/component/order`）。

- 打开时读一次贴纸（`loadStickers`），`system:settingsChanged` 后重读（`:69-77`）。
- `openPicker`（`:79`）：`!cwd || streaming` 直接 return（无项目/回复中不开）；`getBoundingClientRect()` 锚定按钮位置，选择器 portal 到 `document.body`，`position: fixed` 定位在按钮下方。
- `send(sticker)`（`:88`）：与 `index.tsx` 的 `sendSticker` 同逻辑（`content.trim() || title.trim() || ""`），`ctx.events.emit("stickers:send", { text, image })`，然后 `setOpen(false)`。**同一份发送请求构造逻辑在 index.tsx 和本文件各写了一遍**——这是个小重复（两处 `const text = sticker.content.trim() || sticker.title?.trim() || ""`），但不构成跨层违规，属同插件内两视图的平行实现。
- `fill(sticker)`（`:100`）：`readBannerDataUri` 读图 → `ctx.events.emit("stickers:fillComposer", { text, image: { src, title, dataUri } })` → 关选择器。
- 键盘导航（`:110-120`）：`window.addEventListener("keydown")`，←↑→↓ 在网格平铺回绕（`(i ± 1 + n) % n`），Enter 发、Esc 关。

`StickerCell`（`:14`）是单格：优先 banner 图，无图显示标题/内容摘要（`title || content.split("\n")[0] || "贴纸"`）；`onClick` 选中、`onDoubleClick` 发送、hover 出「加入输入框」小按钮（`onFill`）。`PickerPortal`（`:165`）是弹层：`createPortal` 到 body，点弹层外关（`mousedown` 监听 `ref.current.contains`），zIndex 99999。

### 5.4 sticker.tsx：便利贴视觉基座

`sticker.tsx` 是纯视觉组件，无任何业务逻辑，无 PluginContext 依赖。

- `hashId(id)`（`:14`）：djb2 字符串哈希，`((h << 5) + h + id.charCodeAt(i)) | 0`。
- `stickerPose(id)`（`:29`）：由贴纸 id 推出稳定姿态——`tilt = (h % 33) / 10 - 1.6`（-1.6~+1.6 度，0.1 步进），`deco = (h >> 5) % 2 === 0 ? "tape" : "pin"`（胶带/图钉各半）。**同一张卡每次渲染歪得一模一样**，不随重渲染跳动。
- `Tape`（`:35`）/ `Pin`（`:56`）：胶带用 `color-mix(in srgb, var(--color-fg) 14%, transparent)` 混出半透明塑料胶带感；图钉用 `radial-gradient` + `var(--color-primary)`。**颜色全吃主题 token，不引入纸色数据字段**——「贴纸感来自几何与装饰」。
- `StickerCard`（`:85`）：容器，`noteId` 给则摆姿态（倾斜+装饰）、缺省平整卡（编辑器用）。hover 回正 + 微放大 + 阴影加深（「被拈起来」），`lifted = hover && pose !== null`，transform `rotate(0deg) scale(1.03)`。

## 6 事件通道：声明、方向、payload

`renderer/index.tsx:42` 一行声明两个 channel：

```ts
export const channels = ["stickers:fillComposer", "stickers:send"] as const;
```

这是本插件**对外发布**的全部事件面。事件总线的机制在 `packages/react/src/event-bus.ts`：框架加载 module 后读 `module.channels` 自动注册（`registerChannels` `:55`），`emit` 校验 channel 在自己声明过的集合里（`emit` `:112-118`：`!this.isChannelOwnedBy(pluginId, channel)` 抛「emit 未声明的 channel」），`on` 校验 channel 来自某个已加载插件或 `system:*` 框架事件（`channelExists` `:103`）。所以**方向必须是 stickers 声明自有 channel、timeline 订阅**——文件头 `:37-39` 注释写死了这条约束：「只有声明方能 emit——所以方向必须是 stickers 声明自有 channel，timeline 以 try/catch 订阅兜底其缺席」。

两个 channel 的语义和 payload：

- `stickers:send`——「直接发送」请求。stickers 点卡片只发请求，timeline 用发送按钮同一条动作执行（`sendText`），模型回灌/入队/附件全一致。payload `{ text: string, image?: { src: string, title?: string } }`。emit 点在 `index.tsx:149` 的 `sendSticker` 和 `sticker-composer-button.tsx:93` 的 `send`。
- `stickers:fillComposer`——「加入输入框」请求（不发送，用户改后手动发）。payload `{ text: string, image?: { src: string, title?: string, dataUri?: string } }`，`dataUri` 是贡献方（stickers）读文件提供的、供 timeline composer 直接渲染的 base64，timeline 只挂载不碰文件读取。emit 点在 `index.tsx:181` 的 `fillComposer` 和 `sticker-composer-button.tsx:102` 的 `fill`。

订阅系统事件用 `system:` 前缀，插件订阅不需要 dependsOn：`useStickers` 订阅 `system:settingsChanged`（`:136`）、`StickerComposerButton` 打开时订阅 `system:settingsChanged`（`:73`）。`system:settingsChanged` 由壳后端在 `config.set` 写盘后经 `broadcastSettingsChanged`（`src/server/controllers/config.ts:24`）广播——这就是「写后 main 广播 → 两侧视图订阅重读」闭环的另一半，数据层写完不重发、靠壳广播。

## 7 与其他插件交互：timeline 是唯一消费方

stickers 的唯一交互对象是 timeline 插件（`src/plugins/sessions/timeline/`）。交互走三条路：`composerActions` 槽（timeline 查槽渲染按钮）、`stickers:fillComposer` 事件（timeline 订阅、追加文本+挂图）、`stickers:send` 事件（timeline 订阅、等效点发送）。三条路都遵循「贡献方不认识消费方、消费方不认识贡献方」的双向解耦——stickers 从不 import timeline，timeline 从不 import stickers，它们只共享圆心契约（槽位类型、channel 字符串、DisplayMeta 类型）。

### 7.1 composerActions 槽：timeline 查槽渲染

链条是「manifest 静态声明 → registry 注册 → renderer hook 查询 → timeline 渲染」四段式：

- stickers 在 `plugin.json` 声明 `composerActions: [{ id: "stickers-picker", component: "StickerComposerButton", order: 10 }]`。
- 壳后端 registry `src/server/application/loader/registry.ts:95` 持 `composerActions = new ArraySlot<ComposerActionContribution>()`，`:330` `composerActionItems()` 列出全部贡献项（按 order 升序、缺省 100）。
- 壳前端经 `window.kernel.slots.composerActions()`（`src/web/kernel/build-kernel.ts:124`）拿到 `{id, component, order, pluginId}[]`；`packages/react/src/composer-actions.ts` 的 `useComposerActions()`（`:13`）把它包成 hook，`pluginsNonce` 失效重拉。
- timeline `src/plugins/sessions/timeline/renderer/index.tsx:720-728` 消费：`useComposerActions()` → `useMemo` 里对每个贡献 `getPluginComponent(c.pluginId, c.component)` 找组件，找到就 `<PluginIdContext.Provider key={c.id} value={c.pluginId}><Comp /></PluginIdContext.Provider>`。

最后那个 `PluginIdContext.Provider` 是关键细节（`:718-719` 注释）：「否则组件落在 timeline 的上下文里，emit/config 等 pluginId 绑定面全部错认成 timeline」。`StickerComposerButton` 内部 `usePluginContext()` 拿到的 pluginId 必须被显式切回 `stickers`，否则它 `ctx.config` 读写、`ctx.events.emit("stickers:send")` 都会错绑到 timeline 的 pluginId。这是所有「槽消费者渲染别的插件的组件」都要做的事，settings/sidebar 槽消费同款。

### 7.2 stickers:fillComposer：追加而非覆盖

timeline `:355-374` 订阅，`try/catch` 包裹：

```ts
try {
  return ctx.events.on("stickers:fillComposer", (payload) => {
    const p = payload as { text?: string; image?: {...} } | null;
    if (typeof text === "string" && text) {
      setInput((prev) => { const pr = prev.trimEnd(); return pr ? `${pr}\n\n${text}` : text; });
    }
    const src = p?.image?.src;
    if (typeof src === "string" && src) setPendingImage({ src, title, dataUri });
  });
} catch { return undefined; }
```

两个语义：

- **追加而非覆盖**：`setInput` 的 reducer 把新文本接在已有草稿后、之间空一行——「已有草稿不能被顶掉」（`:352-353`）。
- **挂图到 composer 上方**：`setPendingImage` 把图挂到 `composerImage` state，`PendingImageBar`（`index.tsx:1476`）在输入框上方渲染，`dataUri` 有则直接渲 `<img>`、无则显示逻辑路径字符串 + title。`composerImageRef`（`:130`）同步镜像供 `doSend` 消费（发送动作在 useCallback 里，ref 同步可见）。

`try/catch` 的意义（`:353` 注释）：stickers 是可选插件，channel 未加载/已禁用时 `on()` 会抛「channel 未被任何已加载插件注册」（event-bus `:171-173`），timeline 兜底绝不因 stickers 缺席而崩。**timeline 不加 dependsOn**——stickers 是可选项，反过来不能卡住受保护的 timeline（stickers 文件头 `:38-39` 注释明说）。

### 7.3 stickers:send：等效点击发送按钮

timeline `:1006-1017` 订阅：

```ts
try {
  return ctx.events.on("stickers:send", (payload) => {
    const p = payload as { text?: string; image?: {...} } | null;
    if (typeof p?.text === "string") {
      void sendTextRef.current(p.text, p.image?.src ? { src: p.image.src, title: p.image.title } : undefined);
    }
  });
} catch { return undefined; }
```

`sendTextRef.current` 是 `sendText` 的 ref 镜像（`:995-996`），因为 `sendText` 每次渲染重建、且依赖 `inputRef.current`，订阅必须读 ref 拿最新闭包（`index.tsx:115-117` 注释：「避免 sendText 依赖 input state 导致 stickers:send 订阅随每次按键重建」）。

`sendText(text, image?)`（`:929`）是「发送按钮与表情包共用的唯一入口」，签名 `Promise<boolean>`（返回 false = 未即时发出：入队/拦截/失败）。它内部：

- 拼参考文件段（`filesSection`）→ `fullText`。
- `hasImage = !!(image ?? composerImageRef.current)`——图也算「有内容」，纯图发送是完整意图（`:942`）。
- 斜杠命令拦截（`/goal` 等，`runComposerCommandIfMatch`）→ 命中吞掉本次发送。
- 空内容 + 无附件 + 无图 → return false；`!currentCwd` → toast「先打开文件夹」。
- `kernelAvailable === false` → 复查自愈（按当前模型归属内核查）。
- `streaming` 中 → `enqueueMessage` 入队（`:964-979`），否则 `doSend` 直发。

`doSend(text, attSnapshot, image)`（`:821`）是真正走 RPC 的序列：`const img = image ?? composerImageRef.current` → `store.sendMessage(currentCwd, text, { sendSuffix, image: img })`。**表情包点发送 = 走 timeline 的 `sendText` → `doSend` → `store.sendMessage`，与点击发送按钮完全同一条路径**——这就是「表情包不再自己写一份 sendMessage 调用」的落点（stickers 文件头 `:40-41`、timeline `:1004` 注释）。模型回灌、工具过滤、乐观回显、统计、streaming 入队全部由 timeline/session-store 统一承担，stickers 不复制任何一份发送逻辑。

### 7.4 清输入框只清「输入框内容」

`sendText` `:935` 有个细节：`const fromComposer = trimmed === inputRef.current.trim()`。清输入框只在「发送的是输入框内容」时发生（`if (fromComposer) setInput("")`），**表情包直接发送不打扰正在草拟的内容**（`:932` 注释）。这保证用户草稿写一半点个表情包发送，草稿不被误清。

## 8 DisplayMeta 展示图 vs vision 图：两条不相交路径

这是本插件最需要讲透的架构点，也是任务点名要求专节的两条路径之一。一句话结论：**stickers 的 banner 图走 `display`（展示元数据），永不进 AI 投影；vision 图走 `sendMessage` 的 `images` 参数进 AI 投影，两者在圆心类型上就是两条互不相交的字段**。

### 8.1 圆心契约：DisplayMeta 显式成类型

`packages/shared/src/domain/session-neutral.ts` 定义：

- `NeutralEntry.display?: DisplayMeta`（`:71`）——中性条目的展示元数据字段，注释：「交流机制，不进 AI 投影。图等归中立层维护，发送时过滤」。
- `DisplayMeta`（`:77-80`）：「只给人看，永不进 pi/dsh 的 AI 投影……「图是交流机制、不是 AI 输入」这条在此显式成类型：展示图走 display，vision 图走 sendMessage 的 images 参数，两条不相交路径」。形状只有一个字段：`image?: { src: string; title?: string }`——`src` 存逻辑路径，图文件本体在全局数据根。

关键在 `session-neutral.ts` 里 `DisplayMeta` 是 `NeutralEntry` 的成员，而 `NeutralEntry` 是「中立会话树」的一部分（`NeutralSession.lineages[].entries[]`）。这意味着展示图是**会话中立层**的数据，由壳维护、随会话持久化，但发送到内核时被过滤掉（不进 AI 投影）。

### 8.2 展示图路径：image → prompt 第三参 → 中立层 → __image → ImageBlock

发送链（stickers 侧触发的完整路径）：

1. `StickerComposerButton.send` / `sendSticker` emit `stickers:send`，payload `image: { src, title }`。
2. timeline `sendText(p.text, { src, title })` → `doSend` → `store.sendMessage(currentCwd, text, { image: { src, title } })`。
3. 前端 `session-store.sendMessage`（`src/web/stores/session-store.ts`）：
   - `:538-546` `const imageOpt = opts?.image`，有图则把 `__image: { src, title }` 挂到**乐观 user 消息**上（`messages.map` 最后一条 user）。
   - `:552-557` `await window.kernel.sessions.prompt(sendText, undefined, imageOpt ? { image: { src, title } } : undefined, prefs)`——注意第二参 `images` 传 `undefined`，第三参 `display` 传 `{ image: {...} }`。
4. `MessagingApi.prompt`（`packages/shared/src/domain/sessions.ts:248`）签名：`prompt(text, images?: ImageInput[], display?: DisplayMeta, prefs?)`——`display` 是第三参，注释 `:244` ：「只进中立层，不进 AI 投影，与 vision 输入 images 是两条不相交路径」。
5. 壳后端 `src/server/controllers/sessions.ts:85-86` 把 `display` 透传给 `sessionStore.prompt`，后者把 `display` 写进中立层（`NeutralEntry.display`），发送到内核的只有 `text`（+ vision `images` 若传）。
6. 重开会话时，main 把中立层 `display` 合进 messages 的 `__image`（timeline `:1318` 注释「main 侧 mergeNeutralDisplay」），renderer `MessageRow` 的 user 分支（`:1356-1357`）读 `(message as NeutralMessage & { __image }).__image`，有图则 `<ImageBlock src={img.src} />`。
7. `ImageBlock`（`src/plugins/sessions/timeline/renderer/image-block.tsx:20`）：`ctx.configFile.readBinary(src)` 读 base64 → 扩展名推 mime → data URI → `<img>`；文件丢失则 `lost` 态显示「图已丢失」占位（`:40-46`）。

这条路径的**运行时验证**在 `src/web/stores/session-store.image.test.ts:117-130`：发带图消息后断言 `calls.prompt[0][1]` 是 `undefined`（无 vision images）、`calls.prompt[0][2]` 等于 `{ image: { src, title } }`（display 进第三参），且不 append `custom_message` 到内核文件（`:129`——不再写 imageIndex/session-images.json，neutral-first 后的落点）。

### 8.3 vision 图路径：images → prompt 第二参 → BaseBackend.sendMessage

vision 图是另一条路，stickers 不涉及，但必须列出来对照才能讲清「不相交」：

- `ImageInput` 定义在 `packages/shared/src/domain/sessions.ts:117`，是给内核的视觉输入。
- 发送时 `prompt(text, images, display, prefs)` 的**第二参** `images`，最终落到 `BaseBackend.sendMessage(text, images?)`（`packages/shared/src/domain/backend.ts:112`）——这是中立契约的消息意图，`images` 进内核 AI 投影。
- pi 扩展面的 `steer(text, images?)` / `followUp(text, images?)`（`sessions.ts:288-290`）同样收 `images`。

两条路径的判别标准：**图是「给人看」还是「给模型看」**。给人看 → `display`（`DisplayMeta.image`），图文件留壳的全局数据根、进会话中立层、发送时过滤、随会话重开还原展示。给模型看 → `images`（`ImageInput[]`），进 AI 投影。stickers 的 banner 图是「IM 配图风格」的交流机制（图挂在 user 消息上方），所以走 `display`，模型看到的只有贴纸文本。

### 8.4 一个易混的第三路径：参考文件（附注）

`packages/shared/src/domain/composer-files.ts` 里 `classifyReferenceFile`（`:51`）把文件分 `"file" | "image"`，这是「参考文件」路径——文件以**绝对路径引用折进正文**，AI 用工具（fs）自己读，既不进 vision 也不进 display。timeline `sendText` 里的 `filesSection`（`index.tsx:938-940`）就是这条。它和 stickers 无关，但阅读「图」相关代码时三路径（display / vision / 参考文件）容易混，一并钉死边界。

## 9 关键机制与设计决策（逐条落点）

下面把散布在各文件的机制性决策收拢，每条都落到具体函数/行号，避免只给结论。

- **manual 保存语义，无保存浮层**。`plugin.json` `saveMode: "manual"` + `configFile: null`，每次写操作即时 `await writeLayer` 落盘。这偏离了「框架管 save/dirty」的默认路径，但因为贴纸管理是高频即时编辑场景（增删改/拖拽/迁移），等保存浮层反而是噪音。写后刷新靠壳后端的 `broadcastSettingsChanged`，不靠本插件重发事件。
- **纯图表情包合法**。`StickerItem.content` 可以是空串（`asStickers` 只判 `typeof o.content === "string"`，`:74`），`createSticker` 不校验 content 非空，`importImages`（遗留）也建 content 空、banner 为图的条目。发送时 `sendSticker` 用 `content.trim() || title.trim() || ""` 兜底，纯图发标题、标题也空发空文本。
- **streaming 中禁发 + 入队**。面板 `send` 的 `useCallback` `if (streaming || !cwd) return`（`:170-175`）挡住直接发；但 timeline 的 `sendText` 在 `streaming` 时走 `enqueueMessage` 入队（`:964`）——两者不矛盾：面板禁发是为了避免误触（禁发时 tooltip「等待当前回复完成」），若绕过面板直接点发送按钮则入队而非丢弃。核心保证是 `sendingRef` 双击闸门（`index.tsx:120-123` 注释的根因修复）。
- **编辑中抑制重读**。`useStickers` 的 `editingRef` + `if (!editingRef.current) void reload()`（`:136-139`），根因是「正在输入时广播重读会把编辑器顶掉」。`StickerComposerButton` 里重读没有这个抑制（它没有编辑器，只有只读网格）。
- **搜索/编辑态禁拖拽**。`dndDisabled = editing !== null || q !== ""`（`:197`、`:456`）——过滤子集里重排会写回错误的 order，所以搜索过滤后或编辑态禁止拖拽排序。
- **拖拽策略分离**。面板用 `makeDragEnd`（纯重排），设置页用内联 `onDragEnd`（区分跨层 `moveToLayer` vs 同层 `reorderStickers`），因为设置页有跨区迁移语义、面板没有。
- **builtin 只读三重守卫**。`createSticker` 对 builtin 抛错（`:313`）、`updateSticker`/`removeSticker`/`moveLayer`/`moveToLayer` 对 builtin 提前 return 或记墓碑、`reorderStickers` 剔除 builtin id 不写回。数据层四层守卫，UI 层 `BuiltinSection` 不渲编辑/迁移入口（只展开/发送/复制/删除）双保险。
- **图文件不随条目删**。`removeSticker` 删条目不删 banner 图（`:360`），因为「会话历史消息的展示仍引用它」——图是展示元数据的一部分，删了历史消息里该图就丢了。这是 DisplayMeta 持久化的一个直接后果。
- **依赖只向内**。全插件只 import `@my-harness-desktop/shared`（类型）和 `@my-harness-desktop/react`（hooks/组件），client 层 `Ctx = Pick<PluginContext, ...>` 不 import React，renderer 层不 import 任何 `@/server`/`@/core`。数据层是纯 IO 函数 + 类型，可独立 vitest 单测（`stickers-store.test.ts` mock ctx 不碰真实文件系统）。
- **手写收敛到成熟包**。拖拽用 `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`，过渡动画用 `framer-motion`（`AnimatePresence`/`motion`），图标用 `lucide-react`，zip 打包由壳后端 `saveZip`/`openZip`（main 用 jszip）。`sticker.tsx` 的 djb2 hash 是手写的小纯函数（稳定姿态用），其余复杂交互全部收敛。
- **零硬编码（部分兑现）**。plugin ID、component 名、slot contribution ID 不在代码里出现字符串字面量（组件自动匹配、pluginId 由 PluginIdContext 注入）。但 `channel` 字符串 `"stickers:fillComposer"`/`"stickers:send"` 是代码级 `export const channels` 声明（事件总线约定，代码即声明），文案走 `t("stickers.*")` i18n key、颜色全吃主题 token。注意一个真实存在的偏差：`StickerDisplay` 的层徽标 tooltip（`:172-178`）和部分按钮 title 写死了中文文案（如「设为全局」「移到项目」「加入输入框（不发送，可改后再发）」），这些是硬编码的用户可见文案，严格按 §1.2「token key 合规、token 值违规」看属于待收的内容泄漏（历史残留，非本轮重点）。

## 10 QA

**Q：stickers 为什么不需要 pi-extension / dsh-extension？**

因为它是纯 UI 内容插件，不向任何内核补能力。它出的「文本 + 展示图」最后都借 timeline 的发送动作进会话：文本进 prompt，图进中立层 `display`。它既不注入系统提示、也不注册工具、也不改会话模型，没有「内核侧缺能力」需要补面——所以四件套里只用 renderer + client + locales 三件。对照参考实现 `src/plugins/sessions/goal/`（含 pi-extension + dsh-extension）就能看出差别：goal 需要给两个内核补「目标追踪」能力，stickers 不需要。

**Q：删掉内置贴纸，为什么随壳资产文件还在？**

因为内置贴纸的 manifest 是壳启动时 `mirrorManagedDir` 强制镜像的受管文件，用户无权也不该改受管目录（改了下次启动被覆盖回源）。删除只能「记墓碑」——`removeSticker` 对 builtin 只把 id 写进全局层 config 的 `removedBuiltin` key，`loadStickers` 读时过滤。这样升级壳新增的内置贴纸照常出现，用户删过的旧内置贴纸下次启动仍不回来，两个语义都不破坏。

**Q：banner 图删了条目为什么不删图文件？**

图是展示元数据的一部分，随会话历史持久化（`NeutralEntry.display.image.src` 指向图文件）。会话里已经发出过的消息，重开时还要渲染那张图。如果删条目就连带删图文件，历史消息里的图就变成「图已丢失」占位。所以图文件是独立的、恒全局的存储，条目的生命周期（增删/迁移）不连带图文件的生命周期——`removeSticker` 只 filter 掉条目本体，不碰 `BANNER_DIR`。

**Q：stickers 点发送和点发送按钮，到底有没有区别？**

在「发送」这个动作上没有区别——`stickers:send` 事件被 timeline 订阅后调 `sendText`，与发送按钮走同一条 `sendText → doSend → store.sendMessage`，模型回灌/工具过滤/乐观回显/统计/streaming 入队全一致。区别只在「清输入框」：`sendText` 里 `fromComposer = trimmed === inputRef.current.trim()` 判断发送的是不是输入框内容，表情包直接发送不是输入框内容，所以不清草稿；点发送按钮发的是输入框内容，才清。

**Q：为什么 timeline 订阅 stickers 的 channel 要 try/catch 而不加 dependsOn？**

因为 stickers 是可选的、可被禁用的插件。`on()` 对「未被任何已加载插件注册的 channel」会抛错（event-bus `:171-173`），timeline 若不加 try/catch，stickers 缺席时 timeline 自己崩。而 dependsOn 是生命周期护栏不控制加载顺序，且 timeline 是受保护插件、stickers 是可选插件——timeline 加 dependsOn 会让可选插件反过来卡住受保护插件，方向错了。所以约定是：stickers 声明自有 channel 并 emit，timeline try/catch 订阅兜底。

**Q：DisplayMeta 的图和 vision 的图，判别标准是什么？**

一句话：图是「给人看」还是「给模型看」。给人看（IM 配图、贴纸 banner）走 `display`（`DisplayMeta.image`），图文件留壳的全局数据根、进中立层、发送时过滤不进 AI 投影、随会话重开还原展示。给模型看（要模型理解图像内容）走 `sendMessage` 的 `images`（`ImageInput[]`），进 AI 投影。圆心类型层面就是两个不相交字段：`prompt(text, images?, display?, prefs?)` 的第二参和第三参，`BaseBackend.sendMessage(text, images?)` 只有第二参（vision），`DisplayMeta` 只在 `NeutralEntry` 上。stickers 的 banner 图永远是前者。

**Q：三层并集和配置的两层覆盖，为什么不一样？**

覆盖型配置（主题 token 等）是「全局写全量、项目层只存 diff，读时项目层覆盖全局层」——同一个 key 有两份，项目层胜出。贴纸不是 key-value，是「一条只属于一层」的条目集合，id 全局唯一、无遮蔽。所以读用 `ctx.config.getScope(scope)` 拿单层原始快照再并集排序，不用 `ctx.config.all()`（合并后快照）；迁移是把条目本体从一层搬到另一层（`moveLayer`/`moveToLayer`），不是两层各存一份再覆盖。文件头注释 `:7` 明说「合并是并集按 order 排序，不是配置那种同 key 覆盖」。

**Q：stickers-store 里那几个 export 但没接线的函数是干嘛的？**

`exportStickers`/`importStickers`（JSON 版）和 `importImages`/`exportStickerImages` 是 zip 方案上线前的旧入口，现在 `renderer/index.tsx` 只 import `exportStickersZip, importStickersZip`，四个旧函数无调用点，属 stale 代码。JSON 导入导出被 zip 取代（zip 能带图、JSON 只能带 base64 单文件），图片导入导出被「设置页 zip 整体导入导出」取代。它们仍在编译面暴露但不参与运行时路径，未来清理熵增时可删。
