import { useState, useCallback, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

export type ScrollMode = "autoFollow" | "manualScroll";

export const DEFAULT_LIVE_TAIL_MAX = 32;
const PREPEND_THRESHOLD = 4;
const BOTTOM_THRESHOLD = 4;

const DEFAULT_ROW_HEIGHTS: Record<string, number> = {
  "user-message": 80,
  "assistant-message": 160,
  "tool-call": 56,
  compaction: 28,
  error: 40,
  slash: 32,
};

export interface TimelineScrollItem {
  type: string;
  id: string;
}

export function estimateRenderCount(viewportHeight: number, items: TimelineScrollItem[]): number {
  if (items.length === 0) return 0;
  const typeCount: Record<string, number> = {};
  for (const it of items) typeCount[it.type] = (typeCount[it.type] ?? 0) + 1;
  let weightedSum = 0;
  for (const [t, c] of Object.entries(typeCount)) {
    weightedSum += (DEFAULT_ROW_HEIGHTS[t] ?? 80) * c;
  }
  const avg = weightedSum / items.length;
  return Math.max(20, Math.ceil((viewportHeight / avg) * 1.5));
}

export function sliceHistoryForViewport<T>(history: T[], renderCount: number): T[] {
  if (history.length <= renderCount) return history;
  return history.slice(history.length - renderCount);
}

export interface TimelineRenderSegment<T> {
  kind: "history" | "liveHead";
  items: T[];
}

export function splitTimelineRenderSegments<T extends TimelineScrollItem>(
  items: T[],
  liveTailMax = DEFAULT_LIVE_TAIL_MAX,
): TimelineRenderSegment<T>[] {
  if (items.length <= liveTailMax) {
    return [{ kind: "liveHead", items }];
  }
  const splitIdx = items.length - liveTailMax;
  return [
    { kind: "history", items: items.slice(0, splitIdx) },
    { kind: "liveHead", items: items.slice(splitIdx) },
  ];
}

export function useScrollBridge() {
  const [mode, setMode] = useState<ScrollMode>("autoFollow");
  const [unreadCount, setUnreadCount] = useState(0);
  const lastScrollTopRef = useRef(0);
  const isProgrammaticRef = useRef(false);

  const onUserScroll = useCallback((scrollTop: number, scrollHeight: number, clientHeight: number) => {
    if (isProgrammaticRef.current) {
      isProgrammaticRef.current = false;
      lastScrollTopRef.current = scrollTop;
      return;
    }
    const delta = scrollTop - lastScrollTopRef.current;
    const distFromBottom = scrollHeight - scrollTop - clientHeight;
    if (distFromBottom <= BOTTOM_THRESHOLD) {
      setMode("autoFollow");
      setUnreadCount(0);
    } else if (delta < 0 && mode === "autoFollow") {
      setMode("manualScroll");
    }
    lastScrollTopRef.current = scrollTop;
  }, [mode]);

  const onNewItem = useCallback((count = 1) => {
    if (mode === "manualScroll") {
      setUnreadCount((c) => c + count);
    }
  }, [mode]);

  const scrollToBottom = useCallback(() => {
    isProgrammaticRef.current = true;
    setMode("autoFollow");
    setUnreadCount(0);
  }, []);

  const onPrepend = useCallback(() => {
    isProgrammaticRef.current = true;
  }, []);

  return { mode, unreadCount, onUserScroll, onNewItem, scrollToBottom, onPrepend };
}

export function JumpToBottomButton({
  unreadCount,
  onClick,
}: {
  unreadCount: number;
  onClick: () => void;
}): ReactNode {
  const { t } = useTranslation();
  if (unreadCount === 0) return null;
  return (
    <button
      onClick={onClick}
      className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] text-[var(--color-fg)] border border-[var(--color-border)]"
      style={{ background: "var(--color-surface)", boxShadow: "var(--shadow-md)" }}
    >
      <ChevronDown className="size-3.5" />
      {t("shell.scrollToBottom")}
      {unreadCount > 0 && (
        <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-[var(--color-primary)] text-[var(--color-primary-fg)]">
          {unreadCount}
        </span>
      )}
    </button>
  );
}

export interface ProgressTrackProps {
  visible: boolean;
  status: "idle" | "running" | "failed";
  completedTurns: number;
  estimatedTotalTurns: number;
}

export function ProgressTrack({ visible, status, completedTurns, estimatedTotalTurns }: ProgressTrackProps): ReactNode {
  if (!visible) return null;
  const pct = estimatedTotalTurns > 0 ? Math.min(100, (completedTurns / estimatedTotalTurns) * 100) : 0;
  const color = status === "failed" ? "var(--color-accent-error)" : status === "running" ? "var(--color-primary)" : "var(--color-muted)";
  return (
    <div className="flex items-center gap-2 px-4 py-1 border-b border-[var(--color-border)] text-[length:var(--font-size-sm)]">
      <div className="flex-1 h-1 rounded-full bg-[var(--color-border)] overflow-hidden">
        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[var(--color-muted)] tabular-nums">{completedTurns}/{estimatedTotalTurns}</span>
    </div>
  );
}
