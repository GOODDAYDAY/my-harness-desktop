// comments-only-bubble.tsx —— 纯评论消息的用户气泡占位(blockRenderers 槽 userIntent)。
//
// 用户发了纯评论消息(正文留空):消息行需要一个真实用户气泡给"这是一条用户消息"
// 的锚点——引用条不再悬空。内容为轻量占位文案(design docs/design/aux-block-mechanism.md
// §8 关联),视觉与 UserBubble 同形态(右对齐、surface 底、圆角、细投影)。
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquarePlus } from "lucide-react";

export function CommentsOnlyBubble(): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end">
      <div
        className="flex items-center gap-1.5 max-w-[65%] rounded-[var(--radius-md)] px-4 py-2.5 text-[length:var(--font-size-base)] leading-7 text-[var(--color-fg)] whitespace-pre-wrap break-words"
        style={{ background: "var(--color-surface)", boxShadow: "0 1px 3px rgba(0,0,0,.12)" }}
      >
        <MessageSquarePlus className="size-4 flex-none text-[var(--color-muted)]" />
        <span>{t("shell.commentsOnly")}</span>
      </div>
    </div>
  );
}
