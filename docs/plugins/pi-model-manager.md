# pi-model-manager

## 1 这个插件解决什么问题

pi 底座需要配置模型供应商和模型——哪个供应商用什么 API Key、什么 Base URL、哪些模型可用。没有这个插件，用户得手动编辑 `~/.pi/agent/models.json`。pi-model-manager 把供应商和模型的增删改查放到设置页，用表单编辑而不是手写 JSON。

## 2 设计决策

### 2.1 为什么是插件而不是内核

模型管理的 UI 会变——表单布局会调、右键菜单会加项。但"能读写 JSON 配置"这个能力不会变。UI 是内容，推给插件；配置读写原语留内核。

### 2.2 选了什么机制

贡献 `settings` 槽位，`order: 20`。声明 `configFile: "~/.pi/agent/models.json"` + `configMerge: "replace"`——模型配置结构简单，整份覆盖，不做深合并。零权限。类型从 `@my-harness-desktop/core` 导入 `ModelsConfig`、`ProviderConfig`、`ModelConfig`——圆心定义类型，发布面 re-export，插件消费。

### 2.3 和框架的分工

框架管：组件注册、configFile 生命周期、`SettingsSection` / `ListItem` 样式。插件管：供应商 CRUD、模型 CRUD、右键菜单（Radix ContextMenu）、增删改进出动画（framer-motion）。

### 2.4 是否修改了内核

没有。pi-model-manager 插件只从 `@my-harness-desktop/react` 和 `@my-harness-desktop/core` 导入。从 `@my-harness-desktop/react` 导入：`registerSettingsComponent`、`ListItem`、`SettingsSection`、`SettingsComponentProps`。从 `@my-harness-desktop/core` 导入：`ModelsConfig`、`ProviderConfig`、`ModelConfig`（纯类型 re-export）。外加第三方包 `framer-motion`、`@radix-ui/react-context-menu`、`react-i18next`（`useTranslation`）。不 import `src/domain/`、`src/gateway/`、`src/application/`、`src/shell/` 的任何文件。插件的全部代码在 `renderer/index.tsx`（282 行），全部是 React UI 逻辑——CRUD 操作、右键菜单、进出动画，零内核代码侵入。

注意：`@my-harness-desktop/core` 是纯 re-export `src/domain/` 的类型——插件 import 的是发布面，不是直接 import 圆心。这符合依赖方向：插件（外层）→ `packages/core`（发布面）→ `domain/`（圆心），只向内。删掉 `src/plugins/pi-model-manager/` 目录，内核一行不动——设置页的"模型" tab 消失，但加载器、configFile 机制、类型定义全部不受影响。
### 2.5 使用了内核的什么功能

pi-model-manager 插件使用内核提供的以下能力，每一项底层走什么、内核提供什么保障逐条列出：

- **`contributes.settings` 槽位**：`order: 20`，`component: "ModelManagerPage"` 指向 renderer 导出的 React 组件，`configFile: "~/.pi/agent/models.json"` + `configMerge: "replace"`。内核的插件加载器注册组件后，框架自动管 configFile 生命周期：读 JSON → 传入 `config` prop → 监听 `onChange` → 设 dirty → 弹保存浮层 → 用户确认后整份覆盖写回（`replace` 模式不做深合并）。内核保障：`readJsonFile` 带目录不存在则创建、文件不存在返回空对象；`writeJsonFile` 用 `withDirLock` 串行化；`replace` 模式直接覆盖——整份写回，不保留旧文件里的任何 key。
- **`config`/`onChange` prop（框架 configFile 机制）**：`config` 是框架从 `configFile` 读进来的 `Record<string, unknown>`，插件内部强转为 `ModelsConfig` 类型使用。`onChange` 是报告改动的回调——插件做完 CRUD 操作后调 `onChange(newConfig)`，框架记录 dirty 并管理后续保存流程。内核保障：dirty 追踪带拦截（切换设置 tab 或关闭窗口时弹"保存/丢弃/取消"）；`replace` 模式下写回的是 `onChange` 传入的完整对象——插件负责确保对象完整性；刷新按钮重读 configFile 并重置 dirty。
- **框架组件**：`SettingsSection`（只边框无填色）、`ListItem`（列表项样式，`active` prop 控制选中态）。这些组件在 `@my-harness-desktop/react` 发布面，内核提供统一的设置页视觉契约。
- **契约类型（经 `@my-harness-desktop/core`）**：`ModelsConfig`、`ProviderConfig`、`ModelConfig`。定义在圆心 `domain/sessions.ts`，经 `packages/core` re-export。插件用这些类型做编译期类型检查——保证读进来的 JSON 结构正确。内核保障：类型定义单源（只在 `domain/sessions.ts` 定义），外层只做 re-export；类型变化时所有引用处（包括这个插件）编译期报错，不会静默漂移。
- **`useTranslation`（react-i18next）**：插件自己的所有用户可见文字走 `t("key")`。key 的值由 i18n 插件（或其他语言插件）贡献。
- **`refreshSignal` prop**：框架刷新按钮点击时 `refreshSignal` +1，插件的 `useEffect` 依赖它重设默认 provider 选中。
## 3 怎么通信

### 3.1 和内核通信

走 `config`/`onChange` prop（框架从 `~/.pi/agent/models.json` 读进来的配置对象 + 报告改动的回调）。不调 `usePiApi`——这个插件只管配置编辑，不需要内核版本管理或主题列表等跨插件能力。插件改了配置 → `onChange(newConfig)` → 框架设 dirty → 用户点"确定改动" → 框架按 `configMerge: "replace"` 整份写回。

### 3.2 和其他插件通信

不和其他插件通信。配置写回后，pi 底座下次启动时读取新模型配置——不走插件间通信。

### 3.3 其他插件怎么使用自己

pi-model-manager 不产生可被其他插件消费的输出。它只写 `~/.pi/agent/models.json`——这个文件由 pi 底座在下次启动时读取，不是由桌面端其他插件读取。

**唯一的间接影响路径**：用户配置的模型（供应商、API Key、Base URL、模型列表）决定 pi 底座能用哪些模型。底座根据 `models.json` 里的配置发 API 请求，产生会话事件。这些事件经 `session-store`（application 层）写入 `useSessionStore`，所有订阅会话状态的插件（sessions-list、timeline 等）消费这些事件。如果用户配置了一个模型但 API Key 错误，底座报错——timeline 插件会显示错误消息。但这个影响是 pi 底座 → 会话事件 → 其他插件，不是 pi-model-manager → 其他插件。pi-model-manager 和其他插件之间没有通信通道。

**插件间契约的间接受益**：`ModelsConfig` 类型定义在 `domain/sessions.ts`，是所有消费模型信息的插件的共享契约。pi-model-manager 编辑 `models.json` 时保证输出符合 `ModelsConfig` 类型。其他插件（如显示当前模型名的 timeline、显示模型选择列表的会话输入框）从 `useSessionStore` 拿模型信息时，数据结构和 pi-model-manager 写入的一致。这不是直接通信——是双方都遵守圆心定义的同一份契约。

**不受影响的插件**：所有插件都和 pi-model-manager 无关。theme-manager 管主题切换、pi-manager 管 settings.json、sessions-list 管会话展示——它们都不依赖 pi-model-manager 的任何输出。
## 4 怎么处理

### 4.1 数据流

框架读 `~/.pi/agent/models.json` → 传入 `config` prop → 插件强转为 `ModelsConfig` 类型 → 渲染供应商列表（左列）和模型列表（右列）。用户编辑 → `onChange(newConfig)` → 框架管 dirty/save。

### 4.2 供应商 CRUD

- 新增：表单输入 ID/名称/Base URL，用 `crypto.randomUUID()` 生成唯一 ID——不手写 UUID 生成。
- 复制：`structuredClone` 深拷贝选中的供应商，改 ID 和名称，插到原供应商下方。
- 删除：右键菜单（Radix ContextMenu），`delete` 操作。
- 模型 CRUD：新增/编辑/删除/复制，进出动画用 framer-motion 的 `AnimatePresence`。

### 4.3 不可变更新

修改 config 时先 `structuredClone` 再改——`updateProvider` / `updateModel` 都返回新对象，不改原引用。React state 需要新引用触发重渲染——不手写深拷贝，用 `structuredClone`。

## 5 怎么保证

### 5.1 类型安全

`config` prop 是 `Record<string, unknown>`，插件强转为 `ModelsConfig`。类型定义在圆心 `domain/sessions.ts`，经 `@my-harness-desktop/core` re-export。契约单源——不在插件里定义"本地版"。

### 5.2 UUID 正确性

`crypto.randomUUID()` 是浏览器内置 API，不手写 UUID 生成——手写的 UUID 可能不唯一（`Math.random` 凑的）或不合规（不符合 RFC 4122）。

### 5.3 深拷贝正确性

`structuredClone` 是浏览器内置 API，处理循环引用、Date、Map 等边界情况。手写的深拷贝在循环引用上会栈溢出，在 Date 上会变成字符串。

## 6 如果没有这个插件，整个系统会有什么影响

删掉 `src/plugins/pi-model-manager/` 目录后，系统仍然能正常启动——内核加载器跳过这个插件，其他一切照常。内核不崩溃，机制全在。但用户失去了以下东西：

**失去的 UI 入口**：设置页的"模型" tab（`order: 20`）消失。用户无法通过 UI 管理供应商和模型——不能新增供应商、不能删除供应商、不能编辑 Base URL 和 API Key、不能添加/删除/复制模型。

**失去的功能**：用户必须手动编辑 `~/.pi/agent/models.json`。这个文件的结构是 `{ providers: { id: { baseUrl, api, apiKey, models: [...] } } }`——嵌套 JSON，手写容易出错。特别是 `api` 字段的合法值（`openai-completions`、`anthropic-messages`、`google-genai`、`openai-responses`）没有 UI 提示时容易打错。`contextWindow` 和 `maxTokens` 是数字但容易写成字符串（`"128000"` vs `128000`）——pi 底座可能因此不识别。

**对其他插件的影响**：无。所有插件照常工作。但如果用户没手动配好 `models.json`，pi 底座启动时没有可用模型，所有会话功能不可用——timeline 显示"无可用模型"错误、会话输入框的模型选择列表为空。这是 pi 底座的问题，不是桌面端插件的问题。

**第三方能否替代**：完全可以。第三方插件贡献 `contributes.settings`（带 `configFile: "~/.pi/agent/models.json"` + `configMerge: "replace"`）和 renderer 组件即可完全替代 pi-model-manager。由于 pi-model-manager 是 builtin（优先级最低），第三方插件的设置页会覆盖同名 tab。实际上，第三方可以做一个更好的模型管理 UI——比如从 `.env` 文件读 API Key、支持 OAuth 认证、内置供应商模板（一键添加 OpenAI/Anthropic/Google）——pi-model-manager 作为 builtin 只提供最基础的 CRUD。

## 7 QA

**Q：configMerge 为什么用 replace 而不是 deep？**

模型配置是 `{ providers: { id: { name, baseUrl, models: [...] } } }` 结构。用户删了一个供应商，如果用 deep 合并，框架会尝试保留删除的字段——但删除就是要把 key 去掉，不是改值。`replace` 整份覆盖最符合直觉：用户看到的就是写回去的。

**Q：供应商 ID 能重复吗？**

不能。`crypto.randomUUID()` 保证唯一性。但如果用户手动改了 ID 和已有供应商重复，当前没有做唯一性校验——标注"演进"。底座可能会拒绝重复 ID，也可能静默覆盖。

**Q：类型从 @my-harness-desktop/core 导入，会不会循环依赖？**

不会。`@my-harness-desktop/core` 是纯 re-export `src/domain/`——圆心零依赖。插件 import `@my-harness-desktop/core` 拿类型定义，不 import 实现。依赖方向：插件（外层）→ packages/core（发布面）→ domain（圆心），只向内。
