# general-config：通用配置

桌面端自己的通用配置——不写 pi 底座的 `~/.pi/agent/settings.json`（那是 pi-manager 管的），不写主题/字体偏好（那是 theme-manager 经 `useUiStore` 管的）。这个插件管的是"桌面壳自己需要、但没有归属到任何功能插件"的零散配置项。

## 1 这个插件解决什么问题

有些配置不属于任何功能插件——比如"默认 thinking level"是桌面壳启动新会话时的默认值，"侧栏默认展开"是壳的布局偏好。这些字段没有"归属插件"，硬塞进 pi-manager（它管 pi 底座配置）或 theme-manager（它管视觉偏好）都不对——领域不匹配。

general-config 把这些零散字段收到一个设置页里，configFile 走 `~/.pi-desktop/config/general.json`，框架管读/写/dirty/save/reset/拦截。

## 2 标题块约定：一个字段一个 SettingsSection

### 2.1 为什么要分开

两个字段挤在一个 `SettingsSection` 里，视觉上是一坨——用户分不清"这是两件事"还是一个表单的两行。pi-manager 做得好的一点是：按 `FIELD_GROUPS` 分组，每组一个 `SettingsSection` 带边框的块。general-config 同理——每个字段各占一个块，天然隔开。视觉上用**两列卡片网格**排布，不再是列满面宽的单行堆叠。

### 2.2 怎么做

容器用 **两列卡片网格** `grid` 排列多个 `SettingsSection`。每个 `SettingsSection` 的 `title` 是字段名，`description` 是字段说明，`children` 是编辑控件：

```tsx
<div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)", display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--spacing-lg)", alignContent: "start" }}>
  <SettingsSection title={t("settings.defaultThinkingLevel")} description={t("settings.defaultThinkingLevelDesc")}>
    <select value={...} onChange={...} style={inputStyle}>
      {LEVELS.map((l) => <option key={l} value={l}>{t(LEVEL_I18N[l])}</option>)}
    </select>
  </SettingsSection>
  <SettingsSection title={t("settings.sidebarDefaultOpen")} description={t("settings.sidebarDefaultOpenDesc")}>
    <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
      <input type="checkbox" checked={...} onChange={...} style={checkboxStyle} />
      <span>{sidebarDefaultOpen ? t("common.on") : t("common.off")}</span>
    </label>
  </SettingsSection>
</div>
```

`SettingsSection` 自带 `border` + `borderRadius: var(--radius-md)` + `padding: var(--spacing-md)`，不需要手写边框。`gap` 负责块间距，不需要手写分割线。

### 2.3 不要做什么

- **不要把多个字段塞进一个 `SettingsSection`**。两个字段共用一个块，视觉上就是一坨，失去了"小方块隔开"的意义。
- **不要手写 `borderTop: 2px solid var(--color-border)` 分割线**。用 `gap` 间距替代——分割线是"一坨里的分隔"，`gap` + 独立块是"两件各自独立的事"。
- **不要给 `SettingsSection` 加 `style` 覆盖边框**。边框样式是框架级视觉契约，插件不该各自定义。

## 3 和框架的分工

框架管：组件注册（`registerSettingsComponent`）、configFile 生命周期（读/写/dirty/save/reset/拦截/刷新/打开配置）、`SettingsSection` 样式。插件管：字段渲染 + `onChange` 报告改动。

## 4 新增字段

往 `general.json` 加一个字段时：

1. 在 `GeneralConfigPage` 里加一个 `SettingsSection` 块——`title` 是字段名，`description` 是说明，`children` 是编辑控件。
2. 控件的 `onChange` 里调 `update("新字段名", value)`——框架自动设 dirty + 弹保存浮层。
3. 不需要改 `plugin.json`——`configMerge: "deep"` 保证新字段自动合并进 `general.json`。

## 5 配置键契约

`general.json` 是桌面壳通用偏好的单源契约。general-config 拥有本节列出的插件级键；`general.json` 里还住着框架层挂载的键（`layout`、`currentModelId`），契约归框架层所有、不由本插件定义，列在表后说明里。

插件级键（本插件拥有、其余消费方只读）:

| 键 | 类型 | 默认 | 消费方 | 含义 |
|---|---|---|---|---|
| `defaultThinkingLevel` | string | `"high"` | timeline | 桌面壳新会话时默认 thinking level |
| `sidebarDefaultOpen` | bool | `false` | layout-store | 应用启动时是否默认展开左侧栏 |
| `showHiddenMessages` | bool | `false` | timeline | 是否显示底座注入的内部上下文(如 CLAUDE.md) |
| `timelineCollapseDefault` | bool | `true` | timeline | 时间线中工具卡片(Bash/Edit/Read/Grep/默认)和思考链默认折叠,点击可展开 |
| `composerApplyTiming` | string | `"onSend"` | timeline | 修改模型/思考强度后何时生效:`"onSend"`=发送时 flush,`"immediate"`=立即 RPC 到底座 |
| `debugMode` | bool | dev 环境默认 `true`,打包态默认 `false` | debug-bar | 开启后在会话流右上角显示调试工具(复制渲染状态、元素审查) |

框架层挂载键(不由本插件定义,但物理上住在 `general.json` 分层文件内):

| 键 | 类型 | 拥有方 | 含义 |
|---|---|---|---|
| `layout` | object | layout-store | 窗口布局树骨架,layout-store 持久化与 rehydrate |
| `currentModelId` | string | ui-store | 当前选中模型(`provider/modelId`),ui-store 切模型时落盘 |

## 6 plugin.json

```json
{
  "id": "general-config",
  "version": "0.1.0",
  "displayName": "通用配置",
  "description": "桌面端通用配置",
  "contributes": {
    "settings": [
      {
        "id": "general",
        "title": "通用",
        "component": "GeneralConfigPage",
        "configFile": "~/.pi-desktop/config/general.json",
        "configMerge": "deep",
        "order": 1
      }
    ]
  }
}
```

`configFile` 走 `~/.pi-desktop/config/general.json`，在桌面配置树内（白名单允许）。`configMerge: "deep"` 保证加字段时旧配置不被覆盖。`order: 1` 排在 pi-manager（`order: 0`）之后。
