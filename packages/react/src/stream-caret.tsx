// 流式件（StreamingCaret + useDebouncedValue）—— 发布面共享件，单一实现。
//
// 为什么在 packages/react 而不在各插件里（本节是收敛记录，勿再复制第四份）：
// `StreamingCaret` 与 `useDebouncedValue` 曾被**逐字节复制**两份——一份在
// `src/plugins/sessions/message-blocks/renderer/stream-text-reveal.tsx`，
// 一份在 `src/plugins/sessions/markdown/renderer/stream-utils.tsx`（markdown 从
// message-blocks 迁出时自持了一份，没有 import 原件）。`docs/plugins/sessions/markdown.md`
// §3.2/Q&A 把这件事记成「已知重复」，并写明正确方向是上提到共享层让两边 import——
// 这里就是那次收敛。
//
// 收敛不是洁癖，是被一次真实缺陷逼出来的：诉求 15 要求「打印中」看得出在执行，
// 而光标是关键信号。两份平行实现意味着**只改一份就能让另一条路径继续不动**——
// markdown 恰恰是助手正文最常见的渲染路径。同一逻辑一份定义，改一次两条路径同时变。
//
// 依赖方向：packages/react 是发布面，插件只 import `@my-harness-desktop/react`
// （CLAUDE.md §6.3 检验④），所以共享流式件放这里插件才拿得到。

import { useEffect, useState, type ReactNode } from "react";
import "./stream-caret.css";

/**
 * StreamingCaret：流式文本末尾的 1.5px 光标。
 *
 * 几何与颜色写死在这里（1.5px / foreground 50%），**动画挂在 `.stream-caret` 类上**
 * （见 ./stream-caret.css）：明暗交替表示「正在打印」。`prefers-reduced-motion` 下
 * CSS 停掉动画退回常亮，几何不变。
 */
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

/** 流式快照防抖：高频 update 攒批到 delayMs，避免每个 token 触发一次重渲染。 */
export function useDebouncedValue<T>(value: T, delayMs = 50): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
