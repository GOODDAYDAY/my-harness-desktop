import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import {
  usePluginContext,
  useSessionStore,
  useUiStore,
  useArmConfirm,
  stripToolLimitNote,
  type MessageActionProps,
  type NeutralMessage,
} from "@pi-desktop/react";
import { messageContentText } from "@pi-desktop/contract";

const STYLE = "flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer";
const ARMED_STYLE = "flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-accent-error)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer";

export function RetryAction({ message }: MessageActionProps): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  // 根因修复,勿回退到 snapshot.messages:那是整表 sync 基线,不随事件流推进——最新回复
  // 不在其中(findIndex→-1 静默 return),文件读会话更恒为 null。锚点必须取自时间线
  // 实际渲染的这份 messages。
  const { messages, streaming } = useSessionStore();
  const currentCwd = useUiStore((s) => s.currentCwd);
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
    if (!message.id || !currentCwd) return;
    const idx = messages.findIndex((m) => m.id === message.id);
    if (idx < 0) {
      setToast(t("shell.retryNotFound"));
      return;
    }
    let userMsg: NeutralMessage | null = null;
    for (let i = idx; i >= 0; i--) {
      if (messages[i].role === "user") { userMsg = messages[i]; break; }
    }
    if (!userMsg?.id) {
      setToast(t("shell.retryNoUserMessage"));
      return;
    }
    // 落盘的 user 消息可能带工具限制前缀(buildToolLimitNote);剥掉再发——
    // sendMessage 在工具过滤生效时会自行注入,直接透传会二次注入。
    const text = stripToolLimitNote(messageContentText(userMsg.content));
    if (!text.trim()) {
      setToast(t("shell.retryNoUserMessage"));
      return;
    }
    try {
      await ctx.tree.fork(userMsg.id);
      // 统一走受管发送入口(sendMessage):偏好回灌/工具过滤/乐观回显/assistant 占位/
      // 发送后滚底,与正常发送行为一致(与 rewind 同契约;此前裸 prompt 全丢)。
      const res = await useSessionStore.getState().sendMessage(currentCwd, text);
      if (!res.ok) {
        setToast(t("shell.retryFailed", { error: res.error ?? "" }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const m = /Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/.exec(msg);
      setToast(t("shell.retryFailed", { error: m?.[1] ?? msg }));
    }
  }, [ctx, t, streaming, messages, message.id, currentCwd]);

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
