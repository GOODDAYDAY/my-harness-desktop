# minimal 内核验收报告

基于 `docs/design/minimal-kernel.md` 实现的第三内核（与 DSH/PI 同等地位）的完整交付与验收记录。

## 交付概览

| 维度 | 结果 |
|---|---|
| doc §3–§8 全落地 | ✅ 零留位桩 |
| 核心 bug/漂移修复 | ✅ 14 个（各带回归守卫） |
| 写死→注册式 | ✅ 2 处 |
| 契约级抽象修复 | ✅ 4 处 |
| 6 表面验证 | ✅ 运行时/分叉/真模型/设置/工具卡/单测 |
| typecheck / 单测 / e2e / build | 0 / 562 / 40 断言 / OK |
| push | 零 push、纯本地 |

## 内核本体（`src/server/kernel/minimal/`）

- `kernel/minimal-cli.mjs` — 协议循环（JSONL stdin/stdout，单线执行器）
- `kernel/minimal-model.mjs` — SSE 模型客户端（OpenAI 兼容流式）
- `kernel/minimal-tools.mjs` — 工具注册表（read/list/write/bash + 工具集）
- `kernel/minimal-plugin.mjs` — 插件系统（registerTool/on/registerCommand/getConfig）
- `backend/` — MinimalBackend（适配器）+ MinimalCatalog + MinimalTransport + subprocess-lifecycle
- `manager/` — 模型源/配置/扩展/logo（诚实桩）

## 14 个核心 bug/漂移（各带守卫）

1. 工厂路由 `!== dsh 即 pi` 错配 minimal→pi
2. agentDir pi 特权（minimal 文件误写 .pi/）
3. 会话文件读写格式不一致（裸写缺 type 包装）
4. plugin-icon 写死 `pi||dsh` 漏 minimal
5. MinimalCatalog.rename 投影缺失
6. MinimalCatalog.deleteSessions 文件泄漏
7. 头行缺 model/tools 快照 + setXxx 不回头更头行
8. 模型失败静默（error 事件被白名单过滤）
9. 模型源脱节（ModelSource 写死 vs CLI 读真配置）
10. 工具回环达上限 reason 缺 maxToolRounds
11. capabilities.pi 被当文件态代理（→ fileBacked 能力位）
12. newSessionId 返 null 误判惰性内核（→ 文件态预生成）
13. messageEnd 先发后写（→ 写穿先于发事件）
14. updateHeader 写 toolConfig 但 readToolConfig 返 null（→ 反向映射）

## 4 处契约级抽象修复

1. `capabilities.fileBacked`（文件态是独立轴，不借 pi 能力位）
2. 模型源同源（ModelSource 读真 models.json）
3. 文件态预生成（newSessionId 与 pi 对齐）
4. `onProcessExit` 中性化（pi 属性改名 onExit + 契约方法 + 三内核统一）

## 三件"演进"项（已全部收官）

1. switchKernel 门禁翻转 + 重挂槽位 + setModel 模型下拉接线（§8 运行期切换）
2. processExit 中性传导（pi/dsh/minimal 三内核统一）
3. setTools 契约 + 壳 updateHeader 热切换（§5.6.1 开关语义）

## 验证矩阵

- 单测：562（58 文件），稳定无 flaky（固定 sleep → 事件驱动）
- e2e：5 个（smoke 20 / fork 11 / model 3 / settings 3 / tool 3）
- 文件对应四层面：格式/计数/顺序/内容

---

# 内核插件化（round 1-25 追加）

## 目标

把 pi/dsh/minimal 三内核从核心代码抽离成插件，核心代码（圆心 + 壳机制 + web 机制）不出现内核名字面量。加第四个内核 = 写一个 KernelPlugin 工厂 + registry.register 一行。

## 核心机制

- `KernelPlugin` 接口（圆心）+ `KernelPluginContext`（壳注入运行时环境）+ `KernelPluginFactory`
- `KernelRegistry`（register/get/all/ids）+ `validateKernelPlugin`（启动期完整性校验）
- `wrapVersionApi`（KernelManager → KernelVersionApi 通用包装）

## 三个内核插件工厂

`src/server/kernel/{pi,dsh,minimal}/plugin.ts` —— 各自聚合会话面（createBackend/seed）+ 目录面（createCatalog）+ 管理面五槽位（modelSource/modelsApi/configApi/extensionSource/versionApi）。

## 核心去内核字面量

- `KernelId = string`（不透明）
- `KERNEL_IDS` 字面量数组已删（内核清单 `KernelRegistry.all()` → `IPC.kernel.list` → `window.kernel.kernelIds`）
- `capabilities.pi/dsh` → `extension/thinking/fileBacked`
- assemble 三分支 / session-store 判别 / build-kernel Record / reconcile / versionApi 全部注册表驱动

## 验证

typecheck 0 · **577 全量测试**（60 文件，含 N 内核注册验收）· 5 e2e · build OK · 零 push

## 剩余演进项

1. defaultKernelId 迁移期默认 "pi"（bootstrap 已覆盖）
2. pi/dsh 专属 IPC（dshModels/dshSettings/models/piSettings + llmOneshot）
3. BackendExtensions 语义拆分（steering/thinking/compaction/bash 与 dsh 能力面统一）
