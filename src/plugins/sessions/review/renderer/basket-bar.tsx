import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePluginContext, type ComposerAttachmentProps } from "@my-harness-desktop/react";
import { useReviewBasketStore } from "./review-basket-store";
export function ReviewBasketBar({ payload }: ComposerAttachmentProps): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const removeComment = useReviewBasketStore((s) => s.removeComment);
  const clearBasket = useReviewBasketStore((s) => s.clearBasket);
  const updateComment = useReviewBasketStore((s) => s.updateComment);
  // 就地编辑态(点击条目展开):与选区浮层编辑器互斥——浮层编辑器打开时(editorActive)
  // 本组件不展开内联编辑;点击条目在篮子内就地编辑(位置从消息行迁到篮子,设计 §5.2)。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const items = payload.items ?? [];
  // 篮子限高(36px/条):reviewBasketVisibleCount 配置迁移前先定值(配置归位 review 自读,演进)。
  const basketVisibleCount = 5;

  // payload 更新(篮子变化重发)时收掉编辑态,避免编辑框指向已消失的条目。
  useEffect(() => {
    if (editingId && !items.some((i) => i.id === editingId)) setEditingId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  if (items.length === 0) return null;

  return (
    <div className="px-4 pt-2 pb-1 flex flex-col gap-1 overflow-y-auto" style={{ maxHeight: `${basketVisibleCount * 36}px` }}>
      {items.map((item) => (
        <div key={item.id} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[length:var(--font-size-sm)]">
          <span className="text-[var(--color-accent)] font-semibold flex-none">{item.seq}</span>
          <span
            className="text-[var(--color-muted)] italic truncate max-w-[45%] hover:text-[var(--color-fg)]"
            style={item.messageId ? { cursor: "pointer" } : undefined}
            onClick={item.messageId ? () => { try { ctx.events.invoke("timeline:scrollTo", { messageId: item.messageId! }); } catch { /* timeline 不在场 */ } } : undefined}
          >❝{item.quotePreview}</span>
          <span className="text-[var(--color-muted)] flex-none">→</span>
          {editingId === item.id ? (
            <textarea
              autoFocus
              className="flex-1 min-w-0 bg-transparent text-[var(--color-fg)] text-[length:var(--font-size-sm)] resize-none outline-none border-none"
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                const comment = draft.trim();
                if (comment) updateComment(payload.sessionKey, item.id, comment);
                setEditingId(null);
              }}
              onKeyDown={(e) => {
                // IME 拼音输入中按 Enter 确认候选词(isComposing)不触发提交——
                // 与 timeline composer / 浮层编辑器既有检查一致(缺检查时拼音没打完就被提交)。
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  const comment = draft.trim();
                  if (comment) updateComment(payload.sessionKey, item.id, comment);
                  setEditingId(null);
                }
                if (e.key === "Escape") setEditingId(null);
              }}
            />
          ) : (
            <span
              className="text-[var(--color-fg)] truncate flex-1 min-w-0 cursor-text"
              onClick={() => {
                // 就地编辑(滚到原文保留:点击引号区已可滚)
                setDraft(item.comment);
                setEditingId(item.id);
              }}
            >{item.comment}</span>
          )}
          <button
            className="size-5 flex items-center justify-center flex-none rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-accent-error)] hover:bg-[var(--color-bg)] text-xs cursor-pointer"
            onClick={() => removeComment(payload.sessionKey, item.id)}
          >✕</button>
        </div>
      ))}
      <button
        className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] hover:text-[var(--color-accent-error)] self-end cursor-pointer"
        onClick={() => clearBasket(payload.sessionKey)}
      >{t("shell.clearAll")}</button>
    </div>
  );
}
