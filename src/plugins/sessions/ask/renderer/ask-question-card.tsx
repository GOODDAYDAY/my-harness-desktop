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
import { MessageCircleQuestion, Check, X, ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from "lucide-react";
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

/** 模型的原始出题入参(toolCall.args.questions):帧/文件装不下的字段从这里补。 */
function argsQuestionsOf(toolCall: ToolCallBlock): Question[] {
  const args = toolCall.args as { questions?: unknown } | undefined;
  return Array.isArray(args?.questions) ? (args.questions as Question[]) : [];
}

/** 按问句文本匹配,从工具入参补回 multi_select/description(pi 帧装不下这些字段;
 *  扩展把 q.question 原样作帧 title,匹配可靠)。匹配不到按原样(现状兜底)。 */
function enrichQuestions(questions: Question[], toolCall: ToolCallBlock): Question[] {
  const argsQuestions = argsQuestionsOf(toolCall);
  if (argsQuestions.length === 0) return questions;
  return questions.map((q) => {
    const hit = argsQuestions.find((aq) => aq && typeof aq === "object" && aq.question === q.question);
    if (!hit) return q;
    const options = (q.options ?? []).map((opt) => {
      const hitOpt = (hit.options ?? []).find((ao) => ao.label === opt.label);
      return hitOpt?.description && !opt.description ? { ...opt, description: hitOpt.description } : opt;
    });
    return { ...q, multi_select: hit.multi_select ?? q.multi_select, options };
  });
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
  const ctx = usePluginContext();
  const isStreaming = toolCall.state === "pending" || toolCall.state === "running";
  const [revived, setRevived] = useState<PendingRequest | null>(null);

  // 复活(ask-design §8.2):重启/重开后 toolCall.state 不再是 running——查挂起记录,
  // 命中(优先 toolCallId 精确锚定,fallback 会话唯一 pending)且块无 result → 恢复交互态。
  useEffect(() => {
    if (isStreaming || toolCall.result !== undefined) return;
    let alive = true;
    void ctx.sessions.getPendingQuestions().then((records) => {
      if (!alive) return;
      const hit = records.find((r) => r.toolCallId !== null && r.toolCallId === toolCall.id)
        ?? (records.length === 1 ? records[0] : undefined);
      // 同 requestId 返回旧引用(React 跳过重渲)——否则每轮 render 的新对象会把 effect 拖进死循环
      if (hit) setRevived((cur) => (cur?.requestId === hit.requestId ? cur : { requestId: hit.requestId, questions: hit.questions }));
    }).catch(() => {});
    return () => { alive = false; };
  }, [ctx, isStreaming, toolCall.id, toolCall.result]);

  if (isStreaming) return <RunningQuestion toolCall={toolCall} />;
  if (revived) return <RunningQuestion toolCall={toolCall} initialRequest={revived} onDone={() => setRevived(null)} />;
  return <SettledSummary toolCall={toolCall} collapseDefault={collapseDefault} />;
}

/** 运行中：订阅提问事件，在时间线内联渲染问题 + 选项 + 输入。
 *  initialRequest = 复活的挂起记录(重启后无新事件,从 store 直接起)。 */
function RunningQuestion({ toolCall, initialRequest, onDone }: { toolCall: ToolCallBlock; initialRequest?: PendingRequest; onDone?: () => void }): ReactNode {
  const ctx = usePluginContext();
  const [pending, setPending] = useState<PendingRequest | null>(initialRequest ?? null);
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>(() => initialRequest ? initialRequest.questions.map(() => ({ selected: [], custom: "", skipped: false })) : []);
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
      // 帧/文件装不下的字段从工具入参补回(pi 的 multi_select/description)
      setPending({ requestId: req.requestId, questions: enrichQuestions(questions, toolCall) });
    });
    return off;
  }, [ctx, toolCall]);

  const question = pending?.questions[index];
  const draft = drafts[index];

  const settle = (): void => {
    setPending(null);
    setIndex(0);
    setDrafts([]);
    setBusy(null);
    setError(null);
    onDone?.(); // 复活态卡片作答后退场(记录已结算,不再命中 pending)
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
          {/* 选项:每个选项独占一整行(用户要求:选项整行 + 支持多行文本),单选=radio 语义、
              多选=checkbox 语义;description 作为第二行弱化展示。 */}
          <div className="px-3 pb-2 flex flex-col gap-1.5">
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
                    className="flex w-full items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-left transition-colors"
                    style={{
                      borderColor: selected ? "var(--color-primary)" : "var(--color-border)",
                      background: selected ? "color-mix(in srgb, var(--color-primary) 12%, transparent)" : "var(--color-bg)",
                      color: "var(--color-fg)",
                      cursor: busy !== null ? "default" : "pointer",
                    }}
                  >
                    {/* 选择指示:单选圆点 / 多选方块,选中着色 */}
                    <span
                      aria-hidden
                      className="mt-1 flex-none inline-block size-3 rounded-full border"
                      style={{
                        borderColor: selected ? "var(--color-primary)" : "var(--color-border)",
                        background: selected ? "var(--color-primary)" : "transparent",
                        borderRadius: question.multi_select === true ? "var(--radius-sm)" : "9999px",
                      }}
                    />
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[length:var(--font-size-sm)] leading-snug">
                      <span>{display.label}</span>
                      {display.recommended && (
                        <span className="ml-1.5 rounded-full px-1.5 py-0.5 text-[length:var(--font-size-xs)] text-[var(--color-primary)] whitespace-nowrap"
                          style={{ background: "color-mix(in srgb, var(--color-primary) 16%, transparent)" }}>
                          推荐
                        </span>
                      )}
                      {option.description && (
                        <span className="block mt-0.5 text-[length:var(--font-size-xs)] text-[var(--color-muted)] whitespace-pre-wrap break-words">
                          {option.description}
                        </span>
                      )}
                    </span>
                    {selected && <Check className="size-3.5 mt-0.5 shrink-0 text-[var(--color-primary)]" />}
                  </button>
                );
              })}
            </div>

            {/* 自定义输入:两种情况(单选/多选)都支持(用户要求)——整行 textarea 支持多行;
                单选下键入即取代选项选择,多选下与已选共存(一并提交)。Enter 提交,Shift+Enter 换行。 */}
            <textarea
              value={draft.custom}
              disabled={busy !== null}
              autoFocus={!hasOptions}
              placeholder={hasOptions
                ? (question.multi_select === true ? "自定义答案(可与已选共存)" : "自定义答案(键入即取代选项)")
                : "输入你的答案"}
              rows={2}
              onChange={(e) => updateDraft((cur) => ({
                ...cur,
                selected: question.multi_select === true ? cur.selected : [],
                custom: e.target.value,
                skipped: false,
              }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !isComposing(e)) { e.preventDefault(); continueFlow(); }
              }}
              className="w-full resize-none rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[length:var(--font-size-sm)] text-[var(--color-fg)] outline-none whitespace-pre-wrap"
              style={{
                background: draft.custom !== "" ? "color-mix(in srgb, var(--color-primary) 6%, transparent)" : "var(--color-bg)",
              }}
            />
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

/** 结算后：摘要展示交互结果；展开体逐题渲染「问句 + 选项（选中高亮）+ 答案」
 *  （ask-design §9：问句/选项来自 toolCall.args.questions——模型入参一直在场）。 */
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

  // 问句与答案按 id 连接:args.questions 是模型出题原文(含选项),answers 里 id 回显
  const argsQuestions = argsQuestionsOf(toolCall);
  const answerOf = (id: string) => result?.find((a) => a.id === id);
  // 展开条目:优先出题原文顺序;args 缺失(异常)时退化为答案列表
  const rows: { key: string; question?: Question; answer?: { id: string; selected?: string[]; custom?: string } }[] =
    argsQuestions.length > 0
      ? argsQuestions.map((q) => ({ key: q.id, question: q, answer: answerOf(q.id) }))
      : (result ?? []).map((a) => ({ key: a.id, answer: a }));

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
      {!collapsed && rows.length > 0 && (
        <div className="mt-1 rounded-[var(--radius-md)] p-2.5 text-[length:var(--font-size-sm)] space-y-2.5"
          style={{ background: "color-mix(in srgb, var(--color-bg) 55%, var(--color-border))" }}>
          {rows.map(({ key, question, answer }) => {
            const selected = answer?.selected ?? [];
            const custom = answer?.custom ?? "";
            return (
              <div key={key} className="space-y-1">
                {/* 问句正文(有出题原文)或 id 兜底 */}
                <div className="text-[var(--color-fg)] break-words leading-snug">
                  {question ? question.question : key}
                </div>
                {/* 选项列表:选中高亮 */}
                {(question?.options ?? []).map((opt) => {
                  const hit = selected.includes(opt.label);
                  return (
                    <div key={opt.label} className="flex items-start gap-1.5 pl-2"
                      style={{ color: hit ? "var(--color-primary)" : "var(--color-muted)" }}>
                      <span aria-hidden className="mt-0.5 shrink-0">{hit ? "☑" : "☐"}</span>
                      <span className="min-w-0 break-words">{opt.label}</span>
                    </div>
                  );
                })}
                {/* 自定义答案 / 跳过标记 */}
                {custom !== "" && (
                  <div className="pl-2 text-[var(--color-fg)] break-all">(wrote) {custom}</div>
                )}
                {selected.length === 0 && custom === "" && (
                  <div className="pl-2 text-[var(--color-muted)]">(skipped)</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
