import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { usePluginContext, useUiStore } from "@pi-desktop/react";

interface ReviewComment {
  id: string;
  messageId?: string;
  role: string;
  quote: string;
  comment: string;
  createdAt: number;
  updatedAt: number;
}

interface EditorState {
  anchorMessageId?: string;
  quoteText: string;
  draft: string;
  commentId?: string;
}

const NUMS = ["①","②","③","④","⑤","⑥","⑦","⑧","⑨"];
const numOf = (i: number): string => NUMS[i] ?? String(i + 1);
const truncate = (s: string, n: number): string => {
  const f = s.replace(/\s+/g, " ").trim();
  return f.length > n ? f.slice(0, n) + "…" : f;
};

export const channels = [
  "review:submitNew", "review:submitEdit", "review:cancelEditor",
  "review:requestEdit", "review:remove", "review:clearAll", "review:sent",
] as const;

const CALLBACK_CHANNELS = {
  submitNew: "review:submitNew",
  submitEdit: "review:submitEdit",
  cancelEditor: "review:cancelEditor",
  requestEdit: "review:requestEdit",
  remove: "review:remove",
  clearAll: "review:clearAll",
  sent: "review:sent",
} as const;

function composePromptFragment(comments: ReviewComment[], t: (key: string, vars?: Record<string, unknown>) => string): string {
  if (comments.length === 0) return "";
  let frag = `\n\n---\n${t("shell.promptHeader")}\n`;
  comments.forEach((c, i) => {
    const seq = numOf(i);
    frag += `\n[${t("shell.commentLabel", { seq })}] ${t("shell.youWrote")}\n❝${c.quote}\n${t("shell.myOpinion")} ${c.comment}\n`;
  });
  return frag;
}

function composeEchoFragment(count: number, t: (key: string, vars?: Record<string, unknown>) => string): string {
  if (count === 0) return "";
  return t("shell.echoSuffix", { count });
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
  const currentSessionPath = useUiStore((s) => s.currentSessionPath);
  const currentCwd = useUiStore((s) => s.currentCwd);

  const [baskets, setBaskets] = useState<Map<string, ReviewComment[]>>(new Map());
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [floatState, setFloatState] = useState<{ visible: boolean; x: number; y: number }>({ visible: false, x: 0, y: 0 });

  const sessionKey = currentSessionPath ?? (currentCwd ? `new:${currentCwd}` : "");

  const pushState = useCallback(() => {
    if (!sessionKey) return;
    const comments = baskets.get(sessionKey) ?? [];
    const items = comments.map((c) => ({
      id: c.id,
      quotePreview: truncate(c.quote, 60),
      comment: c.comment,
    }));
    const promptFragment = composePromptFragment(comments, t);
    const echoFragment = composeEchoFragment(comments.length, t);
    ctx.events.invoke("timeline:composerAttachments", {
      sessionKey,
      items,
      promptFragment,
      echoFragment,
      editor,
      channels: CALLBACK_CHANNELS,
    });
  }, [ctx, sessionKey, baskets, editor, t]);

  useEffect(() => { pushState(); }, [pushState]);

  useEffect(() => {
    if (!sessionKey) return;
    const comments = baskets.get(sessionKey) ?? [];
    if (comments.length === 0 && !editor) return;
    const off = ctx.events.on("system:settingsChanged", () => { pushState(); });
    return off;
  }, [ctx, sessionKey, baskets, editor, pushState]);

  useEffect(() => {
    const onSelChange = (): void => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setFloatState((p) => p.visible ? { visible: false, x: 0, y: 0 } : p);
        return;
      }
      const msgEl = msgOfSelection(sel);
      if (!msgEl) {
        setFloatState((p) => p.visible ? { visible: false, x: 0, y: 0 } : p);
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setFloatState({ visible: true, x: rect.right, y: rect.top });
    };
    document.addEventListener("selectionchange", onSelChange);
    const onScroll = (): void => {
      if (floatState.visible) onSelChange();
    };
    const timeline = document.querySelector("[data-virtuoso-scroller]") ?? document;
    timeline.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("selectionchange", onSelChange);
      timeline.removeEventListener("scroll", onScroll);
    };
  }, [floatState.visible]);

  useEffect(() => {
    const offs: Array<() => void> = [];
    const tryOn = (ch: string, handler: (payload: unknown) => void): void => {
      try { offs.push(ctx.events.on(ch, handler)); } catch { /* timeline not loaded yet */ }
    };

    tryOn("review:submitNew", (payload) => {
      const p = payload as { anchorMessageId?: string; quoteText: string; comment: string };
      const comment: ReviewComment = {
        id: crypto.randomUUID(),
        messageId: p.anchorMessageId,
        role: "assistant",
        quote: truncate(p.quoteText, 500),
        comment: p.comment,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setBaskets((prev) => {
        const next = new Map(prev);
        const list = next.get(sessionKey) ?? [];
        next.set(sessionKey, [...list, comment]);
        return next;
      });
      setEditor(null);
    });

    tryOn("review:submitEdit", (payload) => {
      const p = payload as { commentId: string; comment: string };
      setBaskets((prev) => {
        const next = new Map(prev);
        const list = next.get(sessionKey) ?? [];
        next.set(sessionKey, list.map((c) => c.id === p.commentId ? { ...c, comment: p.comment, updatedAt: Date.now() } : c));
        return next;
      });
      setEditor(null);
    });

    tryOn("review:cancelEditor", () => { setEditor(null); });

    tryOn("review:requestEdit", (payload) => {
      const p = payload as { id: string };
      const list = baskets.get(sessionKey) ?? [];
      const c = list.find((c) => c.id === p.id);
      if (c) setEditor({ anchorMessageId: c.messageId, quoteText: c.quote, draft: c.comment, commentId: c.id });
    });

    tryOn("review:remove", (payload) => {
      const p = payload as { id: string };
      setBaskets((prev) => {
        const next = new Map(prev);
        const list = next.get(sessionKey) ?? [];
        next.set(sessionKey, list.filter((c) => c.id !== p.id));
        return next;
      });
      setEditor(null);
    });

    tryOn("review:clearAll", () => {
      setBaskets((prev) => {
        const next = new Map(prev);
        next.set(sessionKey, []);
        return next;
      });
      setEditor(null);
    });

    tryOn("review:sent", (payload) => {
      const p = payload as { sessionKey: string };
      setBaskets((prev) => {
        const next = new Map(prev);
        next.set(p.sessionKey, []);
        return next;
      });
      setEditor(null);
    });

    return () => { offs.forEach((off) => off()); };
  }, [ctx, sessionKey, baskets]);

  const onFloatClick = useCallback((): void => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const msgEl = msgOfSelection(sel);
    const messageId = msgEl?.getAttribute("data-message-id") ?? undefined;
    const quoteText = truncate(sel.toString(), 500);
    setEditor({ anchorMessageId: messageId, quoteText, draft: "" });
    setFloatState({ visible: false, x: 0, y: 0 });
    sel.removeAllRanges();
  }, []);

  useEffect(() => {
    setBaskets((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map<string, ReviewComment[]>();
      const seen = new Set<string>();
      for (const [key, list] of prev) {
        const newKey = key.startsWith("new:") && currentSessionPath ? currentSessionPath : key;
        if (!seen.has(newKey)) { next.set(newKey, list); seen.add(newKey); }
        else { next.set(newKey, [...(next.get(newKey) ?? []), ...list]); }
      }
      return next;
    });
  }, [currentSessionPath]);

  if (!floatState.visible) return null;

  const btnW = 80;
  const btnH = 28;
  const top = Math.max(8, floatState.y - btnH - 8);
  const left = Math.max(8, Math.min(floatState.x - btnW, window.innerWidth - btnW - 8));

  return createPortal(
    <button
      style={{
        position: "fixed", top: `${top}px`, left: `${left}px`, zIndex: 9999,
        display: "flex", alignItems: "center", gap: "4px", padding: "4px 12px",
        borderRadius: "999px", border: "none", background: "var(--color-accent, #89b4fa)",
        color: "var(--color-bg, #111118)", fontSize: "12px", fontWeight: 600,
        fontFamily: "inherit", cursor: "pointer", boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
        userSelect: "none",
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onFloatClick}
    >
      💬 {t("shell.comment")}
    </button>,
    document.body,
  );
}
