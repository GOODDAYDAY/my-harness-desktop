import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MessageSquarePlus } from "lucide-react";
import { create } from "zustand";
import { usePluginContext, useUiStore, SettingsSection, type SettingsComponentProps } from "@pi-desktop/react";

interface ReviewComment {
  id: string;
  messageId?: string;
  quote: string;
  comment: string;
  createdAt: number;
  updatedAt: number;
}

interface EditorState {
  anchorMessageId?: string;
  quoteText: string;
  draft: string;
}

const NUMS = ["①","②","③","④","⑤","⑥","⑦","⑧","⑨"];
const numOf = (i: number): string => NUMS[i] ?? String(i + 1);
const truncate = (s: string, n: number): string => {
  const f = s.replace(/\s+/g, " ").trim();
  return f.length > n ? f.slice(0, n) + "…" : f;
};

export const channels = [
  "review:submitNew", "review:submitEdit", "review:cancelEditor",
  "review:remove", "review:clearAll", "review:sent",
] as const;

const CALLBACK_CHANNELS = {
  submitNew: "review:submitNew",
  submitEdit: "review:submitEdit",
  cancelEditor: "review:cancelEditor",
  remove: "review:remove",
  clearAll: "review:clearAll",
  sent: "review:sent",
} as const;

/** 拼装格式(设置页可配,configFile 持久):空串 = 内置 i18n 默认。
 *  Overlay(发送拼装)与 ReviewConfigPage(设置页)经本 store 共享——
 *  设置页 onChange 即写,草稿态即生效;Overlay 挂载时从 config 水合。 */
interface ReviewFormat { promptHeader?: string; itemTemplate?: string }
const useFormatStore = create<{ format: ReviewFormat; setFormat: (f: ReviewFormat) => void }>((set) => ({
  format: {},
  setFormat: (format) => set({ format }),
}));

function composePromptFragment(comments: ReviewComment[], t: (key: string, vars?: Record<string, unknown>) => string, format: ReviewFormat): string {
  if (comments.length === 0) return "";
  const header = format.promptHeader?.trim() || t("shell.promptHeader");
  const itemTpl = format.itemTemplate?.trim() || "";
  let frag = `\n\n---\n${header}\n`;
  comments.forEach((c, i) => {
    const seq = numOf(i);
    if (itemTpl) {
      frag += "\n" + itemTpl
        .replaceAll("{seq}", seq)
        .replaceAll("{quote}", c.quote)
        .replaceAll("{comment}", c.comment) + "\n";
    } else {
      frag += `\n[${t("shell.commentLabel", { seq })}] ${t("shell.youWrote")}\n❝${c.quote}\n${t("shell.myOpinion")} ${c.comment}\n`;
    }
  });
  return frag;
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
  const format = useFormatStore((s) => s.format);

  const sessionKey = currentSessionPath ?? (currentCwd ? `new:${currentCwd}` : "");

  // 挂载即水合拼装格式(configFile 两层合并读,与设置页保存的是同一文件)
  useEffect(() => {
    void ctx.config.all().then((cfg) => {
      const c = (cfg ?? {}) as Record<string, unknown>;
      useFormatStore.getState().setFormat({
        promptHeader: String(c["promptHeader"] ?? ""),
        itemTemplate: String(c["itemTemplate"] ?? ""),
      });
    });
  }, [ctx]);

  const pushState = useCallback(() => {
    if (!sessionKey) return;
    const comments = baskets.get(sessionKey) ?? [];
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
        promptFragment: composePromptFragment(comments, t, format),
        editor,
        channels: CALLBACK_CHANNELS,
      });
    } catch { /* 评论表面不可用,浮条与本地状态照常 */ }
  }, [ctx, sessionKey, baskets, editor, t, format]);

  useEffect(() => { pushState(); }, [pushState]);

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

  // 回调通道订阅。deps 只到 sessionKey:全部 handler 走 setBaskets 函数式更新,
  // 不闭包读 baskets——篮子每次变化不再触发 6 通道重订阅。
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
    });

    tryOn("review:cancelEditor", () => { setEditor(null); });

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
  }, [ctx, sessionKey]);

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

  // 桶迁移只发生在"新会话首发落盘"一瞬:prevKey 是 new: 桶、当前拿到真实 sessionPath。
  // 新会话窗口无消息可选,new: 桶唯一非空来源是首发到水合间的 IPC 窗口;
  // path→path(打开旧会话/rewind fork)不迁——fork 后评论滞留原会话是写明的取舍(设计文档 §2.5)。
  const prevKeyRef = useRef("");
  useEffect(() => {
    const prevKey = prevKeyRef.current;
    prevKeyRef.current = sessionKey;
    if (!prevKey.startsWith("new:") || !currentSessionPath) return;
    setBaskets((prev) => {
      const draft = prev.get(prevKey);
      if (!draft?.length) return prev;
      const next = new Map(prev);
      next.delete(prevKey);
      next.set(currentSessionPath, [...(next.get(currentSessionPath) ?? []), ...draft]);
      return next;
    });
  }, [sessionKey, currentSessionPath]);

  if (!floatState.visible) return null;

  const btnW = 76;
  const btnH = 26;
  const top = Math.max(8, floatState.y - btnH - 8);
  const left = Math.max(8, Math.min(floatState.x - btnW, window.innerWidth - btnW - 8));

  // 浮层语言与 toast/卡片一致(surface 底 + 细边框 + shadow-md),动作语言与
  // message-actions 一致(muted 字、hover 升 fg + accent 边框)——全部吃主题 token。
  return createPortal(
    <button
      className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[length:var(--font-size-xs)] text-[var(--color-muted)] shadow-[var(--shadow-md)] hover:border-[var(--color-accent)] hover:text-[var(--color-fg)] cursor-pointer select-none"
      style={{ position: "fixed", top: `${top}px`, left: `${left}px`, zIndex: 9999 }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onFloatClick}
    >
      <MessageSquarePlus className="size-3.5" />
      {t("shell.comment")}
    </button>,
    document.body,
  );
}

const PLACEHOLDERS = [
  { token: "{seq}", descKey: "shell.phSeq" },
  { token: "{quote}", descKey: "shell.phQuote" },
  { token: "{comment}", descKey: "shell.phComment" },
] as const;

/** 评论设置页(settings 槽,manifest component 自动匹配):拼装格式两项可配。
 *  save/dirty/拦截/刷新由框架管(configFile 声明,§9.1),组件只报 onChange;
 *  改动经 format store 同步给 Overlay——草稿即生效,发送拼装所见即所得。 */
export function ReviewConfigPage({ refreshSignal, config, onChange }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const setFormat = useFormatStore((s) => s.setFormat);
  const promptHeader = String(config?.["promptHeader"] ?? "");
  const itemTemplate = String(config?.["itemTemplate"] ?? "");
  const itemRef = useRef<HTMLTextAreaElement>(null);

  // 草稿即生效的配对纪律:框架重读(保存落盘/丢弃回滚/外部变更)后,
  // format store 以文件真值重新对齐,丢弃的草稿不残留在拼装链路里。
  useEffect(() => {
    setFormat({ promptHeader: String(config?.["promptHeader"] ?? ""), itemTemplate: String(config?.["itemTemplate"] ?? "") });
  }, [refreshSignal, config, setFormat]);

  const update = (key: "promptHeader" | "itemTemplate", value: string): void => {
    const next = { ...(config ?? {}), [key]: value };
    onChange(next);
    setFormat({ promptHeader: String(next["promptHeader"] ?? ""), itemTemplate: String(next["itemTemplate"] ?? "") });
  };

  // mousedown preventDefault 保 textarea 焦点,点击 chip 时 selection 仍有效(删掉这行插入就退回追加)。
  const insertPlaceholder = (token: string): void => {
    const el = itemRef.current;
    const start = el?.selectionStart ?? itemTemplate.length;
    const end = el?.selectionEnd ?? itemTemplate.length;
    update("itemTemplate", itemTemplate.slice(0, start) + token + itemTemplate.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const controlClass = "w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-[length:var(--font-size-sm)] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]";
  const chipClass = "rounded-[var(--radius-sm)] border border-[var(--color-border)] px-1.5 py-0.5 text-[length:var(--font-size-xs)] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-fg)] cursor-pointer select-none";

  // "填入默认值"按钮仅空值时显示:非空时点击会覆盖用户草稿。
  const fieldLabelRow = (label: string, value: string, defaultValue: string, key: "promptHeader" | "itemTemplate"): React.ReactNode => (
    <div className="mb-1 flex items-center justify-between gap-2">
      <span className="text-[length:var(--font-size-sm)] font-medium">{label}</span>
      {!value.trim() && (
        <button type="button" className={chipClass} onClick={() => update(key, defaultValue)}>
          {t("shell.fillDefault")}
        </button>
      )}
    </div>
  );

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)" }}>
      <SettingsSection title={t("shell.formatSection")} description={t("shell.formatSectionDesc")}>
        <div className="flex flex-col gap-4">
          <div>
            {fieldLabelRow(t("shell.formatHeaderLabel"), promptHeader, t("shell.promptHeader"), "promptHeader")}
            <input
              className={controlClass}
              placeholder={t("shell.promptHeader")}
              value={promptHeader}
              onChange={(e) => update("promptHeader", e.target.value)}
            />
          </div>
          <div>
            {fieldLabelRow(t("shell.formatItemLabel"), itemTemplate, t("shell.formatItemPlaceholder"), "itemTemplate")}
            <textarea
              ref={itemRef}
              className={`${controlClass} resize-y font-mono`}
              rows={4}
              placeholder={t("shell.formatItemPlaceholder")}
              value={itemTemplate}
              onChange={(e) => update("itemTemplate", e.target.value)}
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
              <span>{t("shell.formatHint")}</span>
              {PLACEHOLDERS.map((ph) => (
                <span key={ph.token} className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    className={`${chipClass} font-mono`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertPlaceholder(ph.token)}
                  >
                    {ph.token}
                  </button>
                  <span>{t(ph.descKey)}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
