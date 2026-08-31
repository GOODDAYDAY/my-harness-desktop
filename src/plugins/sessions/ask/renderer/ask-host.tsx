// AskComposer —— ask_user_question 的常驻消费方，单一中性传输：
//   订阅 ctx.sessions.onQuestion（pi 的 extension_ui 帧与 dsh 的文件侧车桥都经适配器翻译成这一形状）
//   → 在输入框上方（composerTop 槽）渲染问句卡片，不弹窗、不打断会话流。
//
// 纯抄 DSH 的 QuestionComposer/QuestionFlow（ui-user-questions）：一张内联卡片，含标题、
// 选项（单选/多选）+ 自定义答案、分页、跳过、放弃整组。用户「随时」作答——卡片常驻在
// composer 上方，不遮屏、不强制立即回复（ChatGPT 式：模型问、用户有空再答）。
// 渲染是纯函数：不出现 pi/dsh 内核身份分支——两侧差异由适配器在事件层抹平。
import { useEffect, useState, type ReactNode } from "react";
import { usePluginContext } from "@my-harness-desktop/react";
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, X, Check, Edit3 } from "lucide-react";
import type { Question, QuestionAnswer, QuestionRequestEvent } from "@my-harness-desktop/shared";

/** 每道题的草稿态：selected（选项 label 数组）、custom（自定义文本）、skipped（跳过）。 */
interface Draft {
  selected: string[];
  custom: string;
  skipped: boolean;
}

interface PendingQuestion {
  requestId: string;
  questions: Question[];
}

/** DSH parseRecommendedLabel：拆掉「(推荐)/(Recommended)」后缀，不改变回传的答案值。 */
function parseRecommendedLabel(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;
  return suffix.test(label)
    ? { label: label.replace(suffix, ""), recommended: true }
    : { label, recommended: false };
}

function isComposing(event: { nativeEvent?: { isComposing?: boolean; keyCode?: number } }): boolean {
  return event.nativeEvent?.isComposing === true || event.nativeEvent?.keyCode === 229;
}

export function AskComposer(): ReactNode {
  const ctx = usePluginContext();
  const [pending, setPending] = useState<PendingQuestion | null>(null);
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState<"answer" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);

  // 新问题到达：重置到首题、清空草稿、展开卡片（不弹窗、不抢焦点）。
  useEffect(() => {
    const off = ctx.sessions.onQuestion((req: QuestionRequestEvent) => {
      const questions = (req.questions ?? []).filter((q) => typeof q.question === "string");
      if (questions.length === 0) return;
      setIndex(0);
      setDrafts(questions.map(() => ({ selected: [], custom: "", skipped: false })));
      setBusy(null);
      setError(null);
      setMinimized(false);
      setPending({ requestId: req.requestId, questions });
    });
    return off;
  }, [ctx]);

  const question = pending?.questions[index];
  const draft = drafts[index];

  const settle = (): void => {
    setPending(null);
    setIndex(0);
    setDrafts([]);
    setBusy(null);
    setError(null);
  };

  const cancelFlow = (): void => {
    if (!pending) return;
    setBusy("cancel");
    setError(null);
    void ctx.sessions.answerQuestion(pending.requestId, pending.questions.map((q) => ({ id: q.id, selected: [] })))
      .then(() => settle())
      .catch((cause) => { setBusy(null); setError(cause instanceof Error ? cause.message : String(cause)); });
  };

  const updateDraft = (update: (cur: Draft) => Draft): void => {
    setDrafts((cur) => cur.map((item, i) => (i === index ? update(item) : item)));
    setError(null);
  };

  const answered = (item: Draft): boolean => item.selected.length > 0 || item.custom.trim() !== "";
  const completed = (item: Draft): boolean => answered(item) || item.skipped;

  const submitDrafts = (values: Draft[]): void => {
    if (!pending) return;
    const missing = values.findIndex((item) => !completed(item));
    if (missing >= 0) {
      setIndex(missing);
      setError("请选择一个选项或填写自定义答案。");
      return;
    }
    const answers: QuestionAnswer[] = pending.questions.map((q, i) => {
      const v = values[i];
      if (v.skipped) return { id: q.id, selected: [] };
      const custom = v.custom.trim();
      return {
        id: q.id,
        selected: custom === "" || q.multi_select === true ? v.selected : [],
        ...(custom === "" ? {} : { custom }),
      };
    });
    setBusy("answer");
    setError(null);
    void ctx.sessions.answerQuestion(pending.requestId, answers)
      .then(() => settle())
      .catch((cause) => { setBusy(null); setError(cause instanceof Error ? cause.message : String(cause)); });
  };

  const choose = (label: string): void => {
    if (!question) return;
    updateDraft((cur) => {
      if (question.multi_select === true) {
        const selected = cur.selected.includes(label)
          ? cur.selected.filter((item) => item !== label)
          : [...cur.selected, label];
        return { ...cur, selected, skipped: false };
      }
      return { selected: [label], custom: "", skipped: false };
    });
    if (question.multi_select !== true && index < (pending?.questions.length ?? 1) - 1) setIndex((c) => c + 1);
  };

  const continueFlow = (): void => {
    if (!draft || !pending) return;
    if (!answered(draft)) { setError("请选择一个选项或填写自定义答案。"); return; }
    if (index < pending.questions.length - 1) { setIndex((c) => c + 1); setError(null); return; }
    submitDrafts(drafts);
  };

  const skipQuestion = (): void => {
    const next = drafts.map((item, i) => (i === index ? { selected: [], custom: "", skipped: true } : item));
    setDrafts(next);
    setError(null);
    if (index < (pending?.questions.length ?? 1) - 1) { setIndex((c) => c + 1); return; }
    submitDrafts(next);
  };

  if (!pending || !question || !draft) return null;

  const hasOptions = (question.options?.length ?? 0) > 0;
  const total = pending.questions.length;

  return (
    <div
      data-ask-card
      className="w-full mb-2 rounded-[var(--radius-lg)] border overflow-hidden"
      style={{
        borderColor: "var(--color-border)",
        background: "var(--color-surface)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      {/* 头部：标题 + 收起/关闭 */}
      <div className="flex items-start justify-between gap-3 px-4 pt-3 pb-2">
        <div className="min-w-0">
          {question.header && (
            <div className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] mb-0.5">{question.header}</div>
          )}
          <h2 className="m-0 text-[length:var(--font-size-base)] font-semibold text-[var(--color-fg)] leading-snug break-words">
            {question.question}
          </h2>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            title={minimized ? "展开问题" : "收起问题"}
            aria-label={minimized ? "展开问题" : "收起问题"}
            aria-expanded={!minimized}
            disabled={busy !== null}
            onClick={() => setMinimized((c) => !c)}
            className="size-6 grid place-items-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40"
          >
            {minimized ? <ChevronDown /> : <ChevronUp />}
          </button>
          <button
            type="button"
            title="放弃整组问题"
            aria-label="放弃整组问题"
            disabled={busy !== null}
            onClick={cancelFlow}
            className="size-6 grid place-items-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {!minimized && (
        <>
          {/* 主体：选项 + 自定义输入 */}
          <div className="px-4 pb-2 flex flex-col gap-1.5">
            <div className="flex flex-col gap-1.5" role={question.multi_select === true ? "group" : "radiogroup"}>
              {(question.options ?? []).map((option, optionIndex) => {
                const selected = draft.selected.includes(option.label);
                const display = parseRecommendedLabel(option.label);
                return (
                  <button
                    key={`${option.label}-${optionIndex}`}
                    type="button"
                    role={question.multi_select === true ? "checkbox" : "radio"}
                    aria-checked={selected}
                    aria-label={display.label}
                    disabled={busy !== null}
                    onClick={() => choose(option.label)}
                    className="flex items-start gap-2 rounded-[var(--radius-md)] border px-2.5 py-1.5 text-left text-[length:var(--font-size-sm)] transition-colors"
                    style={{
                      borderColor: selected ? "var(--color-primary)" : "var(--color-border)",
                      background: selected ? "color-mix(in srgb, var(--color-primary) 10%, transparent)" : "var(--color-bg)",
                      color: "var(--color-fg)",
                      cursor: busy !== null ? "default" : "pointer",
                    }}
                  >
                    <span className="mt-0.5 shrink-0 text-[var(--color-muted)]">
                      {question.multi_select === true ? (
                        <span className="inline-flex size-4 items-center justify-center rounded border border-[var(--color-border)]">
                          {selected && <Check className="size-3 text-[var(--color-primary)]" />}
                        </span>
                      ) : (
                        <span className="inline-block min-w-4 text-center tabular-nums">{optionIndex + 1}</span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{display.label}</span>
                      {display.recommended && (
                        <span className="ml-1.5 rounded-full px-1.5 py-0.5 text-[length:var(--font-size-xs)] text-[var(--color-primary)]"
                          style={{ background: "color-mix(in srgb, var(--color-primary) 14%, transparent)" }}>
                          推荐
                        </span>
                      )}
                      {option.description !== undefined && (
                        <span className="block text-[length:var(--font-size-xs)] text-[var(--color-muted)]">{option.description}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* 自定义答案：有选项时是内联补充行，无选项时是整块输入 */}
            {hasOptions ? (
              <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 py-1.5"
                style={{ background: draft.custom !== "" ? "color-mix(in srgb, var(--color-primary) 6%, transparent)" : "var(--color-bg)" }}>
                <Edit3 className="size-3.5 shrink-0 text-[var(--color-muted)]" />
                <input
                  type="text"
                  value={draft.custom}
                  disabled={busy !== null}
                  placeholder="输入你的答案"
                  onChange={(e) => updateDraft((cur) => ({
                    ...cur,
                    selected: question.multi_select === true ? cur.selected : [],
                    custom: e.target.value,
                    skipped: false,
                  }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !isComposing(e)) { e.preventDefault(); continueFlow(); }
                  }}
                  className="flex-1 min-w-0 bg-transparent outline-none text-[length:var(--font-size-sm)] text-[var(--color-fg)]"
                />
              </div>
            ) : (
              <textarea
                autoFocus
                value={draft.custom}
                disabled={busy !== null}
                placeholder="输入你的答案"
                rows={2}
                onChange={(e) => updateDraft((cur) => ({ ...cur, custom: e.target.value, skipped: false }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !isComposing(e)) { e.preventDefault(); continueFlow(); }
                }}
                className="w-full resize-none rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[length:var(--font-size-sm)] text-[var(--color-fg)] outline-none"
              />
            )}
          </div>

          {/* 底部：分页 + 错误 + 跳过/提交 */}
          <div className="flex items-center gap-2 px-3 pb-2.5">
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="上一题"
                disabled={index === 0 || busy !== null}
                onClick={() => { setIndex((c) => c - 1); setError(null); }}
                className="size-6 grid place-items-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="px-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)] tabular-nums">
                {index + 1} / {total}
              </span>
              <button
                type="button"
                aria-label="下一题"
                disabled={index === total - 1 || busy !== null}
                onClick={() => { setIndex((c) => c + 1); setError(null); }}
                className="size-6 grid place-items-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>

            {error !== null && (
              <div role="status" className="min-w-0 flex-1 truncate text-[length:var(--font-size-xs)] text-[var(--color-accent-error)]">{error}</div>
            )}
            {error === null && <div className="flex-1" />}

            <button
              type="button"
              disabled={busy !== null}
              onClick={skipQuestion}
              className="rounded-[var(--radius-md)] px-2.5 py-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40"
            >
              跳过本题
            </button>
            <button
              type="button"
              disabled={busy !== null || !answered(draft)}
              onClick={continueFlow}
              className="rounded-[var(--radius-md)] px-3 py-1 text-[length:var(--font-size-sm)] font-medium disabled:opacity-40"
              style={{ background: "var(--color-primary)", color: "var(--color-fg)" }}
            >
              {busy === "answer" ? "提交中…" : index === total - 1 ? "提交" : "下一题"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
