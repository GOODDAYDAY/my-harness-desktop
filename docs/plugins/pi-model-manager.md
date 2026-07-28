# pi-model-manager

## 1 这个插件解决什么问题

pi 底座需要配置模型供应商和模型——哪个供应商用什么 API Key、什么 Base URL、哪些模型可用。没有这个插件，用户得手动编辑 `~/.pi/agent/models.json`。pi-model-manager 把供应商和模型的增删改查放到设置页，用表单编辑而不是手写 JSON。

## 2 设计决策

### 2.1 为什么是插件而不是内核

模型管理的 UI 会变——表单布局会调、右键菜单会加项。但"能读写 JSON 配置"这个能力不会变。UI 是内容，推给插件；配置读写原语留内核。

### 2.2 选了什么机制

贡献 `settings` 槽位，`order: 20`。声明 `configFile: "~/.pi/agent/models.json"` + `configMerge: "replace"`——模型配置结构简单，整份覆盖，不做深合并。零权限。类型从 `@pi-desktop/core` 导入 `ModelsConfig`、`ProviderConfig`、`ModelConfig`——圆心定义类型，发布面 re-export，插件消费。

### 2.3 和框架的分工

框架管：组件注册、configFile 生命周期、`SettingsSection` / `ListItem` 样式。插件管：供应商 CRUD、模型 CRUD、右键菜单（Radix ContextMenu）、增删改进出动画（framer-motion）。

## 3 怎么通信

### 3.1 和内核通信

走 `config`/`onChange` prop（框架从 `~/.pi/agent/models.json` 读进来的配置对象 + 报告改动的回调）。不调 `usePiApi`——这个插件只管配置编辑，不需要内核版本管理或主题列表等跨插件能力。插件改了配置 → `onChange(newConfig)` → 框架设 dirty → 用户点"确定改动" → 框架按 `configMerge: "replace"` 整份写回。

### 3.2 和其他插件通信

不和其他插件通信。配置写回后，pi 底座下次启动时读取新模型配置——不走插件间通信。

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

`config` prop 是 `Record<string, unknown>`，插件强转为 `ModelsConfig`。类型定义在圆心 `domain/sessions.ts`，经 `@pi-desktop/core` re-export。契约单源——不在插件里定义"本地版"。

### 5.2 UUID 正确性

`crypto.randomUUID()` 是浏览器内置 API，不手写 UUID 生成——手写的 UUID 可能不唯一（`Math.random` 凑的）或不合规（不符合 RFC 4122）。

### 5.3 深拷贝正确性

`structuredClone` 是浏览器内置 API，处理循环引用、Date、Map 等边界情况。手写的深拷贝在循环引用上会栈溢出，在 Date 上会变成字符串。

## 6 QA

**Q：configMerge 为什么用 replace 而不是 deep？**

模型配置是 `{ providers: { id: { name, baseUrl, models: [...] } } }` 结构。用户删了一个供应商，如果用 deep 合并，框架会尝试保留删除的字段——但删除就是要把 key 去掉，不是改值。`replace` 整份覆盖最符合直觉：用户看到的就是写回去的。

**Q：供应商 ID 能重复吗？**

不能。`crypto.randomUUID()` 保证唯一性。但如果用户手动改了 ID 和已有供应商重复，当前没有做唯一性校验——标注"演进"。底座可能会拒绝重复 ID，也可能静默覆盖。

**Q：类型从 @pi-desktop/core 导入，会不会循环依赖？**

不会。`@pi-desktop/core` 是纯 re-export `src/domain/`——圆心零依赖。插件 import `@pi-desktop/core` 拿类型定义，不 import 实现。依赖方向：插件（外层）→ packages/core（发布面）→ domain（圆心），只向内。
