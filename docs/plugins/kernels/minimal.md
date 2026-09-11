# minimal（内核插件 · desktop 对接面）

## 1 这个插件是什么

`src/plugins/kernels/minimal/` 是 **minimal 内核的插件目录**——把「内核本体」与「desktop 对接面」放在同一个插件里：

| 面 | 内容 | 现状 |
|---|---|---|
| 内核面 | `kernel` 块（`plugin.json`）+ `src/server/kernel/minimal/**`（CLI/适配器/目录/管理面） | 内核本体是独立进程（`minimal-cli.mjs`），本插件声明它 |
| 对接面 | `renderer/`（三个 TAB 组件）+ `locales/`（四语言） | 本文件描述的对象 |
| 声明面 | `contributes.settings`（一个入口三个 TAB）+ `contributes.languages` | 与 pi / dsh 同构 |

**为什么 minimal 必须有这一面**：在它之前，pi 与 dsh 各有一个设置页入口，minimal 没有——「内核无特权差异」在用户可见面里当场破功（§1.4）。而 minimal 并非没有可管的东西：它有模型配置（`~/.minimal/agent/models.json`）、原生配置、拓展。缺的从来不是能力，是**没人给它做对接面**。

这一面刻意与 pi/dsh **同构**（同共享 base、同三 TAB 切分、同 i18n 命名空间约定）：第四个内核照抄本目录即可，不需要动壳一行。

## 2 目录与文件

```
src/plugins/kernels/minimal/
  plugin.json                      # id=minimal + kernel 块 + contributes(settings/languages)
  renderer/
    index.tsx                      # MinimalManagerPage（TAB 1：内核 + 配置）
    extensions.tsx                 # MinimalExtensionsPage（TAB 2）
    models.tsx                     # MinimalModelsPage（TAB 3）
  locales/{zh-CN,zh-TW,en,de}/
    minimal.json                   # ns `minimal.*`（版本页 + 拓展标题/占位符）
    minimal-models.json            # ns `minimalModels.*`（模型页）
```

## 3 三个 TAB

### 3.1 TAB 1「Minimal」：`MinimalManagerPage`

`renderer/index.tsx` 内联，两段：`<KernelVersionPage api={ctx.kernels.minimal} i18nPrefix="minimal" />` + 分隔线 + `<KernelConfigForm api={ctx.kernelConfig.minimal} … />`。

- **版本面是显式降级**：minimal 随壳分发，不装不升不降。`createVersionApi()` 交的是诚实桩——`status()` 回 `currentVersion: "built-in"`、`listVersions()` 回 `[]`、`install()` 回 `{ ok: false, error: "minimal 是内置内核，不支持安装/升级" }`。页面据此把安装区呈现为不可用；文案（`minimal.willUpgrade` = 「内置内核不可升级」等）说明**为什么**不可用，而不是让按钮无声地灰着。
- **配置面字段清单为空**（`MinimalConfigApi.fields()` → `[]`），所以设置页不渲染任何字段——这是显式降级，不是「忘了填」。但**存储是真的**：`get()/set()` 落到 `~/.minimal/agent/config.json`，`set` 返回的是**回读后的盘上真值**（此前直接 `return obj` 回显入参、什么都没落盘，是 §7.9.3 禁止的「伪造成功」）。

### 3.2 TAB 2「Minimal 拓展」：`MinimalExtensionsPage`

对共享 base `KernelExtensionsPage` 的薄封装，只做两件事：绑 `kernel="minimal"`，传两个**内核专属**文案：

```tsx
<KernelExtensionsPage kernel="minimal" title={t("minimal.extTitle")} sourcePlaceholder={t("minimal.extSourcePlaceholder")} refreshSignal={refreshSignal} />
```

- `title`：区块标题（内核专属）。
- `sourcePlaceholder`：安装来源输入框的占位符（内核专属——提示该内核的插件包名形状）。

**通用文案（`ext.*`）不归本插件**：它由语言插件单一来源供给（`src/plugins/system/i18n/locales/<locale>/ext.json`）。理由见 §5。

`MinimalExtensionSource` 当前 `list()` 回 `[]`、`capabilities: { update: false, reorder: false }`、装/卸返回「不支持」——同样是**显式降级**（壳据此置灰入口），不是伪造一个空列表假装成功。

### 3.3 TAB 3「Minimal 模型」：`MinimalModelsPage`

```tsx
<ModelConfigPage api={ctx.kernelModels.minimal} i18nPrefix="minimalModels" capabilities={{ reasoning: false }} … />
```

- 数据/保存走框架（manifest 的 `kernelModels: "minimal"` 声明 → 框架走 `kernelModels.minimal` 的读写面）。
- **`capabilities.reasoning: false` 是有意的**：minimal 的模型配置里没有 reasoning 档位映射（那是 pi/dsh 各自内核的概念）。旗标是「有没有这个面」的诚实回答。
- 读写面是真实现：provider 增删改、默认模型、导入导出全落 `~/.minimal/agent/models.json`；**apiKey 落独立的 `~/.minimal/agent/.credentials.json`（0600），models.json 里不留明文**，且 legacy 明文会被一次性迁移走。守卫见 `minimal-models.test.ts`（15 条）。

## 4 `kernel` 块与「一个内核 = 一个插件」

```json
"kernel": { "order": 3, "enabled": false }
```

- `order`：注册顺序（越小越先；`registry.ids()[0]` 即默认内核）。
- `enabled: false`：**默认不装载**。这是用户明确要求的一条：minimal 对正式使用没有意义，不该在默认内核清单里占位。运行时用 `MHD_ENABLE_KERNELS=minimal` 强制启用（测试/演示）。

**同生共死**：`enabled: false` 同时意味着这个插件的**对接面也不加载**（没有内核却显示它的设置页，只会得到一堆报错）。所以「禁用/卸载这个插件」= 内核 + 设置页一起消失，其余内核照常——这正是「卸载验收」要的那个形态。

## 5 通用文案为什么不放在本插件里（根因记录）

`KernelExtensionsPage` 是**内核无关的共享 base**（`packages/react/src/kernel-extensions-page.tsx`），它自己消费一批 `ext.*` 文案。此前 pi 与 dsh 各交一份 `ext.json`（逐字重复），本插件若照抄就是第三份。这有两个真实后果：

1. **谁生效取决于插件加载顺序**。i18n 合并规则是「同优先级先处理者胜」，而两份的 `ext.empty`（「还没有 extension」/「还没有拓展」）、`ext.sourcePlaceholder`（pi 的 `@scope/pkg…` / dsh 的 `@deepseek-ai/dsh-xxx…`）**取值不同**——于是 dsh 的拓展页可能提示 pi 的插件包名形状。
2. **可卸载性被破坏**。内核插件是可卸载的；文案若由 pi 插件供给，卸掉 pi 之后另一个内核的拓展页就没字了。

**已落地**：通用 `ext.*` 归语言插件（框架层）单一来源；内核专属的安装占位符与标题改走各内核自己的 namespace，经 prop 传进 base。

**守卫**：`src/i18n-collision.test.ts`——① 同一 `(locale, ns, key)` 被多个插件给出不同值即红；② 共享 base 消费的 key 不许只由内核插件贡献（否则卸载即失字）。两条判据都自动派生（扫 manifest + 解析共享组件源码），不写手写清单。

## 6 与其他插件的关系

- **不声明任何私有频道**（与 pi/dsh 同款）：「默认模型变了」由 main 侧广播中性信号 `system:refreshRequested`，消费方订阅框架信号——插件之间不认彼此的 id/channel（§8.3）。
- **不 import 任何 `@/server` 路径**，只从 `@my-harness-desktop/shared` 与 `@my-harness-desktop/react` 取类型与 API（壳插件纪律；`npm run audit:deps` 检验④）。
- 与 pi/dsh 是**并列同级**：同共享 base、同 TAB 切分、同 i18n 约定；差异全部经适配器（形状）与 capabilities（能力旗标）抹平，base 里没有 `if (kernel === "minimal")`。

## 7 相关文档

- 内核本体设计：`docs/design/minimal-kernel.md`（§2.10 独立内核、§4.9 模型与凭证、§7.9 管理面）
- 内核插件化：`docs/design/kernel-plugin.md`（注册表 / 物理插件 / 卸载验收 / 内核之间零 import）
- 验收记录：`docs/minimal-kernel-acceptance.md`
- 同级插件：`docs/plugins/kernels/pi.md`、`docs/plugins/kernels/dsh.md`

## 8 QA

**Q：minimal 默认不装载，那这个设置页平时是看不见的？**

对，看不见。`enabled: false` 让壳在**装载前**就跳过整个插件（内核面与对接面一起），所以设置页里没有 Minimal 入口，模型下拉里也没有 minimal 的条目——这与「默认不装载」是同一件事的两面。用 `MHD_ENABLE_KERNELS=minimal` 启动后，内核与它的设置页一起出现。

**Q：minimal 的版本页现在长什么样？**

**不画用不了的控件**。共享 base `KernelVersionPage` 先问 `api.capabilities()`，只在**明确支持**时才渲染安装区/「最新版本+检查更新」行/「自定义内核目录」区；minimal 交的是 `{ install: false, customDir: false }`，于是这三块都不出现，只留一行说明为什么没有（`minimal.noInstallHint`：「minimal 随壳分发：不安装、不升级、不降级，也没有需要指定的目录。」）。状态一栏读的是 `minimal.upToDate`（「内置内核，无版本概念」），而不是 `common.unknown`——「未知」读起来像"查不到"，真相是"没有这回事"。

判据是**数据**不是内核身份分支（§1.4）：加第四个内核只填它自己的旗标，共享 base 零改动。守卫：`packages/react/src/manager/kernel-version-page.test.tsx`（4 条：不支持→区块不渲染 + 说明在；支持→照常渲染；能力未到→先不画，不闪一个点不动的按钮；状态文案不落 `common.unknown`）与 `minimal-settings.e2e.mjs`（9 断言，真 app 里同时验 minimal 隐藏与 pi 照常——降级不能误伤有版本源的内核）。

> 演进记录：此前这里写着「保留区块 + 文案说明不可用」，并把它列为"加 `KernelVersionApi.capabilities` 后即可隐藏"的演进项。**已落地**。

**Q：minimal 的拓展页现在什么都不能装，为什么还要有？**

因为它得**和另外两个内核长得一样**。如果 minimal 干脆没有拓展 TAB，用户看到的是「pi/dsh 能管拓展，minimal 没这回事」——而事实是 minimal 的插件系统仍在第一版（设计见 `minimal-kernel.md` §6），是「还没有」不是「不需要」。显式降级（入口在、清单空、装/卸明确回「不支持」）比隐藏入口诚实。
