// 会话栏行图标(设计 docs/design/session-working-phase.md §2.3):按 WorkingPhase 切换形态与颜色。
// 运行中态(thinking/toolExecuting)= 明暗交替(animate-pulse,透明度呼吸)说明「在执行」(§目标 15);
// 其余忙碌态(requesting/outputting/retrying/compacting)= 转圈(animate-spin)。
// 颜色映射与 timeline 底部指示同语义:请求=灰/思考=蓝紫/工具=绿/输出=蓝/重试=红/压缩=灰。
// 渲染层内容,主题 token 是查询契约,不新增 token。
import { Brain, Wrench, LoaderCircle } from "lucide-react";
import type { WorkingPhase } from "@my-harness-desktop/shared";

const PHASE_COLOR: Record<string, string> = {
  requesting: "var(--color-muted)",
  thinking: "color-mix(in srgb, var(--color-primary) 65%, var(--color-muted) 35%)",
  toolExecuting: "var(--color-accent-success)",
  outputting: "var(--color-primary)",
  retrying: "var(--color-accent-error)",
  compacting: "var(--color-muted)",
};

/** 会话栏行图标:按 WorkingPhase 切换形态。运行中态(思考/工具执行)= 明暗交替,其余忙碌态=转圈。 */
export function PhaseIcon({ phase }: { phase: WorkingPhase }): React.ReactNode {
  const color = PHASE_COLOR[phase] ?? "var(--color-primary)";
  const common = { width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)", color } as const;
  if (phase === "thinking") return <Brain className="animate-pulse" style={common} />;
  if (phase === "toolExecuting") return <Wrench className="animate-pulse" style={common} />;
  return <LoaderCircle className="animate-spin" style={common} />;
}
