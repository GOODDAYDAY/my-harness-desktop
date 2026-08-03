// EmptyState —— 面板空态(图标 + 主文案 + 可选副文案),右面板页签/空列表共用。
import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
}

export function EmptyState({ icon, title, description }: EmptyStateProps): ReactNode {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 py-10 text-[var(--color-muted)]">
      {icon != null && <div className="opacity-60">{icon}</div>}
      <div className="text-[length:var(--font-size-sm)]">{title}</div>
      {description != null && <div className="text-[length:var(--font-size-sm)] opacity-70">{description}</div>}
    </div>
  );
}
