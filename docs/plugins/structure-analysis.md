# 结构分析插件设计（structure-analysis）

> 状态：低保真已确认，待开发。
> 关联：`docs/plugins/git-review.md`（勾选 + 生成 + 会话投喂的交互范式）、`docs/plugins/projects.md`（项目上下文）、`docs/design/plugin-decoupling.md`（槽位三段式）。

## 1. 定位

一个挂在右面板的"项目结构辅助分析"插件：看着整个目录树做**架构 / 分层 / 职责**级 review，不读代码细节。核心仍是中区会话流——插件把「结构 + 逐节点介绍 + review 结论」作为**待发送附件**投喂回会话，让用户接着在对话里追问或动手改。

一句话：**file-tree 给的是"文件在哪"，本插件给的是"目录是干什么的、架构对不对"，并能把结论带回会话。**

## 2. 放哪（槽位决策）

| 槽位 | 角色 | 决策 |
|---|---|---|
| `sidePanel` | 主视图：右面板 Tab「结构分析」 | ✅ 主落点，`order: 20`（「Review」10、「文件」30 之间） |
| `composerAttachments` | 会话结合：把分析结果作为输入框附件投喂 | ✅ 副落点（与 `review` 插件同范式） |
| `fileActions` | 入口增强：文件树右键"分析此目录"，`revealOn` 跳转激活本 Tab | 🔶 可选（第二期） |
| `settingsGroups` | 配置默认 ignore 清单 / 默认深度 | 🔶 可选（第二期） |

不落 `mainView`（中区是 timeline 会话流本体）、不落 `sidebar`（左栏是会话/项目导航）。

## 3. 低保真线框（最终版，已确认决策标注）

### 3.1 全局布局

```
┌──────────────┬────────────────────────────────┬─────────────────────────┐
│ 左栏(sidebar)│  中区 timeline（会话流，不动）   │ 右面板(sidePanel)        │
│              │                                │ ┌─────────────────────┐ │
│ ▾ 对话        │  user / assistant / tool …     │ │[文件][结构分析][Rev…]│ │ ← 新 Tab
│ ▾ 项目        │  ┌──────────────────────────┐  │ │ 深度切换 + 过滤       │ │
│   · 当前项目  │  │ 输入框(composer)         │  │ │ 树 + 逐节点介绍       │ │
│              │  └──────────────────────────┘  │ │ + 勾选 review + 发送  │ │
│              │                                │ └─────────────────────┘ │
└──────────────┴────────────────────────────────┴─────────────────────────┘
```

### 3.2 Tab 内容 · 工具栏 + 逐节点介绍 + 勾选聚焦

```
┌─ 结构分析 ────────────────────────────────────────────────────────────────┐
│ [🔍 过滤目录/文件…]  (○一级)(●二级)(○三级)(○全展开)   [⚙排除] [↻]      │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ ☐ 📁 src                                                            │ │
│ │    源码入口，含 plugins/server/web 三大部分      ← 逐节点介绍(已确认)   │ │
│ │   ☐ ├─ 📁 plugins    内容层壳插件                                    │ │
│ │   ☑ └─ 📁 server     后端（命中，展开）                              │ │
│ │       ☑ ├─ 📁 application   用例编排                                │ │
│ │       ☐ ├─ 📁 client        流出适配器                              │ │
│ │       ☐ └─ 📁 controllers   IPC 控制器                             │ │
│ │ ☐ 📁 web     渲染层                                                  │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ [✨ 生成介绍]  [🧪 Review 选中 (2)]   ← 勾选即隐式圈定 review 范围        │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.3 过滤：搜索聚焦（命中路径 + 祖先链保留，其余折叠）

```
┌─ 结构分析 ────────────────────────────────────────────────────────────────┐
│ [🔍 controller ]   (○一级)(○二级)(○三级)(●全展开)    [⚙] [↻]           │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ ▸ 📁 src                                                            │ │
│ │ ▸ 📁 server                                                         │ │
│ │   ▾ 📁 controllers            ← 命中 "controller"                   │ │
│ │     ├─ 📄 ipc-sessions.ts                                           │ │
│ │     ├─ 📄 slots-dialog.ts                                           │ │
│ │     └─ …                                                           │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.4 排除目录（⚙）：持久忽略清单，读树前就跳过

```
┌─ 结构分析 ────────────────────────────────────────────────────────────────┐
│  ⚙ 排除目录（读树前跳过，不回读子树）                          [保存]     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ ☑ node_modules   ☑ .git   ☑ dist   ☑ out   ☑ build              │   │
│  │ ☑ __pycache__    ☐ vendor  ☐ .next  ☐ target                     │   │
│  │ [新增目录名…]                                              [+]   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│  提示：排除项经 readDirTree(ignore:[…]) 传给内核，内核不回读该子树       │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Review 选中目录（结构级，附"关键文件摘要"开关，默认关）

```
┌─ 结构分析 ────────────────────────────────────────────────────────────────┐
│ [🧪 Review 选中 (2)]  范围：src/server + src/web     [附文件摘要 ⬜]      │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ 🧪 架构 Review（目录结构级，未读代码文件内容）                         │ │
│ │ ✅ src/server/application  用例编排层，只依赖 domain/接口，方向正确    │ │
│ │ ✅ src/server/client       流出适配器，未 import react，分层干净        │ │
│ │ ⚠️ src/web                 渲染层，注意别反向 import server/application│ │
│ │ 💡 建议：web 与 server 的边界可用 packages/shared 收敛类型             │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ [⇥ 发送到会话]（review 结论 + 目录结构 一起拼进 prompt）                  │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.6 发送到会话（composerAttachments 附件条，与 review 插件同款）

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 输入框上方：                                                            │
│ ┌───────────────────────────────────────────────────────────────────┐   │
│ │ 📎 结构Review · src/server+web  范围2目录 · 附3条结论        [×]   │   │
│ └───────────────────────────────────────────────────────────────────┘   │
│ [就这个 review 结论，帮我把依赖方向问题具体改一下…]        [发送 ▸]     │
│  ↑ 发出时：review 结论 + 目录结构 自动拼进 prompt（已确认）               │
└───────────────────────────────────────────────────────────────────────────┘
```

## 4. 插件目录结构（对齐现有惯例）

```
src/plugins/project/structure-analysis/
  plugin.json
  renderer/
    index.tsx              # StructureAnalysisTab（右面板 Tab 入口）
    toolbar.tsx            # 搜索框 + 深度切换 + ⚙排除 + 刷新
    structure-tree.tsx     # 树 + checkbox + 逐节点介绍（懒加载下钻）
    ignore-sheet.tsx       # 排除目录弹层
    prompt-editor.tsx      # 自定义 prompt 输入（默认指令可回填）
    review-panel.tsx       # review 结果区
  core/
    tree-slice.ts          # 纯函数：FileTreeNode → 按深度/关键字切片
    serialize.ts           # 纯函数：树 → 缩进文本片段（prompt 用）
    prompt-assembly.ts     # 纯函数：结构片段 + 默认/自定义指令 → AI prompt
    analysis-model.ts      # 类型：NodeDescription / StructureReview
  client/
    tree-reader.ts         # 树读取封装：maxDepth 切换 + ignore 透传 + 懒加载下钻
    analysis-store.ts      # 介绍/review 结果的持久化缓存（ctx.config 项目级）
  locales/{zh-CN,zh-TW,en,de}/*.json
```

## 5. manifest

```jsonc
{
  "id": "structure-analysis",
  "version": "0.1.0",
  "tier": "official",
  "displayName": "结构分析",
  "description": "右面板项目结构辅助分析：目录级架构 review + 逐节点介绍，结论可投喂回会话",
  "tags": ["project", "review"],
  "renderer": "./renderer/index.tsx",
  "permissions": ["fs:project", "llm:oneshot"],
  "dependsOn": ["timeline"],              // invoke timeline:composerAttachments
  "contributes": {
    "sidePanel": [
      { "id": "structure", "label": "结构分析", "icon": "folder-tree",
        "component": "StructureAnalysisTab", "order": 20 }
    ],
    "languages": [ /* zh-CN / zh-TW / en / de */ ]
  }
}
```

## 6. 数据流

```
currentCwd（useUiStore().currentCwd）
  │
  ├─ readDirTree(cwd, { maxDepth: 1|2|3, ignore })   ← 深度切换(1/2/3)
  │     或 readDirTree(dirPath, { maxDepth: 1 })     ← 全展开=懒加载逐层下钻
  ▼
FileTreeNode（目录 children:undefined = 未下钻）
  │  tree-slice（深度切片 + 关键字过滤 + 勾选聚焦）
  ▼
渲染树（逐节点介绍内联）
  │  "✨ 生成介绍" → prompt-assembly(结构片段, 默认|自定义指令)
  ▼
ctx.llm.oneshot(prompt)  →  NodeDescription  →  analysis-store 缓存
  │  "🧪 Review 选中" → prompt-assembly(勾选范围结构, review 指令, [可选关键文件摘要])
  ▼
ctx.llm.oneshot(prompt)  →  StructureReview  →  结果区渲染
  │  "⇥ 发送到会话" → serialize(review 结论 + 目录结构)
  ▼
ctx.events.invoke("timeline:composerAttachments",
                  { sessionKey, items, promptFragment })   ← 与 review 插件同通道
```

## 7. 核心逻辑设计

### 7.1 树读取与"真·全展开"（懒加载）

- `FileTreeNode`（`packages/shared/src/domain/sessions.ts:434`）语义：目录 `children: undefined` = 未下钻，消费方可懒加载。
- **深度切换 1/2/3**：`readDirTree(root, { maxDepth: 1|2|3, ignore })` 一次拿 N 层，纯参数差异。
- **全展开**：无固定上限。初次 `readDirTree(root, { maxDepth: 1 })` 只拿根层，展开某目录时对该目录 `readDirTree(dirPath, { maxDepth: 1 })` 下钻一层，以此类推——只读展开的部分，节点再多也不卡。
- `ignore` 清单默认 `["node_modules", ".git", "dist", "out", "build", "__pycache__"]`，用户可在 ⚙ 弹层增删，持久化到项目级 `ctx.config`。

### 7.2 过滤（三种，正交）

1. **搜索聚焦**：工具栏关键字，`tree-slice` 只保留命中节点 + 其祖先链，其余折叠为 `▸`（纯前端，不重读磁盘）。
2. **排除目录**：`ignore` 清单，读树前由内核跳过（`readDirTree` 的 `ignore` 参数），不回读子树。
3. **勾选聚焦**：目录行 checkbox，勾选集合 = review 范围。

### 7.3 逐节点介绍（已确认：每个目录一句）

- 粒度：**每个目录节点一条** `NodeDescription`，不是每级汇总。
- 生成：`ctx.llm.oneshot`。单节点可「↻重生成」，整层可「✨ 生成当前深度介绍」（串行逐节点生成，避免一次要结构化 JSON 的脆弱性）。
- 缓存：按 `nodePath` 键控存 `analysis-store`，切深度/切项目不丢已生成项。

### 7.4 目录级 review（不读代码细节）

- 输入 = 勾选范围的**目录结构**（每目录：路径 + 子目录清单 + 关键文件名清单）。
- 「附关键文件摘要」开关（默认关）：勾选后对 `package.json`（name/scripts/deps）、`README`、各目录 `index` 等骨架文件各读开头 N 行喂入，**不读具体业务代码文件**。
- 输出 = `StructureReview`，行级 `{ kind: "ok"|"warn"|"tip", text }`，结果区按 ✅/⚠️/💡 渲染。

### 7.5 prompt 组装（`prompt-assembly.ts`，纯函数）

- 结构序列化 `serialize.ts`：`FileTreeNode → 缩进文本`，纯函数，零依赖。
- 默认指令与 review 指令是**内容**，走 i18n key（`t("prompt.nodeDesc")` / `t("prompt.review")`），不硬编码在 core。
- 自定义 prompt 只替换"指令"，结构片段由插件自动拼入；应用范围可选「当前深度 / 当前节点 / 整树 / 勾选范围」。

### 7.6 结果持久化

`analysis-store.ts` 用 `ctx.config`（项目级 scope）按 cwd 分桶存 `descriptions` 与 `reviews`，重开项目不丢。

## 8. 会话流结合

- 唯一通道：`ctx.events.invoke("timeline:composerAttachments", payload)`，payload 形状见 `ComposerAttachmentPayload`（`contributions.ts:234`）。
- `promptFragment` = `serialize(review 结论 + 目录结构)`（已确认：两者一起拼）。
- 依赖 `dependsOn: ["timeline"]`（消费对方 channel 的护栏）。
- 不直连 `messaging.prompt`——附件投喂让用户可编辑后再发，符合"核心还是会话、辅助分析不抢主动权"。

## 9. 分层纪律对照

- `core/` 纯类型 + 纯函数（tree-slice / serialize / prompt-assembly），零 react/electron import，可单测。
- `client/` 只做 IO 适配（tree-reader、analysis-store），不写 UI。
- `renderer/` 只调 `usePluginContext()` + 纯展示组件，零硬编码 pluginId/component 名（框架自动匹配）。
- 文案与默认 prompt 指令句全走 `locales/`，代码里不出现写死中文/颜色。
- 只依赖 `@my-harness-desktop/react` 与 `@my-harness-desktop/shared` 发布面，不 import `src/server`/`src/web` 内部。

## 10. 已确认决策清单

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 主落点 | 右面板 `sidePanel` Tab，`order: 20` |
| 2 | 会话结合 | `composerAttachments` 附件投喂 |
| 3 | 介绍粒度 | 逐节点（每个目录一句） |
| 4 | 全展开 | 真·全展开，懒加载逐层下钻，无固定上限 |
| 5 | 发送内容 | review 结论 + 目录结构 一起拼进 prompt |
| 6 | review 形态 | 目录结构级，不读代码细节，附"关键文件摘要"开关（默认关） |
| 7 | 过滤 | 搜索聚焦 + ignore 排除 + 勾选聚焦 三种正交 |

## 11. 落地计划（每个 commit 都是可用的完整态）

1. **骨架**：`plugin.json` + `locales` + `renderer/index.tsx`（空 Tab 挂上右面板，可点开）。
2. **读树 + 深度切片 + 过滤**：`core/tree-slice.ts` + `client/tree-reader.ts` + `renderer/structure-tree.tsx`（1/2/3/全展开懒加载 + 搜索 + ignore 可用）。
3. **AI 生成**：`core/prompt-assembly.ts` + `core/serialize.ts` + `client/analysis-store.ts` + `renderer/prompt-editor.tsx`（默认/自定义 prompt、逐节点介绍、勾选 review 全通）。
4. **会话流结合**：`composerAttachments` 附件投喂收尾。
