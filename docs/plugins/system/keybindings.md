# keybindings：组合键 → 事件总线 channel 的声明式映射

keybindings 提供"组合键 → 事件总线 channel"的声明式映射。按下组合键，插件 `invoke` 目标 channel，目标插件的既有处理逻辑原样执行——快捷键只是给已有事件加了一个新的触发源，不复制任何业务逻辑。它的核心原则（`DESIGN.md` §7）是：**不实现任何动作，只做映射**。默认绑定 11 条（`mod+k` 聚焦输入框、`mod+shift+]`/`[` 切模型、`mod+alt+]`/`[` 切思考深度、`mod+shift+'` 触发 key-hints、`mod+shift+s` 打开设置、`mod+shift+c` 返回对话等），全指向 timeline/shell/key-hints 的既有 channel。设置页提供录制式绑定编辑 + 动态事件列表。

## 职责边界

keybindings 的职责是"触发"，不是"执行"。一条绑定 = 组合键 + 目标 channel（+ 可选 payload + 可选输入态守卫），按下命中就 invoke，动作执行是目标插件自己的处理逻辑（单源）。这个边界是它和 key-hints 分家的根本原因：key-hints 直接操作 DOM（扫描、分配、触发点击），是动作执行者；keybindings 只做映射，是触发器。两者经 `keyhints:toggle` channel 对接，keybindings 保持纯映射，key-hints 负责导览交互，两侧独立演化。

- **纯函数层与渲染层分离**。`core/combo.ts`（组合键规范化）和 `core/bindings.ts`（绑定模型 + 默认绑定）是纯函数层，不 import react、不碰 ctx，可裸单测（`combo.test.ts`/`bindings.test.ts`）。`renderer/index.tsx`（Overlay 分发）和 `renderer/settings.tsx`（设置页）是渲染层。这条边界让"组合键怎么归一、怎么判定命中"成为可单测的纯逻辑，和"怎么监听 keydown、怎么录键"的 DOM 交互解耦。

## 目录结构

```
src/plugins/system/keybindings/
  plugin.json          manifest：settings 槽 + languages 槽
  DESIGN.md            设计文档
  core/
    combo.ts           组合键规范化：normalizeKey/comboFromEvent/parseCombo/comboMatches
    bindings.ts        绑定模型：Binding/DEFAULT_BINDINGS/parseBinding/parseBindings
    combo.test.ts      组合键单测
    bindings.test.ts   绑定单测
  renderer/
    index.tsx          Overlay（零可见常驻）+ keydown 分发
    settings.tsx       KeybindingsSettings（动态事件列表 + 录制式编辑）
  locales/
    zh-CN/settings.json  文案 key（keybindings.*）
    zh-TW/ en/ de/       同构
```

## plugin.json 逐字段

```json
{
  "id": "keybindings",
  "version": "0.1.0",
  "tier": "official",
  "displayName": "快捷键",
  "description": "把组合键绑定到事件总线 channel：按下即 invoke，手不离键盘触发任意插件动作",
  "tags": ["productivity"],
  "renderer": "./renderer/index.tsx",
  "contributes": {
    "settings": [
      { "id": "keybindings", "title": "快捷键", "icon": "keyboard",
        "component": "KeybindingsSettings", "order": 55 }
    ],
    "languages": [ ... ]
  }
}
```

- **`settings` 贡献**。`component: "KeybindingsSettings"` 对应 `settings.tsx` 第 23 行。无 `configFile`，走 settings 槽框架托管统一通道（`~/.my-harness-desktop/config/keybindings.json`）。`order: 55` 在 key-hints（56）之前。

- **无 channel 声明**。keybindings 自己不声明任何 channel——它是纯触发器，只 invoke 别人的 channel，不 on 也不 emit。所以它没有 `export const channels`，也不需要 `dependsOn`（它不消费任何特定 channel，它 invoke 的目标是运行时动态的）。

## 绑定模型（core/bindings.ts）

`Binding`（第 10–15 行）是核心数据结构：`{ combo: string; channel: string; payload?: unknown; when?: InputWhen }`。`InputWhen`（第 7 行）是 `"smart" | "always"`。

- **`DEFAULT_BINDINGS`（第 18–32 行）**。11 条默认绑定，全指向既有 channel，避开壳层已占的 `⌘B/⌘J/⌘N/⌘,`（注释第 17 行）。`mod+k` → `timeline:focusComposer`；`mod+shift+up/down` → `timeline:scrollTo`（payload `{position: "top"/"bottom"}`）；`mod+shift+]`/`[` → `timeline:cycleModel`（`[` 带 `{direction: -1}`，Vim `]`/`[` 方向语义）；`mod+alt+]`/`[` → `timeline:cycleThinking`（shift 组管模型、alt 组管思考深度）；`mod+shift+'` → `keyhints:toggle`；`mod+shift+s` → `shell:openSettings`；`mod+shift+c` → `shell:backToChat`。

- **`parseBinding(raw)`（第 35–47 行）**。形状收紧：`raw` 必须是对象，`combo`/`channel` 必须是非空字符串，`when` 只能是 `"always"`/`"smart"`（否则 undefined），`payload` 有才带上。返回 `Binding | null`。这是配置读入的"防手改脏数据"闸门——用户手改坏 JSON，单条非法返回 null 丢弃。

- **`parseBindings(raw)`（第 53–60 行）**。数组且每项合法 → 收紧数组；否则 null。单条非法整条丢弃，不阻塞其余绑定。这是"单条坏不拖垮全部"的容错策略。

## 组合键规范化（core/combo.ts）

组合键规范串的格式是：修饰键按固定顺序 `ctrl → alt → shift → meta` 前缀 + 主键小写，用 `+` 连接，如 `meta+shift+f`、`ctrl+k`、`alt+up`。

- **`ComboEvent`（第 9–15 行）**。keydown 事件中参与组合键判定的字段子集（`metaKey/ctrlKey/altKey/shiftKey/key`），让纯函数单测不依赖 DOM 事件类型。

- **`KEY_ALIASES`（第 27–55 行）**。主键别名映射：`" "`→`space`、`Escape`→`esc`、`Enter`→`enter`、`ArrowUp`→`up`、`PageDown`→`pagedown` 等。关键的是 shift 形态映射：`"}"`→`"]"`、`"{"`→`"["`、`'"'`→`"'"`——因为 `shift+]` 的 `e.key` 是 `"}"`，用户心智是 `]`，绑定写 `mod+shift+]` 即命中。这是"用户心智 vs 物理键值"的翻译，不映射的话 `mod+shift+]` 永远绑不上（用户按 shift+] 拿到的是 `}`）。

- **`MODIFIER_KEYS`（第 58 行）**。纯修饰键集合（`meta/ctrl/alt/shift/control/option`），单独按下不构成绑定。`normalizeKey`（第 61–67 行）对纯修饰键返回 null。

- **`comboFromEvent(e)`（第 70–80 行）**。事件 → 规范串：`normalizeKey(e.key)` 得主键，`ctrlKey/altKey/shiftKey/metaKey` 按固定顺序 push 修饰键前缀，`join("+")`。纯修饰键按下返回 null。

- **`parseCombo(combo)`（第 83–107 行）**。绑定串 → 解析结果 `ParsedCombo`（`mod/ctrl/alt/shift/meta/key` 六个开关 + 主键）。`split("+")` 后最后一段是主键，其余是修饰键，`mod`/`ctrl`/`alt`/`shift`/`meta` 之外未知修饰键返回 null。注意 `mod` 是独立标志，不是 ctrl/meta 的别名——它在 `comboMatches` 里单独处理。

- **`comboMatches(binding, eventCombo)`（第 114–129 行）**。命中判定，最关键的逻辑是 `mod` 的跨平台展开：`p.mod` 为真时，要求事件**恰好按了 meta 或 ctrl 之一**（`e.meta === e.ctrl` 返回 false，即 ⌘+Ctrl 同时按不命中）；非 `mod` 时精确比较 `meta`/`ctrl`。`alt`/`shift` 精确比较。这样 `mod+k` 在 mac（⌘=meta）和 win/linux（Ctrl=ctrl）两边都能用，写死 `ctrl+k` 就真的只认 Ctrl 不认 ⌘。

## Overlay 分发（renderer/index.tsx）

`Overlay` 是零可见常驻组件，挂 window keydown 监听做分发。

- **读绑定 + 订阅保存**（第 37–55 行）。`ctx.config.get<unknown>("bindings")` 读绑定数组，`parseBindings` 收紧，合法则 `bindingsRef.current = parsed`；读失败保持现状。`system:configFileSaved` 订阅重读，保存即生效。注释点明"任何 configFile 保存都重读，重读一次便宜，不挑路径"——不精确过滤是哪个文件保存了，因为重读成本低、精确过滤反而要维护路径判断。

- **keydown 分发**（第 58–74 行）。`comboFromEvent(e)` 得事件规范串 → `bindingsRef.current.find(b => comboMatches(b.combo, combo))` 找命中绑定 → `shouldFire(binding)` 输入态守卫 → `preventDefault` → `ctx.events.invoke(binding.channel, binding.payload)`，`catch` 里静默（目标 channel 未注册/插件未加载时不打断）。

- **`shouldFire`（第 24–29 行）**。输入态守卫。`when === "always"` 无条件；否则查 `/\b(ctrl|meta|alt|mod)\b/` 是否含强修饰键——含则输入态也触发（带 ctrl/meta/alt 的组合键在输入态不会和打字冲突），不含则 `!isInputTarget(document.activeElement)`（焦点在 input/textarea/select/contentEditable 时纯键不触发，避免打字时误触单键绑定）。`isInputTarget`（第 15–21 行）用 `instanceof` 查三类表单元素 + `isContentEditable`。

## 设置页：动态事件列表 + 录制式编辑（renderer/settings.tsx）

这是 keybindings 最复杂的部分，`KeybindingsSettings` 用一个 `AddingState` 联合类型（第 13–16 行）管三阶段：`idle`（列表态）、`recording`（录键态，可选 `editingIndex` 表示改键）、`configuring`（选目标 + 填 payload 态）。

- **动态事件列表**（第 31–38 行）。`eventBus.listChannels()` 列出当前已加载插件注册的全部 channel（不含 `system:*`），依赖 `useUiStore((s) => s.pluginsNonce)`——插件装/卸时框架 bump nonce 刷新。这是"事件列表不写死"的关键：第三方插件新增 channel 后设置页立即出现、可被绑定，keybindings 无需升级。`listChannels` 定义在 `packages/react/src/event-bus.ts` 第 74–85 行，返回 `ChannelInfo[]`（`channel/pluginId/meta`）。

- **搜索与分组**（第 40–58 行）。`filtered` 按 query 过滤 channel 名 + `meta.label` + `meta.description`；`byPlugin` 按 `pluginId` 分组排序（`Map` 聚合 + `localeCompare` 排序），配置面板里按插件分组显示 channel。

- **录制模式**（第 73–96 行）。`adding.phase === "recording"` 时挂 window capture 级 keydown：`Esc` 取消；`comboFromEvent(e)` 得组合键；`editingIndex !== undefined`（改键）时原位替换 combo 直接 commit 并回 idle；否则进 `configuring` 态带 combo。`bindingsRef`/`commitRef` 用 ref 镜像避免 keydown 监听因依赖重绑（第 64–70 行，录制窗口内这些值不变，ref 语义足够）。

- **configuring 态**（第 222–313 行）。选 combo 显示 + 重录/取消按钮 + 搜索框 + 按插件分组的 channel 列表 + 选中后显示 `when` 下拉 + payload textarea。`selectChannel`（第 129–137 行）选中时用 `meta?.payloadExample` 预填 payload JSON（`JSON.stringify(..., null, 2)`）。`saveNew`（第 104–127 行）校验 combo+channel 非空、payload JSON 可解析（非法留在编辑态让用户改），editing 原位替换、否则 append。

- **`modLabel()`（第 19–21 行）**。平台主修饰键展示名：`navigator.platform` 匹配 Mac 显示 `⌘`，否则 `Ctrl`。录制提示和绑定列表里 `b.combo.replace("mod", modLabel())` 把 `mod` 显示成用户看得懂的 ⌘/Ctrl。

- **`hasRegistered`（第 139 行）**。绑定指向的 channel 是否在 `channels` 列表里——不在则列表行显示 `keybindings.channelMissing`（"目标插件未加载，此绑定当前不生效"）。这是"目标插件未加载时静默"的显式化：不报错，但告诉用户这条绑定现在不生效，改绑或装插件。

## 为什么用 invoke 而不是 emit

这是 keybindings 的一个关键设计决策（`DESIGN.md` §2.2）：用 `invoke` 而不是 `emit`。

- `emit` 是发布/订阅，要求插件只能发自己声明过的 channel，语义是广播状态。keybindings 要触发的是**别的插件**拥有的 channel，调用方不需要权属——语义上就是 `invoke`（定向分派）。

- `invoke` 无订阅者时入队、首个订阅者挂载时恰好一次投递——懒加载的 sidePanel tab 也能收到（`event-bus.ts` 第 134–152 行）。快捷键触发"打开某 tab"时，目标 tab 可能还没挂载订阅，入队等它挂载后投递，不丢。

- `emit` 的 payload 被缓存供 `replayLast` 回放，那是"可回放状态广播"；快捷键是"一次性命令"，不该回放——用户按了两次 `mod+shift+]` 是要切两次模型，不是要新订阅者收到最近一次"切模型"状态。所以用 invoke。

## 一次按键的完整触发链

把"用户按下 `mod+shift+]`"从物理按键到模型切换的完整路径走一遍，能看到 keybindings 作为"触发器"的各层分工。

- **物理键按下**。浏览器派发 keydown，`e.key` 是 `}`（shift+] 的物理值）、`e.metaKey` 或 `e.ctrlKey` 为 true（按平台）、`e.shiftKey` 为 true。keybindings 的 Overlay `onKeyDown`（`index.tsx` 第 59 行）在 window 级 bubble 收到。

- **事件 → 规范串**。`comboFromEvent(e)`（`combo.ts` 第 70 行）：`normalizeKey("}")` 经 `KEY_ALIASES` 映射成 `"]"`（第 52 行），修饰键按 `ctrl → alt → shift → meta` 顺序拼，得 `"meta+shift+]"`（mac）或 `"ctrl+shift+]"`（win/linux）。

- **绑定匹配**。`bindingsRef.current.find(b => comboMatches(b.combo, combo))`（第 62 行）。`comboMatches("mod+shift+]", "meta+shift+]")`：`p.mod` 为真，`e.meta !== e.ctrl`（meta true、ctrl false）通过，`alt`/`shift` 精确比较，`key` 相等，命中。找到 `DEFAULT_BINDINGS` 第 23 行的 `{ combo: "mod+shift+]", channel: "timeline:cycleModel" }`。

- **输入态守卫**。`shouldFire(binding)`（第 24 行）：combo 含 `mod`（`/\b(ctrl|meta|alt|mod)\b/` 命中），强修饰键存在 → 输入态也触发，直接过。

- **invoke**。`e.preventDefault()`（第 65 行）吞掉默认行为，`ctx.events.invoke("timeline:cycleModel", undefined)`（第 67 行）。eventBus 的 `invoke`（`event-bus.ts` 第 134 行）找到 `timeline:cycleModel` 的 handlers 逐个调用。timeline 的订阅处理器执行切模型逻辑——**这里就是 keybindings 的边界**：它只负责把按键翻译成 invoke，切模型是 timeline 的既有处理逻辑，keybindings 一行业务代码都不含。

- **payload 传递**。如果绑的是 `mod+shift+[`（`{ direction: -1 }`），invoke 时把 payload 原样传给 timeline 的 handler，handler 读 `direction` 决定向前还是向后切。payload 的 JSON 形状在设置页录制时由用户填或由 `channelMeta.payloadExample` 预填。

这条链展示了 keybindings 的核心价值：它把"物理按键"和"业务动作"彻底解耦，中间只隔一个 channel 字符串。timeline 改切模型逻辑，keybindings 无感；用户改绑 `mod+shift+]` 到别的 channel，timeline 无感。

## 贡献的槽

- **`settings`**（`SettingsContribution`）：「快捷键」设置页，`KeybindingsSettings`。

- **`languages`**（`LanguageContribution`）：`keybindings.settings` 命名空间。

无 channel 声明、无 `titlebar`、无 `sidePanel`、无内核扩展。

## 与其他插件交互

- **invoke 所有声明 channel 的插件**。keybindings 的"目标"是运行时动态的——`eventBus.listChannels()` 列出谁，谁就能被绑定。默认绑定指向 timeline（`timeline:focusComposer`/`scrollTo`/`cycleModel`/`cycleThinking`）、key-hints（`keyhints:toggle`）、shell（`shell:openSettings`/`backToChat`）。keybindings 不 import 这些插件，只共享 channel 字符串。

- **触发 key-hints**。`mod+shift+'` → `keyhints:toggle`，是 key-hints 两种触发方式之一。key-hints 的 `settings.tsx` 第 7–8 行注释点明两路互不依赖。

- **依赖框架 eventBus 枚举接口**。`eventBus.listChannels()` 是事件总线新增的枚举能力，暴露"当前已注册的全部插件 channel"，供快捷键/命令面板类插件列出可绑定目标。keybindings 是它的第一个消费方。

- **依赖框架 pluginsNonce**。插件装/卸触发 `useUiStore.pluginsNonce` 变化，keybindings 据此刷新事件列表。这是"框架管通用（插件装/卸通知）、特化归外层（keybindings 据此重拉）"的落地。

## 相关契约与类型落点

- `ChannelMeta`/`ChannelInfo`：`packages/shared/src/channel/channel-meta.ts:11/21`
- `eventBus.listChannels()`：`packages/react/src/event-bus.ts:74`
- `PluginEventsApi.invoke`：`packages/shared/src/domain/context.ts:234`
- `SettingsComponentProps`：`packages/react/src`（settings 槽组件 props）
- `SettingsContribution`：`packages/shared/src/domain/contributions.ts:9`

## QA

**Q：我绑了 `mod+k`，在 mac 上按 ⌘K 触发，在 Windows 上按什么？**

A：按 Ctrl+K。`mod` 是跨平台主修饰键抽象：mac 的 `meta`（⌘）和 win/linux 的 `ctrl`（Ctrl）都算 `mod`。`comboMatches` 里 `p.mod` 为真时要求事件恰好按了 meta 或 ctrl 之一（`e.meta === e.ctrl` 返回 false，⌘+Ctrl 同时按不命中）。写死 `ctrl+k` 则真的只认 Ctrl，mac 上 ⌘K 不触发；写死 `meta+k` 只认 ⌘。要两边通用就写 `mod+k`。

**Q：为什么 `mod+shift+]` 能绑上？我按 shift+] 键盘事件里 key 不是 `}` 吗？**

A：是 `}`，所以 `KEY_ALIASES` 里映射了 `"}"`→`"]"`、`"{"`→`"["`、`'"'`→`"'"`（`combo.ts` 第 52–54 行）。`comboFromEvent` 拿到 `}` 先 normalize 成 `]` 再和绑定串比较。用户心智是"shift+]"，物理键值是 `}`，这个映射把物理值翻译回用户心智，否则 `mod+shift+]` 永远绑不上。注释点明这是 Vim `]`/`[` 方向语义的绑定要求。

**Q：设置页的事件列表里为什么没有 `system:*` 开头的事件？**

A：`eventBus.listChannels()` 显式跳过 `system:*`（`event-bus.ts` 第 77 行 `if (this.isSystemChannel(ch)) continue`），注释写"invoke 不支持系统频道，快捷键不可绑"。系统事件（`configFileSaved`/`settingsChanged` 等）是框架内部广播，语义是状态通知不是可触发动作，绑定它没意义——invoke 一个系统频道会直接抛错（`event-bus.ts` 第 135–137 行）。

**Q：目标插件被卸载了，我绑的键按下会怎样？**

A：静默不生效。分发端 `ctx.events.invoke` 时目标 channel 未注册，`catch` 里静默（`index.tsx` 第 67–70 行）。设置页列表里该绑定显示 `channelMissing`（"目标插件未加载，此绑定当前不生效"）。这是"显式降级不伪造成功"——不报错、不假装触发，而是告诉用户这条绑定现在不生效，改绑或重装插件。插件装回来后 binding 恢复生效，配置里的 channel 字符串还在。

**Q：我在输入框打字，按到单键绑定（比如绑了 `a`），会误触发吗？**

A：取决于 `when`。`shouldFire` 里 `when === "always"` 无条件触发；`smart`（默认）时先查 combo 是否含强修饰键（`ctrl/meta/alt/mod`）——含则输入态也触发（组合键和打字不冲突），不含则 `!isInputTarget(activeElement)` 才触发，焦点在输入框时纯键不触发。所以绑 `a` 这类纯键默认在输入态被守卫拦下，打字安全；绑 `mod+a` 则输入态也触发。这是 `InputWhen` 的 `smart` 语义（`bindings.ts` 第 7 行）。

**Q：恢复默认绑定按钮会把我的自定义绑定覆盖吗？**

A：会，且是整份覆盖。`commit([...DEFAULT_BINDINGS])`（`settings.tsx` 第 151 行）把 `bindings` 数组整个替换成 `DEFAULT_BINDINGS`，用户自定义的绑定（含改键、增删）全部丢弃。这是"恢复默认"的语义——不是合并。如果你只想加一条绑定，用"添加绑定"而不是"恢复默认"。
