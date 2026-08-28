# general-config：通用设置页宿主 + settingsGroups 通用渲染器

general-config 是系统域里唯一一个"双重职责"的壳插件：它既是"桌面壳自有、但没归属到任何功能插件"的零散配置的收容所（一个设置页），又是 `settingsGroups` 槽的通用渲染器宿主（一个机制）。后一半才是它的核心价值——它让"往通用设置页加一框字段"从"改 general-config 的 renderer"降级成"贡献方在自己的 `plugin.json` 里加一段 JSON + 在自己的 locales 里加文案"，general-config 一行不改。这份设计有它自己的自述文档 `src/plugins/system/general-config/plugin.md`，本文件是那份自述的独立技术文档，落到具体文件/函数/类型名。

## 职责边界

这个插件管两摊事，边界要分清楚，因为第二摊很容易被误读成"所有插件的 UI 房东"。

- **收容无主配置**。有些配置不属于任何功能插件：`sidebarDefaultOpen`（启动是否展开左侧栏）是壳的布局偏好，没有"归属插件"；`floatCard`（拖拽时把列表项提起为悬浮卡）是跨所有排序拖拽界面的视觉偏好，也不归某个功能插件。把它们塞进 pi-manager（管内核配置）或 theme-manager（管视觉主题）都不对——领域不匹配。general-config 给这些零散字段一个家，configFile 走 `~/.my-harness-desktop/config/general.json`，框架管读/写/dirty/save/reset/拦截。

- **持有 settingsGroups 槽的通用渲染器**。这是机制，不是内容。曾经"往通用页加设置项 = 改本插件 renderer"，谁的字段都往这塞，general-config 成了所有插件的 UI 房东。现在翻转：本页只持有一个通用渲染器，字段组由各插件（含本插件自己）经 `settingsGroups` 槽纯 JSON 声明，渲染器查槽后按声明渲成 UI。贡献方零渲染代码。这是 VSCode `configuration` 贡献点的同构模型：设置项的"形状"是数据，渲染是宿主的通用机制。

- **一个显式标注的 bespoke 例外**。`debugMode` 的默认值随 `import.meta.env.DEV` 动态（dev 默认开、打包默认关），静态 JSON 声明表达不了"默认值取决于构建环境"这个动态，所以保留一块手写的「调试」组。文件头注释（`renderer/index.tsx` 第 8–9 行）和 plugin.md 都把这块标为"显式标注的已知缺口（演进），不是范式"。诚实标注一个机制覆盖不了的角落，比硬把它塞进声明式框架更符合"根因修复不打补丁"。

## 目录结构

```
src/plugins/system/general-config/
  plugin.json           manifest：settings 槽 + settingsGroups 槽（自狗食）+ languages 槽
  plugin.md             本插件的自述设计文档（settingsGroups 槽契约的正文）
  renderer/
    index.tsx           GeneralConfigPage + FieldControl + SectionGroup
  locales/
    zh-CN/settings.json   设置页 i18n key（settings.*）
    zh-CN/plugin.json     插件显示名 i18n key（plugin.general-config.*）
    zh-TW/ en/ de/       同构
```

没有 `core/`、没有 `client/`、没有 pi/dsh 扩展。它持有的通用渲染器逻辑直接写在 renderer 里，量小到不需要拆纯函数层。四个 locale 各有两份 JSON（`settings.json` 管设置页文案，`plugin.json` 管插件自身的 displayName/description 文案），对应 manifest 里两条 languages 贡献（`general-config.settings` 和 `general-config.plugin` 两个命名空间）。

## plugin.json 逐字段

```json
{
  "id": "general-config",
  "version": "0.4.9",
  "tier": "official",
  "displayName": "通用配置",
  "description": "桌面端通用配置",
  "contributes": {
    "settings": [
      { "id": "general", "title": "通用", "icon": "settings",
        "component": "GeneralConfigPage",
        "configFile": "~/.my-harness-desktop/config/general.json",
        "configMerge": "deep", "order": 1 }
    ],
    "settingsGroups": [
      { "id": "interface", "titleKey": "settings.groupInterface", "order": 20,
        "fields": [
          { "key": "sidebarDefaultOpen", "type": "boolean", "default": true,
            "titleKey": "settings.sidebarDefaultOpen", "descKey": "settings.sidebarDefaultOpenDesc" },
          { "key": "floatCard", "type": "boolean", "default": true,
            "titleKey": "settings.floatCard", "descKey": "settings.floatCardDesc" }
        ] }
    ],
    "languages": [ ... ]
  }
}
```

- **`settings` 贡献**。`id: "general"` 是设置页左列表项标识，`title: "通用"` 是列表显示名，`component: "GeneralConfigPage"` 是框架按名匹配的组件（`renderer/index.tsx` 第 77 行 `export function GeneralConfigPage`）。`configFile: "~/.my-harness-desktop/config/general.json"` 是配置落盘路径，`~` 开头表示展开到 home 目录；`configMerge: "deep"` 是深合并——加字段时旧配置不被整份覆盖，这是关键：如果走默认的 `"replace"`，将来新增一个键就会把用户手改的旧键清掉。`order: 1` 排在 pi-manager（`order: 0`）之后，是设置页列表里的第二个。

- **`settingsGroups` 自狗食**。本插件自己的「界面」组（`sidebarDefaultOpen`、`floatCard`）也走 `settingsGroups` 声明，而不是 bespoke 硬编码。这是"无特权差异"的自我证明：第三方能做的事，内置不靠特权。渲染器对自己声明的组和对第三方声明的组一视同仁——都是查槽后按声明渲。

- **`languages` 双命名空间**。`general-config.settings`（文案在 `settings.json`，key 前缀 `settings.*`）和 `general-config.plugin`（文案在 `plugin.json`，key 前缀 `plugin.general-config.*`）分开，是因为插件显示名（在插件管理器里显示"通用配置"）和设置页文案（`settings.groupInterface` 等）是两个不同的消费场景，各归各的命名空间不互相污染。

## settingsGroups 槽契约

这是本插件作为机制提供者的核心契约，形状定义在圆心 `packages/shared/src/domain/contributions.ts` 的 `SettingsGroupContribution`（第 45–54 行）和 `SettingsFieldDecl`（第 57–70 行）。这两份类型是圆心纯类型，零依赖，贡献方和渲染器都 import 它。

- **`SettingsGroupContribution`**。字段 `id`（组 id，页内唯一，同 id 后注册高优先级整框覆盖）、`titleKey`（组名 i18n key，文案由贡献方自己的 languages 资源提供）、`order`（排序，小的在上，缺省 100）、`fields`（字段列表，声明顺序即渲染顺序）。

- **`SettingsFieldDecl`**。一个键 + 一个控件。`key`（general.json 里的键，建议 pluginId 前缀防撞，如 `notifier.enabled`）、`type`（`boolean`→开关 / `enum`→字符串下拉 / `int`→数字档位下拉）、`default`（未写入时的显示默认值，消费方仍各自兜底）、`titleKey`/`descKey`（字段名/说明 i18n key）、`options`（enum 传 `{value,labelKey?}` 对象数组，int 传数字数组）。

- **三种控件是完备的但不是无限的**。boolean/enum/int 三种覆盖了绝大多数设置字段，但复杂编辑 UI（自定义卡片、slider、列表编辑器）表达不了——那种情况贡献方该经 `settings` 槽贡献自己的设置页（如 pi-manager、theme-manager），而不是硬塞进声明式框架。plugin.md §2.3 明确写了这个边界："字段有复杂编辑 UI → 该插件经 settings 槽贡献自己的设置页"。声明式框架做减法，不做万能。

## 渲染器：查槽 + 通用渲染

`renderer/index.tsx` 的 `GeneralConfigPage`（`SettingsComponentProps` 的 `{ config, onChange }` 签名）是设置页组件，`FieldControl` 是单字段渲染器，`SectionGroup` 是组框壳。值流是单向的：`config` 是 general.json 的当前值（可能 undefined、可能是手改脏值），`onChange` 把新对象报告给框架。

- **查槽**。`const groups = useSettingsGroups()`（第 92 行）拿全部已注册的 settingsGroups 贡献项。`useSettingsGroups` 定义在 `packages/react/src/settings-groups.ts`，它经 `window.kernel.slots.settingsGroups()` 异步拉一次，缓存到 `{ nonce, data }`，依赖 `useUiStore((s) => s.pluginsNonce)`——插件装/卸时框架 bump `pluginsNonce`，hook 重新拉。返回的每条是 `SettingsGroupContribution & { pluginId }`，即框架把"这个组是哪个插件贡献的"拼进声明里，供渲染时 `key={g.pluginId}:${g.id}` 去重。

- **`FieldControl` 的三分支**（第 34–74 行）。`field.type === "boolean"` 渲染 checkbox，`checked = (value ?? field.default ?? false) === true`——value 可能 undefined，逐层兜底。`field.type === "int"` 渲染 `Select`，`presets = field.options.filter(isNumber)`，`current = Number(value ?? field.default ?? presets[0] ?? 0)`，且**手改 JSON 写出非档值时并入选项**——`opts = presets.includes(current) ? presets : [...presets, current].sort()`，否则 select 显示空白。`field.type === "enum"`（else 分支）渲染 `Select`，同样处理"手改写出的法外值"：`declared.some(o => o.value === current) ? declared : [...declared, { value: current }]`。

- **`update` 的浅拷贝语义**（第 97–99 行）。`onChange({ ...config, [key]: value })` 每次只改一个键，其余键原样保留。这是 settings 槽框架托管 save 的约定：`onChange` 报告的是"新的完整配置对象"，框架设 dirty、弹保存浮层、写回 general.json。`configMerge: "deep"` 在框架侧做深合并写回。

- **bespoke 头尾两块**。`appInfo` 头（第 103–135 行）从 `ctx.appInfo.get()` 拿 `{ name, version, electron, node, chrome, platform, isPackaged }`，渲染一条徽标行 + 一个两段确认的重启按钮（`restartArmed` state，第一次点 arm、3 秒内再点才 `ctx.appInfo.restart()`，超时自动 disarm）。`appInfo` 走 `system:app:restart` 通道的语义是"整 App 重启，退出链路同手动退出"，不是配置字段，所以不进 settingsGroups。`debugMode` bespoke 块（第 145–152 行）见上文。

## 值流与消费方

general.json 是桌面壳通用偏好的单源契约，但**键的拥有权归声明它的插件**——谁的 settingsGroups 声明里有这个 key，谁拥有它；general-config 只是统一落盘处。这一句是 plugin.md §5 的核心，也是理解"为什么 notifier 的 `notifier.enabled` 住在 general.json 而不是 notifier.json"的钥匙。

- **写路径**。贡献方在 manifest 声明 → registry 查槽聚合 → general-config 的 FieldControl 渲成控件 → 用户改 → `onChange` → 框架 dirty/save → 深合并写回 general.json → 框架广播 `system:configFileSaved`（或 `system:settingsChanged`）。

- **读路径**。消费方经 `useUiStore((s) => s.generalConfig)` 只读分层合并视图，带默认值兜底。notifier 在 `renderer/index.tsx` 第 34 行 `const cfg = useUiStore.getState().generalConfig` 读 `cfg["notifier.enabled"]`；debug-bar 经 `ctx.configFile.get(GENERAL_CONFIG_PATH)` 读 `debugMode`；layout-store 读 `layout` 键。消费方不感知 general-config，只感知 general.json 里的键。

- **键的归属现状**。plugin.md §5 给了一张键清单：「界面」组（`sidebarDefaultOpen`、`floatCard`）和调试 bespoke（`debugMode`）归 general-config；「会话流」六键（`defaultThinkingLevel`/`composerApplyTiming`/`composerMaxLines`/`userBubbleMaxLines`/`showHiddenMessages`/`timelineCollapseDefault`）已迁到 timeline 的 settingsGroups 声明；`reviewBasketVisibleCount` 归 review；`layout` 是框架层挂载键（layout-store 持久化），不由任何插件定义但物理住在 general.json。这张清单的价值在于：它把"谁拥有哪个键"写死成文档，避免将来两个插件声明同一个 key 打架。

## settings 槽的框架托管 save 管线

general-config 的 `configFile: "~/.my-harness-desktop/config/general.json"` + `configMerge: "deep"` 触发了 settings 槽的框架托管 save 管线，这一整条管线 general-config 零感知——它只 `onChange` 报告改动，剩下的 dirty/浮层/拦截/深合并/广播全由框架承担（§9.1）。

- **`onChange` 报告改动 → 框架设 dirty**。`GeneralConfigPage` 的 `FieldControl` 里每次改动调 `update(key, value)` → `onChange({ ...config, [key]: value })`。`onChange` 是 `SettingsComponentProps` 的第二个 prop，框架注入。框架收到新对象后把当前设置项标 dirty，弹保存浮层（用户可保存/放弃/继续改）。

- **保存时的 `configMerge: "deep"`**。保存时框架把内存里的配置对象深合并写回 general.json，而不是整份覆盖。这是 `SettingsContribution.configMerge`（`contributions.ts` 第 21–22 行）的语义：`"deep"`=深合并，`"replace"`=整份覆盖。general-config 选 deep 的原因是——general.json 里除了它自己声明的键，还有 timeline/review/notifier 等其他 settingsGroups 贡献方的键，还有框架层挂载的 `layout` 键。如果 replace，保存一次「界面」组的改动就会把其他插件的键清掉。deep 保证"只改我这一层，别的不动"。

- **保存后广播 `system:configFileSaved`**。落盘成功后框架广播系统事件，订阅方（key-hints 的 backquote 重读、keybindings 的 bindings 重读）据此重读，保存即生效。这是"框架系统事件"的消费方之一，插件订阅不需要 dependsOn。

- **`saveMode` 缺省 framework**。`SettingsContribution.saveMode`（第 23–24 行）缺省 `"framework"`（有保存浮层/拦截），`"manual"` 是实时生效（无浮层，仅打开按钮）。general-config 不声明 saveMode，走 framework 缺省——用户改完要显式保存才落盘，误改可放弃。

- **settings 槽的运行时形态 `SettingsItem`**（`contributions.ts` 第 569–590 行）。`settings:list` IPC 返回的每行，聚合 `SettingsContribution` + `pluginId`，字段经 registry 兜底默认值（`icon` 缺省 `"settings"`、`configMerge` 缺省 `"replace"`、`saveMode` 缺省 `"framework"`）。设置页左列表和框架 save 管线都消费这个形态，general-config 不感知。

## 贡献的槽

- **`settings`**（`SettingsContribution`，`contributions.ts` 第 9–39 行）：贡献「通用」设置页，`configFile`/`configMerge`/`order` 齐全，`saveMode` 缺省 framework（有保存浮层/拦截）。

- **`settingsGroups`**（`SettingsGroupContribution`，第 45–54 行）：既是宿主的消费对象（`useSettingsGroups` 查槽），也是贡献方（自狗食「界面」组）。

- **`languages`**（`LanguageContribution`，第 130–137 行）：双命名空间文案。

它不贡献 `titlebar`、不贡献 `sidePanel`、不声明 channel。它是系统域的"地面"插件——别的插件往它身上挂字段，它自己几乎不往外发信号。

## 与其他插件交互

general-config 是所有 settingsGroups 贡献方的宿主，也是 `debugMode` 的拥有方，它的交互关系是系统域里最密集的。

- **作为宿主的聚合关系**。notifier（`notifier.enabled`/`notifier.cooldownSec`）、timeline（会话流六键）、review（`reviewBasketVisibleCount`）都往 general-config 的通用渲染器上挂字段。方向是单向的：贡献方声明 → general-config 渲染。general-config 不认识这些贡献方（`useSettingsGroups` 只返回 `SettingsGroupContribution` 形状），贡献方也不认识 general-config（它们只声明 JSON + 读 general.json 里的键）。双向解耦——这正是 VSCode configuration 贡献点要的东西：宿主机制和内容完全分离。

- **debug-bar 的开关来源**。`debugMode` 归 general-config 拥有（bespoke 块写它），debug-bar 消费（读 general.json + 订阅 `system:settingsChanged` 重读）。general-config 保存 `debugMode` 改动时框架广播 settings 变更，debug-bar 即时显隐。这里没有自定义 channel，靠框架系统事件 + 共享配置文件。

- **i18n 依赖**。`useTranslation()` 的 `t("settings.groupInterface")` 等能解析，靠 i18n 插件启动时合并各插件的 languages 资源。general-config 的组名/字段名/说明全走 i18n key，不写死中文文案。

- **`appInfo`/`restart` 的能力依赖**。`ctx.appInfo.get()` 和 `ctx.appInfo.restart()` 是 PluginContext 的核心默认能力（`context.ts` 第 344 行），实现经 `window.kernel.app.info()/restart()` 桥到 Host 接口的 `HostApp`（`host.ts` 第 69–72 行）。这是"应用信息 + 重启"作为壳机制能力的消费，不是插件间通信。

## 相关契约与类型落点

- `SettingsContribution`：`packages/shared/src/domain/contributions.ts:9`
- `SettingsGroupContribution`：`packages/shared/src/domain/contributions.ts:45`
- `SettingsFieldDecl`：`packages/shared/src/domain/contributions.ts:57`
- `SettingsItem`（settings 槽运行时形态）：`packages/shared/src/domain/contributions.ts:569`
- `useSettingsGroups`：`packages/react/src/settings-groups.ts:9`
- `AppInfo`：`packages/shared/src/domain/context.ts:238`
- `HostApp`：`packages/shared/src/domain/host.ts:69`
- `GENERAL_CONFIG_PATH`：`packages/shared/src/contract/paths.ts:5`

## QA

**Q：往通用设置页加一框字段，到底要改哪些文件？**

A：三个地方，全在贡献方自己的插件里，不动 general-config：① 贡献方 `plugin.json` 的 `contributes.settingsGroups` 加一段声明（组 id + titleKey + order + fields）；② 贡献方 `locales/*/xxx.json` 加组名/字段名/说明/选项的 i18n key，并在 `contributes.languages` 登记该资源（若还没登记）；③ 消费方（通常也是贡献方自己）经 `useUiStore.generalConfig` 读键，带默认值兜底。如果贡献方还没有 languages 登记，第②步要补一条 languages 贡献。general-config、内核、壳机制一行不改。

**Q：两个插件声明了同一个 `key`（比如都叫 `notifier.enabled`），会怎样？**

A：字段按 `key` 渲染时取 `config?.[f.key]`，两个组会渲染出两个指向同一键的控件，`onChange({ ...config, [key]: value })` 会让后改的覆盖先改的，两个控件同值闪烁。这是配置键所有权冲突，plugin.md §5 用"键的拥有权归声明它的插件"的清单来防——同 key 冲突说明清单没维护好，是文档问题不是框架 bug。框架本身不做 key 归属校验（那会是内容判断，不属于壳机制）。

**Q：手改 general.json 写了个 `notifier.cooldownSec: "abc"`（字符串），设置页会崩吗？**

A：不会崩。`FieldControl` 的 int 分支 `Number(value ?? default ?? presets[0] ?? 0)` 把 `"abc"` Number 成 `NaN`，`Number.isFinite(parsed) ? parsed : (presets[0] ?? 0)` 回退到第一档，select 显示第一档而不是空白。消费方（notifier 的 `numberOr`）也有独立的 `Number.isFinite(n) && n > 0 ? n : fallback` 兜底。脏值不崩溃、按默认兜底，这是声明式配置的健壮性约定。

**Q：为什么 `debugMode` 不走 settingsGroups 而走 bespoke 块？**

A：settingsGroups 的 `default` 是静态 JSON 值，而 `debugMode` 的默认值随 `import.meta.env.DEV` 动态（dev 默认开、打包默认关）。静态声明表达不了"默认值取决于构建环境"。所以保留 bespoke 块，文件头注释和 plugin.md 都把它显式标为"已知缺口（演进）"——诚实标注，不是偷偷破坏声明式范式。将来如果声明式加"defaultFromEnv"之类的扩展，这块可以迁回去。

**Q：为什么 general-config 自己也要贡献 settingsGroups（自狗食），而不是直接 bespoke 渲染「界面」组？**

A：为了证明"内置与第三方同契约、无特权差异"。如果「界面」组 bespoke 渲染，就留下一个"内置可以不用槽、第三方必须用槽"的双轨，违背无特权差异。自狗食让渲染器对自己和第三方一视同仁，也顺带测试了通用渲染器路径（内置自己先踩坑）。这是 CLAUDE.md §1.4 的落地表达。

**Q：插件被禁用后，它贡献的 settingsGroups 框会怎样？已写入 general.json 的键会怎样？**

A：框随贡献从注册表移除而消失（`useSettingsGroups` 依赖 `pluginsNonce`，禁用 bump nonce 后重拉，被禁插件的组不再返回）。已写入 general.json 的键残留无害——消费方读不到就用默认值兜底，general-config 不会主动清理孤儿键（清理属于"谁拥有谁负责"，宿主不该越权删别人的键）。这是 plugin.md §2.2 明确写的"贡献方禁用/卸载 → 框即消失；已写入键残留无害"。
