// GoalRoundCard —— goal 续跑提示(<goal_round> 包装的用户消息)的呈现卡。
//
// 设计语义(所见即所得,用户要求 #5):续跑提示是 desktop 自驱动的机器消息,不是用户手写
// 内容——不冒充用户气泡,渲染成一张「目标续跑卡」:🎯 + 第 N/M 轮 + 目标摘要,点击展开
// 看包装原文(用户有权看到模型实际收到了什么,但默认不占视觉)。
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Target, ChevronRight, ChevronDown } from "lucide-react";
import type { AuxBlock } from "@my-harness-desktop/shared";
import type { GoalRoundData } from "./goal-round-parser";

export function GoalRoundCard({ aux }: { aux: AuxBlock }): ReactNode {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const data = aux.data as GoalRoundData;
  const roundText = data.round !== null && data.maxRounds !== null
    ? t("goal.roundCard.roundOf", { round: data.round, max: data.maxRounds })
    : null;
  return (
    <div className="flex justify-center my-1" data-goal-round-card>
      <div
        className="max-w-[85%] rounded-[var(--radius-md)] border px-3 py-1.5 text-[length:var(--font-size-xs)]"
        style={{
          borderColor: "var(--color-border)",
          background: "color-mix(in srgb, var(--color-surface) 55%, transparent)",
          borderLeft: "3px solid var(--color-accent-success)",
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex items-center gap-1.5 w-full text-left bg-transparent border-none cursor-pointer p-0"
          title={t("goal.roundCard.toggle")}
        >
          <Target className="size-3.5 shrink-0" style={{ color: "var(--color-accent-success)" }} />
          <span className="text-[var(--color-muted)]">{t("goal.roundCard.title")}</span>
          {roundText && (
            <span className="tabular-nums text-[var(--color-muted)]">{roundText}</span>
          )}
          {data.objective && (
            <span className="min-w-0 truncate text-[var(--color-fg)]">{data.objective}</span>
          )}
          <span className="text-[var(--color-muted)] shrink-0">
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </span>
        </button>
        {expanded && (
          <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-[var(--color-bg)] p-2 text-[var(--color-muted)]">
            {data.raw}
          </pre>
        )}
      </div>
    </div>
  );
}
