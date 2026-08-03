import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Bookmark, Undo2 } from "lucide-react";
import { usePluginContext, useUiStore, type MessageActionProps } from "@pi-desktop/react";

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
  const ctx = usePluginContext();
  if (message.role !== "assistant" || !message.id || !currentSessionPath) return null;
  return (
    <button
      onClick={() => {
        const preview = text.replace(/\s+/g, " ").trim().slice(0, 30) || "(empty)";
        ctx.events.emit("timeline:bookmarkRequested", { sessionPath: currentSessionPath, entryId: message.id, preview });
      }}
      title={t("shell.bookmark")}
      className={STYLE}
    >
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
