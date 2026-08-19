// AskHost —— ask_user_question 的常驻消费方：订阅 ctx.sessions.onExtensionUI，
// 把底座 ctx.ui.select 的 extension_ui_request 渲染成选项卡片，用户作答后 replyExtensionUI 回填。
// 挂在 sidebar 槽常驻（sub-agent 的 SubAgentSection 同款手法）：无请求时 return null，不占左栏。
// 这是全仓 onExtensionUI 的第一个消费方，堵上"提问被静默丢包"的缺面。
import { useEffect, useState, type ReactNode } from "react";
import { usePluginContext } from "@my-harness-desktop/react";

interface SelectPayload {
  title?: string;
  options?: string[];
}

interface PendingQuestion {
  requestId: string;
  title: string;
  options: string[];
}

export function AskHost(): ReactNode {
  const ctx = usePluginContext();
  const [pending, setPending] = useState<PendingQuestion | null>(null);

  useEffect(() => {
    const off = ctx.sessions.onExtensionUI((req) => {
      if (req.method !== "select") return;
      const payload = (req as { payload?: SelectPayload }).payload;
      const options = Array.isArray(payload?.options) ? payload.options : [];
      if (options.length === 0) return;
      setPending({
        requestId: req.requestId,
        title: payload?.title ?? "",
        options,
      });
    });
    return off;
  }, [ctx]);

  if (!pending) return null;

  const reply = (value?: string, cancelled?: boolean): void => {
    void ctx.sessions.replyExtensionUI(
      pending.requestId,
      cancelled ? { cancelled: true } : { value },
    );
    setPending(null);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.4)",
      }}
      onClick={() => reply(undefined, true)}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(480px, calc(100vw - 48px))",
          maxHeight: "80vh",
          overflowY: "auto",
          borderRadius: "var(--radius-lg)",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
          padding: "16px 18px",
        }}
      >
        <div className="text-[length:var(--font-size-base)] font-semibold text-[var(--color-fg)] mb-2">
          {pending.title}
        </div>
        <div className="flex flex-col gap-1.5">
          {pending.options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => reply(opt)}
              style={{
                textAlign: "left",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--color-border)",
                background: "color-mix(in srgb, var(--color-bg) 55%, transparent)",
                color: "var(--color-fg)",
                padding: "8px 12px",
                cursor: "pointer",
                fontSize: "var(--font-size-sm)",
              }}
            >
              {opt}
            </button>
          ))}
        </div>
        <div className="flex justify-end mt-3">
          <button
            type="button"
            onClick={() => reply(undefined, true)}
            style={{
              borderRadius: "var(--radius-md)",
              color: "var(--color-muted)",
              padding: "6px 12px",
              cursor: "pointer",
              fontSize: "var(--font-size-sm)",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
