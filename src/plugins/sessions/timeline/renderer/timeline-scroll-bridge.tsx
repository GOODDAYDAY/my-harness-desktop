import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";

export function JumpToBottomButton({
  onClick,
}: {
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
    </button>
  );
}
