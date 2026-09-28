import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// ── 常驻 live region 宿主 ─────────────────────────────────────────────────────
//
// 为什么需要它：`role="status"` / `aria-live` 的播报前提是**容器在内容变化之前就已经在 DOM 里**。
// 而消费方的写法一律是 `{toast && <Toast … />}` —— 元素与文本**同时挂载**，
// 这种情况下多数读屏不会播报（`role="alert"` 因为是插入即播报的特例，可靠性稍好，
// 但 success/info 用的 status 就基本听不到）。所以不能只在 Toast 的 div 上加 aria 属性了事。
//
// 做法：一个**单例、常驻**的宿主容器（带 aria-live/aria-atomic），Toast 把可视内容 portal 进去。
// 宿主一旦建立就不再移除，于是从第二条起内容变化发生在一个已存在的 live region 内部 → 可靠播报；
// 第一条则由应用启动时挂载的 `<LiveRegionHost />`（见 `live-region.tsx`）提前建好宿主来覆盖。
let host: HTMLElement | null = null;

/** 取得（必要时创建）常驻 toast 宿主。幂等；宿主脱离文档时会重建。 */
export function ensureToastHost(): HTMLElement {
  if (host && host.isConnected) return host;
  const el = document.createElement("div");
  el.setAttribute("data-toast-live-region", "");
  // polite：toast 是"告知"而非"打断"（自动消失、非阻塞），不该抢占用户当前的朗读。
  el.setAttribute("aria-live", "polite");
  // atomic：整条消息作为一个整体播报，而不是逐节点念（toast 里可能有图标 + 文本）。
  el.setAttribute("aria-atomic", "true");
  el.setAttribute("role", "status");
  el.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:200;";
  document.body.appendChild(el);
  host = el;
  return el;
}

export interface ToastProps {
  message: string;
  onClose: () => void;
  duration?: number;
  variant?: "success" | "error" | "info";
}

export function Toast({ message, onClose, duration = 2500, variant = "success" }: ToastProps): ReactNode {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onClose, 300);
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const color = variant === "error"
    ? "var(--color-accent-error)"
    : variant === "info"
      ? "var(--color-primary)"
      : "var(--color-accent-success)";

  return createPortal(
    <div
      // ⚠ 语义分两种：错误用 role="alert"（插入即播报、打断当前朗读，符合"出错要立刻知道"），
      //   其余交给宿主的 role="status" + aria-live="polite"（不抢占）。
      //   宿主已经是 live region，所以这里**不需要**再写 aria-live（嵌套 live region 反而会互相干扰）。
      {...(variant === "error" ? { role: "alert" } : {})}
      data-toast-variant={variant}
      style={{
        position: "fixed",
        top: visible ? "var(--spacing-md)" : "-60px",
        left: "50%",
        transform: `translateX(-50%)`,
        zIndex: 200,
        transition: "top 0.3s ease",
        padding: "var(--spacing-sm) var(--spacing-lg)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-surface)",
        border: `1px solid ${color}`,
        boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
        color,
        fontSize: "var(--font-size-sm)",
        fontFamily: "var(--font-family-sans)",
        maxWidth: 480,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {message}
    </div>,
    ensureToastHost(),
  );
}
