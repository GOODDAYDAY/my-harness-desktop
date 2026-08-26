// AskHost —— ask_user_question 的常驻消费方，单一中性传输：
//   订阅 ctx.sessions.onQuestion（pi 的 extension_ui 帧与 dsh 的文件侧车桥都经适配器翻译成这一形状）
//   → 渲染问句（有选项走按钮、无选项走自由输入）→ ctx.sessions.answerQuestion 回填。
// 挂在 sidebar 槽常驻（sub-agent 的 SubAgentSection 同款手法）：无请求时 return null，不占左栏。
// 渲染是纯函数：不出现 pi/dsh 内核身份分支——两侧差异由适配器在事件层抹平。
import { useEffect, useState, type ReactNode } from "react";
import { usePluginContext } from "@my-harness-desktop/react";
import type { Question, QuestionRequestEvent } from "@my-harness-desktop/shared";

export function AskHost(): ReactNode {
  const ctx = usePluginContext();
  const [pending, setPending] = useState<{ requestId: string; question: Question } | null>(null);
  const [customText, setCustomText] = useState("");

  useEffect(() => {
    const off = ctx.sessions.onQuestion((req: QuestionRequestEvent) => {
      const q = req.questions?.[0];
      if (!q || typeof q.question !== "string") return;
      setCustomText("");
      setPending({ requestId: req.requestId, question: q });
    });
    return off;
  }, [ctx]);

  if (!pending) return null;

  const { requestId, question } = pending;
  const options = (question.options ?? []).map((o) => o.label ?? "").filter(Boolean);
  const hasOptions = options.length > 0;
  const title = question.header ?? question.question;

  const reply = (value?: string, cancelled?: boolean): void => {
    const answers = cancelled || value === undefined
      ? [{ id: question.id, selected: [] as string[] }]
      : hasOptions
        ? [{ id: question.id, selected: [value] }]
        : [{ id: question.id, selected: [] as string[], custom: value }];
    void ctx.sessions.answerQuestion(requestId, answers);
    setPending(null);
  };

  const submitCustom = (): void => {
    const text = customText.trim();
    if (text) reply(text);
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
        {hasOptions ? (
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
        ) : (
          <div className="flex flex-col gap-1.5">
            <input
              autoFocus
              type="text"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitCustom(); }}
              placeholder="输入你的回答…"
              style={{
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--color-border)",
                background: "var(--color-bg)",
                color: "var(--color-fg)",
                padding: "8px 12px",
                fontSize: "var(--font-size-sm)",
              }}
            />
            <button
              type="button"
              onClick={submitCustom}
              style={{
                alignSelf: "flex-end",
                borderRadius: "var(--radius-md)",
                background: "var(--color-primary)",
                color: "var(--color-fg)",
                padding: "6px 14px",
                cursor: "pointer",
                fontSize: "var(--font-size-sm)",
              }}
            >
              Submit
            </button>
          </div>
        )}
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
