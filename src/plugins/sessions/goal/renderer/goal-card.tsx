// GoalCard —— set_goal / achieve_goal 两个工具调用块的时间线渲染件(blockRenderers 槽)。
// 非交互:只渲染 args/result。set_goal 展示 objective + max_rounds;achieve_goal 展示达成态。
// 状态机(圆心纯函数)与续跑引擎(本插件 goal-controller)都在插件侧,本卡片只做内容呈现。
import { useState, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Target } from "lucide-react";
import { CollapsibleCardHeader, ExecutionStatus } from "@my-harness-desktop/react";
import type { ToolCallBlock } from "@my-harness-desktop/react";

export function GoalCard({ toolCall, collapseDefault = true }: { toolCall: ToolCallBlock; collapseDefault?: boolean }): ReactNode {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(collapseDefault);
  useEffect(() => { setCollapsed(collapseDefault); }, [collapseDefault]);

  const isStreaming = toolCall.state === "pending" || toolCall.state === "running";
  const args = (toolCall.args ?? {}) as Record<string, unknown>;
  const isAchieve = toolCall.name === "achieve_goal";
  // ⚠ 此前写死中文「目标达成」（r53 修）。它能长期存在是因为中文守卫的三个探测器
  //   都覆盖不到这一形态：ATTR 只认五个属性、JSX_TEXT 只认裸文本节点、
  //   而 bare 走的 jsxTextOf() 会**先把所有 `{…}` 与字符串字面量剥掉**再判——
  //   中文在判定之前就被抹掉了。这是守卫的**机制性盲区**，已补第四个探测器 + 债务棘轮。
  const summary = isAchieve
    ? t("goal.roundCard.achieved")
    : (typeof args.objective === "string" && args.objective.trim() !== "" ? args.objective : toolCall.name);

  const borderColor = toolCall.isError
    ? "var(--color-accent-error)"
    : isStreaming
      ? "var(--color-accent-success)"
      : "var(--color-primary)";

  // r57 收敛：容器样式 / 交互三件套（role·tabIndex·Enter·Space）/ aria-expanded /
  // 四段布局（图标→摘要→状态→chevron）全部来自共享的 `CollapsibleCardHeader`。
  // 此前这里是**第二份**内联实现，与 message-blocks 的 `CardHeader` 逐字重复——
  // r41 修的三个缺陷（缺 aria-expanded、硬编码英文 running、纯图标状态无可访问名）
  // 在这一份里全都还在，直到 r52 才补上（§3.5 重复实现的代价：修一处漏一处，且静默）。
  // 本组件现在只保留**目标卡特有**的两件事：左边条颜色规则、以及图标与摘要的组装。
  const status = isStreaming ? "running" : toolCall.isError ? "error" : "success";
  return (
    <div className="mb-1.5">
      <CollapsibleCardHeader
        borderColor={borderColor}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        icon={<span className="text-[var(--color-muted)]"><Target className="size-3.5" /></span>}
        summary={summary}
        status={<ExecutionStatus state={status} />}
      />
      {!collapsed && !isAchieve && typeof args.objective === "string" && (
        <div className="mt-1 rounded-[var(--radius-md)] p-2.5 text-[length:var(--font-size-sm)] space-y-1"
          style={{ background: "color-mix(in srgb, var(--color-bg) 55%, var(--color-border))" }}>
          <div className="text-[var(--color-fg)] break-all">{args.objective}</div>
          {typeof args.max_rounds === "number" && (
            <div className="text-xs text-[var(--color-muted)]">max rounds: {args.max_rounds}</div>
          )}
        </div>
      )}
    </div>
  );
}
