# dsh 运行时思考深度切换——补面设计

> 状态：设计待实施。前置事实已全部实测（2026-09-07，kernel-thinking-matrix e2e + dsh 源码对读）。
> 已落地的部分：composer 对 dsh 会话的思考开关挂诚实提示（`shell.thinkingSwitchUnsupported`，显式降级 §7.6）——那是降级态，不是本设计的完成态。

## 1 问题

用户报告：「DSH 好像无法触发思考深度的切换」。

实测（幕D 证据）：dsh 会话下 composer 的思考档位下拉不渲染（`levels = capabilities.piExtension ? … : []`），思考开关置灰。用户无处切档。

## 2 根因链（实测钉死）

1. dsh 内核**没有运行时切档 RPC**：`initialize` 只收 `{cwd, provider, model, maxTokens}`，`session/setModel` 只收 `{sessionId, provider, modelId}`（`packages/sdk/protocol/src/types.ts`）。`reasoningEffort` 是配置态（settings.yaml / initialize 时的 agentOptions）。
2. 桌面 `DshBackend` 继承 `AbstractBackend.setThinkingLevel` 缺面默认（抛错），发送路径对无运行时切档面的内核跳过（`session-store.ts` 的 `capabilities.pi` 探测）。这是 `atomic-send.md` §1.3 定的显式降级，**语义正确，但呈现缺失**（控件整个消失，用户「无法触发」且不知道为什么）。

## 3 已验证的补面通道（dsh 侧）

dsh 的 agent-loop `buildRequest` 每步经 `dispatch.waterfall("agent/request", …)` 跑请求配置（`packages/core/agent-loop/src/agent.ts:457`），而 `installModelSelection`（`@deepseek-ai/dsh-agent/model-selection`）的 `agent/request` 钩子会把 `selection.assembled.reasoningEffort` 应用进请求配置——**`ModelSelection` 类型本就带 `reasoningEffort?: ReasoningEffortId`**。

桌面的 dsh 适配插件（`src/server/kernel/dsh/extension/dsh-extension/index.mjs`）**已经在用这套机制**：它给 `HarnessSdkJsonRpcServer.prototype.handleRequest` 打了补丁，把 `session/setModel` 升级成 `installModelSelection` 原地热切（不 dispose、不 resume、下一 step 生效）。补面思考深度 = 同一机制延伸，零新通道。

### 词汇对齐

dsh 的 `THINKING_LEVELS`（llm-pi-ai `catalog.ts`：`off/minimal/low/medium/high/xhigh/max`）与 pi 的档位词汇同源（同出 pi-ai）。桌面的中性档位（composer 的 `DEFAULT_LEVELS`）与其对等到 `xhigh`；`max` 是 dsh 独多的一档，UI 侧可按能力面选择是否露出。

## 4 设计（补面，不改 dsh 源码，§7.7 纪律）

```
renderer composer 选档
  → 中立契约 BaseBackend.setThinkingLevel(level)        （已在契约,不动）
  → DshBackend.setThinkingLevel override:
      transport.request("session/setThinkingLevel", { sessionId, level })
  → dsh 适配插件 handleRequest 补丁拦截该方法:
      agent = sessions.get(sessionId).handle.agent
      ref = modelSelectionRefs.get(agent) ?? installModelSelection(agent.ctx, ref)
      ref.current = { provider: <当前生效 provider>, model: <当前生效 model>, reasoningEffort: level }
  → 下一 step 的 agent/request 钩子自动应用(热切,不重启)
```

- **方法名单源**：`session/setThinkingLevel` 收进 `DSH_METHODS`（`src/server/kernel/dsh/protocol/dsh-methods.ts`）——线协议字符串不散落。
- **provider/model 解析**：扩展侧从 agent 记录读当前生效值（热切语义要求 selection 携带完整 provider/model/effort 三元组——`installModelSelection` 的钩子在 selected 存在时覆盖三个面，缺 effort 会清掉继承档）。桌面 `DshBackend` 本地记账 `effectiveModel` 已有，随 RPC 一并带上更稳（不依赖扩展侧反查）。
- **缺面降级**：旧版适配插件没有该方法 → 原生 server 抛 unknown method → `DshBackend` 懒探测记缺面（既有 `recordMissing` 通道）→ 桌面显式降级（composer 挂诚实提示，即现状）。版本配对天然安全。
- **生效显形**：dsh 的 `request/header` 事件带生效的 `reasoningEffort`，翻译器已会派生 `thinking_level_change` 分隔线（`dsh-event-translator.ts:457`）——切档成功在会话流里自动留痕，零新增。

## 5 模型支持度门槛（必须一起解决的坑）

`llm-pi-ai` 的 `resolveReasoningLevel`：effort 不在模型的 `getSupportedThinkingLevels` 里 → **抛 `UNSUPPORTED_REASONING_EFFORT`**。模型的支持面来自 `resolveModelReasoning`：settings.yaml 的每模型 `reasoningEfforts` 声明，或 pi-ai 内置 catalog 的 `reasoning` 基座。

现状：桌面的 dsh 模型写口（`dsh-config-source.ts setProvider`）只写 `id/name/contextWindow/maxTokens`，**不写 `reasoningEfforts`**；用户的 dsh 模型全是自建网关 id（bifrost/...），内置 catalog 查无 → 支持面只剩 `off`。若不做这半，切高档位会让下一发直接抛错（诚实但难看）。

**配套**：桌面写 dsh 模型时按 provider api 形态补 `reasoningEfforts` 映射（openai-completions 系 wire 值与档同名：`low/medium/high`；`off` 映射为省略参数）。这块的 wire 值表归属 llm-pi-ai 的 `thinkingLevelMap` 语义，实施时以 `packages/llm/llm-pi-ai/src/catalog.ts` 的 `resolveModelReasoning` 校验规则为准（`off` 可为 null=省略，其余档必须非空串）。

## 6 呈现面（composer）

- `levels` 的生产今天绑 `capabilities.piExtension`。补面后改为能力探测：`capabilities.dsh?.thinkingLevels === true`（dsh 能力面加一位，扩展装上即真）时也给出档位清单。dsh 档位清单不需要 RPC 拉取（词汇与 pi 同源），用 `DEFAULT_LEVELS` 即可。
- 模型不支持思考（无 reasoning 面）时切档会抛错——错误 toast 显形（既有 send 失败通道），不伪造成功。
- pi 侧行为不变（回归位）。

## 7 验收（三级）

- unittest：`dsh-extension` 的 setThinkingLevel 拦截（ref.current 写入正确三元组）；`DshBackend.setThinkingLevel` 发 RPC + 缺面降级。
- DOM test：composer 对「dsh 且支持切档」的能力面渲染可用档位下拉。
- e2e（kernel-thinking-matrix 幕D 升级）：dsh 会话切档 → `request/header` 分隔线出现 → 下一发生效。
