import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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
    document.body,
  );
}
