import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Bookmark, Undo2 } from "lucide-react";
import { usePluginContext, useUiStore, useSessionStore, InlineConfirmInput, type MessageActionProps } from "@pi-desktop/react";

const STYLE = "flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer";

export function CopyAction({ text }: MessageActionProps): React.ReactNode {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={t("shell.copy")}
      className={STYLE}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? t("shell.copied") : t("shell.copy")}
    </button>
  );
}

export function BookmarkAction({ message, text }: MessageActionProps): React.ReactNode {
  const { t } = useTranslation();
  const { currentSessionPath } = useUiStore();
  // 默认 label = 会话名(设计拍板);无名会话(未自动命名)回退消息预览
  const sessionName = useSessionStore((s) => s.snapshot?.state.sessionName ?? null);
  const ctx = usePluginContext();
  const [editing, setEditing] = useState(false);
  if (message.role !== "assistant" || !message.id || !currentSessionPath) return null;
  const entryId = message.id;
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 30) || "(empty)";

  if (editing) {
    return (
      <InlineConfirmInput
        defaultValue={sessionName ?? preview}
        placeholder={t("shell.bookmarkLabel")}
        confirmTitle={t("common.confirm")}
        cancelTitle={t("common.cancel")}
        onConfirm={(label) => {
          ctx.events.emit("timeline:bookmarkRequested", { sessionPath: currentSessionPath, entryId, preview, label });
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <button onClick={() => setEditing(true)} title={t("shell.bookmark")} className={STYLE}>
      <Bookmark className="size-3.5" />
      {t("shell.bookmark")}
    </button>
  );
}

export function RewindAction({ message, text }: MessageActionProps): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  if (message.role !== "user" || !message.id) return null;
  return (
    <button
      onClick={() => ctx.events.emit("timeline:rewindRequested", { message, text })}
      title={t("shell.rewind")}
      className={`${STYLE} ml-auto`}
    >
      <Undo2 className="size-3.5" />
      {t("shell.rewind")}
    </button>
  );
}
