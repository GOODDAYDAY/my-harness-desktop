import { useEffect, useState, type ReactNode } from "react";

/** StreamingCaret:1.5px 静态竖线,颜色 foreground/50,不闪烁(与 message-blocks 同规格)。 */
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

/** 流式快照防抖:高频 update 攒批到 delayMs,避免每个 token 触发一次重渲染。 */
export function useDebouncedValue<T>(value: T, delayMs = 50): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
