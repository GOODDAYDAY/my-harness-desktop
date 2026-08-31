// AskQuestionCard —— ask_user_question 工具调用块的时间线渲染件（blockRenderers 槽）。
//
// 运行中（pending/running）：在会话流里内联渲染「问题气泡 + 选项 chips + 自定义输入」
// （ChatGPT 式：问句就躺在对话流里，可点选、可输入、可跳过，不弹窗、不强制立即回复）。
// 结算后：摘要展示 N/M answered 或 cancelled。
//
// 交互收集归本卡片（原 AskComposer/composerTop 已并入）：订阅 ctx.sessions.onQuestion 拿
// requestId + questions（服务端已按激活会话过滤，不跨 session），作答经 ctx.sessions.answerQuestion 回填。
// 渲染纯函数：不出现 pi/dsh 内核身份分支——两侧差异由适配器在事件层抹平。
import { useEffect, useState, type ReactNode } from "react";
import { usePluginContext } from "@my-harness-desktop/react";
import { MessageCircleQuestion, Check, X, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Edit3 } from "lucide-react";
import type { ToolCallBlock } from "@my-harness-desktop/react";
import type { Question, QuestionAnswer, QuestionRequestEvent } from "@my-harness-desktop/shared";

interface AskResult {
  answers?: { id: string; selected?: string[]; custom?: string }[];
}

interface PendingRequest {
  requestId: string;
  questions: Question[];
}

/** 每道题的草稿态：selected（选项 label 数组）、custom（自定义文本）、skipped（跳过）。 */
interface Draft {
  selected: string[];
  custom: string;
  skipped: boolean;
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

export function AskQuestionCard({ toolCall, collapseDefault = true }: { toolCall: ToolCallBlock; collapseDefault?: boolean }): ReactNode {
  const isStreaming = toolCall.state === "pending" || toolCall.state === "running";
  if (isStreaming) return <RunningQuestion />;
  return <SettledSummary toolCall={toolCall} collapseDefault={collapseDefault} />;
}

/** 运行中：订阅提问事件，在时间线内联渲染问题 + 选项 + 输入。 */
function RunningQuestion(): ReactNode {
  const ctx = usePluginContext();
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState<"answer" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);

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

  if (!pending || !question || !draft) {
    // 提问事件尚未到达（toolCallStart 已到、question 帧/文件还在路上）：轻量 waiting 占位。
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-1.5 text-[length:var(--font-size-sm)]"
        style={{ borderLeft: "3px solid var(--color-accent-success)", background: "color-mix(in srgb, var(--color-surface) 30%, transparent)" }}>
        <MessageCircleQuestion className="size-3.5 text-[var(--color-muted)]" />
        <span className="text-[var(--color-fg)]">ask_user_question</span>
        <span className="text-xs text-[var(--color-muted)]">waiting…</span>
      </div>
    );
  }

  const hasOptions = (question.options?.length ?? 0) > 0;
  const total = pending.questions.length;

  return (
    <div
      data-ask-question
      className="mb-1.5 rounded-[var(--radius-lg)] border overflow-hidden"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      {/* 问题气泡头部 */}
      <div className="flex items-start justify-between gap-3 px-3 pt-2.5 pb-2">
        <div className="min-w-0">
          {question.header && (
            <div className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] mb-0.5">{question.header}</div>
          )}
          <div className="text-[length:var(--font-size-base)] font-medium text-[var(--color-fg)] leading-snug break-words">
            {question.question}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button type="button" title={minimized ? "展开" : "收起"} aria-label={minimized ? "展开" : "收起"} aria-expanded={!minimized}
            disabled={busy !== null} onClick={() => setMinimized((c) => !c)}
            className="size-6 grid place-items-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40">
            {minimized ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
          </button>
          <button type="button" title="放弃整组问题" aria-label="放弃整组问题" disabled={busy !== null} onClick={cancelFlow}
            className="size-6 grid place-items-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40">
            <X className="size-4" />
          </button>
        </div>
      </div>

      {!minimized && (
        <>
          {/* 选项 chips + 自定义输入 */}
          <div className="px-3 pb-2 flex flex-col gap-1.5">
            <div className="flex flex-wrap gap-1.5" role={question.multi_select === true ? "group" : "radiogroup"}>
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
                    title={option.description}
                    disabled={busy !== null}
                    onClick={() => choose(option.label)}
                    className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[length:var(--font-size-sm)] transition-colors"
                    style={{
                      borderColor: selected ? "var(--color-primary)" : "var(--color-border)",
                      background: selected ? "color-mix(in srgb, var(--color-primary) 12%, transparent)" : "var(--color-bg)",
                      color: "var(--color-fg)",
                      cursor: busy !== null ? "default" : "pointer",
                    }}
                  >
                    {selected && <Check className="size-3 text-[var(--color-primary)]" />}
                    <span>{display.label}</span>
                    {display.recommended && (
                      <span className="rounded-full px-1.5 py-0.5 text-[length:var(--font-size-xs)] text-[var(--color-primary)]"
                        style={{ background: "color-mix(in srgb, var(--color-primary) 16%, transparent)" }}>
                        推荐
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 自定义输入：有选项时是内联补充行，无选项时是整块输入 */}
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
          <div className="flex items-center gap-2 px-2.5 pb-2">
            <div className="flex items-center gap-1">
              <button type="button" aria-label="上一题" disabled={index === 0 || busy !== null}
                onClick={() => { setIndex((c) => c - 1); setError(null); }}
                className="size-6 grid place-items-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40">
                <ChevronLeft className="size-4" />
              </button>
              <span className="px-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)] tabular-nums">{index + 1} / {total}</span>
              <button type="button" aria-label="下一题" disabled={index === total - 1 || busy !== null}
                onClick={() => { setIndex((c) => c + 1); setError(null); }}
                className="size-6 grid place-items-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40">
                <ChevronRight className="size-4" />
              </button>
            </div>

            {error !== null && (
              <div role="status" className="min-w-0 flex-1 truncate text-[length:var(--font-size-xs)] text-[var(--color-accent-error)]">{error}</div>
            )}
            {error === null && <div className="flex-1" />}

            <button type="button" disabled={busy !== null} onClick={skipQuestion}
              className="rounded-[var(--radius-md)] px-2.5 py-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)] hover:bg-[var(--color-bg)] disabled:opacity-40">
              跳过本题
            </button>
            <button type="button" disabled={busy !== null || !answered(draft)} onClick={continueFlow}
              className="rounded-[var(--radius-md)] px-3 py-1 text-[length:var(--font-size-sm)] font-medium disabled:opacity-40"
              style={{ background: "var(--color-primary)", color: "var(--color-fg)" }}>
              {busy === "answer" ? "提交中…" : index === total - 1 ? "提交" : "下一题"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** 结算后：摘要展示交互结果。 */
function SettledSummary({ toolCall, collapseDefault }: { toolCall: ToolCallBlock; collapseDefault: boolean }): ReactNode {
  const [collapsed, setCollapsed] = useState(collapseDefault);
  useEffect(() => { setCollapsed(collapseDefault); }, [collapseDefault]);

  const result = (toolCall.result as AskResult | undefined)?.answers;
  const answeredCount = result?.filter((a) => (a.selected?.length ?? 0) > 0 || (a.custom ?? "").length > 0).length ?? 0;
  const totalCount = result?.length ?? 0;
  const summary = result === undefined
    ? "answered"
    : totalCount > 0
      ? `${answeredCount}/${totalCount} answered`
      : "answered";

  const borderColor = toolCall.isError
    ? "var(--color-accent-error)"
    : "var(--color-primary)";

  return (
    <div className="mb-1.5">
      <div
        className="flex items-center gap-2 text-[length:var(--font-size-sm)] font-[var(--font-family-mono)] cursor-pointer rounded-[var(--radius-md)]"
        style={{ borderLeft: `3px solid ${borderColor}`, background: "color-mix(in srgb, var(--color-surface) 30%, transparent)", padding: "5px 12px" }}
        onClick={() => setCollapsed((c) => !c)}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCollapsed((c) => !c); } }}
      >
        <span className="text-[var(--color-muted)]"><MessageCircleQuestion className="size-3.5" /></span>
        <span className="text-[var(--color-fg)] flex-1 truncate">ask_user_question</span>
        <span className="text-xs text-[var(--color-muted)]">{summary}</span>
        {toolCall.isError ? <X className="size-3.5 text-[var(--color-accent-error)]" /> : <Check className="size-3.5 text-[var(--color-muted)]" />}
        <span className="text-[var(--color-muted)]">
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
        </span>
      </div>
      {!collapsed && result && (
        <div className="mt-1 rounded-[var(--radius-md)] p-2.5 text-[length:var(--font-size-sm)] space-y-1.5"
          style={{ background: "color-mix(in srgb, var(--color-bg) 55%, var(--color-border))" }}>
          {result.map((a) => (
            <div key={a.id} className="flex gap-2">
              <span className="text-[var(--color-muted)] shrink-0">{a.id}</span>
              <span className="text-[var(--color-fg)] break-all">
                {a.custom ? `(wrote) ${a.custom}` : (a.selected?.join(", ") || "(skipped)")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
