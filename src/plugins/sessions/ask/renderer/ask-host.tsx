// AskHost —— ask_user_question 的常驻消费方，双传输：
//   1. pi：订阅 ctx.sessions.onExtensionUI（extension_ui_request → 选项卡片 → replyExtensionUI 回填）
//   2. dsh：轮询 ctx.sessions.dshQuestions.list()（文件侧车桥 → 选项卡片 → dshQuestions.answer 回填）
// 挂在 sidebar 槽常驻（sub-agent 的 SubAgentSection 同款手法）：无请求时 return null，不占左栏。
// pi 侧堵上"提问被静默丢包"；dsh 侧堵上"文件侧车无人应答导致超时"。
import { useEffect, useState, type ReactNode } from "react";
import { usePluginContext } from "@my-harness-desktop/react";

interface SelectPayload {
  title?: string;
  options?: string[];
}

interface DshOption {
  label?: string;
  description?: string;
}

interface DshQuestion {
  id: string;
  question: string;
  header?: string;
  options?: DshOption[];
  multi_select?: boolean;
}

type Pending =
  | { kind: "pi"; requestId: string; title: string; options: string[] }
  | { kind: "dsh"; requestId: string; question: DshQuestion };

export function AskHost(): ReactNode {
  const ctx = usePluginContext();
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    const off = ctx.sessions.onExtensionUI((req) => {
      if (req.method !== "select") return;
      const payload = (req as { payload?: SelectPayload }).payload;
      const options = Array.isArray(payload?.options) ? payload.options : [];
      if (options.length === 0) return;
      setPending({
        kind: "pi",
        requestId: req.requestId,
        title: payload?.title ?? "",
        options,
      });
    });
    return off;
  }, [ctx]);

  useEffect(() => {
    const timer = setInterval(() => {
      void ctx.dshQuestions.list().then((list) => {
        if (!Array.isArray(list) || list.length === 0) return;
        const first = list[0];
        const questions = Array.isArray(first.questions) ? first.questions : [];
        const q = questions[0] as DshQuestion | undefined;
        if (!q || typeof q.question !== "string") return;
        setPending((prev) => (prev && prev.kind === "pi" ? prev : { kind: "dsh", requestId: first.requestId, question: q }));
      });
    }, 500);
    return () => clearInterval(timer);
  }, [ctx]);

  if (!pending) return null;

  const title = pending.kind === "pi" ? pending.title : pending.question.question;
  const options = pending.kind === "pi"
    ? pending.options
    : (pending.question.options ?? []).map((o) => o.label ?? "").filter(Boolean);

  const reply = (value?: string, cancelled?: boolean): void => {
    if (pending.kind === "pi") {
      void ctx.sessions.replyExtensionUI(
        pending.requestId,
        cancelled ? { cancelled: true } : { value },
      );
    } else {
      const answers = [{ id: pending.question.id, selected: cancelled || value === undefined ? [] : [value] }];
      void ctx.dshQuestions.answer(pending.requestId, answers);
    }
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
