/**
 * SubAgentDialog —— 与某会话来回对话的面板(sidePanel 槽)。
 * 状态全在 dialog-state.ts;本组件只读快照渲染 + 输入/发送/关闭。
 * 空态(未选目标)时显示提示,不占面板。目标经卡片/子 agent 列表的「对话」按钮设置。
 */
import { useEffect, useState, type ReactNode } from "react";
import { usePluginContext } from "@pi-desktop/react";
import { useTranslation } from "react-i18next";
import { closeDialog, getDialogState, sendDialogMessage, subscribeDialog } from "./dialog-state";

export function SubAgentDialog(): ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [, setVersion] = useState(0);
  const [input, setInput] = useState("");
  useEffect(() => subscribeDialog(() => setVersion((v) => v + 1)), []);

  const st = getDialogState();
  if (!st.open || !st.target) {
    return (
      <div className="p-3 text-[length:var(--font-size-sm)] text-[var(--color-muted)]">
        {t("sub-agent.dialog.empty")}
      </div>
    );
  }

  const send = (): void => {
    if (!input.trim()) return;
    void sendDialogMessage(ctx, input);
    setInput("");
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)]">
        <span className="text-[length:var(--font-size-sm)] font-medium flex-1 truncate">
          {st.target.name ?? st.target.addr}
        </span>
        {st.busy && <span className="text-[length:var(--font-size-xs)] text-[var(--color-muted)]">{t("sub-agent.dialog.thinking")}</span>}
        <button
          className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] hover:underline"
          onClick={() => void closeDialog(ctx)}
        >
          {t("sub-agent.dialog.close")}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {st.error && (
          <div className="text-[length:var(--font-size-xs)] text-[var(--color-accent-error)] px-2">{t(`sub-agent.dialog.${st.error}`)}</div>
        )}
        {st.messages.length === 0 && (
          <div className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] px-2">{t("sub-agent.dialog.hint")}</div>
        )}
        {st.messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[85%] px-2 py-1 text-[length:var(--font-size-sm)] whitespace-pre-wrap break-words rounded-[var(--radius-md)] ${
              m.role === "user"
                ? "self-end bg-[var(--color-primary)] text-[var(--color-bg)]"
                : "self-start bg-[var(--color-surface)] border border-[var(--color-border)]"
            }`}
          >
            {m.text || (m.streaming ? "…" : "")}
            {m.streaming && <span className="animate-pulse">▍</span>}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 p-2 border-t border-[var(--color-border)]">
        <input
          className="flex-1 px-2 py-1 text-[length:var(--font-size-sm)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-md)] outline-none"
          value={input}
          placeholder={t("sub-agent.dialog.placeholder")}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button
          className="px-2 py-1 text-[length:var(--font-size-xs)] bg-[var(--color-primary)] text-[var(--color-bg)] rounded-[var(--radius-md)]"
          onClick={send}
        >
          {t("sub-agent.dialog.send")}
        </button>
      </div>
    </div>
  );
}
