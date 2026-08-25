import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Bookmark, Undo2, GitFork } from "lucide-react";
import { usePluginContext, useUiStore, useSessionStore, useArmConfirm, type MessageActionProps } from "@my-harness-desktop/react";

const STYLE = "flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer";
const ARMED_STYLE = "flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-accent-error)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer";

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
  const [done, setDone] = useState(false);
  if (message.role !== "assistant" || !message.id || !currentSessionPath) return null;
  const entryId = message.id;
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 30) || "(empty)";

  // 一击收藏:不再原位输入——立即以默认 label 创建,右面板揭示收藏 tab 并原位改标题。
  // invoke 而非 emit:收藏 tab 未挂载时请求入队,面板揭示后挂载冲刷恰好一次投递,
  // 根因修复旧路径 emit 对零订阅者静默丢失(keep-alive 注释名不副实,tab 关掉组件即卸载)。
  return (
    <button
      onClick={() => {
        ctx.events.invoke("timeline:bookmarkRequested", {
          sessionPath: currentSessionPath,
          entryId,
          preview,
          label: sessionName ?? preview,
        });
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      title={done ? t("shell.bookmarked") : t("shell.bookmark")}
      className={STYLE}
    >
      {done ? <Check className="size-3.5" /> : <Bookmark className="size-3.5" />}
      {done ? t("shell.bookmarked") : t("shell.bookmark")}
    </button>
  );
}

export function ForkAction({ message }: MessageActionProps): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const { currentCwd, currentSessionPath } = useUiStore();
  const { streaming } = useSessionStore();
  const [toast, setToast] = useState<string | null>(null);
  const { armed, arm, disarm } = useArmConfirm();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  // 分叉 = 从这条 assistant 回答后开新分支。走 forkFromSession 原子用例:它内部自己
  // start 起进程,打开历史会话(纯文件读、pi 未活)也能直接分叉——与收藏 fork 同一条路径。
  const handleFork = useCallback(async (): Promise<void> => {
    if (streaming) {
      setToast(t("shell.forkStreamingBlocked"));
      return;
    }
    if (!message.id || !currentCwd || !currentSessionPath) return;
    try {
      await ctx.pi.forkFromSession(currentCwd, currentSessionPath, message.id, "at");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const m = /Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/.exec(msg);
      setToast(t("shell.forkFailed", { error: m?.[1] ?? msg }));
    }
  }, [ctx, t, streaming, message.id, currentCwd, currentSessionPath]);

  if (!message.id || message.role !== "assistant" || !currentSessionPath) return null;

  return (
    <>
      <button
        onClick={() => {
          if (armed) { disarm(); void handleFork(); return; }
          arm(true);
        }}
        title={armed ? t("shell.forkArmed") : t("shell.fork")}
        className={armed ? ARMED_STYLE : STYLE}
      >
        <GitFork className="size-3.5" />
        {armed ? t("shell.forkArmed") : t("shell.fork")}
      </button>
      {toast && <span className="text-xs text-[var(--color-accent-error)]">{toast}</span>}
    </>
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
