// StreamTextReveal —— 流式文本显示（增量渲染 + 防抖 + 光标 + 停顿提示）
//
// 设计锚定:
//   docs/plugins/08-plugin-timeline.md §4.4 / §8.3 / §8.4
//   docs/design-style-guide.md §2.3.4（防抖 50ms 攒批）+ §4.5（StreamingCaret）+ §4.5.2（useStalledHint）
//
// 关键机制:
//   - `message_update` 推的是完整快照而非 delta——本组件直接消费快照文本，
//     不自己累积 delta，每次用最新快照重渲染。
//   - 高频 update 防抖到 rAF（§8.4 批处理 + §2.3.4 50ms 攒批），避免每个 token 触发一次重渲染。
//   - 流式期间（streaming=true）末尾挂 StreamingCaret（§4.5.1 静态 1.5px 竖线，不闪烁）。
//   - 停顿超 800ms 触发 useStalledHint，shimmer 落在提示文字上、光标仍静态（§4.5.1/§4.5.2）。
//
// 本组件只负责"流式文本"这一种内容块——markdown 富文本由 markdown.tsx 处理，
// 工具卡片由 tool-cards.tsx 处理，thinking 块由 thinking-chain-block.tsx 处理。
import { useState, useEffect, useRef, type ReactNode } from "react";

/** StreamingCaret：1.5px 静态竖线，颜色 foreground/50，不闪烁（§4.5.1） */
export function StreamingCaret(): ReactNode {
  return (
    <span
      className="stream-caret"
      aria-hidden
      style={{
        display: "inline-block",
        width: "1.5px",
        height: "1.05em",
        marginLeft: "2px",
        transform: "translateY(2px)",
        borderRadius: "1px",
        background: "color-mix(in srgb, var(--color-fg) 50%, transparent)",
        verticalAlign: "baseline",
      }}
    />
  );
}

/**
 * useStalledHint —— 停顿提示 hook（§4.5.2）
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
 * useDebouncedValue —— 50ms 防抖值（§2.3.4 50ms 攒批）
 *
 * 高频 message_update 每 token 触发一次，防抖到 50ms 攒批后重渲染，
 * 避免每个 token 都跑一次 markdown 解析 + highlight。
 */
export function useDebouncedValue<T>(value: T, delayMs = 50): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}

/**
 * StreamTextReveal —— 流式文本组件
 *
 * 在流式期间用防抖文本 + StreamingCaret 渲染；
 * 停顿超过 800ms 显示 "正在思考..." shimmer 提示（光标仍静态）。
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
