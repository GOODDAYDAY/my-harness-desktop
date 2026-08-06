import { RotateCcw, Hourglass } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { QueuedMessage } from "@pi-desktop/react";

export interface QueueBasketProps {
  items: QueuedMessage[];
  /** 可见条数(36px/条限高),复用评论篮的通用配置。 */
  visibleCount: number;
  onEdit: (item: QueuedMessage) => void;
  onRemove: (id: string) => void;
  onRetry: () => void;
  onClearAll: () => void;
}

export function QueueBasket({ items, visibleCount, onEdit, onRemove, onRetry, onClearAll }: QueueBasketProps): React.ReactNode {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  const hasFailed = items.some((q) => q.failed);

  return (
    <div className="px-4 pt-2 pb-1 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 px-1 text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
        <Hourglass className="size-3" />
        <span>{t("timeline.queue.title", { count: items.length })}</span>
        <span className="opacity-60">·</span>
        <span className="opacity-80">{t("timeline.queue.hint")}</span>
      </div>
      <div className="flex flex-col gap-1 overflow-y-auto" style={{ maxHeight: `${visibleCount * 36}px` }}>
        {items.map((item, i) => (
          <div key={item.id}>
            <div
              className={`flex items-center gap-2 rounded-[var(--radius-sm)] border bg-[var(--color-surface)] px-2.5 py-1.5 text-[length:var(--font-size-sm)] ${
                item.failed ? "border-[var(--color-accent-error)]" : "border-[var(--color-border)]"
              }`}
            >
              <span
                className={`font-semibold flex-none ${
                  item.failed ? "text-[var(--color-accent-error)]" : "text-[var(--color-accent-warning)]"
                }`}
              >
                {i + 1}
              </span>
              <span
                className="text-[var(--color-fg)] truncate flex-1 min-w-0 cursor-pointer hover:text-[var(--color-accent-warning)]"
                title={t("timeline.queue.editHint")}
                onClick={() => onEdit(item)}
              >
                {item.displayText ?? item.text}
              </span>
              <button
                className="size-5 flex items-center justify-center flex-none rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-accent-error)] hover:bg-[var(--color-bg)] text-xs cursor-pointer"
                title={t("timeline.queue.cancel")}
                onClick={() => onRemove(item.id)}
              >✕</button>
            </div>
            {item.failed && i === 0 && (
              <div className="mt-1 mx-1 flex items-center gap-2 text-[length:var(--font-size-xs)] text-[var(--color-accent-error)]">
                <span className="flex-1 min-w-0 truncate">{t("timeline.queue.failed", { error: item.errMsg ?? "" })}</span>
                <button
                  className="flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-sm)] border border-[var(--color-accent-error)] bg-transparent text-[var(--color-accent-error)] hover:bg-[var(--color-surface)] cursor-pointer flex-none"
                  onClick={onRetry}
                >
                  <RotateCcw className="size-3" />
                  {t("timeline.queue.retry")}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <button
        className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] hover:text-[var(--color-accent-error)] self-end cursor-pointer"
        onClick={onClearAll}
      >{t("timeline.queue.clearAll")}</button>
      {hasFailed && items.length > 1 && (
        <div className="px-1 text-[length:var(--font-size-xs)] text-[var(--color-muted)] opacity-70">
          {t("timeline.queue.pausedHint")}
        </div>
      )}
    </div>
  );
}
