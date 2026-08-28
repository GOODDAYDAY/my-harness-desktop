# 插件管理：UI 增强设计

> 本文是 `plugin-manager` 插件 UI 层的增量设计，覆盖 i18n 接入、分页、来源分类、插件描述、排序五个需求。内核机制（加载器/注册表/生命周期）不变，改动集中在 `PluginManifest` 类型扩展 + `PluginListItem` 数据模型 + renderer UI。
>
> **实现后变更**：保护机制从硬编码 id 清单改为纯 manifest `protected` 字段（59d6b7f）；tier 不再按 source 推断，改为统一 community 兜底 + manifest 声明（59d6b7f）；main 侧 `pluginLoader.load` 改 no-op，renderer 侧 `plugins-host` 负责全部加载（dbda4f2 + 72bfe61）。

## 1 i18n 接入

当前插件管理页面的所有文案都是硬编码中文——"安装插件"、"操作成功"、"启用"、"禁用"等。需要接入 i18n 系统，走 `t("key")` 查表。

### 1.1 i18n key 命名空间

新增 i18n namespace `plugin`（复用已有的 `src/plugins/i18n/locales/*/plugin.json` 文件），key 前缀 `pluginManager.*`：

```json
// zh-CN/plugin.json 新增
{
  "pluginManager.title": "插件",
  "pluginManager.install": "安装插件",
  "pluginManager.installPlaceholder": "输入 URL 或选择本地文件",
  "pluginManager.selectFile": "选择文件",
  "pluginManager.installing": "安装中...",
  "pluginManager.installBtn": "安装",
  "pluginManager.operationSuccess": "操作成功",
  "pluginManager.operationFailed": "操作失败",
  "pluginManager.enable": "启用",
  "pluginManager.disable": "禁用",
  "pluginManager.uninstall": "卸载",
  "pluginManager.reload": "重载",
  "pluginManager.protectedTooltip": "受保护，不可卸载",
  "pluginManager.pagePrev": "上一页",
  "pluginManager.pageNext": "下一页",
  "pluginManager.tierOfficial": "官方",
  "pluginManager.tierVerified": "认证",
  "pluginManager.tierCommunity": "社区",
  "pluginManager.stateActive": "运行中",
  "pluginManager.stateInactive": "已禁用",
  "pluginManager.stateError": "加载失败"
}
```

四语言文件同步新增（zh-CN / zh-TW / en / de）。

### 1.2 设置页标题

`plugin.json` 里 settings 贡献项的 `title: "插件"` 走已有的 `t("settings.plugins")` 机制——settings-page 渲染左列表时已经调 `t("settings." + item.id)`。所以只需要在 i18n 的 settings namespace 里加 `"settings.plugins": "插件"`。

### 1.3 插件 displayName 的 i18n

每个插件的显示名也需要 i18n。当前 `plugin.json` 里的 `displayName` 是硬编码的（如 `"插件管理"`）。已有的模式是 i18n 插件的 `plugin.json` 文件里有 `plugin.<id>.displayName` key——比如 `"plugin.i18n.displayName": "国际化"`。

plugin-manager 页面显示插件名时，先查 `t("plugin." + p.id + ".displayName")`，查不到 fallback 到 `p.displayName`（manifest 里的值）。这样已有的内置插件名字都会走 i18n，第三方插件没贡献 i18n 的就显示 manifest 里的 displayName。

## 2 来源分类（tier）

### 2.1 tier 字段

`PluginManifest` 新增 `tier` 字段，和 `source` 正交：

```ts
export type PluginTier = "official" | "verified" | "community";

export interface PluginManifest {
  // ... 已有字段
  tier?: PluginTier;
}
```

三个 tier 的语义：

- **official（官方）**：随壳分发的内置插件，my-harness-desktop 团队维护。需在 manifest 里声明 `"tier": "official"`。
- **verified（认证）**：经审核的第三方插件，有明确的作者和来源。需在 manifest 里声明 `"tier": "verified"`。
- **community（社区）**：用户自己放的或未经审核的插件。未声明 tier 的插件统一为 community（中性兜底）。

tier 完全由 manifest 声明，不按 source 自动赋级——这避免了"内置 = official"的隐性特权（§1.4 无特权差异）。source 管物理位置（磁盘上哪个目录），tier 管信任级别（manifest 声明），两者正交但 tier 不从 source 推断。

### 2.2 PluginListItem 扩展

```ts
export interface PluginListItem {
  id: string;
  displayName: string;
  version: string;
  source: "project" | "user" | "installed" | "builtin";
  tier: PluginTier;
  state: PluginState;
  protected: boolean;
  description?: string;
}
```

`description` 从 manifest 的 `description` 字段读取（已有字段，当前未用）。

### 2.3 UI 展示

每个插件行的副信息行显示：`id · tier badge · state`。tier 用彩色 badge：

- official：primary 色
- verified：success 色
- community：muted 色

## 3 插件描述

### 3.1 manifest description 字段

`PluginManifest` 已有 `description?: string` 字段（i18n 插件在用）。所有插件在 `plugin.json` 里声明 `description`，plugin-manager 页面展示它。

```json
{
  "id": "sessions-list",
  "description": "左栏会话列表：搜索、新建、分组、置顶、归档"
}
```

### 3.2 description 的 i18n

和 displayName 同理——先查 `t("plugin." + p.id + ".description")`，查不到 fallback 到 manifest 的 `description`。已有内置插件在 i18n 的 `plugin.json` 里补 `plugin.<id>.description` key。

### 3.3 UI 展示

插件行扩展为两行布局：

```
[图标] 显示名  v0.4.9  [官方 badge]  [Shield]
       描述文字一行截断
       id · 来源 · 状态                    [启用] [重载] [卸载]
```

描述过长时 `text-overflow: ellipsis` 截断，hover 1s 后显示自定义 tooltip 气泡（`TooltipButton` 组件，替代原生 `title` 属性）。

## 4 分页

### 4.1 分页模型

插件列表前端分页（不涉及 IPC 改动——`plugins:list` 仍然返回全量，renderer 侧切片）：

```ts
const PAGE_SIZE = 10;
const [currentPage, setCurrentPage] = useState(1);
const totalPages = Math.ceil(plugins.length / PAGE_SIZE);
const pageItems = plugins.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
```

### 4.2 分页 UI

列表底部：

```
< 1 2 3 ... 5 >
```

- 页码按钮：当前页高亮，点击跳转
- 上一页/下一页箭头：首页禁用上一页，末页禁用下一页
- 总数显示："共 23 个插件"

插件总数 ≤ PAGE_SIZE 时不显示分页栏。

### 4.3 分页 + 排序的交互

排序变化时重置到第 1 页。用户在第 3 页禁用了一个插件后 refresh，列表长度可能变化——如果当前页超出 totalPages，自动回退到最后一页。

```ts
useEffect(() => {
  if (currentPage > totalPages) setCurrentPage(Math.max(1, totalPages));
}, [currentPage, totalPages]);
```

## 5 排序

### 5.1 排序规则

默认排序（用户未拖拽时）按三级优先级：

1. **tier**：official → verified → community
2. **source**：builtin → installed → user → project
3. **displayName**：字母升序

manifest 的 `order` 字段不参与插件管理页面的排序——`order` 是槽位贡献项的排序（settings 列表里的顺序），不是插件整体在管理页面的顺序。两者语义不同。

### 5.2 用户拖拽排序

用户可以在管理页面拖拽插件行调整顺序。拖拽顺序持久化到 plugin-manager 的 config（`configStore`），key 为 `customOrder`：

```json
["plugin-manager", "i18n", "sessions-list", "git-review", ...]
```

### 5.3 排序合成

最终列表顺序 = customOrder 里有记录的按 customOrder 排 + 其余按默认规则排到末尾。

```ts
function sortPlugins(plugins: PluginListItem[], customOrder: string[]): PluginListItem[] {
  const orderMap = new Map(customOrder.map((id, i) => [id, i]));
  return [...plugins].sort((a, b) => {
    const aOrder = orderMap.get(a.id);
    const bOrder = orderMap.get(b.id);
    // 两个都在 customOrder 里：按 customOrder 排
    if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
    // 只有一个在 customOrder 里：在 customOrder 里的排前面
    if (aOrder !== undefined) return -1;
    if (bOrder !== undefined) return 1;
    // 都不在 customOrder 里：按默认规则排
    return defaultCompare(a, b);
  });
}

function defaultCompare(a: PluginListItem, b: PluginListItem): number {
  const tierOrder = { official: 0, verified: 1, community: 2 };
  if (a.tier !== b.tier) return tierOrder[a.tier] - tierOrder[b.tier];
  const sourceOrder = { builtin: 0, installed: 1, user: 2, project: 3 };
  if (a.source !== b.source) return sourceOrder[a.source] - sourceOrder[b.source];
  return a.displayName.localeCompare(b.displayName);
}
```

### 5.4 拖拽实现

用 `@dnd-kit/sortable`（项目已有 `@dnd-kit/core` + `@dnd-kit/sortable` 依赖）。每个插件行用 `useSortable`，列表用 `SortableContext`。拖拽完成后更新 `customOrder` 并持久化到 configStore。

### 5.5 拖拽只影响显示顺序

关键设计决策：**拖拽排序只影响管理页面的显示顺序，不影响加载优先级**。加载优先级始终由 source 的四目录优先级决定（project > user > installed > builtin），这是内核机制，用户不能通过拖拽改变。拖拽改变的是"你在管理页面先看到谁"，不是"谁先加载"。

## 6 实现改动清单

### 6.1 domain 层

`contributions.ts`：
- `PluginManifest` 新增 `tier?: PluginTier`、`description?: string`（description 已有但未在 PluginListItem 里暴露）
- 新增 `PluginTier` 类型
- `PluginListItem` 新增 `tier: PluginTier`、`description?: string`

### 6.2 application 层

`lifecycle/index.ts`：
- `getPluginState` 不变
- `plugins:list` IPC handler 里组装 `PluginListItem` 时填充 `tier`（从 manifest 读，未声明统一 community）和 `description`（从 manifest 读）
- 不可卸载由 manifest `protected` 字段声明，内核不硬编码插件 id 列表（§1.4 无特权差异）。plugin-manager/i18n/theme 各自在 `plugin.json` 声明 `"protected": true`。

tier 推断逻辑：
```ts
function inferTier(manifest: PluginManifest, _source: string): PluginTier {
  // tier 由 manifest 声明，不按 source 自动赋级（避免"内置=official"隐性特权）。
  return manifest.tier ?? "community";
}
```

### 6.3 i18n 层

`src/plugins/i18n/locales/*/plugin.json` 四语言文件新增 `pluginManager.*` keys。
`src/plugins/i18n/locales/*/settings.json` 四语言文件新增 `"settings.plugins"` key。
`src/plugins/i18n/locales/*/plugin.json` 补充已有插件的 `plugin.<id>.description` keys。

### 6.4 plugin-manager renderer

`renderer/index.tsx`：
- 所有硬编码文案改 `t("pluginManager.*")`
- 插件行布局改为两行（名称+描述）
- 新增分页组件
- 新增拖拽排序（@dnd-kit/sortable）
- 插件 displayName/description 走 i18n fallback
- tier badge 展示
- customOrder 从 configStore 读写

### 6.5 各插件 plugin.json

已有内置插件在 `plugin.json` 里补 `description` 字段。不强制——缺 description 的插件显示空描述行，不影响功能。

## 7 QA

**Q1：用户拖拽排序后，新安装的插件出现在哪？**

出现在列表末尾——新插件的 id 不在 `customOrder` 里，按默认规则排到所有 customOrder 之后的末尾位置。用户如果想调整新插件的位置，手动拖拽。

**Q2：分页和拖拽的关系——第 2 页的插件能拖到第 1 页吗？**

不能。拖拽在同一页内进行——`SortableContext` 只包裹当前页的插件行。跨页拖拽需要虚拟列表 + 复杂的坐标计算，投入产出比太低。用户想跨页调整顺序，先翻到目标页记下位置，再翻回来拖。

**Q3：tier 可以伪造吗？第三方插件声明 `tier: "official"`？**

可以伪造——tier 是 manifest 声明的语义字段，没有签名机制。和 `protected: true` 一样，恶意插件可以自评。系统不维护硬保护清单——不可卸载由 manifest `protected` 字段声明，内核不硬编码插件 id 列表（§1.4 无特权差异）。tier 只影响显示 badge，不影响加载优先级。未来如果有插件签名机制，可以做 tier 校验。

**Q4：description 很长怎么办？**

单行截断（`text-overflow: ellipsis`），hover 显示完整描述（`title` 属性）。不做多行展开——管理页面是列表视图，不是详情页。如果用户需要看完整描述，hover 即可。

**Q5：排序后翻页，翻到第 2 页再回来，排序还在吗？**

在。`customOrder` 是持久化的，不随翻页变化。翻页只是切片展示，排序是全量排好后切片。

## 8 分类 tag 过滤

插件数量增长后（28 个内置插件里 7 个是主题），管理页需要按类别筛选。tag 是插件公共元数据的第一种实现：抽象是"每个插件都有公共元数据"，tag 是落地形态。

### 8.1 tag 从哪来：推导 ∪ 声明

`PluginManifest` 新增 `tags?: string[]`（声明式部分）；`PluginListItem` 新增 `tags: string[]`（解析结果）。最终 tags 由圆心纯函数 `resolvePluginTags(manifest)` 合成：

```ts
export function derivePluginTags(contributes?: PluginContributes): string[] {
  const tags: string[] = [];
  if (contributes?.themes?.length) tags.push("theme");
  if (contributes?.languages?.length) tags.push("i18n");
  if (contributes?.settings?.length) tags.push("management");
  return tags;
}

export function resolvePluginTags(manifest: Pick<PluginManifest, "tags" | "contributes">): string[] {
  return [...new Set([...derivePluginTags(manifest.contributes), ...(manifest.tags ?? [])])];
}
```

推导规则（机制，稳定）：`themes→theme`、`languages→i18n`、`settings→management`。无语义槽（sidebar/sidePanel/mainView/titlebar）不推导，由 manifest 显式声明。28 个内置插件里 16 个零声明自动带 tag——框架管通用（§3.3），插件不为每个分类各写一遍元数据。

### 8.2 推荐词表

`RECOMMENDED_PLUGIN_TAGS`（11 个）：theme / i18n / management / session / project / git / conversation / review / dev / productivity / insight。

推荐而非强制——manifest 可自由追加词表外 tag（防止 theme/themes/主题 近义漂移靠词表引导，不靠硬校验）。词表的消费点：管理页 chip 排序按词表序优先，词表外 tag 字母序排末尾。词表是标识符不是文案，用户可见标签走 i18n `pluginManager.tag.<tag>` key（四语言），词表外 tag 经 `defaultValue` 回退显示原标识符。

### 8.3 筛选模型

三态 chip：点击循环 不过滤 → 只看(inc) → 排除(exc) → 不过滤，可多 chip 组合：

```ts
type TagFilter = Record<string, "inc" | "exc">;  // 不存在的 key = 不过滤

function filterPluginsByTags(plugins: PluginListItem[], filter: TagFilter): PluginListItem[] {
  const inc = Object.keys(filter).filter((t) => filter[t] === "inc");
  const exc = Object.keys(filter).filter((t) => filter[t] === "exc");
  if (!inc.length && !exc.length) return plugins;
  return plugins.filter((p) => {
    if (inc.length && !p.tags.some((t) => inc.includes(t))) return false;
    if (p.tags.some((t) => exc.includes(t))) return false;
    return true;
  });
}
```

语义：inc 非空时先取并集（有任一 inc tag 即入选），再减去 exc（有任一 exc tag 即出局）。被排除的插件完全消失（不留折叠桩）——筛选是视图过滤不是状态变更，`plugins:list` 永远返回全量。

### 8.4 持久化与分页

筛选态写 plugin-manager 自己的 config（`ctx.config.set("tagFilter", ...)`），下次打开保持"排除 theme"。筛选在排序之后、分页之前：`sortedPlugins → filteredPlugins → pageItems`，分页总数显示过滤后数量。筛选变化不重置 `customOrder`——排序和过滤正交。

### 8.5 决策记录

- **首击=只看而非排除**：排除主题需点两下（只看→排除）。考虑过首击=排除或右键=排除，低保真原型评审后维持三态循环——单一交互模型覆盖筛选与排除两个场景，不为单一场景加第二种手势。
- **theme-manager 不被"排除 theme"隐藏**：它贡献 settings 槽，tag 是 management 而非 theme——语义正确（主题管理是管理页，不是主题）。
- **第三方插件无 tag**：`resolvePluginTags` 返回 `[]`，无筛选时正常显示；inc 激活时不入选（无 tag 即不匹配任何类别），符合直觉。

