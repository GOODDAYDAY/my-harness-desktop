# general-config：通用配置

通用设置页的宿主 + 通用渲染器。双重职责：① 给"桌面壳自己需要、但没有归属到任何功能插件"的零散配置一个家；② 持有 `settingsGroups` 槽的通用渲染器——任何插件（含本插件自己）在自己的 `plugin.json` 里纯 JSON 声明一框字段，本页按声明渲成 UI，贡献方零渲染代码。

## 1 这个插件解决什么问题

### 1.1 无主配置的收容所

有些配置不属于任何功能插件——"侧栏默认展开"是壳的布局偏好，没有"归属插件"，硬塞进 pi-manager（它管 pi 底座配置）或 theme-manager（它管视觉偏好）都不对——领域不匹配。general-config 把这些零散字段收到通用设置页，configFile 走 `~/.my-harness-desktop/config/general.json`，框架管读/写/dirty/save/reset/拦截。

### 1.2 通用渲染器：加框不改任何人

曾经，往通用页加一个设置项就要改本插件的 renderer——谁的字段都往这塞，本插件成了所有功能插件的 UI 房东。现在翻转：本页只持有一个**通用渲染器**，字段组由各插件在自己的 `plugin.json` 里经 `settingsGroups` 槽声明（组 id、组名 i18n key、字段清单），本渲染器查槽后按声明渲成 `SectionGroup` + `SettingsSection` + 控件。**加一框 = 贡献方自己的 manifest 加一段 JSON + 自己的 locales 加文案，本插件一行不改。**

这是 VSCode `configuration` 贡献点的同构模型：设置项的"形状"是数据，渲染是宿主的通用机制。timeline 的「会话流」、review 的「评论」、本插件自己的「界面」都走这个槽——内置与第三方同契约，无特权差异。

## 2 settingsGroups 槽契约

### 2.1 声明形状

贡献方在自己 `plugin.json` 的 `contributes.settingsGroups` 里声明：

```jsonc
{
  "id": "sessionFlow",                    // 组 id,页内唯一;同 id 整框覆盖(后注册高优先级胜出)
  "titleKey": "settings.groupSessionFlow",// 组名 i18n key,文案由贡献方自己的 languages 资源提供
  "order": 10,                            // 排序,小的在上;缺省 100
  "fields": [
    {
      "key": "composerMaxLines",          // general.json 里的键(建议 pluginId 前缀防撞)
      "type": "int",                      // boolean→开关 / enum→字符串下拉 / int→数字档位下拉
      "default": 10,                      // 未写入时的显示默认值(消费方仍各自兜底)
      "titleKey": "settings.composerMaxLines",
      "descKey": "settings.composerMaxLinesDesc",
      "options": [5, 10, 15, 20, 30]      // int:数字数组;enum:{value,labelKey?} 对象数组
    }
  ]
}
```

### 2.2 渲染与值流

- 渲染器把每个组渲成一个 `SectionGroup`（外圈框 + 组名 + 两列网格），每个字段渲成一个 `SettingsSection` + 按 `type` 出的控件；手改 JSON 写出非档值时当前值并入选项，select 不空白。
- 值统一落本页 configFile（general.json）：控件的 `onChange` 走框架既有管线——dirty/保存浮层/拦截/分层合并/`configFileSaved` 广播，贡献方零感知。消费方照旧 `useUiStore((s) => s.generalConfig)` 只读，手改脏值（非数/负数）由消费方各自回退默认。
- 贡献方插件被禁用/卸载 → 其声明从注册表移除，框即消失；已写入 general.json 的键残留无害（消费方默认值兜底）。
- i18n：组名/字段名/说明/enum 选项文案全是 i18n key，文案由**贡献方自己的** `languages` 资源提供（全局合并，t() 直接可解）。

### 2.3 什么时候不该走这个槽

- 字段有复杂编辑 UI（自定义卡片、slider、列表编辑器）→ 声明式三种控件表达不了，那个插件该经 `settings` 槽贡献自己的设置页（如 pi-manager、theme-manager）。
- 值不该和别人共享一个 configFile → 同上，自己的设置页 + 自己的 configFile。

## 3 本插件自己的内容

通用渲染器之外，本页还持有一头一尾两块自有内容：

- **appInfo 头**：应用名/版本/Electron/Node/Chrome/平台徽标行——不是字段，不走声明。
- **「调试」组（bespoke 例外）**：`debugMode` 的默认值随 `import.meta.env.DEV` 动态（dev 默认开、打包默认关），静态 JSON 声明表达不了，保留硬编码块。这是显式标注的已知缺口（演进），不是范式。

本插件自己的「界面」组（`sidebarDefaultOpen`、`floatCard`）也走 `settingsGroups` 声明（见 §5 plugin.json）——自狗食，证明第三方能做到的内置不靠特权。

## 4 往通用页加一框（贡献方视角）

1. 在自己 `plugin.json` 的 `contributes.settingsGroups` 加一段声明（§2.1）。
2. 在自己的 `locales/*/xxx.json` 加组名/字段名/说明/选项的 i18n key，并在 `contributes.languages` 登记资源（若还没登记）。
3. 消费方（通常也是你自己）经 `useUiStore.generalConfig` 读键，带默认值兜底。

不需要改 general-config、不需要改内核、不需要写渲染代码。

## 5 配置键契约

`general.json` 是桌面壳通用偏好的单源契约，但**键的拥有权归声明它的插件**（谁的 settingsGroups 声明里有这个 key，谁拥有它；本页只是统一落盘处）。

本插件拥有的键（「界面」组声明 + 调试 bespoke）：

| 键 | 分组 | 类型 | 默认 | 消费方 | 含义 |
|---|---|---|---|---|---|
| `sidebarDefaultOpen` | 界面 | bool | `true` | ui-store + layout-store | 应用启动时是否默认展开左侧栏 |
| `floatCard` | 界面 | bool | `true` | framer-motion Reorder 类排序拖拽 | 拖拽列表项时将其提起为悬浮卡(带底色与投影);关闭后原位半透明随列表让位,影响全部排序拖拽界面(会话/项目/插件列表等) |
| `debugMode` | 调试 | bool | dev 环境默认 `true`,打包态默认 `false` | debug-bar | 开启后在会话流右上角显示调试工具(复制渲染状态、元素审查) |

已迁出的键（拥有方随行）：「会话流」六键（`defaultThinkingLevel`/`composerApplyTiming`/`composerMaxLines`/`userBubbleMaxLines`/`showHiddenMessages`/`timelineCollapseDefault`）归 **timeline** 的 settingsGroups 声明；`reviewBasketVisibleCount` 归 **review** 的声明。

框架层挂载键（不由本插件定义，但物理上住在 `general.json` 分层文件内）：

| 键 | 类型 | 拥有方 | 含义 |
|---|---|---|---|
| `layout` | object | layout-store | 窗口布局树骨架,layout-store 持久化与 rehydrate |

## 6 plugin.json

```json
{
  "id": "general-config",
  "contributes": {
    "settings": [
      { "id": "general", "title": "通用", "component": "GeneralConfigPage",
        "configFile": "~/.my-harness-desktop/config/general.json", "configMerge": "deep", "order": 1 }
    ],
    "settingsGroups": [
      { "id": "interface", "titleKey": "settings.groupInterface", "order": 20,
        "fields": [
          { "key": "sidebarDefaultOpen", "type": "boolean", "default": true, "titleKey": "...", "descKey": "..." },
          { "key": "floatCard", "type": "boolean", "default": true, "titleKey": "...", "descKey": "..." }
        ] }
    ]
  }
}
```

`configFile` 走 `~/.my-harness-desktop/config/general.json`，在桌面配置树内（白名单允许）。`configMerge: "deep"` 保证加字段时旧配置不被覆盖。`order: 1` 排在 pi-manager（`order: 0`）之后。`settingsGroups` 是本插件自狗食的「界面」组声明——通用渲染器对它和第三方声明一视同仁。
