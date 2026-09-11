// StreamTextReveal —— 流式文本显示（增量渲染 + 防抖 + 光标 + 停顿提示）
//
// 设计锚定:
//   docs/plugins/sessions/timeline.md §4.4 / §8.3 / §8.4
//   docs/design/timeline-block-renderers.md（防抖 50ms 攒批 + StreamingCaret + useStalledHint；
//   原指向的 docs/design-style-guide.md 已不存在,该内容现落在本文档）
//
// 关键机制:
//   - `message_update` 推的是完整快照而非 delta——本组件直接消费快照文本，
//     不自己累积 delta，每次用最新快照重渲染。
//   - 高频 update 防抖到 rAF（§8.4 批处理 + §2.3.4 50ms 攒批），避免每个 token 触发一次重渲染。
//   - 流式期间（streaming=true）末尾挂 StreamingCaret（竖线规格见 `docs/plugins/sessions/message-blocks.md`：
//     1.5px、**明暗交替**——诉求 15 要求「打印中」也看得出在执行，故由「静态不闪烁」改为
//     opacity 呼吸，关键帧在 ./stream-text-reveal.css）。
//   - 停顿超 800ms 触发 useStalledHint，shimmer 落在提示文字上（与光标呼吸互补：
//     光标=在动，微光文字=卡住了）。
//
// 本组件只负责"流式文本"这一种内容块——markdown 富文本由 markdown.tsx 处理，
// 工具卡片由 tool-cards.tsx 处理，thinking 块由 thinking-chain-block.tsx 处理。
import { useState, useEffect, useRef, type ReactNode } from "react";
// StreamingCaret / useDebouncedValue 收归发布面共享件（packages/react/src/stream-caret.tsx）。
// 此前本文件与 markdown/renderer/stream-utils.tsx 各持一份**逐字节拷贝**——
// 两份平行实现意味着改一份另一条路径不动（markdown 恰是助手正文最常见的渲染路径）。
// 现在单一实现：改一次，两条路径同时变。此处 re-export 只为兼容既有 import 点，
// 新代码请直接从 @my-harness-desktop/react 引。
export { StreamingCaret, useDebouncedValue } from "@my-harness-desktop/react";
import { StreamingCaret, useDebouncedValue } from "@my-harness-desktop/react";

/**
 * useStalledHint —— 停顿提示 hook（规格见 docs/plugins/sessions/message-blocks.md 的停顿提示小节）
 *
 * @param streaming 是否流式中
 * @param deltaKey  随 token 到达而变化的值（通常是文本长度或最后时间戳）
 * @param stallMs   停顿阈值，默认 800ms
 * @returns         超过阈值未变化返回 true
 */
export function useStalledHint(
  streaming: boolean,
  deltaKey: unknown,
  stallMs = 800,
): boolean {
  const [stalled, setStalled] = useState(false);
  const lastChangeRef = useRef<number>(0);

  useEffect(() => {
    if (!streaming) {
      setStalled(false);
      return;
    }
    lastChangeRef.current = Date.now();
    setStalled(false);

    const id = setInterval(() => {
      if (Date.now() - lastChangeRef.current > stallMs) {
        setStalled(true);
      }
    }, stallMs / 2);

    return () => clearInterval(id);
  }, [streaming, stallMs]);

  useEffect(() => {
    if (streaming) {
      lastChangeRef.current = Date.now();
      setStalled(false);
    }
  }, [deltaKey, streaming]);

  return stalled;
}

/**
 * StreamTextReveal —— 流式文本组件
 *
 * 在流式期间用防抖文本 + StreamingCaret 渲染；
 * 停顿超过 800ms 显示 "正在思考..." shimmer 提示（与光标呼吸互补：光标=在动，微光=卡住）。
 *
 * 非流式时直接渲染 children（不防抖、不加光标）。
 */
export function StreamTextReveal({
  text,
  streaming,
  children,
}: {
  text: string;
  streaming: boolean;
  children?: (text: string) => ReactNode;
}): ReactNode {
  const debouncedText = useDebouncedValue(text, 50);
  const stalled = useStalledHint(streaming, text.length);

  if (!streaming) {
    return children ? children(text) : <>{text}</>;
  }

  return (
    <span style={{ position: "relative" }}>
      {children ? children(debouncedText) : <>{debouncedText}</>}
      <StreamingCaret />
      {stalled && (
        <span
          className="stalled-hint"
          style={{
            display: "inline-block",
            marginLeft: 8,
            fontSize: "0.85em",
            color: "var(--color-muted)",
            background:
              "linear-gradient(90deg, var(--color-muted) 0%, var(--color-fg) 50%, var(--color-muted) 100%)",
            backgroundSize: "200% 100%",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            animation: "shimmer 2s linear infinite",
          }}
        >
          ...
        </span>
      )}
    </span>
  );
}
