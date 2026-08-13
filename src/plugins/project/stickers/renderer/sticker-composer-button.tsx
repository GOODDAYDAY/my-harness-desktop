// StickerComposerButton —— composerActions 槽贡献的表情包快速入口按钮 + 网格选择器。
// 按钮渲染进 composer 底部工具栏的 children(设计 docs/design/sticker-plugin.md §5)。
// 点击弹选择器:网格铺贴纸(banner 图/标题),↑↓←→ 导航、Enter 直接发、Esc 关;
// 每格 hover 出「加入输入框」小按钮(复用 stickers:fillComposer 通道,走 timeline 挂图)。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Smile, TextCursorInput } from "lucide-react";
import { usePluginContext, useSessionStore, useUiStore } from "@pi-desktop/react";
import { loadStickers, type LayeredSticker } from "../client/stickers-store";
import { readBannerDataUri, useBannerDataUri } from "./sticker-card";

/** 选择器单格:优先 banner 图,无图显示标题/内容摘要;选中高亮,hover 出「加入输入框」。 */
function StickerCell({ sticker, selected, onSelect, onSend, onFill }: {
  sticker: LayeredSticker;
  selected: boolean;
  onSelect: () => void;
  onSend: () => void;
  onFill: () => void;
}): ReactNode {
  const uri = useBannerDataUri(sticker.banner);
  const label = sticker.title || sticker.content.split("\n")[0] || "贴纸";
  return (
    <div
      className="group relative cursor-pointer rounded-[var(--radius-sm)] border overflow-hidden"
      style={{
        width: 72, height: 72,
        borderColor: selected ? "var(--color-primary)" : "var(--color-border)",
        outline: selected ? "1px solid var(--color-primary)" : "none",
        background: "var(--color-surface)",
      }}
      onClick={onSelect}
      onDoubleClick={onSend}
    >
      {uri ? (
        <img src={uri} alt={label} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-center px-1 text-[length:var(--font-size-xs)] text-[var(--color-fg)]">
          <span className="line-clamp-3">{label}</span>
        </div>
      )}
      {/* hover「加入输入框」:覆盖在格子上缘,可见性优先(设计 §5.2) */}
      <div className="absolute inset-x-0 top-0 flex justify-center opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          title="加入输入框（不发送，可改后再发）"
          onClick={(e) => { e.stopPropagation(); onFill(); }}
          className="mt-1 flex items-center gap-0.5 px-1.5 py-0.5 rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-bg)]/90 text-[var(--color-muted)] hover:text-[var(--color-fg)] text-[length:var(--font-size-xs)] cursor-pointer"
        >
          <TextCursorInput className="size-3" />加入
        </button>
      </div>
    </div>
  );
}

export function StickerComposerButton(): ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const cwd = useUiStore((s) => s.currentCwd);
  const streaming = useSessionStore((s) => s.streaming);
  const [open, setOpen] = useState(false);
  const [stickers, setStickers] = useState<LayeredSticker[]>([]);
  const [index, setIndex] = useState(0);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 打开时读一次贴纸(与面板/设置页同一份数据);settingsChanged 后重读。
  useEffect(() => {
    if (!open || !cwd) return;
    let alive = true;
    void loadStickers(ctx).then((list) => { if (alive) { setStickers(list); setIndex(0); } });
    const off = ctx.events.on("system:settingsChanged", () => {
      void loadStickers(ctx).then((list) => { if (alive) { setStickers(list); setIndex((i) => Math.min(i, Math.max(0, list.length - 1))); } });
    });
    return () => { alive = false; off(); };
  }, [open, cwd, ctx]);

  const openPicker = (): void => {
    if (!cwd || streaming) return;
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 8, left: r.left });
    }
    setOpen(true);
  };

  const send = useCallback(async (sticker: LayeredSticker): Promise<void> => {
    if (streaming || sendingId || !cwd) return;
    setSendingId(sticker.id);
    try {
      await useSessionStore.getState().sendMessage(
        cwd, sticker.content,
        sticker.banner ? { image: { src: sticker.banner, title: sticker.title } } : undefined,
      );
      setOpen(false);
    } finally {
      setSendingId(null);
    }
  }, [cwd, streaming, sendingId]);

  const fill = useCallback(async (sticker: LayeredSticker): Promise<void> => {
    const dataUri = sticker.banner ? await readBannerDataUri(ctx, sticker.banner) : undefined;
    ctx.events.emit("stickers:fillComposer", {
      text: sticker.content,
      image: sticker.banner ? { src: sticker.banner, title: sticker.title, dataUri: dataUri ?? undefined } : undefined,
    });
    setOpen(false);
  }, [ctx]);

  // 键盘导航:←↑→↓ 在网格移动(平铺回绕),Enter 直接发,Esc 关。
  useEffect(() => {
    if (!open || stickers.length === 0) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => (i + 1) % stickers.length); return; }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => (i - 1 + stickers.length) % stickers.length); return; }
      if (e.key === "Enter" && stickers[index]) { e.preventDefault(); void send(stickers[index]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, stickers, index, send]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={openPicker}
        title={t("stickers.composerEntry")}
        className="flex items-center justify-center size-8 rounded-full border-none bg-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)] cursor-pointer shrink-0"
      >
        <Smile className="size-5" />
      </button>
      {open && pos && (
        <PickerPortal
          pos={pos}
          onClose={() => setOpen(false)}
          title={t("stickers.composerEntry")}
          hint={t("stickers.pickerHint")}
        >
          {stickers.length === 0 ? (
            <div className="p-4 text-center text-[var(--color-muted)] text-[length:var(--font-size-xs)]">
              {t("stickers.pickerEmpty")}
            </div>
          ) : (
            <div className="grid gap-2 p-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(72px, 72px))" }}>
              {stickers.map((n, i) => (
                <StickerCell
                  key={n.id}
                  sticker={n}
                  selected={i === index}
                  onSelect={() => setIndex(i)}
                  onSend={() => void send(n)}
                  onFill={() => void fill(n)}
                />
              ))}
            </div>
          )}
        </PickerPortal>
      )}
    </>
  );
}

/** 选择器弹层(portal,锚在按钮下方):点击空白/Esc 关;外层处理键盘。 */
function PickerPortal({ pos, onClose, title, hint, children }: {
  pos: { top: number; left: number };
  onClose: () => void;
  title: string;
  hint: string;
  children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  // 点弹层外关闭(含按钮本体——第二次点按钮=关)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      style={{
        position: "fixed", top: pos.top, left: Math.max(8, pos.left), zIndex: 99999,
        maxWidth: "min(420px, calc(100vw - 16px))",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-lg)",
      }}
    >
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="text-[length:var(--font-size-sm)] font-medium text-[var(--color-fg)]">{title}</span>
        <span className="text-[length:var(--font-size-xs)] text-[var(--color-muted)]">{hint}</span>
      </div>
      <div className="max-h-72 overflow-y-auto">{children}</div>
      <div className="px-3 py-1.5 text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
        Enter 直接发 · ↑↓←→ 选择 · Esc 关闭 · 每格 hover「加入」= 加入输入框
      </div>
    </div>,
    document.body,
  );
}
