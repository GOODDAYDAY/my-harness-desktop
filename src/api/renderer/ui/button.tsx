// pi.ui Button —— 最小 shadcn 风格组件,消费主题 token 的 CSS 变量。
//
// 依据 docs/structure/17 §1.3.1(pi.ui 在 shell/renderer/ui/,底层 Radix + lucide)、
// docs/plugins/06-plugin-theme.md(组件不内嵌颜色常量,从 token 取值)。
// 这是 shell 细节:组件代码归项目管(复制进 src/),圆心不感知。
import { cva, type VariantProps } from "class-variance-authority";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** cn: clsx + tailwind-merge,合并 className 并解决 Tailwind 冲突。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const buttonVariants = cva(
  // 基础:从主题 token 取圆角/字号/边框宽度/过渡,不硬编码颜色
  // disabled 态走主题 token(--color-disabled/-fg),不再 opacity 压色——
  // 与 packages/react Button 控件同一视觉契约(单一来源:domain theme-tokens)。
  // pointer-events-none 保在前面:禁用后 hover: 变体不应再命中。
  "inline-flex items-center justify-center gap-[var(--spacing-xs)] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-[var(--color-disabled)] disabled:text-[var(--color-disabled-fg)] disabled:border-[var(--color-border)]",
  {
    variants: {
      variant: {
        // primary:背景用 color.primary、前景用 color.primary-fg
        primary:
          "bg-[var(--color-primary)] text-[var(--color-primary-fg)] hover:opacity-90",
        // ghost:透明底,hover 用 surface
        ghost:
          "bg-transparent text-[var(--color-fg)] hover:bg-[var(--color-surface)]",
        // outline:边框用 color.border
        outline:
          "border border-[var(--color-border)] border-[length:var(--border-width-thin)] bg-transparent text-[var(--color-fg)] hover:bg-[var(--color-surface)]",
      },
      size: {
        sm: "h-8 px-[var(--spacing-sm)] text-[var(--font-size-sm)] rounded-[var(--radius-sm)]",
        md: "h-9 px-[var(--spacing-md)] text-[var(--font-size-base)] rounded-[var(--radius-sm)]",
        lg: "h-10 px-[var(--spacing-lg)] text-[var(--font-size-lg)] rounded-[var(--radius-md)]",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps): React.ReactNode {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
