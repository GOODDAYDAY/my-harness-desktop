// Section —— 左栏分组折叠容器(自管 state + CSS grid 高度动画)。
//
// 契约:分组头(标题 + 可选计数 + 右侧动作区)+ 折叠内容;默认展开。
// 左栏 sidebar 槽的分组组件用它做外壳,样式全走 token。
//
// 不用 Radix Collapsible.Content:它闭合时给 hidden + 不渲染 children,
// 高度动画(grid 0fr↔1fr)跑不起来。改为自管 open + data-state 容器,
// 内容常驻 DOM,动画由 index.css 的 .pi-collapsible[data-state] 统一驱动
// (全局一处,所有分组白拿)。
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export interface SectionProps {
  /** 分组标题(如 "会话"/"项目")。 */
  title: string;
  /** 右侧动作区(如 "+" 按钮),折叠状态也常驻。 */
  actions?: ReactNode;
  /** 初始是否展开,默认 true。 */
  defaultOpen?: boolean;
  children?: ReactNode;
}

export function Section({ title, actions, defaultOpen = true, children }: SectionProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col min-h-0 shrink-0">
      <div
        className="flex items-center gap-1 px-2 select-none shrink-0 whitespace-nowrap"
        style={{ paddingTop: "var(--sidebar-section-pt)", paddingBottom: "var(--sidebar-section-pb)" }}
      >
        <button
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 hover:text-[var(--color-fg)] cursor-pointer bg-transparent border-none p-0 font-[var(--font-family-sans)]"
          style={{ outline: "none", fontSize: "var(--sidebar-section-fs)", color: "var(--color-muted)" }}
        >
          <span style={{ display: "var(--sidebar-arrow-display)" }}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </span>
          <span>{title}</span>
        </button>
        {actions != null && <span className="ml-auto flex items-center">{actions}</span>}
      </div>
      <div className="pi-collapsible" data-state={open ? "open" : "closed"}>
        <div className="flex flex-col min-h-0">
          {children}
        </div>
      </div>
    </div>
  );
}
