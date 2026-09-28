import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MessageSquarePlus } from "lucide-react";
import { usePluginContext, useSessionStore, useCurrentScopeKey, type AuxBlock, type AuxBlockParser } from "@my-harness-desktop/react";
import type { SessionSlot } from "@my-harness-desktop/shared";
import type { ReviewComment } from "../core/basket";
import { useReviewBasket } from "./use-basket";
import { ReviewBasketBar } from "./basket-bar";

export { ReviewBasketBar };
export type { ReviewComment };

// 会话作用域槽(设计 docs/design/session-scope.md §3.3.1):评论篮按会话隔离,物化搬迁用
// concat(壳期入篮的评论追加到真身已有评论之后)——这正是旧实现手写那 17 行 prevKeyRef
// 迁移的语义,现在由框架 carry 承担,插件不再自己侦测会话键变化。
export const sessionSlots: SessionSlot[] = [
  { id: "basket", initial: () => [] as ReviewComment[], carry: "concat" },
];

interface EditorState {
  anchorMessageId?: string;
  quoteText: string;
  /** 浮层定位(选区下缘左点):编辑器挂在划中文本正下方,不是消息块末尾。 */
  pos: { left: number; top: number };
}

const NUMS = ["①","②","③","④","⑤","⑥","⑦","⑧","⑨"];
const numOf = (i: number): string => NUMS[i] ?? String(i + 1);
const truncate = (s: string, n: number): string => {
  const f = s.replace(/\s+/g, " ").trim();
  return f.length > n ? f.slice(0, n) + "…" : f;
};

export const channels = [] as const;

// ── 结构化 review 块:构造/解析/转义同源,契约单源(设计 docs/design/aux-block-mechanism.md §6) ──
// 块格式 <review> + <item seq quote>comment</item> 条目;文本与属性对称转义。
//
// ⚠ 标签名曾是 `<pi-review>`（r27 改为中性的 `<review>`）。这是**内核身份泄漏**：
//   review 是通用壳插件，评论篮对任何内核都适用，而块文本是**拼进 prompt 发给当前内核**的——
//   于是 dsh / minimal 会话里也会收到一个以 pi 命名的标签（违反 CLAUDE.md §1.4 无特权差异）。
//   改名必须**向后兼容**：标签随 prompt 落进了会话文件，历史消息里全是 `<pi-review>`，
//   解析方若只认新标签，老会话的评论块就会退化成裸文本显示。所以解析正则同时认两种，
//   并用**反向引用** `\1` 要求开闭标签一致（不接受 `<review>…</pi-review>` 这种错配）。

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
function unescape(s: string): string {
  return s.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** 评论篮 → 结构化块文本(发送时经 sendSuffix 附加;模型看到带结构的条目,渲染层解析引用条)。
 *  promptHeader 是模型侧引导语(i18n key shell.reviewPromptHeader):在 items 之前一行,
 *  不在 <item> 里,对渲染层透明、只对模型可见(设计 §6.2)。
 *  导出供 DOM 交互测试(review-basket.dom.test)直测结构(零测试缺口补全)。 */
export function buildReviewBlock(comments: ReviewComment[], promptHeader: string): string {
  if (comments.length === 0) return "";
  const items = comments.map((c, i) =>
    `<item seq="${numOf(i)}" quote="${escapeAttr(c.quote)}">${escapeText(c.comment)}</item>`,
  );
  return `<review>\n${promptHeader}\n${items.join("\n")}\n</review>`;
}

export interface ReviewAuxData {
  count: number;
  items: { seq: string; quote?: string; comment: string }[];
}

/** review 块解析器(auxParsers 代码级声明,plugins-host 加载时注册):matchAll 扫描提取
 *  全部完整块,start/end 由 m.index 精确给出(契约硬化,不再让机制猜边界);
 *  块边界正则放宽换行硬依赖,拼接格式微调不再裸显。 */
export const auxParsers: AuxBlockParser[] = [
  {
    id: "review",
    parse(text: string) {
      // `\1` 是开标签的反向引用：新标签 `<review>` 与历史标签 `<pi-review>` 都认，
      // 但必须开闭一致（错配的残缺标签按正文处理，见 review.md Q7 的同款纪律）。
      // ⚠ 捕获组序号因加了标签名组而**整体后移**：inner 从 m[1] 变成 m[2]。
      const re = /<(pi-review|review)>\s*([\s\S]*?)\s*<\/\1>/g;
      const blocks: AuxBlock[] = [];
      for (const m of text.matchAll(re)) {
        const inner = m[2] ?? "";
        const items: ReviewAuxData["items"] = [];
        const itemRe = /<item seq="([^"]*)"(?: quote="([^"]*)")?>([\s\S]*?)<\/item>/g;
        for (const im of inner.matchAll(itemRe)) {
          items.push({
            seq: im[1] ?? "",
            quote: im[2] !== undefined ? unescape(im[2]) : undefined,
            comment: unescape(im[3] ?? "").trim(),
          });
        }
        blocks.push({
          type: "review",
          data: { count: items.length, items } satisfies ReviewAuxData,
          start: m.index,
          end: m.index + m[0].length,
        });
      }
      return blocks.length > 0 ? { blocks } : null;
    },
  },
];

/** review 块引用条渲染器(blockRenderers 槽 auxBlock/review,props 契约 {aux})。
 *  引用条形态:无边框、每条评论一行横排、seq(accent) + ❝quote(斜体截断) +
 *  → + comment,靠右对齐,默认逐条可见(设计 §8.2)。无展开态、无点击跳转。 */
export function ReviewAuxBlock({ aux }: { aux: AuxBlock }): React.ReactNode {
  const data = aux.data as ReviewAuxData;
  if (!data.items?.length) return null;
  return (
    <div className="flex justify-end mt-1">
      <div className="flex flex-col gap-1 items-end max-w-full">
        {data.items.map((it, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[length:var(--font-size-xs)] text-[var(--color-muted)] max-w-full">
            <span className="text-[var(--color-primary)] font-medium flex-none">{it.seq}</span>
            {it.quote && <span className="italic truncate min-w-0">❝{it.quote}</span>}
            <span className="flex-none">→</span>
            <span className="truncate min-w-0">{it.comment}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function msgOfSelection(sel: Selection): Element | null {
  const node = sel.anchorNode;
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  return el?.closest?.("[data-message-id]") ?? null;
}

export function Overlay(): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [floatState, setFloatState] = useState<{ visible: boolean; x: number; y: number }>({ visible: false, x: 0, y: 0 });
  const lastSelRef = useRef<{ messageId?: string; quoteText: string; left: number; bottom: number } | null>(null);

  // 评论篮来自会话作用域槽:切会话自动换档,不再手拼 sessionKey(设计 §2.1.1 身份单源)。
  const basket = useReviewBasket();
  const comments = basket.comments;
  const lastSendNonce = useSessionStore((s) => s.lastSendNonce);
  // sessionKey 仍要发给 timeline(composerAttachments 的 payload 契约里带它,BasketBar
  // 据此按域操作);但它是**读出来的**,不是拼出来的——身份算法单源在圆心。
  const sessionKey = useCurrentScopeKey() ?? "";

  const pushState = useCallback(() => {
    if (!sessionKey) return;
    const items = comments.map((c, i) => ({
      id: c.id,
      seq: numOf(i),
      messageId: c.messageId,
      quotePreview: truncate(c.quote, 60),
      comment: c.comment,
    }));
    // timeline 不在场(加载失败/被绕过 dependsOn 禁用)时 invoke 抛错:悬浮层静默降级,
    // 不把异常甩进共享 React 树(Q3 对称:timeline 调 review 的通道同样 try/catch)。
    try {
      ctx.events.invoke("timeline:composerAttachments", {
        sessionKey,
        items,
        promptFragment: buildReviewBlock(comments, t("shell.reviewPromptHeader", { defaultValue: "以下是用户对之前回复的评论,请据此修改:" })),
        // 新评论编辑器在本组件浮层自渲染(锚定选区),只给 timeline 互斥信号
        editorActive: editor != null,
      });
    } catch { /* 评论表面不可用,浮条与本地状态照常 */ }
  }, [ctx, sessionKey, comments, editor, t]);

  useEffect(() => { pushState(); }, [pushState]);

  // 发送完成收尾(设计 §5.2):框架 store 的 lastSendNonce 递增 = 发送成功——
  // 清空当前篮子(替代旧 review:sent 通道回执,timeline 不再 invoke review)。
  useEffect(() => {
    if (lastSendNonce === 0) return;
    if (sessionKey) basket.clear();
    // deps 只放 lastSendNonce:清空要按「发送成功那一刻」触发,不随篮子内容变化重跑
    // (否则入篮就会触发一次清空判定)。basket.clear 引用稳定(useCallback),放进去也无害。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSendNonce]);

  useEffect(() => {
    // streaming 重渲染会瞬时摧毁选区(DOM 替换):塌陷不立即隐藏,给 400ms 宽限——
    // 期间选区恢复(流式 chunk 间隙)则按钮保住;真取消选择 400ms 后消失,体感无差。
    // 同时缓存最近有效选区:浮钮点击时活选区已死也能取到引用文本(流式消息上评论的前提)。
    let hideTimer: number | null = null;
    const onSelChange = (): void => {
      const sel = window.getSelection();
      const valid = !!sel && !sel.isCollapsed && !!sel.toString().trim() && !!msgOfSelection(sel);
      if (!valid) {
        if (hideTimer == null) {
          hideTimer = window.setTimeout(() => {
            hideTimer = null;
            lastSelRef.current = null;
            setFloatState((p) => p.visible ? { visible: false, x: 0, y: 0 } : p);
          }, 400);
        }
        return;
      }
      if (hideTimer != null) { clearTimeout(hideTimer); hideTimer = null; }
      const msgEl = msgOfSelection(sel!);
      const rect = sel!.getRangeAt(0).getBoundingClientRect();
      lastSelRef.current = {
        messageId: msgEl?.getAttribute("data-message-id") ?? undefined,
        quoteText: truncate(sel!.toString(), 500),
        left: rect.left,
        bottom: rect.bottom,
      };
      setFloatState({ visible: true, x: rect.right, y: rect.top });
    };
    document.addEventListener("selectionchange", onSelChange);
    const onScroll = (): void => {
      if (floatState.visible) onSelChange();
    };
    const timeline = document.querySelector("[data-virtuoso-scroller]") ?? document;
    timeline.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (hideTimer != null) clearTimeout(hideTimer);
      document.removeEventListener("selectionchange", onSelChange);
      timeline.removeEventListener("scroll", onScroll);
    };
  }, [floatState.visible]);

  // 新评论入篮的唯一逻辑:浮层编辑器直接调(owner 内部操作,不再需要 submitNew 通道)。
  const addComment = useCallback((p: { anchorMessageId?: string; quoteText: string; comment: string }): void => {
    const comment: ReviewComment = {
      id: crypto.randomUUID(),
      messageId: p.anchorMessageId,
      quote: truncate(p.quoteText, 500),
      comment: p.comment,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    basket.add(comment);
    setEditor(null);
  }, [basket]);

  // Enter = 确认入篮 + 焦点移交 composer(随后 composer 里 Enter 发送,两段式)。
  // timeline 不在场时 invoke 抛错:静默降级为仅入篮,焦点不动,与现状一致。
  const confirmAndFocus = useCallback((p: { anchorMessageId?: string; quoteText: string; comment: string }): void => {
    addComment(p);
    try { ctx.events.invoke("timeline:focusComposer", {}); } catch { /* timeline 不在场:仅入篮 */ }
  }, [ctx, addComment]);

  const onFloatClick = useCallback((): void => {
    // 活选区优先;流式重渲染已摧毁活选区时回落缓存(宽限期内按钮仍可见,点击必须有效)
    const sel = window.getSelection();
    const live = sel && !sel.isCollapsed && !!sel.toString().trim()
      ? (() => {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          return {
            messageId: msgOfSelection(sel)?.getAttribute("data-message-id") ?? undefined,
            quoteText: truncate(sel.toString(), 500),
            left: rect.left,
            bottom: rect.bottom,
          };
        })()
      : null;
    const use = live ?? lastSelRef.current;
    if (!use) return;
    lastSelRef.current = null;
    // 编辑器挂在选中文本正下方(选区下缘左点),视口边界内收敛
    const EDITOR_W = 420;
    const EDITOR_H = 180;
    setEditor({
      anchorMessageId: use.messageId,
      quoteText: use.quoteText,
      pos: {
        left: Math.max(8, Math.min(use.left, window.innerWidth - EDITOR_W - 8)),
        top: Math.max(8, Math.min(use.bottom + 8, window.innerHeight - EDITOR_H)),
      },
    });
    setFloatState({ visible: false, x: 0, y: 0 });
    sel?.removeAllRanges();
  }, []);

  // 物化搬迁(壳键 → 真身 ns)由框架 carry 承担:篮子槽声明 carry:"concat",
  // 与草稿/队列在同一时刻同步搬完。此处此前是 17 行 prevKeyRef 手写迁移——与框架
  // carrySessionKey 同一逻辑的第二份实现,且时序不同(渲染后异步 vs 换键同步),
  // 两者之间有一个窗口:那个窗口里入篮的评论会与搬来的草稿混在一起(设计 §1.3.2)。
  // 删除它的守卫:audit:session-scope 检查③(插件目录里出现 prevKeyRef 即违规,§3.5.3)。


  // 两个浮层共存:划词按钮(选区右上)与新评论编辑器(选区正下方)。
  const btnW = 76;
  const btnH = 26;
  const top = Math.max(8, floatState.y - btnH - 8);
  const left = Math.max(8, Math.min(floatState.x - btnW, window.innerWidth - btnW - 8));

  // 浮层语言与 toast/卡片一致(surface 底 + 细边框 + shadow-md),动作语言与
  // message-actions 一致(muted 字、hover 升 fg + accent 边框)——全部吃主题 token。
  return (
    <>
      {floatState.visible && createPortal(
        <button
          className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[length:var(--font-size-xs)] text-[var(--color-muted)] shadow-[var(--shadow-md)] hover:border-[var(--color-primary)] hover:text-[var(--color-fg)] cursor-pointer select-none"
          style={{ position: "fixed", top: `${top}px`, left: `${left}px`, zIndex: 9999 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onFloatClick}
        >
          <MessageSquarePlus className="size-3.5" />
          {t("shell.comment")}
        </button>,
        document.body,
      )}
      {editor && createPortal(
        <div style={{ position: "fixed", top: editor.pos.top, left: editor.pos.left, zIndex: 9999, width: 420, maxWidth: "calc(100vw - 16px)" }}>
          <FloatingCommentEditor
            key={`${editor.anchorMessageId ?? ""}:${editor.quoteText}`}
            quoteText={editor.quoteText}
            onSubmit={(comment) => confirmAndFocus({ anchorMessageId: editor.anchorMessageId, quoteText: editor.quoteText, comment })}
            onCancel={() => setEditor(null)}
          />
        </div>,
        document.body,
      )}
    </>
  );
}

/** 新评论浮动输入卡(锚定选区正下方):draft 收在本组件,提交/取消才动状态,
 *  打字零事件流量;key 随锚定消息与引文变化即重置,切目标不串草稿。
 *  键位语义:Enter = 确认入篮(焦点移交 composer,再按 Enter 发送);失焦 = 仅入篮;Esc = 取消。 */
function FloatingCommentEditor({ quoteText, onSubmit, onCancel }: {
  quoteText: string;
  /** Enter:确认入篮 */
  onSubmit: (comment: string) => void;
  onCancel: () => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  // 终结动作幂等闸:Enter 确认后焦点移交 composer,textarea 同步失焦会再触发一次
  // onBlur 提交路径——无闸时同一评论入篮两次。submit/cancel 谁先到谁生效,回声作废。
  const doneRef = useRef(false);
  const submit = (comment: string): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    onSubmit(comment);
  };
  const cancel = (): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-primary)] border-l-2 bg-[var(--color-surface)] p-3 shadow-[var(--shadow-md)]">
      <div className="text-[var(--color-muted)] italic text-[length:var(--font-size-xs)] mb-2 max-h-12 overflow-hidden">❝ {quoteText}</div>
      <textarea
        autoFocus
        className="w-full bg-transparent text-[var(--color-fg)] text-[length:var(--font-size-sm)] resize-none outline-none border-none"
        rows={3}
        placeholder={t("shell.placeholder")}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const comment = draft.trim();
          if (comment) submit(comment); else cancel();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            const comment = draft.trim();
            if (!comment) return;
            submit(comment);
          }
          if (e.key === "Escape") cancel();
        }}
      />
    </div>
  );
}
