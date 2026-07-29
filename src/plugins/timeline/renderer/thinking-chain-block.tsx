import { useState, useEffect, useRef, type ReactNode } from "react";
import { ChevronRight, ChevronDown, Brain } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StreamTextReveal, useStalledHint } from "./stream-text-reveal";

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
  thinkingSignature?: string;
}

export interface ThinkingChainBlockProps {
  content: ThinkingContent;
  streaming: boolean;
  startedAt?: number;
  completedAt?: number;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m${rest}s`;
}

export function ThinkingChainBlock({
  content,
  streaming,
  startedAt,
  completedAt,
}: ThinkingChainBlockProps): ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(streaming);
  const stalled = useStalledHint(streaming, content.thinking.length);
  const [elapsed, setElapsed] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (streaming && startedAt) {
      setOpen(true);
      timerRef.current = setInterval(() => {
        setElapsed(formatDuration(Date.now() - startedAt));
      }, 100);
    }
    if (!streaming) {
      if (timerRef.current) clearInterval(timerRef.current);
      if (startedAt && completedAt) {
        setElapsed(formatDuration(completedAt - startedAt));
      }
      setOpen(false);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [streaming, startedAt, completedAt]);

  if (content.redacted) {
    return (
      <div className="mb-1">
        <button
          className="flex items-center gap-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)] bg-transparent border-none cursor-pointer p-0"
        >
          <Brain className="size-3.5" />
          {t("shell.thinkingFiltered")}
        </button>
      </div>
    );
  }

  const label = streaming
    ? stalled
      ? t("shell.thinkingStalled")
      : t("shell.thinkingInProgress")
    : elapsed
      ? t("shell.thinkingDone", { duration: elapsed })
      : t("shell.thinkingProcess");

  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer p-0"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <Brain className="size-3.5" />
        {label}
      </button>
      {open && (
        <div className="mt-1 pl-4 border-l-2 border-[var(--color-border)] text-[length:var(--font-size-sm)] leading-6 text-[var(--color-muted)] whitespace-pre-wrap">
          <StreamTextReveal text={content.thinking} streaming={streaming} />
        </div>
      )}
    </div>
  );
}
