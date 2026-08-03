import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePluginContext, useSessionStore, type MessageActionInvokePayload, type NeutralMessage } from "@pi-desktop/react";

export const channels = ["retry:messageActionInvoke"] as const;

export function RetryHandler(): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const { snapshot, streaming } = useSessionStore();
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleRetry = useCallback(async (_actionId: string, messageId: string): Promise<void> => {
    if (streaming) {
      setToast(t("shell.retryStreamingBlocked"));
      return;
    }
    if (!window.confirm(t("shell.retryConfirm"))) return;
    try {
      const msgs = snapshot?.messages ?? [];
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      let userMsg: NeutralMessage | null = null;
      for (let i = idx; i >= 0; i--) {
        if (msgs[i].role === "user") { userMsg = msgs[i]; break; }
      }
      if (!userMsg?.id) {
        setToast(t("shell.retryNoUserMessage"));
        return;
      }
      await ctx.tree.fork(userMsg.id);
      const text = typeof userMsg.content === "string"
        ? userMsg.content
        : Array.isArray(userMsg.content)
          ? userMsg.content
              .filter((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text")
              .map((c) => String((c as Record<string, unknown>).text ?? ""))
              .join("")
          : "";
      await ctx.messaging.prompt(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const m = /Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/.exec(msg);
      setToast(t("shell.retryFailed", { error: m?.[1] ?? msg }));
    }
  }, [ctx, t, streaming, snapshot]);

  useEffect(() => {
    const off = ctx.events.on("retry:messageActionInvoke", (payload) => {
      const p = payload as MessageActionInvokePayload | null;
      if (!p) return;
      void handleRetry(p.actionId, p.messageId);
    });
    return off;
  }, [ctx.events, handleRetry]);

  if (!toast) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", width: "fit-content", margin: "0 auto 8px", padding: "6px 14px", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", border: "1px solid var(--color-border)", fontSize: "12px", color: "var(--color-muted)" }}>
      {toast}
    </div>
  );
}
