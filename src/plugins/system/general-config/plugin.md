# general-config：通用配置

桌面端自己的通用配置——不写 pi 底座的 `~/.pi/agent/settings.json`（那是 pi-manager 管的），不写主题/字体偏好（那是 theme-manager 经 `useUiStore` 管的）。这个插件管的是"桌面壳自己需要、但没有归属到任何功能插件"的零散配置项。

## 1 这个插件解决什么问题

有些配置不属于任何功能插件——比如"默认 thinking level"是桌面壳启动新会话时的默认值，"侧栏默认展开"是壳的布局偏好。这些字段没有"归属插件"，硬塞进 pi-manager（它管 pi 底座配置）或 theme-manager（它管视觉偏好）都不对——领域不匹配。

general-config 把这些零散字段收到一个设置页里，configFile 走 `~/.pi-desktop/config/general.json`，框架管读/写/dirty/save/reset/拦截。

## 2 分组约定：功能模块一个大框，组内字段各自带框

### 2.1 为什么分组

字段一多，6 张卡片平铺就分不清谁和谁一组——"默认思考等级"和"应用时机"明明是同一个功能模块（会话思考强度），平铺时却和"侧栏展开"看不出关系。所以升级为**两级布局**：外层按功能模块分组（一个大框 + 组名），组内字段仍是各自独立的 `SettingsSection` 小框（两列网格排布）。

判断标准（和 pi-manager 的 `FIELD_GROUPS` 同一套语义）：**能给这一组起出一个名字，就是一组；起不出名字的字段单独成组，视觉节奏保持一致**。

### 2.2 怎么做

页面容器逐组排列 `SectionGroup`（本地组件：外圈边框 + 组名标题 + 内部两列网格）；组内放各自的 `SettingsSection`：

```tsx
<SectionGroup title={t("settings.groupSession")}>
  <SettingsSection title={t("settings.defaultThinkingLevel")} description={...}>
    <Select ...>
      {LEVELS.map((l) => <option key={l} value={l}>{t(LEVEL_I18N[l])}</option>)}
    </Select>
  </SettingsSection>
  <SettingsSection title={t("settings.composerApplyTiming")} description={...}>
    <Select ...>
      {APPLY_TIMINGS.map((v) => <option key={v} value={v}>{t(APPLY_TIMING_I18N[v])}</option>)}
    </Select>
  </SettingsSection>
</SectionGroup>
```

`SectionGroup` 只管外圈框 + 组名 + 两列网格容器；`SettingsSection` 自带字段框样式（`border` + `borderRadius` + `padding`），**字段级别的边框、Hover 反馈一律沿用框架组件，不覆盖**。当前分组：

| 分组（i18n key） | 字段 |
|---|---|
| `settings.groupSession` · 会话行为 | `defaultThinkingLevel`、`composerApplyTiming` |
| `settings.groupInterface` · 界面 | `sidebarDefaultOpen` |
| `settings.groupTimeline` · 时间线 | `showHiddenMessages`、`timelineCollapseDefault` |
| `settings.groupDebug` · 调试 | `debugMode` |

### 2.3 不要做什么

- **不要把多个字段塞进一个 `SettingsSection`**。组内是各自独立的 SettingsSection，字段框不许合并——视觉上分清"两件各自独立的事"。`SectionGroup` 的"一个大框"是分组容器，不是合并田野的借口。
- **不要给 `SectionGroup`/`SettingsSection` 加 `style` 覆盖边框**。边框样式是框架级视觉契约，插件不该各自定义。
- **不要手写分割线**（`borderTop` 等）。`gap` 负责间距。

## 3 和框架的分工

框架管：组件注册（`registerSettingsComponent`）、configFile 生命周期（读/写/dirty/save/reset/拦截/刷新/打开配置）、`SettingsSection` 样式。插件管：分组归组 + 字段渲染 + `onChange` 报告改动。

## 3 和框架的分工

框架管：组件注册（`registerSettingsComponent`）、configFile 生命周期（读/写/dirty/save/reset/拦截/刷新/打开配置）、`SettingsSection` 样式。插件管：字段渲染 + `onChange` 报告改动。

## 4 新增字段

往 `general.json` 加一个字段时：

1. **先定归属分组**：看看现有 4 组里哪一组语义贴合（会话行为 / 界面 / 时间线 / 调试），把字段塞进那组的 `SectionGroup` 内；现有组都不贴，再开新组——新组需要给 4 份 `locales/*/settings.json` 各加一个 `settings.groupXxx` key，并在 §2.2 的分组表里登记。
2. 在组内加一个 `SettingsSection` 块——`title` 是字段名，`description` 是说明，`children` 是编辑控件。
3. 控件的 `onChange` 里调 `update("新字段名", value)`——框架自动设 dirty + 弹保存浮层。
4. 不需要改 `plugin.json`——`configMerge: "deep"` 保证新字段自动合并进 `general.json`。

## 5 配置键契约

`general.json` 是桌面壳通用偏好的单源契约。general-config 拥有本节列出的插件级键；`general.json` 里还住着框架层挂载的键（`layout`），契约归框架层所有、不由本插件定义，列在表后说明里。

插件级键（本插件拥有、其余消费方只读）:

| 键 | 分组 | 类型 | 默认 | 消费方 | 含义 |
|---|---|---|---|---|---|
| `defaultThinkingLevel` | 会话行为 | string | `"high"` | timeline | 桌面壳新会话时默认 thinking level |
| `composerApplyTiming` | 会话行为 | string | `"onSend"` | timeline | 修改模型/思考强度后何时生效:`"onSend"`=发送时 flush,`"immediate"`=立即 RPC 到底座 |
| `sidebarDefaultOpen` | 界面 | bool | `false` | ui-store + layout-store | 应用启动时是否默认展开左侧栏 |
| `showHiddenMessages` | 时间线 | bool | `false` | timeline | 是否显示底座注入的内部上下文(如 CLAUDE.md) |
| `timelineCollapseDefault` | 时间线 | bool | `true` | timeline | 时间线中工具卡片(Bash/Edit/Read/Grep/默认)和思考链默认折叠,点击可展开 |
| `debugMode` | 调试 | bool | dev 环境默认 `true`,打包态默认 `false` | debug-bar | 开启后在会话流右上角显示调试工具(复制渲染状态、元素审查) |

框架层挂载键(不由本插件定义,但物理上住在 `general.json` 分层文件内):

| 键 | 类型 | 拥有方 | 含义 |
|---|---|---|---|
| `layout` | object | layout-store | 窗口布局树骨架,layout-store 持久化与 rehydrate |

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
