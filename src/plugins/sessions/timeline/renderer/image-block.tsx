// ImageBlock —— 会话流内置的图片展示(timeline 的通用消息能力)。
// custom 条目(customType:"image")的图是会话流天生支持的内容类型,不依赖任何插件
// 槽贡献(设计 docs/design/sticker-plugin.md §3 的"会话流通用图片展示"内置化)。
// 读 src(~/.pi-desktop 白名单逻辑路径) → base64 → 从扩展名推 mime → data URI → img;
// title 有则挂图下当说明行。IM 配图风格:随用户消息右对齐。
import { useEffect, useState, type ReactNode } from "react";
import { usePluginContext } from "@pi-desktop/react";
import { useTranslation } from "react-i18next";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

function mimeOf(src: string): string {
  const i = src.lastIndexOf(".");
  if (i === -1) return "image/png";
  return IMAGE_MIME[src.slice(i + 1).toLowerCase()] ?? "image/png";
}

export function ImageBlock({ src, title }: { src: string; title?: string }): ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [uri, setUri] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  useEffect(() => {
    let alive = true;
    setUri(null);
    setLost(false);
    void ctx.configFile
      .readBinary(src)
      .then((b64) => {
        if (!alive) return;
        if (b64) {
          setUri(`data:${mimeOf(src)};base64,${b64}`);
        } else {
          setLost(true);
        }
      })
.catch(() => { if (alive) setLost(true); });
    return () => { alive = false; };
  }, [ctx, src]);

  if (lost) {
    return (
      <div className="my-1 px-3 py-2 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border)] text-[var(--color-muted)] text-[length:var(--font-size-xs)]">
        {t("timeline.imageLost", { src })}
      </div>
    );
  }
  if (!uri) {
    return <div className="my-1 h-12 w-24 rounded-[var(--radius-sm)] bg-[var(--color-surface)] animate-pulse" />;
  }
  return (
    // IM 配图风格:随用户消息右对齐,图装在有边框的卡片里(背景/边框/投影保证可见),
    // 不依赖复杂 max-w 任意值(逗号在 Tailwind 任意值里可能解析异常)。
    <div className="my-1 flex justify-end">
      <div
        className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]"
        style={{ maxWidth: 420, boxShadow: "0 1px 3px rgba(0,0,0,.12)", background: "var(--color-surface)" }}
      >
        <img
          src={uri}
          alt={title ?? t("timeline.image")}
          onError={() => console.warn("[timeline] ImageBlock img 加载失败(破图/空白):", src, uri?.slice(0, 80))}
          className="w-full block"
          style={{ maxHeight: 288, objectFit: "contain" }}
        />
        {title && (
          <div className="px-2 py-1 text-[var(--color-muted)] text-[length:var(--font-size-xs)] text-right border-t border-[var(--color-border)]">
            {title}
          </div>
        )}
      </div>
    </div>
  );
}
