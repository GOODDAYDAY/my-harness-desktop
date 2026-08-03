// pi.ui ChatRow —— OpenWebUI 式会话行(无默认边框,hover 高亮,选中 surface)。
//
// 对照 open-webui #sidebar-chat-item:不靠 border 区分,靠 hover/active 的 surface 背景。
// 比 ListItem 更软:默认透明无边框,圆角 2xl(> ListItem 的 md)。
// 用于 sidebar 会话列表;settings-page 左列表仍用 ListItem(内联 borderRadius,e2e 依赖)。
//
// 这是 shell 组件,token 经 CSS 变量消费,复用 button.tsx 的 cn。
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./button";

const chatRowVariants = cva(
  "flex items-center gap-2 px-2.5 py-2 rounded-2xl cursor-pointer transition-colors text-[length:var(--font-size-base)] font-[var(--font-family-sans)] select-none w-full",
  {
    variants: {
      active: {
        true: "bg-[var(--color-surface)] text-[var(--color-fg)]",
        false:
          "text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]",
      },
    },
    defaultVariants: { active: false },
  }
);

export interface ChatRowProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onClick">,
    VariantProps<typeof chatRowVariants> {
  /** 选中态。 */
  active?: boolean;
  /** 点击回调。 */
  onClick?: () => void;
  /** 左侧图标(可选)。 */
  icon?: React.ReactNode;
  /** 主文本(自动 truncate)。 */
  children?: React.ReactNode;
}

export function ChatRow({
  active,
  onClick,
  icon,
  children,
  className,
  ...rest
}: ChatRowProps): React.ReactNode {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      className={cn(chatRowVariants({ active }), className)}
      {...rest}
    >
      {icon != null && <span className="shrink-0 flex items-center">{icon}</span>}
      <span className="flex-1 min-w-0 truncate text-left">{children}</span>
    </div>
  );
}

export { chatRowVariants };
