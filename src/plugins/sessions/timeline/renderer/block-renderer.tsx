// block-renderer.tsx —— timeline 的块分派(本文唯一新写的机制代码,设计 §3.3 落点七)。
//
// 职责:拿到块 → 查 blockRenderers 槽 → 按 (block, name?) 二键解析出贡献组件 →
// 按块类型拼标准 props 渲染。timeline 不持有一个渲染组件,也不认识任何贡献方。
// 槽中解析不到组件(message-blocks 缺席的极端路径)落 PlainBlockFallback 纯文本兜底——
// 只保证不崩、可读、可滚,不试图画得还行(设计 §5.3)。
import { type ReactNode } from "react";
import {
  useBlockRenderers, resolveBlockRenderer, resolveBlockRendererComponent,
  type NeutralMessage,
} from "@pi-desktop/react";
import { type TimelineBlock } from "./blocks";

export function BlockRenderer({ block, message, collapseDefault, bubbleMaxLines }: {
  block: TimelineBlock;
  message: NeutralMessage;
  collapseDefault: boolean;
  bubbleMaxLines: number;
}): ReactNode {
  const items = useBlockRenderers();
  const name = block.type === "toolCall" ? block.toolCall.name : block.type === "divider" ? block.kind : block.type === "auxBlock" ? block.aux.type : undefined;
  const item = resolveBlockRenderer(items, block.type, name);
  const Comp = item ? resolveBlockRendererComponent(item) : undefined;
  if (!Comp) return <PlainBlockFallback block={block} />;
  // 流式语义按消息自持(message.pending),不读全局 streaming——现行行为保持。
  const pending = message.pending === true;
  switch (block.type) {
    case "thinking":
      return <Comp content={block.content} streaming={pending} startedAt={message.timestamp} completedAt={pending ? undefined : message.timestamp} collapseDefault={collapseDefault} />;
    case "toolCall":
      return <Comp toolCall={block.toolCall} collapseDefault={collapseDefault} />;
    case "text":
      return <Comp text={block.text} streaming={pending} />;
    case "userText":
      return <Comp text={block.text} maxLines={bubbleMaxLines} />;
    case "divider":
      return <Comp kind={block.kind} i18nKey={block.i18nKey} i18nArgs={block.i18nArgs} detail={block.detail} tone={block.tone} />;
    case "auxBlock":
      // 结构化块(底座 skill 展开 / 插件附加块):贡献方渲染折叠卡,props 只传块本身。
      return <Comp aux={block.aux} />;
  }
}

/** 槽中无渲染器时的极简纯文本兜底:零依赖、无样式追求、不碰 i18n(语言包也可能缺席)。 */
function PlainBlockFallback({ block }: { block: TimelineBlock }): ReactNode {
  if (block.type === "text" || block.type === "userText") {
    return <div className="whitespace-pre-wrap break-words text-[var(--color-fg)]">{block.text}</div>;
  }
  if (block.type === "toolCall") {
    return <div className="text-[var(--color-muted)] text-[length:var(--font-size-sm)] font-[var(--font-family-mono)]">{block.toolCall.name}</div>;
  }
  if (block.type === "divider") {
    return <div className="text-[var(--color-muted)] text-xs">{block.kind}</div>;
  }
  // thinking/auxBlock 块没有短文本可显示,降级路径不渲(auxBlock 不裸显标签原文)。
  return null;
}
