import { Announce } from "@my-harness-desktop/react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { usePluginContext, useSessionStore, type MessageActionProps } from "@my-harness-desktop/react";

const STYLE = "flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer";

/**
 * 继续执行按钮:异常停机的 assistant 消息(工具失败/LLM 失败/用户停止)上出现,
 * 点一下经 ctx.messaging.prompt() 发一条通用「继续」提示原地续跑——续跑就是发消息
 * (设计 docs/design/goal.md §3.2,契约无独立 continue 意图),不 fork、不重发旧消息,
 * 与 retry 语义分开。
 */

// ⚠ 续跑文案走 i18n（r56）：它是经 `messaging.prompt()` **发出去的用户消息**，
//   会原样出现在时间线的用户气泡里 ⇒ 属"用户说的话"，英文界面里冒出一句中文是错的。
//   这与 session-store 的 `TOOL_LIMIT_PREFIX` 是**两类**：后者是发往内核的协议指令、
//   渲染层会 `stripToolLimitNote` 剥除、用户不可见，且剥除依赖 `startsWith(前缀)` 字面比对
//   ——本地化它会让**历史消息**剥不掉而露出协议原文。判据见 shell-no-hardcoded-copy 的豁免清单。
//   所以这里从模块级常量改成在组件内 `t("continue.prompt")`（常量拿不到 hook）。
export function ContinueAction({ message }: MessageActionProps): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const { streaming } = useSessionStore();
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleContinue = useCallback(async (): Promise<void> => {
    if (streaming) {
      setToast(t("shell.continueStreamingBlocked"));
      return;
    }
    try {
      await ctx.messaging.prompt(t("continue.prompt"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast(t("shell.continueFailed", { error: msg }));
    }
  }, [ctx, t, streaming]);

  // 只在异常停机的 assistant 消息上出现(error=生成失败/工具失败;stopped=用户停止)
  if (!message.id || message.role !== "assistant") return null;
  if (message.error !== true && message.stopped !== true) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => { void handleContinue(); }}
        title={t("shell.continue")}
        className={STYLE}
      >
        <Play className="size-3.5" />
        {t("shell.continue")}
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
