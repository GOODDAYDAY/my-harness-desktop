import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { usePluginContext, useSessionStore, type MessageActionProps } from "@my-harness-desktop/react";

const STYLE = "flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer";

/**
 * 继续执行按钮:异常停机的 assistant 消息(工具失败/LLM 失败/用户停止)上出现,
 * 点一下经 ctx.messaging.continue() 原地续跑——经中立第八意图(pi=followUp 翻译,
 * dsh=session/continue RPC),不 fork、不重发旧消息,与 retry 语义分开。
 */
export function ContinueAction({ message }: MessageActionProps): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const { streaming } = useSessionStore();
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleContinue = useCallback(async (): Promise<void> => {
    if (streaming) {
      setToast(t("shell.continueStreamingBlocked"));
      return;
    }
    try {
      await ctx.messaging.continue();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast(t("shell.continueFailed", { error: msg }));
    }
  }, [ctx, t, streaming]);

  // 只在异常停机的 assistant 消息上出现(error=生成失败/工具失败;stopped=用户停止)
  if (!message.id || message.role !== "assistant") return null;
  if (message.error !== true && message.stopped !== true) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => { void handleContinue(); }}
        title={t("shell.continue")}
        className={STYLE}
      >
        <Play className="size-3.5" />
        {t("shell.continue")}
      </button>
      {toast && (
        <span className="text-xs text-[var(--color-accent-error)]">{toast}</span>
      )}
    </>
  );
}
