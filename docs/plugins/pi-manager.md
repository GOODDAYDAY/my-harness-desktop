# pi-manager

## 1 这个插件解决什么问题

用户需要管理 pi 底座——查当前装的什么版本、从 registry 列可用版本、升级/降级到指定版本。同时需要编辑底座配置（`~/.pi/agent/settings.json`）。没有这个插件，用户得手动跑 `npm install` 和编辑 JSON 文件。pi-manager 把版本管理和配置编辑放到一个设置页里。

## 2 设计决策

### 2.1 为什么是插件而不是内核

版本管理的 UI 会变——安装进度展示、版本列表排序都会调。配置编辑的表单会变——字段描述会加、分组会调。这些都是内容，推给插件。内核只管"能查/装 pi 版本"这个能力（`pi.kernel.status/listVersions/install`）和"能读写配置文件"这个原语（`config-file.ts`）。

### 2.2 选了什么机制

贡献 `settings` 槽位，`order: 0`（永远第一）。声明 `configFile: "~/.pi/agent/settings.json"` + `configMerge: "deep"`——框架自动管配置的读/写/dirty/save/reset/拦截。零权限——`kernel` 和 `configFile` 都是核心默认能力。

### 2.3 和框架的分工

框架管：组件注册、configFile 生命周期（读/写/dirty/save/reset/拦截/刷新/打开配置）、`SettingsSection` 样式。插件管：内核版本管理 UI（`usePiApi` 调 `pi.kernel.*`）、配置字段表单渲染（`config`/`onChange` prop）。

## 3 怎么通信

### 3.1 和内核通信

这个插件同时用两种方式拿内核能力：

- `usePiApi()` 拿原始 `window.pi` 对象——调 `pi.kernel.status()`、`pi.kernel.listVersions()`、`pi.kernel.install()`。这是跨插件的系统能力，不属于任何单个插件的上下文，所以走 `usePiApi` 而非 `usePluginContext`。
- `config`/`onChange` prop（框架从 configFile 读进来的配置对象 + 报告改动的回调）——框架管配置生命周期，插件只管渲染和报告改动。

### 3.2 和其他插件通信

不和其他插件通信。配置写回 `~/.pi/agent/settings.json` 后，pi 底座下次启动时读取新配置——不走插件间通信。

## 4 怎么处理

### 4.1 上区：内核版本管理

`pi.kernel.status()` 查当前版本和可用性。`pi.kernel.listVersions(forceRefresh)` 从 npm registry 拉版本列表——用 `semver` 包做版本排序和比较，不手写字符串比较（`"0.10.0" < "0.9.0"` 会误判）。`pi.kernel.install(version, onProgress, onDone)` 安装指定版本——进度经 `onProgress` 回调实时更新安装输出，完成经 `onDone` 回调刷新版本状态。安装是覆盖式：装新=升级、装旧=降级。

### 4.2 下区：pi 配置编辑

`config` prop 是框架从 `~/.pi/agent/settings.json` 读进来的对象。`onChange(newConfig)` 报告改动——框架设 dirty + 弹保存浮层，用户点"确定改动"后框架按 `configMerge: "deep"` 深合并写回。点路径读写用 `dot-prop` 包（`getProperty(obj, "a.b.c")` / `setProperty`），不手写路径解析。深拷贝用 `structuredClone`，不手写——React state 需要新引用触发重渲染。

### 4.3 字段描述表

`field-descriptors.ts` 定义 24 个已知配置字段的元数据（key、type、section、description）。未知字段兜底渲染——底座可能支持但未记录的字段也能编辑。`.d.ts` 解析用 TypeScript Compiler API，不正则——正则在嵌套类型、extends、联合类型面前脆弱不堪。

## 5 怎么保证

### 5.1 版本比较正确性

`semver.compare(current, target)` 做语义化版本比较。字符串字典序会误判 `0.10.0 < "0.9.0"`（因为 `"10" < "9"` 字典序成立）。semver 包处理了 prerelease（`0.1.0-beta` < `0.1.0`）等边界。

### 5.2 安装进度不丢

`pi.kernel.install` 有三个回调：`onProgress`（每行 npm 输出）、`onDone`（完成信号）、invoke 返回的 Promise。完成信号以 `onDone` 为准——不靠 invoke 返回值，因为 invoke reply 与 done 事件的顺序不保证（曾经导致 `onDone` 不触发卡住，根因是 preload 在 done 监听器内同步移除自己）。

### 5.3 配置写回安全

框架管写——`writeJsonFile` 用 `withDirLock` 串行化，`configMerge: "deep"` 用 `deepmerge` 包深合并。插件不自己写文件操作。

## 6 QA

**Q：安装过程中用户切走了怎么办？**

安装是异步的——`onProgress` 和 `onDone` 是回调，切走后回调仍然触发。但用户切回来时看到的是安装输出（因为 React state 在 keep-alive 下保持）。安装完成后 `onDone` 回调刷新版本状态。

**Q：降级版本会丢配置吗？**

不会。pi 底座配置存在 `~/.pi/agent/settings.json`，和底座二进制是分开的。降级只换二进制，不碰配置文件。但旧版本底座可能不认识新版本配置里的某些字段——这是底座的事，不是 pi-manager 的事。

**Q：未知字段怎么编辑？**

`field-descriptors.ts` 不认识的所有字段都走兜底渲染——显示 key 和原始值，可编辑。底座 `.d.ts` 解析出的字段也加进来——`pi-settings-store.ts` 用 TypeScript Compiler API 解析底座的类型定义文件，拿到字段名和类型。
