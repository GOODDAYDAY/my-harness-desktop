/**
 * dsh 内核流式 chunk → 组装态消息 —— **纯函数，零依赖，可裸单测**。
 *
 * 为什么这里要自己算一次组装（设计 docs/design/llm-recorder-dsh-parity.md §2.1）：
 * `llm/stream` 给的是 chunk 流（token 级），而读侧面板要的是"模型答了什么"的组装态
 * （与 pi 侧 message_end 的组装消息同形状）。内核自己有一份组装器（BlockAssembler），
 * 但插件目录运行在 ~/.dsh/.my-harness-desktop-plugins/ 下，**不 import 内核包**——
 * 一旦 import，这个文件就只能在真内核里跑、失去裸单测能力（pi 侧同纪律）。
 * 记录侧只需要最小投影：chunk → ContentBlock[] + usage + finish，不参与任何内核决策。
 *
 * 两条宽容性（对齐内核 BlockAssembler 的容错语义，不发明新语义）：
 *   · 有 `block-end` 就用内核给的**成品块**（权威），delta 只是它的施工过程；
 *   · delta-only 协议（没有 block-start/end）也能攒出块——按 index 惰性建块。
 */

/** 按 chunk 的 index 建一个空块（类型只有 block-start 才告知，delta 只能暗示 text/reasoning）。 */
function emptyBlock(type) {
  switch (type) {
    case "text": return { type: "text", text: "" };
    case "reasoning": return { type: "reasoning", text: "" };
    case "tool-call": return { type: "tool-call", id: "", name: "", arguments: "" };
    // 未来内核新增块类型（ContentBlockMap 是 merge-extensible）：原样留 type，delta 尽力而为。
    default: return { type: type ?? "unknown" };
  }
}

/**
 * 消费 chunk 流，攒出组装态结果。
 * @param {Iterable<object>} chunks 内核产出的 StreamChunk 序列（原样，不改写）
 * @returns {{blocks: object[], usage?: object, finish?: object}} 组装态：块按出现顺序、usage、finish
 */
export function assembleChunks(chunks) {
  const order = [];
  const partials = new Map();
  let usage;
  let finish;

  const ensure = (index, type) => {
    let p = partials.get(index);
    if (p === undefined) {
      p = emptyBlock(type);
      partials.set(index, p);
      order.push(index);
    }
    return p;
  };

  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== "object") continue;
    switch (chunk.type) {
      case "block-start":
        ensure(chunk.index, chunk.blockType);
        break;
      case "text-delta": {
        const p = ensure(chunk.index, "text");
        if (typeof p.text === "string") p.text += chunk.text ?? "";
        break;
      }
      case "reasoning-delta": {
        const p = ensure(chunk.index, "reasoning");
        if (typeof p.text === "string") p.text += chunk.text ?? "";
        break;
      }
      case "tool-call-delta": {
        const p = ensure(chunk.index, "tool-call");
        if (typeof p.id === "string" && typeof chunk.id === "string") p.id = chunk.id;
        if (typeof p.name === "string" && typeof chunk.name === "string") p.name = chunk.name;
        if (typeof p.arguments === "string") p.arguments += chunk.argumentsDelta ?? "";
        break;
      }
      case "block-end":
        // 内核成品块优先（权威形状）——覆盖 delta 攒出来的近似。
        ensure(chunk.index, chunk.block?.type);
        partials.set(chunk.index, chunk.block);
        break;
      case "usage":
        usage = chunk.usage;
        break;
      case "finish":
        finish = chunk.reason;
        break;
      default:
        break;
    }
  }

  return {
    blocks: order.map((i) => partials.get(i)),
    ...(usage === undefined ? {} : { usage }),
    ...(finish === undefined ? {} : { finish }),
  };
}

/** finish reason（内核形状 {kind, failure?}）→ 可展示的字符串（读侧对字符串已容忍）。 */
export function finishText(finish) {
  if (finish === undefined || finish === null) return undefined;
  if (typeof finish === "string") return finish;
  return typeof finish.kind === "string" ? finish.kind : undefined;
}

/** 失败事实：只有 error kind（或其他带 failure 的终结原因）才算失败；aborted 是用户中断，不算。 */
export function failureOf(finish) {
  if (finish === undefined || finish === null || typeof finish !== "object") return undefined;
  if (finish.kind === "aborted") return undefined;
  if (finish.kind !== "error") return undefined;
  const f = finish.failure;
  if (f === undefined || f === null) return { kind: "error" };
  if (typeof f !== "object") return { kind: "error", detail: String(f) };
  return { kind: "error", code: f.code, message: f.message };
}
