// Section —— 左栏分组折叠容器(自管 state + CSS grid 高度动画)。
//
// 契约:分组头(标题 + 可选计数 + 右侧动作区)+ 折叠内容;默认展开。
// 左栏 sidebar 槽的分组组件用它做外壳,样式全走 token。
//
// 不用 Radix Collapsible.Content:它闭合时给 hidden + 不渲染 children,
// 高度动画(grid 0fr↔1fr)跑不起来。改为自管 open + data-state 容器,
// 内容常驻 DOM,动画由 index.css 的 .shell-collapsible[data-state] 统一驱动
// (全局一处,所有分组白拿)。
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export interface SectionProps {
  title: string;
  actions?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  collapsedSuffix?: ReactNode;
  collapsedSubtitle?: ReactNode;
  children?: ReactNode;
}

export function Section({ title, actions, defaultOpen = true, open: controlledOpen, onOpenChange, collapsedSuffix, collapsedSubtitle, children }: SectionProps): ReactNode {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const toggle = (): void => {
    const next = !open;
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };
  return (
    // 两个声明式锚点(壳消费,不是样式契约):
    //   data-section-collapsed —— 收起态。左栏壳据此把"整组都收起"的分隔面板塌到折叠头高度,
    //     把腾出的高度让给后面的组(旧版同处一个 Panel 时由 flex 自动让位,分家后要靠这个信号)。
    //   data-section-header    —— 折叠头元素。壳量它的高度作为塌缩目标高度(展开态也能量,
    //     不必等收起动画落定)。
    <div className="flex flex-col min-h-0 shrink-0" data-section-collapsed={open ? undefined : "true"}>
      {/* 头部:整行可点——button flex-1 撑满到右侧 actions 为止,点击行内空白也折叠 */}
      <div className="flex items-center select-none shrink-0 whitespace-nowrap" data-section-header="">
        <button
          aria-expanded={open}
          onClick={toggle}
          className="flex flex-1 min-w-0 items-center gap-1 hover:text-[var(--color-fg)] cursor-pointer bg-transparent border-none font-[var(--font-family-sans)] text-left"
          style={{ outline: "none", fontSize: "var(--sidebar-section-fs)", color: "var(--color-muted)", paddingLeft: "8px", paddingRight: "4px", paddingTop: "var(--sidebar-section-pt)", paddingBottom: "var(--sidebar-section-pb)" }}
        >
          <span style={{ display: "var(--sidebar-arrow-display)" }}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </span>
          <span>{title}</span>
        </button>
        {!open && collapsedSuffix != null && collapsedSuffix}
        {actions != null && <span className="ml-auto flex items-center pr-2">{actions}</span>}
      </div>
      {!open && collapsedSubtitle != null && (
        <div
          className="pb-1.5 truncate select-none"
          style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", paddingLeft: "20px" }}
        >
          {collapsedSubtitle}
        </div>
      )}
      <div className="shell-collapsible" data-state={open ? "open" : "closed"}>
        <div className="flex flex-col min-h-0">
          {children}
        </div>
      </div>
    </div>
  );
}
