// retry-collapse —— timeline 插件纯逻辑层(无 React/无 IO,可单测)。
//
// 职责:把底座自动重试产生的连续空 error assistant 消息(每次失败落盘一条,
// stopReason:"error" + errorMessage,内容为空)折叠成一条 divider 条目,
// 展示"重试 N/max 次"而非 N 个相同红条。渲染层(index.tsx)只消费,不推导。
//
// 口径(与底座 agent-session 行为对齐):
// - N 条连续失败 = 1 次原始失败 + 其后的重试;全部失败时重试次数 = N-1。
// - 组后紧跟正常 assistant = 最后一次重试成功,重试次数 = N(含成功那次)。
import type { NeutralMessage } from "@pi-desktop/contract";
import { messageContentText } from "@pi-desktop/contract";

/** 是否底座重试序列中的失败消息:assistant + stopReason:"error" + 无任何实质内容。
 *  不看 error 标记——aborted(用户停止)也被 withErrorState 标 error,但它不是重试,不折。 */
function isRetryFailure(m: NeutralMessage): boolean {
  if (m.role !== "assistant" || m.stopReason !== "error") return false;
  if (messageContentText(m.content)) return false;
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (typeof b !== "object" || b === null) continue;
      const t = (b as Record<string, unknown>).type;
      if (t === "thinking" || t === "toolCall") return false;
    }
  }
  return true;
}

function errorText(m: NeutralMessage): string {
  return typeof m.errorMessage === "string" ? m.errorMessage : "";
}

/** 连续 ≥2 条同 errorMessage 的重试失败消息折叠成一条 divider(kind:"retry")。
 *  maxRetries 来自底座 settings(retry.maxRetries),仅作展示分母。 */
export function collapseRetryFailures(messages: NeutralMessage[], maxRetries: number): NeutralMessage[] {
  const out: NeutralMessage[] = [];
  let group: NeutralMessage[] = [];

  const flush = (next?: NeutralMessage): void => {
    if (group.length < 2) {
      out.push(...group);
      group = [];
      return;
    }
    const recovered = next !== undefined && next.role === "assistant" && !isRetryFailure(next);
    const first = group[0];
    const last = group[group.length - 1];
    out.push({
      role: "divider",
      kind: "retry",
      i18nKey: recovered ? "timeline.autoRetryRecovered" : "timeline.autoRetryFailed",
      i18nArgs: { count: recovered ? group.length : group.length - 1, max: maxRetries },
      content: "",
      detail: errorText(first) || undefined,
      tone: recovered ? undefined : "error",
      id: first.id,
      timestamp: last.timestamp,
    } as NeutralMessage);
    group = [];
  };

  for (const m of messages) {
    if (isRetryFailure(m)) {
      if (group.length === 0 || errorText(m) === errorText(group[0])) {
        group.push(m);
      } else {
        flush(m);
        group = [m];
      }
      continue;
    }
    flush(m);
    out.push(m);
  }
  flush();
  return out;
}
