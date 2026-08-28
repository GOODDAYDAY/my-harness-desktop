# pi-manager

## 1 这个插件是什么

`src/plugins/manager/pi-manager/` 是 my-harness-desktop 的壳插件（content 层，`manager` 域），挂在 `settings` 槽位上，贡献「Pi」设置页入口。它的职责一句话：**给 pi 内核提供一个统一管理入口，一个入口三个 TAB——内核版本、PI 拓展、模型配置**。plugin.json 的 `description` 原文是「pi 内核管理:内核版本 + 配置 + 拓展 + 模型(一个入口三个 TAB)」。

它是多内核架构下 `pi` 和 `dsh` 两个同级内核各自管理插件中的一个，与 `src/plugins/manager/dsh-manager/` 完全对称。二者共享同一套 `packages/react` 里的内核无关 base 组件（`KernelVersionPage`、`KernelConfigForm`、`ModelConfigPage`、`KernelExtensionsPage`），各自只填「spec」——pi-manager 的 renderer 代码总量极小（`index.tsx` 34 行 + `models.tsx` 24 行 + `extensions.tsx` 10 行），真正的逻辑全在下沉到壳后端的 pi 适配器（`src/server/kernel/pi/manager/`、`src/server/kernel/pi/model/`）和共享 base 里。这是「壳插件只渲染 + 报告改动」纪律的直接体现：pi-manager 不 import 任何 `@/server` 路径，只从 `@my-harness-desktop/shared` 和 `@my-harness-desktop/react` 引用类型与 API。

理解这个插件，先锚定三件事：

- **它不拥有内核**。pi 内核是壳管理的资源，版本装在哪里（`~/.my-harness-desktop/pi`）、怎么 spawn、会话怎么存，都不是 pi-manager 的职责。pi-manager 只是「内核版本管理」「内核配置编辑」「内核模型配置」「内核拓展管理」四块 UI 的宿主入口，数据与落盘全部经框架注入的受控 API（`ctx.kernels.pi`、`ctx.kernelConfig.pi`、`ctx.kernelModels.pi`、`ctx.kernelExtensions`）走壳后端。
- **它贡献 settings 槽位，并声明了两个「内核专属」源**：`kernelConfig: "pi"` 与 `kernelModels: "pi"`。这是本插件区别于普通设置页插件的关键——普通设置页框架直接读 `configFile`，而 pi-manager 的「Pi」TAB 和「模型」TAB 声明了内核源后，框架改走 `kernelConfig.pi` / `kernelModels.pi` 的中性读写面，`configFile` 只保留「打开配置文件」按钮的语义。
- **它是 pi 内核专属形状的「消费端」而非「翻译层」**。pi 的原生形状（`models.json` 的 `ProviderConfig` 树、`settings.json` 的字段、`.d.ts` 的 `Settings` 接口）全部由 `src/server/kernel/pi/` 下的适配器翻译成中性契约（`KernelModelsApi` / `KernelConfigApi` / `KernelSpec`），pi-manager 拿到的是已经中性化的 `NeutralProvider[]` 和 `KernelConfigField[]`，它自己一行 pi 原生字段拼写都不写死。

## 2 文件清单与职责边界

插件目录物理结构（三份 renderer + 四语 locales + 一份 manifest）：

- `plugin.json` —— manifest。声明 `contributes.settings`（一个 `id: "pi"` 的入口项，含三个 `tabs`）与 `contributes.languages`（8 个 namespace × 4 locale = 32 条资源贡献）。
- `renderer/index.tsx` —— 入口 module。`export` 三个组件 `PiManagerPage` / `ExtensionManagerPage` / `ModelManagerPage` 供框架按 `component` 名自动匹配，并 re-export `channels`。
- `renderer/models.tsx` —— 「模型」TAB 薄 wrapper，声明 `channels = ["pi-manager:defaultChanged"]`。
- `renderer/extensions.tsx` —— 「PI 拓展」TAB 薄 wrapper，绑 `kernel="pi"`。
- `locales/{zh-CN,zh-TW,en,de}/` —— 8 个 namespace 的文案资源：`kernel.json`（版本 + 配置字段）、`models.json`、`ext.json`、`settings.json`、`shell.json`、`plugin.json`、`ext-settings.json`、`models-settings.json`。其中 `kernel.fields.*` / `kernel.fieldDescs.*` / `kernel.groups.*` / `kernel.options.*` 是共享 `KernelConfigForm` 解析 i18n key 的**值来源**。

它不包含 `pi-extension/` 或 `dsh-extension/` 目录（对比 `src/plugins/sessions/goal/` 的四件套）——因为 pi-manager 是纯管理 UI，不需要给内核补能力；它管理的「内核拓展」是 pi 内核已有的 `my-harness-fit-pi-extension` 等扩展，安装/启停走 `pi-cli.ts` 和 `PiExtensionManager`，而不是本插件自带内核插件。

依赖方向（可 grep 检验）：三个 renderer 文件只 import `@my-harness-desktop/react` 和 `react-i18next`，不 import `@/server/*`、`@/core/*`、`@/client/*` 的任何文件，不出现 `"pi" | "dsh"` 之外的内核身份字面量分支逻辑（`extensions.tsx` 里那个 `kernel="pi"` 是**传参**，是数据不是分支）。

## 3 manifest 声明：settings 槽位 + 两个内核源

### 3.1 入口项与三个 TAB

`plugin.json` 的 `contributes.settings` 只有一个数组元素，`id: "pi"`、`title: "Pi"`、`icon: "pi"`、`order: 0`（设置页永远第一）。它没有自身 `component`，而是声明了 `tabs` 数组——这使它成为「展示分组入口」（壳），渲染成顶部 TAB 条 + 当前 TAB 的 pane。契约定义在 `packages/shared/src/domain/contributions.ts` 的 `SettingsContribution`：`tabs?: SettingsContribution[]`，注释明确「每个 TAB 是一个完整 SettingsContribution，config/dirty/save 按 TAB 独立、机制零改动——只合并展示，不合并 config」。

三个 TAB 各自的独立声明：

- **`pi-kernel`**（Pi）：`component: "PiManagerPage"`、`configFile: "~/.pi/agent/settings.json"`、`kernelConfig: "pi"`。`saveMode` 未显式声明，走默认 `"framework"`（框架管 save，有浮层/拦截）。
- **`pi-ext`**（PI 拓展）：`component: "ExtensionManagerPage"`、`saveMode: "manual"`（实时生效，无保存浮层，仅打开按钮）。没有 `configFile`——拓展启停是即时的，不落框架 save 管线。
- **`pi-models`**（模型）：`component: "ModelManagerPage"`、`configFile: "~/.pi/agent/models.json"`、`saveMode: "framework"`、`kernelModels: "pi"`。

### 3.2 kernelConfig 与 kernelModels 两个源声明的语义

这是本插件契约上最关键的两处。`SettingsContribution` 里这两个字段的定义（`contributions.ts` 第 25–32 行）：

- `kernelModels?: KernelId` —— 「声明后 framework 用 `kernelModels[kernel]` 的 `readConfig`/`saveConfig` 读写中性 JSON（providers+default），不直读 configFile。configFile 仍可声明（用于『打开配置』按钮）。与 saveMode 无关；声明即隐含『走内核模型源』，pi/dsh 各自实现翻译」。
- `kernelConfig?: KernelId` —— 「声明后 framework 用 `kernelConfig[kernel]` 的 `get`/`set` 读写全量 JSON（pi=settings.json，dsh=settings.yaml 非模型 namespace）。表单走共享通用渲染，字段名+类型由内核吐（`kernelConfig[kernel].fields()`），label/文案由壳 i18n 贡献」。

落点在 `src/web/components/settings-page.tsx`（框架机制）：读配置时（第 190–204 行）依次判断 `item.kernelModels` → `item.kernelConfig` → 普通 `configFile`；写配置时（第 313–317 行）同样优先走 `kernelModels[kernel].saveConfig` / `kernelConfig[kernel].set`，只有两者都未声明才回落到 `window.kernel.configFile.set`。`configMerge`（默认 `"replace"`）只对普通 configFile 路径生效，内核源路径由适配器自己决定合并策略。

换句话说：pi-manager 的 `configFile` 声明在「Pi」和「模型」两个 TAB 里只保留了「打开 `~/.pi/agent/settings.json` / `models.json` 按钮」这一重语义；真正的读写不再经壳的通用 configFile 管线，而是经壳后端 `MainContext` 里由 bootstrap 注入的 `kernelConfig.pi`（`createPiConfigApi` 产物）与 `kernelModels.pi`（`createPiModelsApi` 产物）。这两个适配器的装配在 `src/server/bootstrap/assemble.ts` 第 304–322 行。

### 3.3 languages 贡献

`contributes.languages` 贡献 8 个 namespace，每个 × 4 locale（zh-CN / zh-TW / en / de）。namespace id 形如 `pi-manager.kernel`、`pi-manager.settings`、`pi-manager.shell`、`pi-manager.ext`、`pi-manager.ext-settings`、`pi-manager.models`、`pi-manager.models-settings`、`pi-manager.plugin`。这些资源经壳的 `mergeLanguageContributions`（`src/server/application/i18n/merge.ts`）合流成 i18next resources，renderer 侧 `useTranslation()` 直接命中。

值得强调的是「key 是契约、值是内容」的落地：共享 `KernelConfigForm` 用 `t("kernel.fields." + key)`、`t("kernel.fieldDescs." + key)`、`t("kernel.groups." + top)`、`t("kernel.options." + field + "." + value)` 派生 i18n key（见 `pi-kernel-config.ts` 的 `labelKey`/`descKey`/`groupKey`/`optionKey`），这些 key 的**值**全在 pi-manager 的 `locales/*/kernel.json` 里。适配器只从字段名派生 key，不写死文案；文案由本插件贡献。dsh-manager 若也想给 dsh 字段贡献文案，走的是它自己的 `dsh` 前缀 namespace，与 pi 的 `kernel.*` 前缀互不干扰——这正是「每个内核的文案由各自管理插件贡献」的机制。

## 4 renderer 三组件：薄 wrapper 模式

三个组件全部是「薄 wrapper」，只做一件事：把 `ctx` 里取到的内核专属 API 实例 + 一个 `i18nPrefix` / `capabilities` 传给共享 base，自己不写任何表单/列表逻辑。

### 4.1 PiManagerPage（index.tsx 第 25–34 行）

```tsx
export function PiManagerPage({ refreshSignal, config, onChange }: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  return (
    <>
      <KernelVersionPage api={ctx.kernels.pi} i18nPrefix="kernel" />
      <div style={{ borderTop: "2px solid var(--color-border)" }} />
      <KernelConfigForm api={ctx.kernelConfig.pi} config={config} onChange={onChange} refreshSignal={refreshSignal} />
    </>
  );
}
```

两个点值得单独讲：

- `api={ctx.kernels.pi}` —— `ctx.kernels` 的类型是 `Record<KernelId, KernelVersionApi>`（`context.ts` 第 302 行），pi-manager 只取 `pi` 这一个 key。`KernelVersionApi` 是内核版本管理的中性功能面（`status` / `setCustomCliDir` / `listVersions` / `install` / `fitPiExtensionAvailable?`），`KernelVersionPage` 只消费这个接口，不含内核身份分支。
- `config` / `onChange` 由框架 `SettingsPage` 注入——因为 manifest 里 `kernelConfig: "pi"`，`SettingsPage` 读配置走 `window.kernel.kernelConfig.pi.get()`（返回全量 JSON），组件改动经 `onChange` 上报，框架置 dirty、顶部保存浮层落盘走 `kernelConfig.pi.set()`。`KernelConfigForm` 自己**不 set**，是受控组件。

### 4.2 ModelManagerPage（models.tsx 第 11–23 行）

```tsx
export const channels = ["pi-manager:defaultChanged"] as const;

export function ModelManagerPage(props: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  return (
    <ModelConfigPage
      api={ctx.kernelModels.pi}
      i18nPrefix="models"
      capabilities={{ reasoning: true }}
      config={props.config}
      dirty={props.dirty ?? false}
      onChange={props.onChange}
      onDefaultChanged={(sel) => ctx.events.emit(channels[0], { provider: sel.provider, modelId: sel.model })}
    />
  );
}
```

两个关键决策：

- `capabilities={{ reasoning: true }}` —— `KernelModelsCapabilities` 只有 `reasoning: boolean` 一个字段（`context.ts` 第 153–155 行）。pi 的 `ModelConfig` 有 `reasoning?` 布尔（`models-config.ts` 第 11 行），所以这里 `reasoning: true`，`ModelConfigPage` 据以渲染 per-model 的 reasoning 复选框（`model-config-page.tsx` 第 357–362 行 `capabilities.reasoning && <checkbox>`）。这是「能力旗标降级」而非内核身份分支——dsh 侧传 `reasoning: false`，UI 自然不渲染该复选框。
- `channels` 必须 re-export。`index.tsx` 第 16–19 行注释点明原因：「框架从入口 module 读 `module.channels` 注册事件总线，模型默认变更频道在 models.tsx 里声明，不 re-export 则『未被任何插件注册』」。`channels` 用 `as const` 声明，框架加载 module 后读 `module.channels` 自动注册——emit 只能发自己声明过的 channel。`onDefaultChanged` 回调在用户「设为默认」时把 `{ provider, modelId }` emit 出去，供 timeline 等消费方订阅（详见 §9）。

### 4.3 ExtensionManagerPage（extensions.tsx 第 7–10 行）

```tsx
export function ExtensionManagerPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  return <KernelExtensionsPage kernel="pi" title={t("settings.extensions")} refreshSignal={refreshSignal} />;
}
```

`KernelExtensionsPage`（`packages/react/src/kernel-extensions-page.tsx`）是内核无关的拓展管理页：只消费 `ctx.kernelExtensions.list/enable/disable/install/uninstall(kernel)` 与 `ctx.restart`，`kernel` 是**传参**（数据），`title` 由外层薄封装传翻译好的文案（内核专属文案，如「PI 拓展」）。pi-manager 这里传 `kernel="pi"`，dsh-manager 传 `kernel="dsh"`，页面本身一行内核分支都没有。

## 5 pi 内核版本管理：基类 + spec + 子类

这是本插件的「内核版本」TAB 背后的完整机制链。核心文件三件套，对应 CLAUDE.md 里「接口 → 抽象基类 → 具体实现」的三段式继承结构：

```
packages/shared/src/domain/kernel-manager.ts    KernelSpec（纯数据契约，零依赖）
src/server/kernel/core/kernel-manager.ts        KernelManager（基类：装/查/状态合成，注入 KernelRuntime）
src/server/kernel/pi/manager/pi-kernel.ts       PiKernelManager extends KernelManager（填 PI_SPEC + postInstall）
```

### 5.1 KernelSpec：一个内核的「数据差异」

`KernelSpec`（`packages/shared/src/domain/kernel-manager.ts` 第 11–29 行）是纯数据，只装「包名 + 安装路径段 + cli.js 位置」这些**会随内核而变**的值：

- `pkg` —— npm 主包名。
- `distTag?` —— dist-tag（决定「最新版本」取哪个 tag），缺省 latest。
- `pkgJsonPath` —— installDir 下到主包 package.json 的相对段（npm 形态，含 package.json）。
- `extraPackages?` —— 附带包（dsh 用，pi 不用）。
- `cliWithinPkg` / `srcCli` / `srcPkgJson` —— 自定义目录归一化的两种形态路径段。
- `cliJsLabel` —— 自定义目录校验失败时的 cli.js 名（错误文案 hint）。

pi 的实例 `PI_SPEC`（`pi-kernel.ts` 第 12–19 行）：

```ts
export const PI_SPEC: KernelSpec = {
  pkg: "@earendil-works/pi-coding-agent",
  pkgJsonPath: ["node_modules", "@earendil-works", "pi-coding-agent", "package.json"],
  cliWithinPkg: ["dist", "cli.js"],
  srcCli: ["dist", "cli.js"],
  srcPkgJson: ["package.json"],
  cliJsLabel: "dist/cli.js",
};
```

注意 `PI_SPEC` 没有 `distTag`（走 latest）也没有 `extraPackages`（pi 是单一包，不像 dsh 的「bin + 插件」组合）。这一份数据就是 pi 内核与 dsh 内核在「版本管理机制」层面的全部差异之一；通用逻辑（装/查/状态合成）一份都不在 pi 侧重写。

### 5.2 KernelManager 基类：装/查/状态合成

`KernelManager`（`src/server/kernel/core/kernel-manager.ts`）是 abstract 类，构造签名 `constructor(spec: KernelSpec, installDir: string)`。它只 import `node:fs` / `node:path` / `semver` / `@my-harness-desktop/shared` 类型 / `./kernel-runtime`，**绝不 import pi/dsh 具体实现**（`core/` 是机制层）。它的成员：

- `currentVersion(): InstalledVersionStatus` —— 直接读 `join(installDir, ...spec.pkgJsonPath)` 的 package.json 拿 version，不 spawn CLI（避免依赖 PATH 里的那份）。文件缺失/解析失败/无字段返回 `{ currentVersion: null, available: false, error }`，宽松不判无效。
- `resolveCustomCli(dir): CustomCliResolution | null` —— 自定义目录归一化，两种形态都认：形态一源码根（`srcCli` 命中，开发仓库 build 后，优先），形态二 npm 安装目录（`pkgJsonPath` 去尾 + `cliWithinPkg`）。纯函数，只做存在性检查 + JSON 读取，不 spawn、不读环境；都不命中返回 null。
- `status(customCliDir): KernelStatus` —— 状态合成（`custom-cli-path.md §2.6` 语义）：`customCliDir` 空 → `source: "installed"` 跟数据根；非空且 `resolveCustomCli` 命中 → `source: "custom"`，`currentVersion` 取自定义版本；非空未命中 → `source: "custom"` 保留配置意图但状态回落数据根，`error` 标注「已回落」。返回的 `KernelStatusView` 里 `currentVersion`（生效版本）与 `installedVersion`（数据根版本）分列承载——「装了什么」与「在跑什么」是两回事。
- `listVersions(forceRefresh?): Promise<RegistryVersions>` —— fetch npm registry 拿版本清单 + dist-tag 最新版本。带 10min TTL 的 per-pkg 缓存（`registryCache` Map，`REGISTRY_TTL_MS = 10 * 60 * 1000`）。**这是标注的已知缺口**（文件头注释 + 盲审 H1/H2）：`listVersions` fetch registry 只用于展示最新版本号，不替用户决策「该不该更新」，是内核补 `pi update --check` 前的临时方案。
- `install(version, onProgress)` —— 下载安装到独立目录，见 §6。
- `installNpm` / `uninstallNpm`（protected）—— `requireRuntime()` 的封装，子类 `installPlugin`/`uninstallPlugin` 复用。
- `postInstall(_onProgress)` —— 安装后钩子，默认空；子类覆盖（pi 打补丁，dsh 无）。

依赖倒置体现在 `KernelRuntime`（`kernel-runtime.ts`）：`installNpm` / `uninstallNpm` / `fetchRegistryVersions` 三个方法。基类不 `spawn("npm")`、不 `fetch`、不读 `process.env`——这些「spawn/fetch/env」是会变的外层细节，实现由 shell 经 `initKernelRuntime(createNpmKernelRuntime())` 注入（`assemble.ts` 第 136 行），`createNpmKernelRuntime` 在 `src/client/npm/kernel-runtime.ts`。换运行时只换 shell 实现，`kernel-manager.ts` 一行不改。

### 5.3 PiKernelManager：只填差异

`PiKernelManager`（`pi-kernel.ts` 第 26–33 行）几乎空类，只 override `postInstall`：

```ts
export class PiKernelManager extends KernelManager {
  protected postInstall(onProgress: (line: string) => void): void {
    const outcome = patchRpcModeForkPosition(this.installDir);
    if (outcome === "patched") onProgress("[patch] rpc-mode.js fork case 已透传 position");
    const eaOutcome = patchAgentSessionEntryAppended(this.installDir);
    if (eaOutcome === "patched") onProgress("[patch] agent-session.js 已补 entry_appended 发射");
  }
}
```

两个补丁在 `src/server/kernel/pi/extension/patch-rpc-mode.ts`，都是「上游 PR 未发版前的桥」：

- `patchRpcModeForkPosition` —— 内核 `dist/modes/rpc/rpc-mode.js` 的 RPC fork case 不读 `command.position`，assistant 锚点恒撞 `before` 的 role 校验。补丁用精确字符串匹配改一行（`FORK_LINE_OLD` → `FORK_LINE_NEW`），透传 `position`。幂等：目标行消失（含内核发版天然支持）则 `already` 跳过。
- `patchAgentSessionEntryAppended` —— 内核 `AgentSessionEvent` 联合声明了 `entry_appended`，但常规消息持久化路径从不发射。补丁在 `message_end` 持久化点补发射（`appendMessage` 返回 entryId → `getEntry` → `_emit`）。这是桌面端消息 id 水合、时间线 `data-message-id`、收藏/重试/回退按钮、review 划词锚定的共同前提；事件缺席 = 新回复永远拿不到 entryId（完整一轮事件流零 `entryAppended` 的实证）。

`PatchOutcome` 是 `"patched" | "already" | "missing"` 三态，`already`/`missing` 都不算失败——内核升级天然支持后目标行本就消失。`postInstall` 之所以要在装/升内核后重打，是因为这两个补丁只在「仓库 npm install 时」由 postinstall 脚本跑过，桌面端覆盖式重装（`prepareInstallDir` 清掉旧产物）后补丁丢失。文件头还标注了契约双源：匹配串在 `assets/scripts/patch-pi-rpc.cjs` 有一份镜像（postinstall 场景无法 import TS），改一边必须改另一边。

## 6 内核安装/升级/降级/自定义目录：一条完整链路

### 6.1 install 的覆盖式安装语义

`KernelManager.install`（`kernel-manager.ts` 第 169–204 行）的语义是「装新 = 更新、装旧 = 降级」，落在**同一个** installDir（pi 是 `~/.my-harness-desktop/pi`）。流程：

1. **version 白名单**：`semver.valid(version)` 不合法直接 `{ ok: false }`，防 npm spec 注入。
2. **prepareInstallDir**：清掉上一版的 `node_modules` + `package-lock.json`，写最小 staging `package.json`（`{ name: "my-harness-desktop-kernel-stage", private: true, version: "1.0.0" }`）。文件头注释记录了实证根因——不清干净时 npm 对旧树做增量更新，主包 peer deps 跨版本升级后 `ERESOLVE` 永远失败；清干净等于全新安装，主包 + 附带包一次装成。
3. **主包 + 附带包同版本**：`installNpm(`${spec.pkg}@${version}`)` 成功后再逐个装 `spec.extraPackages`（pi 无附带包，这条对 pi 是空循环）。同版本对齐的根因注释在 dsh 场景（附带包不写 `@version` 会落到 latest dist-tag 的陈旧 rc，peer deps 冲突），pi 侧同样受益于「同版本」纪律。
4. **postInstall 钩子**：重打 fork position + entry_appended 两个补丁（§5.3）。
5. **回读校验**：成功判定不能只信 npm exit code（npm 可能 exit 0 却没把包落到预期路径，造成「假安装成功」）。`currentVersion()` 回读一次，`!available` 则返回「安装后校验失败」。

### 6.2 自定义内核目录

`KernelVersionPage` 里的 `CustomCliSection`（`kernel-version-page.tsx` 第 190–267 行）消费 `api.setCustomCliDir(dir)`。pi 侧的 handler 在 `src/server/controllers/kernel.ts` 第 20–35 行：校验（空串 = 清除合法；非空须 `resolveCustomCli` 命中，不过不写）→ 写 `prefs.customCliDir` → 运行中会话 `markPendingAll`（「自定义内核路径变更」）→ `broadcastRefreshRequested` → 返回新 status。四步原子，无中间态。

`status` 的「生效来源」维度因此是三态语义：`source: "custom"` 且命中 → `currentVersion` 取自定义版本、`installedVersion` 保留数据根版本；`source: "custom"` 未命中 → 保留配置意图 + `error` 标注回落数据根；`source: "installed"` → 完全跟数据根。UI 据此渲染「自定义内核生效中，安装仅写入数据根」的 override hint（`kernel.customCli.overrideHint` 文案），把「安装」和「自定义生效」两件事解耦——装/升/降级永远写数据根，自定义目录只影响 spawn 时用哪个 cli.js。

### 6.3 冷启动对账

`reconcileMissingKernels`（`src/server/kernel/core/kernel-reconcile.ts`，`assemble.ts` 第 689–703 行调用）在启动后异步扫已装状态，缺失则按 dist-tag 最新版自动补装。fire-and-forget，不阻断启动，失败只 warn 不崩；装完广播 refresh 让「未安装」只读条消失。这是「内核安装不该靠手动」原则的落地——用户第一次打开设置页时 pi 内核大概率已经由对账装好，pi-manager 的「内核版本」TAB 只负责后续的升/降级和自定义。

## 7 模型配置：models.json 的整条中性化链

「模型」TAB 背后的数据链是本插件与内核存储交互最完整的一条。pi 的原生存储是 `~/.pi/agent/models.json`，壳（包括 pi-manager）绝不直读它的 pi 专属形状，而是经 `KernelModelsApi` 中性面。

### 7.1 pi 专属存储契约（下沉到 kernel/pi）

`models-config.ts` 定义了 pi 原生形状，注释明说「之前这些类型定义在 s packages/shared/src/domain/sessions.ts（圆心），被壳 renderer + contract 引用，违反『壳不读内核存储格式』。现下沉到 kernel/pi，只有 pi 适配器 import；壳层不碰这些形状」：

- `ModelConfig` —— `{ id, name, reasoning?, input?, contextWindow?, maxTokens? }`。
- `ProviderConfig` —— `{ baseUrl?, api?, apiKey?, headers?, authHeader?, models: ModelConfig[] }`。
- `ModelsConfig` —— `{ providers: Record<string, ProviderConfig> }`。
- `firstModelOf(cfg)` —— 声明序首个可用模型（第一个挂有模型的 provider 的首个 model），空配置返 null；注释强调消费方「经中性接口拿，不直读 models.json」。

`ModelsStore`（`models-store.ts`）是读写原语：构造接受 `agentDir`（bootstrap 注入 `~/.pi/agent`），`get()` 同步读整份（文件不存在/损坏返回 `{ providers: {} }`，不抛错），`set(config)` 整份覆盖写（models.json 是完整树，不像 settings 深合并），`withDirLock` 串行化并发写。文件头同样标注了「偏离文档」——内核 `models.json` 是公开标准契约，桌面端写标准字段不算重复领域知识，用户明确要管理 pi 模型配置。

### 7.2 中性契约 KernelModelsApi

`KernelModelsApi`（`context.ts` 第 138–150 行）是模型配置的中性 API，pi/dsh 各交一个适配器。方法：`list` / `set` / `remove` / `rename` / `getDefault` / `setDefault` / `test` / `readConfig`（读整份 `KernelModelConfig`）/ `saveConfig`（存整份，全量 reconcile：删缺、增改、设默认）。中性形状 `NeutralProvider` / `NeutralModel` / `NeutralDefaultModel` / `KernelModelConfig` 全在 `context.ts` 第 104–135 行，其中 `NeutralProvider.apiKey` 的注释点明：pi 内联写 models.json，dsh 写 prefs + spawn 注入 apiKeyEnv——中性形状统一成 `apiKey` 字面值，内核拼写差异由适配器抹平。

### 7.3 createPiModelsApi：翻译层

`createPiModelsApi(modelsStore, piSettingsStore, sessionStore)`（`pi-kernel-api.ts`）把 pi 原生形状翻译成 `KernelModelsApi`。关键映射：

- `toNeutral` —— `ModelsConfig.providers` 的 dict 展开成 `NeutralProvider[]`，provider id 作为 key、`baseUrl/api/apiKey/models` 直映射，model 的 `id/name/reasoning/contextWindow/maxTokens` 逐个投影。pi 的 `headers`/`authHeader`/`input` 不进中性模型（`NeutralModel` 只有 `input?` 之外的五个字段），这是「中性契约只放 pi/dsh 公共子集」的取舍。
- `readDefault` —— pi 的默认模型存 `settings.json` 的 `defaultProvider` + `defaultModel` 两个顶层标量（不是 models.json 内），所以 `getDefault`/`readConfig` 从 `piSettingsStore.get()` 读；两者都是字符串才返回 `{ provider, model }`，否则 null。
- `setDefault(sel)` —— 写 `piSettingsStore.set({ defaultProvider, defaultModel })`。
- `test(cwd, provider, modelId)` —— 直接委托 `sessionStore.test(cwd, provider, modelId, "pi")`，第四个参数显式标内核（「内核身份不进配置文件」——测试走哪个内核由调用方显式传，不靠 provider 名猜）。
- `saveConfig(config)` —— 整份重建：`providers` dict 全量重建（等价于逐 provider set 的收敛），有 default 再写 settings.json。返回 `readConfig()`（落盘后的配置）。

### 7.4 模型源与合流

`PiModelSource`（`pi-model-source.ts`）`implements KernelModelSource`（`backend.ts` 第 336–338 行，`listModels(): ModelInfo[]`），把 `ModelsStore.get()` 的 provider 树展平成带 `kernel: "pi"` 标的 `ModelInfo[]`。它在 `assemble.ts` 第 177 行与 dsh 的 `DshConfigSource` 一起注入 `ModelCatalog`：

```ts
const modelCatalog = new ModelCatalog([new PiModelSource(modelsStore), dshConfigSource]);
```

`ModelCatalog`（`src/server/application/models/model-catalog.ts`）只依赖 `KernelModelSource` 接口，`listModels()` 是 `sources.flatMap(s => s.listModels())`，同名模型不跨内核去重。加第三个内核 = 加一个 source，`ModelCatalog` 一行不改。注意 `KernelModelSource.listModels`（模型清单，供会话流模型下拉、`classifyModel` 分档）与 `KernelModelsApi`（模型**配置** CRUD，供设置页）是两回事——pi-manager 的「模型」TAB 走后者，会话流模型下拉走前者，两者共享同一份 `models.json` 数据、不同的读取面。

## 8 内核原生配置：settings.json 的 schema 驱动表单

「Pi」TAB 的下半部分 `KernelConfigForm` 是 schema 驱动的通用表单，pi 只提供「字段清单 + 数据读写」，壳提供「控件映射 + i18n 文案」。

### 8.1 PiSettingsStore：settings.json 的读写 + schema 解析

`PiSettingsStore`（`pi-settings-store.ts`）承担两件事：读写 `~/.pi/agent/settings.json`，以及解析内核 `settings-manager.d.ts` 拿字段清单。

读写面（`PiSettings` 是 `Record<string, unknown>` 宽松类型）：

- `get()` —— 同步读整份，文件不存在/损坏返回 `{}`（设置页显示空，不抛错）。
- `set(patch)` —— 深合并写（只改传入字段，不覆盖整份），`withDirLock` 串行化，`deepMergeJson` 合并。
- `replace(obj)` —— 全量替换写（删除字段随之消失）。注释点明两者分工：「表单持有全量快照（get 后整份回传），deep merge 会保留已删字段，replace 才传播删除」。

schema 解析面（`parseSettingsSchema(installDir, globalResolvePaths)`）：

- `findSettingsDts` —— 优先 installDir（`~/.my-harness-desktop/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.d.ts`），回退全局 `require.resolve` 路径。`globalResolvePaths` 由 shell 注入（`process.cwd()` / `~/.npm-global` / `/usr/local/lib`），application 不读 process 环境（`assemble.ts` 第 145–149 行）。
- `parseSettingsInterfaces` —— 用 `ts.createProgram` + `checker` 把 `Settings` 接口展平成 `SchemaField[]`。嵌套 interface（如 `CompactionSettings`）展成 dotted key（`compaction.enabled`）；字面量联合/外部类型别名（`ThinkingLevel` / `Transport`）经 checker 解析成 `enum` + `enumValues`。这是「方案 D：未知字段兜底」——`.d.ts` 有但描述表没有的字段照展示，内核升级新字段不丢。
- `schemaFieldsOf` —— 把一个 TS Type 映射成 0..N 个 `SchemaField`：Boolean→`boolean`、Number→`number`、String→`string`、string 数组→`string[]`、全字符串字面量联合→`enum`、全数字字面量→`number`、有属性的对象→递归展平 dotted 子字段、无属性对象→`object`（不透明）。解析失败返回空数组（降级：配置表单退化成通用 JSON 兜底，不脆）。

### 8.2 createPiConfigApi 与 KernelConfigField

`createPiConfigApi(piSettings, { installDir, homeDir })`（`pi-kernel-config.ts`）把 `PiSettingsApi` 翻译成 `KernelConfigApi`（`get` / `set` / `fields`）。核心是 `toField`：把 `SchemaField` 补上壳的 i18n key，产出 `KernelConfigField`（`context.ts` 第 163–175 行）：

- `label: labelKey(f.key)` = `kernel.fields.${key}`；`description: descKey` = `kernel.fieldDescs.${key}`；`group` = `kernel.groups.${top}`（dotted key 取第一段，无点进 `general`）；`options` = `kernel.options.${field}.${value}`。
- 注释明说「字段名 + 类型从内核来：`parseSettingsSchema` 解析 pi 自己的 settings-manager.d.ts……适配器不硬编码字段清单——pi 升级加字段，自动跟着 .d.ts 变」；「label/description/group/选项文案是壳的本地化 i18n key，由共享表单 `t()` 解析；适配器只从字段名派生 key，不写死文案」。

`KernelConfigForm`（`packages/react/src/manager/kernel-config-form.tsx`）是消费端：`useEffect` 里 `api.fields()` 拉字段清单，`config` 从框架注入，`onChange` 上报。它把**通用数据型**映射成控件：`boolean`→开关 / `number`→数字 / `string`→文本 / `string[]`→列表 / `enum`→下拉 / `object`→可编辑 JSON。字段清单空（如 dsh 无 schema）时按值递归推断类型：嵌套对象展平成叶子控件（`InferredField`），只有真正无法结构化的叶子（空对象/对象数组）才落到可编辑 JSON textarea。分组渲染按 `group` i18n key 归组，未覆盖的顶层键进「其他字段」。整页不含内核身份分支，pi/dsh 共用。

这条链的机制-内容分离结论：**字段清单是内核吐的数据（`.d.ts` 为唯一源），控件映射是壳的机制，文案是 pi-manager 贡献的内容**。三者各归其位，pi-manager 一个字段名都不写死。

## 9 与其他插件交互

pi-manager 的「交互」分三类：发事件、消费共享 base、经内核源读写面与框架协作。它不 import 别的插件、不读别的插件的 store、不直调别的插件的能力——一切经事件总线或框架槽位。

### 9.1 事件唯一通道：pi-manager:defaultChanged

pi-manager 声明的唯一频道是 `channels = ["pi-manager:defaultChanged"] as const`（`models.tsx` 第 9 行）。发射点只有一个：`ModelConfigPage` 的 `onDefaultChanged` 回调——用户在「模型」TAB 点「设为默认」时，`ctx.events.emit(channels[0], { provider: sel.provider, modelId: sel.model })`。

消费方是 timeline 插件（`src/plugins/sessions/timeline/renderer/index.tsx` 第 422–429 行）：

```ts
useEffect(() => {
  const off = ctx.events.on("pi-manager:defaultChanged", (payload) => {
    const p = payload as { provider?: string; modelId?: string };
    if (!p.provider || !p.modelId) return;
    setDefaults({ provider: p.provider, modelId: p.modelId });
  });
  return off;
}, [ctx]);
```

这条频道的语义是「状态广播」——默认模型变更是可回放的状态，符合 `emit`（发布/订阅）而非 `invoke`（定向分派）的原语选择。timeline 订阅后 `setDefaults`，让输入框顶部的模型指示/新会话默认模型即时反映变更，不刷新、不重拉。timeline 的 manifest 里应声明了对该频道的 `dependsOn`（生命周期护栏——凡消费别人的 channel 都该声明）。

对比对称面：dsh-manager 的 `models.tsx` 声明的是 `channels = ["dsh-manager:defaultChanged"]`，timeline 若也要订阅 dsh 的默认变更，走的是另一条 channel——两个管理插件各自声明各自的内核专属频道，互不抢占。共享 base `ModelConfigPage` 刻意不硬编码频道名，而是留 `onDefaultChanged` 回调让外层薄封装自己 emit（注释：「base 不硬编码频道名」）——这是「事件频道由拥有者声明、不写死在共享组件」的纪律。

### 9.2 与 dsh-manager 的同构关系

pi-manager 与 dsh-manager 是**并列的两个同级管理插件**，互不通信，共享同一套 `packages/react` 的 base：

- 两者都贡献 `settings` 槽（pi `order: 0`、dsh 有自己的 order），各挂一个「内核版本 + 配置 + 拓展 + 模型」的入口。
- 两者都调 `KernelVersionPage`（传 `api={ctx.kernels.pi}` vs `api={ctx.kernels.dsh}` + 不同 `i18nPrefix`）、`KernelConfigForm`（`kernelConfig.pi` vs `kernelConfig.dsh`）、`ModelConfigPage`（`kernelModels.pi` vs `kernelModels.dsh` + 不同 `capabilities`）、`KernelExtensionsPage`（`kernel="pi"` vs `kernel="dsh"`）。
- 差异全部经「适配器翻译（形状）+ capabilities（能力旗标降级）」抹平，共享 base 里不含 `if (kernel === "pi")` 分支。这是 `KernelVersionPage` 文件头注释记录的收敛成果——pi-manager 的 `KernelSection`/`CustomCliSection` 与 dsh-manager 的 `DshKernelPage`/`DshCustomCliSection` 曾是逐行 copy，功能态漂移（保存方式/字段拼写/删除改名不落盘），现收敛成一份。

### 9.3 经内核源读写面与框架协作

pi-manager 的 `kernelConfig: "pi"` / `kernelModels: "pi"` 声明触发的是**框架**（`src/web/components/settings-page.tsx`）走 `kernelConfig.pi` / `kernelModels.pi` 的读写，而这两个 registry 由 bootstrap 注入 `MainContext`（`assemble.ts` 第 304–322 行 `kernelModels` / `kernelConfig`），IPC 层在 `controllers/kernel.ts` 第 111–127 行按 `kernel: KernelId` 分发。也就是说：pi-manager 的「数据从哪读、写到哪」不是它自己决定的，是框架按 manifest 声明路由到 pi 适配器的。换 dsh-manager 只是换 manifest 里的 `kernelModels: "dsh"`，框架零改动。

### 9.4 拓展 TAB 与 restart-coordinator

「PI 拓展」TAB 的 `KernelExtensionsPage` 消费 `ctx.kernelExtensions.list/enable/disable/install/uninstall("pi")` 与 `ctx.restart`。pi 侧的 `PiExtensionManager`（`pi-extension-manager.ts`）extends `KernelExtensionManager` 基类（`src/server/application/extensions/kernel-extension-manager.ts`），`onConfigChanged` 接线 `restartCoordinator.markPendingAll`（`assemble.ts` 第 438–448 行）——拓展启停/安装导致「运行中会话需重载」时，`PendingRestartSection`（`kernel-extensions-page.tsx` 第 391–472 行）列出 pending 会话并给「重载/全部重载」按钮。这是插件经框架 `restart` API 与 restart-coordinator 机制协作，不是插件间直接通信。

### 9.5 能力探测的消费方

`ctx.kernels.pi` 类型里有可选方法 `fitPiExtensionAvailable?(): Promise<boolean>`（`context.ts` 第 275 行），pi 有、dsh 缺面。它的消费方不是 pi-manager 自己，而是 tool-manager 插件（据 `context.ts` 注释「tool-manager 据此刻『过滤不生效』降级提示」）——pi-manager 的「内核版本」TAB 只负责展示与安装，不消费这个探测。这再次印证「能力接口探测、有则用无则降级」，pi 的专属能力（tool-gate 扩展可用性）不进 pi-manager 的 UI 分支。

## 10 QA

**Q：pi-manager 的 renderer 代码为什么这么少？逻辑去哪了？**

三个 renderer 文件加起来 68 行。因为版本管理 UI（`KernelVersionPage`）、配置表单（`KernelConfigForm`）、模型配置页（`ModelConfigPage`）、拓展页（`KernelExtensionsPage`）全是 `packages/react` 里的内核无关共享 base，pi-manager 只填 spec（`api` + `i18nPrefix` + `capabilities`）；pi 原生形状的翻译在 `src/server/kernel/pi/manager/` 和 `model/` 的适配器里。壳插件「只渲染 + 报告改动」的纪律在这里是最极致的形态——它没有一行 pi 专属字段拼写，没有一行内核身份分支。

**Q：`configFile` 和 `kernelConfig`/`kernelModels` 同时声明时，框架到底读哪个？**

读内核源。`settings-page.tsx` 的读配置顺序是 `kernelModels` → `kernelConfig` → 普通 `configFile`，写配置同理 `saveConfig`/`set` 优先。`configFile` 在内核源声明后只保留「打开配置文件」按钮的语义（`~/.pi/agent/settings.json` 或 `models.json`），真正的读写走 `kernelConfig.pi` / `kernelModels.pi`。这是 `SettingsContribution` 注释的明确契约：「声明即隐含走内核模型源，pi/dsh 各自实现翻译」。

**Q：pi 的默认模型为什么存在 settings.json 而不是 models.json？**

这是 pi 内核自己的存储决定，壳不替它改。`createPiModelsApi.readDefault` 从 `piSettingsStore.get()` 读 `defaultProvider` + `defaultModel` 两个顶层标量（`settings.json`），而 provider/model 清单在 `models.json`。壳经 `KernelModelsApi.getDefault`/`setDefault` 中性面读写，不关心底层落在哪个文件；dsh 侧默认模型落在 `settings.yaml` 的 `agent-default-model` 命名空间，形状不同，但壳看到的是同一个 `NeutralDefaultModel`。

**Q：装/升/降级 pi 内核会丢什么？为什么？**

丢两个桌面端依赖的补丁（`rpc-mode.js` 的 fork position 透传、`agent-session.js` 的 `entry_appended` 发射），因为它们只在「仓库 npm install 时」由 postinstall 脚本跑过，桌面端覆盖式重装会清掉。所以 `PiKernelManager.postInstall` 在每次 install 后自动重打，`already`/`missing` 不算失败（内核发版天然支持后目标行消失，补丁幂等跳过）。

**Q：自定义内核目录和「安装」是什么关系？会互相覆盖吗？**

不会。`status` 把「装了什么」（`installedVersion`，数据根）与「在跑什么」（`currentVersion`，自定义生效时取自定义版本）分列。安装永远写数据根 `~/.my-harness-desktop/pi`；自定义目录只影响 spawn 时用哪个 cli.js（`assemble.ts` 的 `customCliPath()`）。UI 用 `kernel.customCli.overrideHint` 提示「自定义内核生效中，安装仅写入数据根」——两者是解耦的两个维度，`source: "custom"` 未命中时状态回落数据根并标注 error，不静默。

**Q：`kernel.fields.*` 这些文案 key 是谁的？为什么 pi-manager 的 locale 里有一大堆？**

key 是共享 `KernelConfigForm` 从 `KernelConfigField.label/description/group/options.label` 消费的 i18n key，值由 pi-manager 贡献。适配器 `createPiConfigApi` 只从字段名派生 key（`kernel.fields.${key}` 等），不写死文案；文案是内容，归 pi-manager 的 `locales/*/kernel.json`。内核升级新字段自动出现在表单里（`.d.ts` 为唯一源），但对应文案 key 若没人贡献，`t()` 的 `defaultValue: field.key` 兜底显示原始 key——这是「未知字段兜底」的正常降级，不脆。

**Q：pi-manager 和 timeline 是怎么联动默认模型的？为什么不用共享 store？**

走事件总线。pi-manager 在用户「设为默认」时 `ctx.events.emit("pi-manager:defaultChanged", { provider, modelId })`，timeline `ctx.events.on` 订阅后 `setDefaults`。不走共享 store 互读写，因为「壳插件之间唯一合法的通信是事件」——emit 是发布/订阅，payload 缓存可 `replayLast` 回放，适合「默认模型」这种可回放的状态广播。timeline 消费该频道应声明 `dependsOn`（生命周期护栏）。

**Q：dsh-manager 和 pi-manager 会不会撞频道、撞组件名？**

不会。组件名各自独立（`PiManagerPage` vs dsh 的组件名），由框架按 manifest `component` 字段在各自 entry module 的 exports 里匹配；频道各自声明（`pi-manager:defaultChanged` vs `dsh-manager:defaultChanged`），事件总线按 pluginId 隔离 emit 权属，只发自己声明过的 channel。共享 base 不硬编码任何频道名/组件名/内核身份，差异全靠传参和适配器。

**Q：为什么「模型配置」走 `kernelModels` 而「配置表单」走 `kernelConfig`，两个源不能合并吗？**

不能，语义不同。`kernelModels` 是**模型** namespace（providers + default），`KernelModelConfig` 有结构、经 `readConfig`/`saveConfig` 整份 reconcile；`kernelConfig` 是**内核原生非模型配置**（pi=settings.json 全量，dsh=settings.yaml 非模型段），无结构、字段清单由内核 `fields()` 吐、表单走通用渲染。两者在 `SettingsContribution` 里是两个独立字段、两个独立 IPC 面（`IPC.kernelModels.*` vs `IPC.kernelConfig.*`），pi 的「模型」TAB 声明前者、「Pi」TAB 声明后者，互不越界。
