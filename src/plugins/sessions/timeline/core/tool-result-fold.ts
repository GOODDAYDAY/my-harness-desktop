// tool-result-fold —— timeline 插件纯逻辑层(无 React/无 IO,可裸单测)。
//
// 职责:pi 会话的工具调用横跨两条 entry——assistant 内容块 toolCall(挂 id/name/args,
// 没有 result)与紧随的独立的 toolResult 消息(挂 toolCallId/content)。逐条渲染就是
// "一张只有参数的卡 + 一张整段原始 JSON 的卡",观感差。本变换按
// toolResult.toolCallId → toolCallBlock.id 把结果折回工具块、从可视序列摘除
// toolResult 消息,一张卡完成"调用 + 结果"。与 core/retry-collapse 同级:
// 渲染管线(index.tsx visibleMessages)只消费,不推导。
//
// 口径:
// - 只折"能配对"的——toolCallId 命中任一 assistant 内容块的 id(id 是每会话计数值,
//   形如 "bash:3"/"bus_status:0",会话内天然唯一;理论重复按首个命中处理)。
// - 配不上的孤儿(fork 截断/部分历史/内核未来改不内嵌 toolCall 块)原样保留,
//   由 blocks.ts 的 toolResult 孤儿分支单列渲染,不在这里造视图。
// - block 已有 result(内核直写/live 路径流式回填)→ 不覆写,但 toolResult 消息
//   仍摘除——那是同一结果的第二份展示。
// - 不可变输出(MessageRow memo 依赖引用相等):仅被折入的 assistant 换新引用,
//   其余消息原引用透传。
import type { NeutralMessage } from "@my-harness-desktop/contract";

/** assistant 内容块里 toolCall 块的定位(消息下标 + 块下标)。 */
interface CallSite {
  msgIdx: number;
  blockIdx: number;
}

/** 折叠配对的结果:从任一 toolResult 消息写入 toolCall 块的字段。 */
interface ResultPatch extends CallSite {
  result: unknown;
  isError: boolean;
}

/** 工具结果折叠:toolResult 消息 → 配对 toolCall 块的 result/isError 字段。
 *  返回去除已配对 toolResult 消息的新序列;无可配对项时返回原数组(快路径,零分配)。 */
export function foldToolResults(messages: NeutralMessage[]): NeutralMessage[] {
  // 索引:assistant 内容块 toolCall 的 id → 位置(首个命中)。
  const sites = new Map<string, CallSite>();
  messages.forEach((m, msgIdx) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return;
    (m.content as unknown[]).forEach((b, blockIdx) => {
      if (typeof b !== "object" || b === null) return;
      const blk = b as Record<string, unknown>;
      if (blk.type === "toolCall" && typeof blk.id === "string" && !sites.has(blk.id)) {
        sites.set(blk.id, { msgIdx, blockIdx });
      }
    });
  });
  if (sites.size === 0) return messages;

  const tombstone = new Set<number>();
  const patches: ResultPatch[] = [];
  messages.forEach((m, msgIdx) => {
    if (m.role !== "toolResult") return;
    const key = typeof m.toolCallId === "string" ? m.toolCallId : undefined;
    const site = key ? sites.get(key) : undefined;
    if (!site) return;
    const blk = (messages[site.msgIdx].content as unknown[])[site.blockIdx] as Record<string, unknown>;
    tombstone.add(msgIdx);
    if (blk.result === undefined) {
      patches.push({ ...site, result: m.content, isError: m.isError === true });
    }
  });
  if (tombstone.size === 0) return messages;

  const patchedMsg = new Map<number, NeutralMessage>();
  for (const p of patches) {
    const src = patchedMsg.get(p.msgIdx) ?? messages[p.msgIdx];
    const content = (src.content as unknown[]).map((b, j) =>
      j === p.blockIdx ? { ...(b as Record<string, unknown>), result: p.result, isError: p.isError } : b);
    patchedMsg.set(p.msgIdx, { ...src, content });
  }
  return messages.flatMap((m, msgIdx) => (tombstone.has(msgIdx) ? [] : [patchedMsg.get(msgIdx) ?? m]));
}
