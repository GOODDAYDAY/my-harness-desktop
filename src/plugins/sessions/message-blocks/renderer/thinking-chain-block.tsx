import { useState, useEffect, useRef, type ReactNode } from "react";
import { ChevronRight, ChevronDown, Brain } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type ThinkingContent } from "@my-harness-desktop/react";
import { StreamTextReveal, useStalledHint } from "./stream-text-reveal";

export type { ThinkingContent };

export interface ThinkingChainBlockProps {
  content: ThinkingContent;
  streaming: boolean;
  startedAt?: number;
  completedAt?: number;
  /** 非流式时默认折叠(true)还是展开(false);由 general.json timelineCollapseDefault 驱动。 */
  collapseDefault?: boolean;
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
  collapseDefault = true,
}: ThinkingChainBlockProps): ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!collapseDefault);
  // 流式中强制展开:思考过程要「一点一点可见」(用户诉求),不能藏在折叠头后只露计时;
  // 流式结束回落折叠默认(设置项驱动)。用户流式中手动收起尊重其选择(仅流转时重置)。
  useEffect(() => { if (streaming) setOpen(true); else setOpen(!collapseDefault); }, [collapseDefault, streaming]);
  const stalled = useStalledHint(streaming, content.thinking.length);
  const [elapsed, setElapsed] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (streaming && startedAt) {
      timerRef.current = setInterval(() => {
        setElapsed(formatDuration(Date.now() - startedAt));
      }, 100);
    }
    if (!streaming) {
      if (timerRef.current) clearInterval(timerRef.current);
      if (startedAt && completedAt) {
        setElapsed(formatDuration(completedAt - startedAt));
      }
      // 折叠态收口在上方流式翻转 effect(单源),此处只管计时收尾。
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

  // 流式期也要露出计时(用户诉求「看到计时在增长」):elapsed 由 100ms 心跳实时刷新,
  // 拼在「思考中…/思考时间较长…」之后;非流式仍走「思考已完成({{duration}})」单源。
  const label = streaming
    ? (stalled ? t("shell.thinkingStalled") : t("shell.thinkingInProgress"))
      + (elapsed ? ` ${elapsed}` : "")
    : elapsed
      ? t("shell.thinkingDone", { duration: elapsed })
      : t("shell.thinkingProcess");

  // 空思考定稿的显式降级(不静默):供应商只回了空 thinking 帧时(实测:anthropic-messages
  // 网关的 reasoning 模型,content_block_start 后无 thinking_delta,pi 落盘 thinking:""),
  // 块里没有任何正文——此时渲染「可点击展开器」等于假装点开有东西(实测观感 = 点击没用、
  // 不展开、点开也看不到)。非流式 + 空正文 → 静态提示(保留时长信息),无 chevron、不可点;
  // 流式期不受影响(正文可能还在路上),有正文的块照旧点击展开全文(无任何截断)。
  if (!streaming && content.thinking.trim().length === 0) {
    return (
      <div className="mb-1 flex items-center gap-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)]">
        <Brain className="size-3.5" />
        {label} · {t("shell.thinkingEmpty")}
      </div>
    );
  }

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
