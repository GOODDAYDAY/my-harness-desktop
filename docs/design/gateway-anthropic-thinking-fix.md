# 网关 anthropic-messages 思考块错标修法规范（外部依赖缺陷，非桌面 bug）

> 状态：已知外部依赖缺陷的接入检查清单。桌面/pi 无尊纪律修法（见 skills §「桌面侧修法穷尽结论」），修复唯一在网关（bifrost ai-router）。

## 1 现象

`deepseek-v4-pro`（`volcengine/deepseek-v4-pro`、`bifrost/tencent/deepseek-v4-pro`）经网关的 anthropic-messages 适配器请求思考时，网关把推理内容**错标成 text 块**：

```
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}   ← 应为 "thinking"
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"我们"}}  ← thinking_delta 进了 text 块
...
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}           ← 同一 index 又流 text_delta
```

**结果**：pi-ai 按 Anthropic 规范校验「thinking_delta 必须落在 thinking 块」，块型不匹配 → 静默丢弃 → pi 落盘无思考。同模型经 openai-completions 路径（`reasoning_content`）正常。对照组 glm-5.2 经同一网关 anthropic 路径正确开 `thinking` 块——**逐模型错标，非系统性**。

## 2 正确序列（网关应产出）

reasoning 模型的 anthropic-messages SSE 应为：

```
event: content_block_start   {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}
event: content_block_delta   {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"…"}}   (×N)
event: content_block_stop    {"type":"content_block_stop","index":0}
event: content_block_start   {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}
event: content_block_delta   {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"…"}}           (×N)
event: content_block_stop    {"type":"content_block_stop","index":1}
event: message_delta         {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{…}}
event: message_stop          {"type":"message_stop"}
```

要点：
- 思考块与文本块是**两个独立 content_block**，各有自己的 `index`（0 = thinking，1 = text）。
- `thinking_delta` 只进 index 0（thinking 块），`text_delta` 只进 index 1（text 块）。
- 一个块 `content_block_start` → `content_block_delta`×N → `content_block_stop` 成组闭合，再开下一块。

## 3 自查清单（网关维护者）

1. 对 reasoning 模型（请求带 `thinking` 参数 + `anthropic-beta: interleaved-thinking-*`），上游返回的推理内容是否单独开 `content_block_start{type:"thinking"}`？
2. `thinking_delta` 的 `index` 是否指向 thinking 块（而非 text 块）？
3. `text_delta` 的 `index` 是否指向 text 块（而非与 thinking_delta 同 index）？
4. 逐块是否 `start` → `delta`×N → `stop` 成组闭合？

## 4 验证口径

- 修复后：`curl -sN https://<gw>/v1/messages` 带 thinking 参数，断言首个 `content_block` 的 `type === "thinking"`，且 `thinking_delta` 与 `text_delta` 的 `index` 不同。
- 桌面侧：pi + 该模型选 thinking 后，思考块应正常渲染展开（`scripts/demo/kernel-thinking-matrix.e2e.mjs` 幕A 口径）。

## 5 桌面侧为何不可修（穷尽结论）

| 层面 | 为何不可修 |
|---|---|
| 请求参数 | display/beta/budget 均不触发错标，改请求无用 |
| pi 扩展 `before_provider_request` | 只改请求体，改不了端点/API 格式，且网关对请求形状不敏感 |
| pi 扩展 `after_provider_response` | 只暴露 `{status, headers}`，无流级 body |
| pi-ai | 按规范丢错标块是对的，改它=掩盖网关 bug（§7.7 禁改外部内核） |

可用绕过：pi 侧选 openai-completions 路径的 dsv4pro 条目（`tencent/deepseek-v4-pro` =「DeepSeek V4 Pro OpenAI」），思考块正常（`pi-openai-thinking.e2e.mjs` 守卫）。
