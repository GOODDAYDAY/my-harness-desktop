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
    // ⚠ 这里曾是 `aria-label="message-meta"`——把**机器标识符**当成了可访问名。
    //   aria-label 会**覆盖**元素内容作为可访问名，于是屏幕阅读器对这个 span 念的是
    //   "message-meta"（对用户毫无意义），而不是它真正的内容（时间 + title 里的完整明细）。
    //   它的唯一用途是给单测当锚点，所以改成 data-* 属性：锚点归 data-*，可访问名归内容。
    <span
      className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] font-[var(--font-family-mono)] select-none whitespace-nowrap"
      data-message-meta=""
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
