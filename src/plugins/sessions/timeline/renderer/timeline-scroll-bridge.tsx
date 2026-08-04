import { useState, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";

export function useScrollBridge() {
  const [unreadCount, setUnreadCount] = useState(0);

  const notifyUnread = useCallback((count = 1) => {
    setUnreadCount((c) => c + count);
  }, []);

  const clearUnread = useCallback(() => {
    setUnreadCount(0);
  }, []);

  return { unreadCount, notifyUnread, clearUnread };
}

export function JumpToBottomButton({
  unreadCount,
  onClick,
}: {
  unreadCount: number;
  onClick: () => void;
}): ReactNode {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[length:var(--font-size-sm)] text-[var(--color-fg)] border border-[var(--color-border)] pointer-events-auto"
      style={{ background: "var(--color-surface)", boxShadow: "var(--shadow-md)" }}
    >
      <ChevronDown className="size-3.5" />
      {t("shell.scrollToBottom")}
      {unreadCount > 0 && (
        <span className="ml-1 px-1.5 py-0.5 rounded-full text-[length:var(--font-size-xs)] bg-[var(--color-primary)] text-[var(--color-primary-fg)]">
          {unreadCount}
        </span>
      )}
    </button>
  );
}
