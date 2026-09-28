import { Announce } from "@my-harness-desktop/react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { usePluginContext, useSessionStore, useUiStore, useArmConfirm, type MessageActionProps, type NeutralMessage } from "@my-harness-desktop/react";

const STYLE = "flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer";
const ARMED_STYLE = "flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-accent-error)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer";

export function RetryAction({ message }: MessageActionProps): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const { snapshot } = useSessionStore();
  // 分叉坐标用中立主键(§kernel-forkless §32:path 降级为投影线索,neutralSessionId 才是主键)。
  // 此前这里传 snapshot.state.sessionFile(pi 投影路径)当 parentLineageId——契约要 lineageId、
  // 调用方给路径,靠壳侧「锚点归属纠偏」兜住结果,但每次重试都打一条 warn 回落,
  // 且把「挂到活跃 lineage」这条已修过的根因重新变成一条活路径(纠偏的前置条件一变就退化)。
  // 另两个入口(timeline rewind / session-tree)传的就是 currentNeutralSessionId,此处对齐。
  const { currentNeutralSessionId } = useUiStore();
  const [toast, setToast] = useState<string | null>(null);
  const { armed, arm, disarm } = useArmConfirm();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleRetry = useCallback(async (): Promise<void> => {
    if (!message.id) return;
    try {
      const msgs = snapshot?.messages ?? [];
      const idx = msgs.findIndex((m) => m.id === message.id);
      // §7.6 不静默(r363 实钉):事件态行(id 是流式 buf 域)对不上投影域快照时,
      // 此前纯静默 return——按钮点了像死了。改为显形 toast,提示再点一次(快照
      // 再水合后行 id 换轨,findIndex 即命中)。
      if (idx < 0) {
        setToast(t("shell.retryStaleRow"));
        return;
      }
      let userMsg: NeutralMessage | null = null;
      for (let i = idx; i >= 0; i--) {
        if (msgs[i].role === "user") { userMsg = msgs[i]; break; }
      }
      if (!userMsg?.id) {
        setToast(t("shell.retryNoUserMessage"));
        return;
      }
      // 回退重跑隐含「这条不要了」→ abortSource:源会话在飞则先中断并等它落定,
      // 再派生(编排收在壳侧,顺序不能拆——abort 打的是激活会话的进程,而派生会把
      // 激活切走;见 ForkOptions.abortSource)。已落定的历史行上重试则无事发生。
      await ctx.tree.fork(currentNeutralSessionId ?? "", userMsg.id, "before", { abortSource: true });
      const text = typeof userMsg.content === "string"
        ? userMsg.content
        : Array.isArray(userMsg.content)
          ? userMsg.content
              .filter((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text")
              .map((c) => String((c as Record<string, unknown>).text ?? ""))
              .join("")
          : "";
      await ctx.messaging.prompt(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const m = /Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/.exec(msg);
      setToast(t("shell.retryFailed", { error: m?.[1] ?? msg }));
    }
  }, [ctx, t, snapshot, currentNeutralSessionId, message.id]);

  if (!message.id || message.role !== "assistant") return null;

  return (
    <>
      <button
        onClick={() => {
          if (armed) { disarm(); void handleRetry(); return; }
          arm(true);
        }}
        title={armed ? t("shell.retryArmed") : t("shell.retry")}
        className={armed ? ARMED_STYLE : STYLE}
      >
        <RotateCcw className="size-3.5" />
        {armed ? t("shell.retryArmed") : t("shell.retry")}
      </button>
      {toast && (
        <>
          {/* 错误文本是瞬时的（几秒后消失），必须走 alert live region，否则读屏用户
              永远不会知道「重试失败/续跑失败」——而这类失败恰恰没有其它可见后果。 */}
          <Announce message={toast} variant="error" />
          <span className="text-xs text-[var(--color-accent-error)]">{toast}</span>
        </>
      )}
    </>
  );
}
