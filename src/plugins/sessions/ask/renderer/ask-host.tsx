// AskHost —— ask_user_question 的常驻消费方（中性单通道）。
// pi 的 extension_ui 与 dsh 的文件侧车桥都在适配器层翻译成中性 Question，
// 经 ctx.sessions.onQuestion 投递；回填走 ctx.sessions.answerQuestion。
// 挂 sidebar 槽常驻：无请求时 return null，不占左栏。
import { useEffect, useState, type ReactNode } from "react";
import { usePluginContext } from "@my-harness-desktop/react";
import type { Question, QuestionRequestEvent } from "@my-harness-desktop/contract";

export function AskHost(): ReactNode {
  const ctx = usePluginContext();
  const [pending, setPending] = useState<QuestionRequestEvent | null>(null);

  useEffect(() => {
    const off = ctx.sessions.onQuestion((req) => {
      if (!Array.isArray(req.questions) || req.questions.length === 0) return;
      setPending(req);
    });
    return off;
  }, [ctx]);

  if (!pending) return null;
  // 一次可多题，当前 UI 只呈现第一题（后续多题渲染再展开）。
  const question: Question | undefined = pending.questions[0];
  if (!question) return null;

  const title = question.header ?? question.question;
  const options = (question.options ?? []).map((o) => o.label).filter(Boolean);

  const reply = (value?: string, cancelled?: boolean): void => {
    void ctx.sessions.answerQuestion(pending.requestId, [
      { id: question.id, selected: cancelled ? [] : value ? [value] : [] },
    ]);
    setPending(null);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.4)",
      }}
      onClick={() => reply(undefined, true)}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(480px, calc(100vw - 48px))",
          maxHeight: "80vh",
          overflowY: "auto",
          borderRadius: "var(--radius-lg)",
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
          padding: "16px 18px",
        }}
      >
        <div className="text-[length:var(--font-size-base)] font-semibold text-[var(--color-fg)] mb-2">
          {title}
        </div>
        <div className="flex flex-col gap-1.5">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => reply(opt)}
              style={{
                textAlign: "left",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--color-border)",
                background: "color-mix(in srgb, var(--color-bg) 55%, transparent)",
                color: "var(--color-fg)",
                padding: "8px 12px",
                cursor: "pointer",
                fontSize: "var(--font-size-sm)",
              }}
            >
              {opt}
            </button>
          ))}
        </div>
        <div className="flex justify-end mt-3">
          <button
            type="button"
            onClick={() => reply(undefined, true)}
            style={{
              borderRadius: "var(--radius-md)",
              color: "var(--color-muted)",
              padding: "6px 12px",
              cursor: "pointer",
              fontSize: "var(--font-size-sm)",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
