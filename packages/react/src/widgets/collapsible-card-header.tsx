// 可折叠卡片头 —— 消息流里"一行可展开的摘要条"的**唯一**实现（r57 收敛）。
//
// ## 为什么要有这个组件
//
// 此前它有两份近乎相同的实现：message-blocks 的 `CardHeader`（工具卡）与 goal 插件的
// `GoalCard` 内联头（目标卡）。两份的容器样式、交互语义、布局骨架**逐字相同**：
//   `flex items-center gap-2 …font-mono…rounded-md` + `borderLeft: 3px solid <色>` +
//   `background: color-mix(…surface 30%…)` + `padding: 5px 12px`，
//   以及 role=button / tabIndex=0 / Enter·Space 键处理 / aria-expanded，
//   以及「图标 → 摘要 → 状态 → chevron」的四段布局。
//
// 重复实现的代价在 r52 被具体验证过：r41 给 `CardHeader` 补齐了 `aria-expanded`、
// 把硬编码英文 `running` 收进 i18n、把纯图标的成功/失败改成 sr-only 文本——
// 而 `GoalCard` 那一份**三个缺陷一个不少地都还在**，且不报错、不变红、没人提起。
// 这就是 §3.5「手写收敛」要治的东西：**修一处漏一处，而漏掉的那处是静默的**。
//
// ## 抽取边界：只抽"壳"，内容一律走插槽
//
// 差异全部落在**内容**上（图标是什么、状态怎么显示、右边还有没有额外槽），
// 所以组件只负责容器 + 交互语义 + 布局骨架，内容经 props 传入。
// ⚠ 刻意**不**加业务旗标（如 `isToolCard` / `variant: "tool" | "goal"`）——
//   那会把两个调用方的差异重新焊回共享层，等于把重复实现换成一个更难读的分叉组件。
//   唯一的布尔是 `livePulse`（流式呼吸条），它是**视觉机制**不是业务分支。

import { useTranslation } from "react-i18next";
import { Check, X, ChevronRight, ChevronDown } from "lucide-react";

/** 执行状态的三态。语义与文案对两类卡片是同一套（`shell.tool*` 键，四语言齐全）。 */
export type ExecStatus = "running" | "error" | "success";

/**
 * 执行状态块：图标是**视觉锚**（标 aria-hidden），语义由 sr-only 文本承担。
 *
 * 为什么不能只留图标：`<Check/>` / `<X/>` 没有可访问名，读屏用户对
 * "这一步成功还是失败"一无所知——而这恰恰是这类卡片最该被听到的一条信息（r41/r52）。
 * 为什么不能只留文本：图标是明眼人扫视列表时的快速锚点，去掉会降低可用性。
 * 所以两者并存：`aria-hidden` 的图标 + `sr-only` 的文本（与 r40 给会话行补状态文本同一套做法）。
 */
export function ExecutionStatus({ state, shimmer = true }: { state: ExecStatus; shimmer?: boolean }): React.ReactNode {
  const { t } = useTranslation();
  if (state === "running") {
    return (
      <span
        className="text-xs text-[var(--color-accent-success)]"
        data-exec-status="running"
        style={shimmer ? { animation: "shimmer 2s linear infinite" } : undefined}
      >
        {t("shell.toolRunning")}
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="text-xs text-[var(--color-accent-error)]" data-exec-status="error">
        <X aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{t("shell.toolFailed")}</span>
      </span>
    );
  }
  return (
    <span className="text-xs text-[var(--color-muted)]" data-exec-status="success">
      <Check aria-hidden="true" className="size-3.5" />
      <span className="sr-only">{t("shell.toolSucceeded")}</span>
    </span>
  );
}

export interface CollapsibleCardHeaderProps {
  /** 左侧 3px 色条的颜色（调用方按自己的语义算：错误/流式/类型…）。 */
  borderColor: string;
  /** 当前是否收起。 */
  collapsed: boolean;
  /** 切换收起/展开。 */
  onToggle: () => void;
  /** 是否有可展开的详情。false ⇒ 不画 chevron、不给 button 语义、不声明 aria-expanded。
   *  ⚠ 给一个点了不动的元素挂 `aria-expanded="false"` 是**错误承诺**：
   *  读屏用户会一直试着展开而什么都不会发生（r41 定的纪律）。 */
  expandable?: boolean;
  /** 图标（调用方自带 animate-pulse 等运行态表现）。 */
  icon?: React.ReactNode;
  /** 摘要文本（占满剩余宽度、单行截断）。 */
  summary: string;
  /** 状态区（通常是 `<ExecutionStatus …/>`）。 */
  status?: React.ReactNode;
  /** 状态区之后的额外内容槽（工具卡用它放路径/行数等）。 */
  trailing?: React.ReactNode;
  /** 流式呼吸条：左侧 2px 的明暗交替竖条（视觉机制，不是业务分支）。 */
  livePulse?: boolean;
}

/** 可折叠卡片头（容器 + 交互语义 + 四段布局；内容全部经插槽传入）。 */
export function CollapsibleCardHeader({
  borderColor,
  collapsed,
  onToggle,
  expandable = true,
  icon,
  summary,
  status,
  trailing,
  livePulse = false,
}: CollapsibleCardHeaderProps): React.ReactNode {
  return (
    <div
      className={`flex items-center gap-2 text-[length:var(--font-size-sm)] font-[var(--font-family-mono)] transition-colors rounded-[var(--radius-md)]${expandable ? " cursor-pointer" : ""}`}
      style={{
        borderLeft: `3px solid ${borderColor}`,
        background: "color-mix(in srgb, var(--color-surface) 30%, transparent)",
        padding: "5px 12px",
        position: "relative",
        overflow: "hidden",
      }}
      onClick={expandable ? onToggle : undefined}
      // ⚠ 三件套必须**成套**给或成套不给（r41）：只给 role 不给 tabIndex/键处理 = 读屏能发现
      //   但键盘到不了；只给 tabIndex 不给 role = 键盘能到但读屏不知道它是按钮。
      //   不可展开时三者全撤（它就是个静态标题，不是控件）。
      {...(expandable ? { role: "button", tabIndex: 0, "aria-expanded": !collapsed } : {})}
      onKeyDown={expandable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } } : undefined}
      data-collapsible-header=""
    >
      {livePulse && (
        <span
          aria-hidden
          style={{
            position: "absolute", left: 0, top: 0, bottom: 0, width: 2,
            background: "var(--color-accent-success)",
            animation: "tool-live-pulse 2.4s ease-in-out infinite",
          }}
        />
      )}
      {icon}
      <span className="text-[var(--color-fg)] flex-1 truncate">{summary}</span>
      {status}
      {trailing}
      {expandable && (
        <span className="text-[var(--color-muted)]" aria-hidden="true">
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
        </span>
      )}
    </div>
  );
}
