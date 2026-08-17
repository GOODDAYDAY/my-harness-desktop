import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { usePluginContext, useSessionStore, useArmConfirm, type MessageActionProps, type NeutralMessage } from "@pi-desktop/react";

const STYLE = "flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer";
const ARMED_STYLE = "flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-accent-error)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer";

export function RetryAction({ message }: MessageActionProps): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const { snapshot, streaming } = useSessionStore();
  const [toast, setToast] = useState<string | null>(null);
  const { armed, arm, disarm } = useArmConfirm();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleRetry = useCallback(async (): Promise<void> => {
    if (streaming) {
      setToast(t("shell.retryStreamingBlocked"));
      return;
    }
    if (!message.id) return;
    try {
      const msgs = snapshot?.messages ?? [];
      const idx = msgs.findIndex((m) => m.id === message.id);
      if (idx < 0) return;
      let userMsg: NeutralMessage | null = null;
      for (let i = idx; i >= 0; i--) {
        if (msgs[i].role === "user") { userMsg = msgs[i]; break; }
      }
      if (!userMsg?.id) {
        setToast(t("shell.retryNoUserMessage"));
        return;
      }
      await ctx.tree.fork(snapshot?.state.sessionFile ?? "", userMsg.id);
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
  }, [ctx, t, streaming, snapshot, message.id]);

  if (!message.id || message.role !== "assistant") return null;

  return (
    <>
      <button
        onClick={() => {
          if (armed) { disarm(); void handleRetry(); return; }
          arm(true);
        }}
        title={armed ? t("shell.retryArmed") : t("shell.retry")}
        className={armed ? ARMED_STYLE : STYLE}
      >
        <RotateCcw className="size-3.5" />
        {armed ? t("shell.retryArmed") : t("shell.retry")}
      </button>
      {toast && (
        <span className="text-xs text-[var(--color-accent-error)]">{toast}</span>
      )}
    </>
  );
}
