// baseUrl 输入 —— 手动输入为主,下拉选已有为辅:输入不自动展开(粘贴 URL 是高频动作,自动弹出
// 会闪),chevron 点击或 ↓ 键才开面板;打开时展示全量候选,开着继续输入才按 includes 过滤。
// 候选 = 其他 provider 的非空 baseUrl 去重,右侧标注来源(多家同 URL 以 · 连接)。
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import type { ProviderConfig } from "@pi-desktop/contract";

export function BaseUrlInput({ value, onChange, providers, selfId, style }: {
  value: string;
  onChange: (v: string) => void;
  providers: Record<string, ProviderConfig>;
  selfId: string;
  style?: React.CSSProperties;
}): ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  // 打开那一刻的输入值:过滤只在"开着且输入变了"时生效——点开面板应看到全量候选,
  // 若直接拿当前值过滤,输入框里已是完整 URL 时会把所有候选滤光、面板永远空白。
  const [openedWith, setOpenedWith] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const options = useMemo(() => {
    const byUrl = new Map<string, string[]>();
    for (const [pid, p] of Object.entries(providers)) {
      if (pid === selfId) continue;
      const url = p.baseUrl?.trim();
      if (!url) continue;
      byUrl.set(url, [...(byUrl.get(url) ?? []), pid]);
    }
    return [...byUrl.entries()].map(([url, from]) => ({ url, from }));
  }, [providers, selfId]);

  const filtered = useMemo(() => {
    if (!open || value === openedWith) return options;
    const q = value.trim().toLowerCase();
    return q ? options.filter((o) => o.url.toLowerCase().includes(q)) : options;
  }, [options, value, open, openedWith]);

  // 过滤结果收窄后高亮越界则收回来(输入过滤是候选变化的唯一来源)
  useEffect(() => {
    setActiveIdx((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (url: string): void => {
    if (url !== value) onChange(url); // 同值不调 onChange——选了等于没选,不该把页面标 dirty
    setOpen(false);
  };

  const toggleOpen = (): void => {
    setActiveIdx(0);
    setOpenedWith(value);
    setOpen((v) => !v);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (options.length === 0) return;
      e.preventDefault();
      if (!open) {
        toggleOpen();
        return;
      }
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActiveIdx((i) => (i + delta + filtered.length) % Math.max(1, filtered.length));
    } else if (e.key === "Enter" && open) {
      const target = filtered[activeIdx];
      if (target) {
        e.preventDefault();
        pick(target.url);
      }
    } else if (e.key === "Escape" && open) {
      e.stopPropagation(); // 关面板即可,别冒泡触发外层的 Esc(如弹窗关闭)
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} style={{ position: "relative", flex: 1, minWidth: 0, display: "flex" }}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        style={{ ...style, paddingRight: options.length > 0 ? "28px" : style?.paddingRight }}
        placeholder="baseUrl"
        spellCheck={false}
      />
      {options.length > 0 && (
        <button
          onClick={toggleOpen}
          title={t("models.baseUrlPick")}
          aria-label={t("models.baseUrlPick")}
          style={{
            position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 22, border: "none", borderRadius: "var(--radius-sm)",
            background: "transparent", color: "var(--color-muted)", cursor: "pointer",
          }}
        >
          <ChevronDown size={14} />
        </button>
      )}
      <AnimatePresence>
        {open && filtered.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            style={{
              position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 1000,
              transformOrigin: "top",
              background: "var(--color-surface)", border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-md)",
              maxHeight: "200px", overflowY: "auto", padding: "var(--spacing-xs) 0",
            }}
          >
            {filtered.map((o, i) => (
              <button
                key={o.url}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => pick(o.url)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--spacing-sm)",
                  width: "100%", padding: "var(--spacing-xs) var(--spacing-md)",
                  border: "none", cursor: "pointer", textAlign: "left",
                  background: i === activeIdx ? "var(--color-bg)" : "transparent",
                  color: "var(--color-fg)", outline: "none",
                }}
              >
                <span style={{
                  fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {o.url}
                </span>
                <span style={{
                  color: "var(--color-muted)", fontSize: "var(--font-size-xs)",
                  flexShrink: 0, maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {o.from.join(" · ")}
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
