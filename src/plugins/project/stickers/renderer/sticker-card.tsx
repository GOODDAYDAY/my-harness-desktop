// 贴纸卡(展示)+ 就地编辑器(新建/编辑共用)—— 面板与设置页两个视图共用的共享子组件。
// 视觉是便利贴:StickerCard 提供倾斜/胶带/图钉/软投影(见 sticker.tsx),banner 图在标题上方。
// 编辑器:banner 上传入口(ctx.dialog.openImages,单张 10MB) + 标题 + 内容,保存/取消即时落盘。

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Globe, Folder, ImagePlus, Loader2, Pencil, Send, TextCursorInput, Trash2, X } from "lucide-react";
import { PanelIconButton, usePluginContext } from "@pi-desktop/react";
import type { PluginContext } from "@pi-desktop/contract";
import { StickerCard } from "./sticker";
import type { LayeredSticker } from "../client/stickers-store";

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
function bannerMime(banner: string): string {
  const i = banner.lastIndexOf(".");
  if (i === -1) return "image/png";
  return IMAGE_MIME[banner.slice(i + 1).toLowerCase()] ?? "image/png";
}

/** 读 banner 文件 → data URI(卡片/选择器/填输入框共用;文件缺失返回 null)。 */
export function useBannerDataUri(banner: string | undefined): string | null {
  const ctx = usePluginContext();
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUri(null);
    if (!banner) return;
    void ctx.configFile.readBinary(banner).then((b64) => {
      if (alive && b64) setUri(`data:${bannerMime(banner)};base64,${b64}`);
    });
    return () => { alive = false; };
  }, [ctx, banner]);
  return uri;
}

/** 事件/回调里读 banner → data URI(非 hook 版本,填输入框时用)。 */
export async function readBannerDataUri(ctx: PluginContext, banner: string): Promise<string | null> {
  const b64 = await ctx.configFile.readBinary(banner);
  if (!b64) return null;
  return `data:${bannerMime(banner)};base64,${b64}`;
}

/** 复制到剪贴板 + 1.5s 勾态反馈：卡片(面板)与行(设置页)两处复用，收敛一处。 */
export function useCopyFeedback(text: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback((): void => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, [text]);
  return { copied, copy };
}

interface StickerDisplayProps {
  sticker: LayeredSticker;
  /** 主点击(面板=发送；设置页不传)。 */
  onActivate?: () => void;
  /** 主点击被禁用时的原因（tooltip），如"等待当前回复完成"。 */
  activateDisabledReason?: string | null;
  sending?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  /** 层间迁移：project→global 传"设为全局"，global→project 传"移到项目"。 */
  onMoveLayer?: () => void;
  /** 加入输入框(不发送，供用户改后手动发；面板传)。 */
  onFillComposer?: () => void;
  /** 展开态(设置页网格用)：展示全文 + 操作行，由外层控制。 */
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** 展开态操作行里的"发送进会话"（设置页传；面板点击即发送，不需要）。 */
  onSend?: () => void;
  sendDisabledReason?: string | null;
  /** 不渲染 hover 浮钮（设置页网格：一切操作收进展开态操作行）。 */
  hideHoverActions?: boolean;
  /** 外层容器附加样式(如设置页网格的最小高度)。 */
  style?: CSSProperties;
}

export function StickerDisplay({ sticker, onActivate, activateDisabledReason, sending, onEdit, onDelete, onMoveLayer, onFillComposer, expanded, onToggleExpand, onSend, sendDisabledReason, hideHoverActions, style }: StickerDisplayProps): ReactNode {
  const { t } = useTranslation();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { copied, copy: copyContent } = useCopyFeedback(sticker.content);
  const bannerUri = useBannerDataUri(sticker.banner);
  const disabled = Boolean(activateDisabledReason);
  const sendDisabled = Boolean(sendDisabledReason);
  return (
    <div
      className="group relative"
      onClick={() => {
        if (!disabled && !sending && onActivate) onActivate();
        else if (onToggleExpand) onToggleExpand();
      }}
      title={activateDisabledReason ?? undefined}
      style={{
        cursor: onActivate ? (disabled ? "not-allowed" : "pointer") : onToggleExpand ? "pointer" : undefined,
        opacity: disabled ? 0.6 : 1,
        ...style,
      }}
    >
      <StickerCard noteId={sticker.id}>
        <div className="flex gap-2 min-w-0">
          {/* 左侧竖排标题(书脊式):窄条竖排,像贴纸的侧标 */}
          {sticker.title && (
            <div
              className="shrink-0 text-[length:var(--font-size-sm)] font-semibold text-[var(--color-fg)] leading-tight"
              style={{ writingMode: "vertical-rl", textOrientation: "mixed", maxHeight: "6.5rem", overflow: "hidden" }}
            >
              {sticker.title}
            </div>
          )}
          <div className="min-w-0 flex-1">
            {/* banner 图:主视觉,缩小展示;无标题时上方带 sending 指示 */}
            {bannerUri && (
              <img src={bannerUri} alt={sticker.title ?? "贴纸图"} className="w-full max-h-20 object-cover rounded-[var(--radius-sm)] mb-1.5" />
            )}
            {sending && <Loader2 className="size-3.5 animate-spin text-[var(--color-muted)] mb-1" />}
            <div
              className={`whitespace-pre-wrap break-words text-[var(--color-muted)] ${bannerUri || sticker.title ? "text-xs" : "text-[length:var(--font-size-sm)]"}`}
              style={expanded ? undefined : { display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}
            >
              {sticker.content}
            </div>
          {expanded && (
            <div className="flex items-center flex-wrap gap-1.5 mt-2" onClick={(e) => e.stopPropagation()}>
              {onSend && (
                <button
                  className={actionBtnClass}
                  title={sendDisabledReason ?? undefined}
                  onClick={() => { if (!sendDisabled && !sending) onSend(); }}
                >
                  {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}{t("stickers.sendToSession")}
                </button>
              )}
              {onEdit && (
                <button className={actionBtnClass} onClick={onEdit}><Pencil className="size-3.5" />编辑</button>
              )}
              <button className={actionBtnClass} onClick={copyContent}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? "已复制" : "复制"}
              </button>
              {onMoveLayer && (
                <button className={actionBtnClass} onClick={onMoveLayer}>
                  {sticker.layer === "project" ? <Globe className="size-3.5" /> : <Folder className="size-3.5" />}
                  {sticker.layer === "project" ? "设为全局" : "移到项目"}
                </button>
              )}
              {onDelete && (
                <button
                  className={actionBtnClass}
                  onClick={() => {
                    if (confirmingDelete) {
                      setConfirmingDelete(false);
                      onDelete();
                    } else {
                      setConfirmingDelete(true);
                    }
                  }}
                >
                  <Trash2 className="size-3.5" />{confirmingDelete ? "确认删除？" : "删除"}
                </button>
              )}
            </div>
          )}
          </div>
        </div>
        {/* 层徽标:左下角小字,不占卡片主体空间(像便利贴的角落标注) */}
        <span
          className="absolute bottom-1.5 left-2 text-[10px] leading-none text-[var(--color-muted)] opacity-70"
          title={sticker.layer === "global" ? "全局层：所有项目可见（存在 ~/.pi-desktop/）" : "项目层：仅当前项目可见（存在项目目录 .pi-desktop/），可“设为全局”分享给所有项目"}
        >
          {sticker.layer === "global" ? "全局" : "项目"}
        </span>
        {/* hover 操作钮右下角浮出：收进贴纸内部跟着一起歪；展开态由操作行接管不重复渲染 */}
        {!expanded && !hideHoverActions && (
          <div
            className="absolute bottom-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            <PanelIconButton title={copied ? "已复制" : "复制内容"} onClick={copyContent}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </PanelIconButton>
            {onFillComposer && (
              <PanelIconButton title="加入输入框（不发送，可改后再发）" onClick={onFillComposer}>
                <TextCursorInput className="size-3.5" />
              </PanelIconButton>
            )}
            {onMoveLayer && (
              <PanelIconButton title={sticker.layer === "project" ? "设为全局" : "移到项目"} onClick={onMoveLayer}>
                {sticker.layer === "project" ? <Globe className="size-3.5" /> : <Folder className="size-3.5" />}
              </PanelIconButton>
            )}
            {onEdit && (
              <PanelIconButton title="编辑" onClick={onEdit}>
                <Pencil className="size-3.5" />
              </PanelIconButton>
            )}
            {onDelete && (
              <PanelIconButton
                title={confirmingDelete ? "确认删除？" : "删除"}
                danger
                onClick={() => {
                  if (confirmingDelete) {
                    setConfirmingDelete(false);
                    onDelete();
                  } else {
                    setConfirmingDelete(true);
                  }
                }}
              >
                <Trash2 className="size-3.5" />
              </PanelIconButton>
            )}
          </div>
        )}
      </StickerCard>
    </div>
  );
}

const actionBtnClass = "flex items-center gap-1 px-2 py-1 text-xs rounded-[var(--radius-xs)] border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent cursor-pointer";

export interface StickerDraft {
  title: string;
  content: string;
  /** 变更后的 banner:{base64,mimeType}=新上传,null=移除,缺省=不动。 */
  banner?: { base64: string; mimeType: string } | null;
}

interface StickerEditorProps {
  initial: StickerDraft & { existingBanner?: string };
  onSave: (draft: StickerDraft) => void | Promise<void>;
  onCancel: () => void;
}

/** 就地编辑卡：banner 上传/预览/移除 + 标题 + 内容，保存/取消即时落盘（manual 语义）。
 *  编辑器不歪不装饰——输入中的卡面要稳。 */
export function StickerEditor({ initial, onSave, onCancel }: StickerEditorProps): ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [title, setTitle] = useState(initial.title);
  const [content, setContent] = useState(initial.content);
  // 新上传的图(替换既有 banner);null 且 initial.existingBanner 在 = 移除;两者皆无 = 不动
  const [uploaded, setUploaded] = useState<{ base64: string; mimeType: string } | null>(null);
  const [removed, setRemoved] = useState(false);
  const [saving, setSaving] = useState(false);
  const existingUri = useBannerDataUri(removed ? undefined : initial.existingBanner);
  const preview = uploaded ? `data:${uploaded.mimeType};base64,${uploaded.base64}` : existingUri;

  const pickBanner = async (): Promise<void> => {
    const imgs = await ctx.dialog.openImages();
    if (imgs.length === 0) return;
    const img = imgs[0];
    setUploaded({ base64: img.data, mimeType: img.mimeType });
    setRemoved(false);
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    try {
      const draft: StickerDraft = { title, content };
      if (uploaded) draft.banner = uploaded;
      else if (removed) draft.banner = null;
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <StickerCard>
      {preview ? (
        <div className="relative mb-1.5">
          <img src={preview} alt="banner 预览" className="w-full max-h-28 object-cover rounded-[var(--radius-sm)]" />
          <button
            type="button"
            title="移除图片"
            onClick={() => { setUploaded(null); setRemoved(true); }}
            className="absolute top-1 right-1 flex items-center justify-center size-5 rounded-full border-none bg-[var(--color-bg)]/80 text-[var(--color-muted)] hover:text-[var(--color-fg)] cursor-pointer"
          >
            <X className="size-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void pickBanner()}
          className="w-full flex items-center justify-center gap-1 py-1.5 mb-1.5 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent cursor-pointer text-xs"
        >
          <ImagePlus className="size-3.5" />上传 banner 图（可选）
        </button>
      )}
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("stickers.titlePlaceholder")}
        autoFocus
        className="w-full bg-transparent border-0 border-b border-[var(--color-border)] px-0 py-1 text-[length:var(--font-size-sm)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary)]"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={t("stickers.contentPlaceholder")}
        rows={4}
        className="w-full bg-transparent border-0 px-0 py-1.5 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none resize-y"
      />
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-2.5 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer"
        >
          {t("stickers.cancel")}
        </button>
        <button
          onClick={() => void save()}
          disabled={saving}
          className="px-2.5 py-1 text-xs rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] border-none cursor-pointer disabled:opacity-40"
        >
          {saving ? t("stickers.saving") : t("stickers.save")}
        </button>
      </div>
    </StickerCard>
  );
}
