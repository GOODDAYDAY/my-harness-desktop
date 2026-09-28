import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Undo2 } from "lucide-react";
import { usePluginContext, type MessageActionProps , copyToClipboard } from "@my-harness-desktop/react";

const STYLE = "flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer";

export function CopyAction({ text }: MessageActionProps): React.ReactNode {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      onClick={async () => {
        // r134：改走统一原语（此前抛错会从 onClick 冒出去成 unhandled rejection）
        if (!(await copyToClipboard(text))) return;
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

export function RewindAction({ message, text }: MessageActionProps): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  if (message.role !== "user" || !message.id) return null;
  return (
    <button
      onClick={() => ctx.events.emit("timeline:rewindRequested", { message, text })}
      title={t("shell.rewind")}
      className={STYLE}
    >
      <Undo2 className="size-3.5" />
      {t("shell.rewind")}
    </button>
  );
}
