// Section —— 左栏分组折叠容器(Radix Collapsible)。
//
// 契约:分组头(标题 + 可选计数 + 右侧动作区)+ 折叠内容;默认展开。
// 左栏 sidebar 槽的分组组件用它做外壳,样式全走 token。
import { useState, type ReactNode } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";

export interface SectionProps {
  /** 分组标题(如 "对话"/"项目")。 */
  title: string;
  /** 标题右侧计数(如会话数);不传不显示。 */
  count?: number;
  /** 右侧动作区(如 "+" 按钮),折叠状态也常驻。 */
  actions?: ReactNode;
  /** 初始是否展开,默认 true。 */
  defaultOpen?: boolean;
  children?: ReactNode;
}

export function Section({ title, count, actions, defaultOpen = true, children }: SectionProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="flex flex-col min-h-0 shrink-0">
      <div className="flex items-center gap-1 px-2 py-1 select-none shrink-0">
        <Collapsible.Trigger asChild>
          <button
            className="flex items-center gap-1 text-[var(--font-size-sm)] text-[var(--color-muted)] hover:text-[var(--color-fg)] cursor-pointer bg-transparent border-none p-0 font-[var(--font-family-sans)]"
            style={{ outline: "none" }}
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            <span>{title}</span>
            {count !== undefined && <span>{count}</span>}
          </button>
        </Collapsible.Trigger>
        {actions != null && <span className="ml-auto flex items-center">{actions}</span>}
      </div>
      <Collapsible.Content className="flex flex-col min-h-0">
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
