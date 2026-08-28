// MessageMeta.tsx —— 消息行元信息徽标(时间 + 指标)的渲染组件。
//
// 纯投影在 message-meta.ts(buildMessageMeta,可裸单测);本组件只消费投影结果渲染一行。
// hover 淡入,不占常驻空间。位置语义由调用方(MessageRow)决定:
//   用户消息在动作按钮**左侧**、AI 消息在按钮**右侧**——两者都朝对话中间靠拢。
import type { NeutralMessage } from "@my-harness-desktop/shared";
import { buildMessageMeta } from "./message-meta";

export function MessageMeta({ message }: { message: NeutralMessage }): React.ReactNode {
  const meta = buildMessageMeta(message);
  if (!meta) return null;
  return (
    <span
      className="opacity-0 group-hover:opacity-100 transition-opacity text-[length:var(--font-size-xs)] text-[var(--color-muted)] font-[var(--font-family-mono)] select-none whitespace-nowrap"
      aria-label="message-meta"
      title={[
        meta.clock,
        meta.duration,
        meta.tokens ? `↑${meta.tokens.input} ↓${meta.tokens.output}` : undefined,
      ].filter(Boolean).join(" · ")}
    >
      {meta.clock}
      {meta.duration ? ` · ${meta.duration}` : ""}
      {meta.tokens ? ` · ↑${meta.tokens.input} ↓${meta.tokens.output}` : ""}
    </span>
  );
}
