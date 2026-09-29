// ImageBlock —— 会话流内置的图片展示(timeline 的通用消息能力)。
// custom 条目(customType:"image")的图是会话流天生支持的内容类型,不依赖任何插件
// 槽贡献(设计 docs/design/sticker-plugin.md §3 的"会话流通用图片展示"内置化)。
// 读 src(~/.my-harness-desktop 白名单逻辑路径) → base64 → 从扩展名推 mime → data URI → img;
// IM 配图风格:随用户消息右对齐。
import { useEffect, useState, type ReactNode } from "react";
import { usePluginContext } from "@my-harness-desktop/react";
import { useTranslation } from "react-i18next";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

/** 由文件名的扩展名推 mime。
 *
 * r245 导出以便单测（此前是模块私有）：扩展名是**契约字段**（来自任意附件文件），
 * 而 IMAGE_MIME 是本文件内部的**兜底呈现表**——表外取值必然出现（任何非常见图片格式）。
 * 两者的容错方向相反（r241）：表可以缺项，契约字段不能因为表缺项就崩或产出空 mime。
 * 按 §4.5 的可测性判据（纯函数不该埋在组件文件里不可测），导出它。 */
export function mimeOf(src: string): string {
  const i = src.lastIndexOf(".");
  if (i === -1) return "image/png";
  return IMAGE_MIME[src.slice(i + 1).toLowerCase()] ?? "image/png";
}

export function ImageBlock({ src }: { src: string }): ReactNode {
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
        if (b64) setUri(`data:${mimeOf(src)};base64,${b64}`);
        else setLost(true);
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
    // IM 配图风格:随用户消息右对齐(用户气泡同侧),圆角 + 细边框 + 轻投影。
    <div className="my-1 flex justify-end">
      <img
        src={uri}
        alt={t("timeline.image")}
        className="max-w-[min(420px,100%)] max-h-72 rounded-[var(--radius-md)] border border-[var(--color-border)]"
        style={{ boxShadow: "0 1px 3px rgba(0,0,0,.12)" }}
      />
    </div>
  );
}
