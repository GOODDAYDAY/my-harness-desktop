// session-bookmarks 的消息动作:ForkAction + BookmarkAction —— 插点(fork/收藏)的 UI 入口。
//
// §bookmark-snapshot-fork-unify §5:fork 与收藏统一收敛进 session-bookmarks 插件,
// 本文件从 timeline 迁入(原 timeline/renderer/message-actions.tsx)。copy/rewind 仍留 timeline。
//
// 收藏走 bookmarks:addRequested 事件(invoke);fork 走 ctx.tree.forkFromSession(中性面,
// 非 pi 扩展面——同一 deriveSession 派生核,pi/dsh 平等可用,§7.1),与收藏发起同源
// 「从某节点开新分支」。文案 shell.* 是共享命名空间,由 timeline 贡献。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Bookmark, GitFork } from "lucide-react";
import { usePluginContext, useUiStore, useSessionStore, useArmConfirm, Announce, type MessageActionProps } from "@my-harness-desktop/react";

const STYLE = "flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer";
const ARMED_STYLE = "flex items-center gap-1 px-1.5 py-1 rounded-[var(--radius-sm)] text-xs text-[var(--color-accent-error)] hover:bg-[var(--color-surface)] bg-transparent border-none cursor-pointer";

export function BookmarkAction({ message, text }: MessageActionProps): React.ReactNode {
  const { t } = useTranslation();
  const { currentSessionPath, currentNeutralSessionId } = useUiStore();
  // 默认 label = 会话名(设计拍板);无名会话(未自动命名)回退消息预览
  const sessionName = useSessionStore((s) => s.snapshot?.state.sessionName ?? null);
  const ctx = usePluginContext();
  const [done, setDone] = useState(false);
  if (message.role !== "assistant" || !message.id || !currentNeutralSessionId) return null;
  const entryId = message.id;
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 30) || "(empty)";

  // 一击收藏:立即以默认 label 创建,右面板揭示收藏 tab 并原位改标题。
  // invoke 而非 emit:收藏 tab 未挂载时请求入队,面板揭示后挂载冲刷恰好一次投递。
  return (
    <button
      onClick={() => {
        ctx.events.invoke("bookmarks:addRequested", {
          sessionPath: currentSessionPath,
          entryId,
          preview,
          label: sessionName ?? preview,
        });
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      title={done ? t("shell.bookmarked") : t("shell.bookmark")}
      className={STYLE}
    >
      {done ? <Check className="size-3.5" /> : <Bookmark className="size-3.5" />}
      {done ? t("shell.bookmarked") : t("shell.bookmark")}
    </button>
  );
}

export function ForkAction({ message }: MessageActionProps): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  // 只取中立主键:forkFromSession 已无 cwd 入参(契约单源,项目归属来自源会话 header.cwd),
  // currentCwd 在此不再参与任何调用;currentNeutralSessionId 非空即蕴含「有激活项目」,
  // 是 fork 的真实前置(组件末尾的 return null 也以它为门),不需要再单独 guard cwd。
  const { currentNeutralSessionId } = useUiStore();
  const [toast, setToast] = useState<string | null>(null);
  const { armed, arm, disarm } = useArmConfirm();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  // 分叉 = 从这条 assistant 回答后派生新会话(§5:派生 → 跳转)。与收藏发起同源「插点」。
  // 流式生成中照样可分叉(不传 abortSource——「从此开新分支」是「两边都要」,源会话
  // 继续在后台跑完,列表行有执行中指示);在飞的那一行则由 manifest 的 when.settled
  // 挡在渲染层(没进中立层 = 没锚可锚),不在这里判全局 streaming。
  const handleFork = useCallback(async (): Promise<void> => {
    if (!message.id || !currentNeutralSessionId) return;
    try {
      await ctx.tree.forkFromSession(currentNeutralSessionId, message.id, "at");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const m = /Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/.exec(msg);
      setToast(t("shell.forkFailed", { error: m?.[1] ?? msg }));
    }
  }, [ctx, t, message.id, currentNeutralSessionId]);

  if (!message.id || message.role !== "assistant" || !currentNeutralSessionId) return null;

  return (
    <>
      <button
        onClick={() => {
          if (armed) { disarm(); void handleFork(); return; }
          arm(true);
        }}
        title={armed ? t("shell.forkArmed") : t("shell.fork")}
        // ⚠ 稳定探针锚点（r179，skills §10.3）：此前剧本只能按 title 是否含「分叉」/「确认分叉」
        //   定位这个按钮 —— 语言绑定探针，换 locale 就静默失效（r121 那族，这是最后一处）。
        //   armed 态单独给一个锚点值：两步确认（r161 的 useArmConfirm）的两个阶段在剧本里
        //   要分别断言，靠文案区分同样会随语言漂移。
        data-message-fork=""
        data-message-fork-armed={armed ? "true" : "false"}
        className={armed ? ARMED_STYLE : STYLE}
      >
        <GitFork className="size-3.5" />
        {armed ? t("shell.forkArmed") : t("shell.fork")}
      </button>
      {/* 错误提示是瞬时的，必须走 alert live region（r59；与 retry/continue 同型同修法） */}
      {toast && <Announce message={toast} variant="error" />}
      {toast && <span className="text-xs text-[var(--color-accent-error)]">{toast}</span>}
    </>
  );
}
