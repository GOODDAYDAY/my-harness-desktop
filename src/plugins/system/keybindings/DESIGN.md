# 快捷键插件设计（keybindings）

> 本文回答"为什么这么做、边界在哪、取舍是什么"；代码回答"字段叫什么、调用链怎么走"。
> 两者不重复——本文讲为什么，代码讲怎么做。

## 1 要解决的问题

my-harness-desktop 的插件动作（滚动时间线、聚焦输入框、切换右面板 tab、收藏一击……）都暴露为
事件总线 channel（`timeline:scrollTo`、`timeline:focusComposer`……）。但触发方式只有鼠标
点击，键盘上只有壳层硬编码的 ⌘B/⌘J/⌘N/⌘, 四个。

本插件提供：**组合键 → 事件总线 channel 的声明式映射**。按下组合键，插件 `invoke`
目标 channel，目标插件的既有处理逻辑原样执行——快捷键只是给已有事件加了一个新的触发源，
不复制任何业务逻辑。

## 2 核心模型

### 2.1 绑定 = 组合键 + 事件

```
Binding = {
  combo:   "mod+k"                      // 组合键规范串（§3.1）
  channel: "timeline:focusComposer"     // 目标事件（必为已注册插件的 channel）
  payload?: unknown                     // invoke 的 payload（JSON）
  when?:   "smart" | "always"           // 输入态守卫（§3.3）
}
```

配置存插件统一配置通道（`~/.my-harness-desktop/config/keybindings.json` 两层合并），
键名 `bindings` 数组。设置页（settings 槽 framework 托管）与分发端（Overlay）
读同一个文件——配置单源。

### 2.2 为什么用 invoke 而不是 emit

`invoke` 是定向分派：调**别的插件**拥有的 channel，调用方不需要权属，无订阅者时入队、
首个订阅者挂载时恰好一次投递——懒加载的 sidePanel tab 也能收到。快捷键是"触发已有动作"，
动作归属执行方插件，keybindings 只是触发器，语义上就是 invoke。`emit` 需要声明 channel
所有权，语义是广播状态，不适合。

### 2.3 事件列表是动态的，不是写死的

设置页不内置任何动作清单。它调用 `eventBus.listChannels()`（本次为事件总线新增的枚举
接口）列出**当前已加载插件注册的全部 channel**，随插件加载/卸载自动增删。channel 的
可读描述（label/description/payload 示例）由各插件以 `channelMeta` 可选导出声明
（见 §4）——没有声明的 channel 也能列出，回退显示 channel 名。

这保证：第三方插件新增 channel 后，设置页里立即出现、可被绑定，keybindings 无需升级。

## 3 组合键规范

### 3.1 规范串

- 修饰键：`meta`（⌘）、`ctrl`、`alt`、`shift`，按固定顺序 `ctrl` → `alt` → `shift` → `meta`
  前缀 + 主键小写，如 `meta+shift+f`、`ctrl+k`。
- `mod` 是跨平台抽象：mac 展开为 `meta`，win/linux 展开为 `ctrl`。绑定写 `mod+k`
  两边都能用；写死 `ctrl+k` 在 mac 上就真的只认 Ctrl 不认 ⌘。
- 主键映射：` ` → `space`，`Escape` → `esc`，`Enter` → `enter`，`ArrowUp` → `up`，
  功能键小写（`f1`），单字符小写。
- 纯修饰键（只按 ctrl/alt/shift/meta）不构成绑定。

### 3.2 匹配

`comboMatches(binding, event)`：把绑定串里的 `mod` 展开成实际修饰键集合后与事件串
精确比较。一个绑定最多命中一次；配置数组里第一个命中的胜出。

### 3.3 输入态守卫

- `when: "smart"`（默认）：焦点在 input/textarea/select/contentEditable 时，
  带 `meta`/`ctrl`/`alt` 的组合键照常触发（打字时 ⌘K 仍可用），纯字母/数字/符号
  不触发（打字不误触）。
- `when: "always"`：无条件触发（含输入态），拦截输入自担。

## 4 channelMeta：channel 的可读描述（机制层新增）

### 4.1 声明（插件侧，可选导出）

```ts
export const channels = ["timeline:scrollTo"] as const;
export const channelMeta = {
  "timeline:scrollTo": {
    label: "滚动时间线",
    description: "payload: { position: \"top\" | \"bottom\" } 或 { messageId }",
    payloadExample: { position: "bottom" },
  },
};
```

不声明则无描述，列表回退显示 channel 名——声明是增强不是门槛。

### 4.2 收集（框架侧）

`plugins-host` 加载模块时与 `mod.channels` 一并读 `mod.channelMeta`，传入
`eventBus.registerChannels(pluginId, channels, meta)`；`eventBus.listChannels()`
返回 `{ channel, pluginId, meta? }[]`，卸载自动消失。类型定义在圆心
`core/domain/channel-meta.ts`（契约单源），经 `@my-harness-desktop/contract` 发布。

## 5 常驻监听：Overlay

keydown 监听必须全局常驻，不能挂在只在设置页打开时才渲染的组件上。框架已有
`PluginOverlays` 全局挂载点：插件 export 名为 `Overlay` 的组件即被常驻渲染
（`PluginIdContext.Provider` 包裹，可用 `usePluginContext()`）。keybindings 的
`Overlay` 返回 `null`（零可见），只挂 keydown 监听 + 分发。

配置变化走事件驱动：设置页保存成功后框架广播 `system:configFileSaved`，Overlay
订阅它重读绑定——保存即生效，不轮询不 sleep。

## 6 默认绑定

开箱即用一组稳定绑定，全部指向 timeline 既有 channel，避开壳层 ⌘B/⌘J/⌘N/⌘, 四键：

| combo | channel | payload | 说明 |
|---|---|---|---|
| `mod+k` | `timeline:focusComposer` | — | 聚焦输入框 |
| `mod+shift+up` | `timeline:scrollTo` | `{position:"top"}` | 滚到顶部 |
| `mod+shift+down` | `timeline:scrollTo` | `{position:"bottom"}` | 滚到底部 |
| `mod+shift+]` | `timeline:cycleModel` | — | 下一个模型(Vim ]/[ 方向语义) |
| `mod+shift+[` | `timeline:cycleModel` | `{direction:-1}` | 上一个模型 |
| `mod+alt+]` | `timeline:cycleThinking` | — | 下一个思考深度 |
| `mod+alt+[` | `timeline:cycleThinking` | `{direction:-1}` | 上一个思考深度 |
| `mod+shift+'` | `keyhints:toggle` | — | 切换按键导览模式(key-hints 插件) |
| `mod+shift+s` | `shell:openSettings` | — | 进入设置视图(框架 shell channel) |
| `mod+shift+c` | `shell:backToChat` | — | 从设置返回对话视图 |

> 方向键的 shift 形态(`}`/`{`)经 `core/combo.ts` 主键别名映射为 `]`/`[`(规范串写
> `mod+shift+]` 即命中实际按键 shift+]);`"` 同理映射为 `'`。

按键导览另有一条内置触发路径:反引号键(输入框外按 ` 进入导览模式、输入框内是普通
字符),由 key-hints 插件自身实现,不走本插件的绑定表——见 key-hints DESIGN.md §3.2。
| `mod+shift+m` | `timeline:cycleModel` | — | 循环切换模型 |
| `mod+shift+t` | `timeline:cycleThinking` | — | 循环切换思考深度 |
| `mod+shift+h` | `keyhints:toggle` | — | 切换按键导览模式（key-hints 插件） |

用户可在设置页增删改。默认绑定是"零配置即可用"的底线，不是功能上限。

`mod+shift+m` / `mod+shift+t` 依赖 timeline 的 `timeline:cycleModel` / `timeline:cycleThinking`
channel（在模型/思考深度清单内循环切换，payload `{direction: 1|-1}` 可反向）；
`mod+shift+h` 依赖 key-hints 插件的 `keyhints:toggle` channel（进入/退出按键导览模式，
见 key-hints/DESIGN.md）。目标插件卸载后绑定静默失效，设置页以列表为准可改绑。

## 7 边界与取舍

- **不迁移壳层快捷键**：⌘B/⌘J/⌘N/⌘, 仍由壳层硬编码。用户若把 `mod+b` 之类绑到
  本插件会与壳层双触发——默认绑定避开，文档说明。壳层动作通道化是独立演进项。
- **失效 channel**：绑定指向的插件被卸载后 `invoke` 抛错，分发端 try/catch 静默
  （不打扰），设置页以列表为准可改绑。
- **不复制业务**：keybindings 不实现任何动作，只做"组合键 → invoke"。动作仍是
  各插件自己的 channel 处理逻辑，单源。
- **内置命令（cycleModel/abort 等）**：这些是 `ctx.*` API 不是 channel，v1 不绑。
  若将来需要，演进方向是给这些命令补 channel 化的执行方，而不是在 keybindings 里
  写死动作分支。

## 8 目录

```
keybindings/
  DESIGN.md            # 本文
  plugin.json          # settings 槽 + languages 槽
  core/
    combo.ts           # 纯函数：KeyboardEvent→规范串、combo 校验/匹配/展开
    bindings.ts        # Binding 类型 + DEFAULT_BINDINGS + 校验（纯函数，可裸单测）
  renderer/
    index.tsx          # export Overlay（监听分发）+ KeybindingsSettings（设置页）
  locales/             # i18n 资源（插件自持有）
```
