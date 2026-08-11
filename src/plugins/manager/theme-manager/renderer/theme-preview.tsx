// 主题预览卡 —— 迷你会话窗口:用户气泡/助手行内代码/bash 卡片/药丸输入条。
//
// 薄壳合规:插件不能 import shell 的 message-list/composer,故按其 var 消费
// 模式逐一复刻(同一批 CSS 变量、同一 color-mix 压深手法),视觉即真身。
// 预览主题经 ctx.themes.build 合并后注入本卡子树的 CSS 变量——var() 就近
// 解析,与 documentElement 上的全局主题隔离,预览不换全局。
// 字号/间距/圆角/阴影全走预览主题 token:密度、形态、层级差异直接可见。
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, Terminal } from "lucide-react";
import { ListItem, useUiStore, usePluginContext } from "@pi-desktop/react";

/** 主题对象 → CSS 变量 style 对象(color.bg → --color-bg,与 theme-context 同一映射)。 */
function themeToCssVars(theme: Record<string, string>): CSSProperties {
  const style: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme)) style[`--${k.replace(/\./g, "-")}`] = v;
  return style as CSSProperties;
}

export interface ThemePreviewCardProps {
  themeId: string;
  label: string;
  active: boolean;
  onSelect: () => void;
}

export function ThemePreviewCard({ themeId, label, active, onSelect }: ThemePreviewCardProps): ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const fontScale = useUiStore((s) => s.fontScale);
  const fontMonoChoice = useUiStore((s) => s.fontMonoChoice);
  const fontEnglishChoice = useUiStore((s) => s.fontEnglishChoice);
  const fontChineseChoice = useUiStore((s) => s.fontChineseChoice);
  const [vars, setVars] = useState<CSSProperties>({});

  // 用当前字体偏好合并预览主题:所见即"应用后"的样子
  useEffect(() => {
    let alive = true;
    void ctx.themes.build(themeId, fontScale, fontMonoChoice, fontEnglishChoice, fontChineseChoice).then((th) => {
      if (alive) setVars(themeToCssVars(th));
    });
    return () => { alive = false; };
  }, [ctx, themeId, fontScale, fontMonoChoice, fontEnglishChoice, fontChineseChoice]);

  return (
    <ListItem
      active={active}
      onClick={onSelect}
      style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)", padding: "var(--spacing-sm)" }}
    >
      <div
        style={{
          ...vars,
          height: "240px",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--color-border)",
          background: "var(--color-bg)",
          color: "var(--color-fg)",
          fontFamily: "var(--font-family-sans)",
          fontSize: "var(--font-size-base)",
          pointerEvents: "none",
        }}
      >
        {/* 迷你页签条 */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", padding: "var(--spacing-xs) var(--spacing-sm)", borderBottom: "1px solid var(--color-border)", flexShrink: 0 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-border)" }} />
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-border)" }} />
          <span style={{ marginLeft: "var(--spacing-xs)", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>session · main</span>
        </div>

        {/* 迷你消息流 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", padding: "var(--spacing-sm)" }}>
          {/* 用户气泡(message-list 的 28px 药丸为硬编码形态,复刻) */}
          <div style={{ alignSelf: "flex-end", maxWidth: "80%", borderRadius: "28px", background: "var(--color-surface)", padding: "var(--spacing-xs) var(--spacing-sm)", lineHeight: 1.4 }}>
            {t("settings.previewUserBubble")}
          </div>
          {/* 助手行:正文 + 行内代码(markdown.tsx 的 surface 底 mono 片,复刻) */}
          <div style={{ lineHeight: 1.5 }}>
            {t("settings.previewAssistantBefore")}
            <code style={{ background: "var(--color-surface)", borderRadius: "var(--radius-sm)", fontFamily: "var(--font-family-mono)", fontSize: "0.875em", padding: "1px 6px" }}>core</code>
            {t("settings.previewAssistantAfter")}
          </div>
          {/* bash 卡片(message-list bashExecution:color-mix 压深 + radius-lg,复刻;成功行展示语义色) */}
          <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-lg)", background: "color-mix(in srgb, var(--color-bg) 55%, black)", padding: "var(--spacing-xs) var(--spacing-sm)", fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
              <Terminal size={12} style={{ color: "var(--color-muted)" }} />
              <span>$ pi --version</span>
            </div>
            <div style={{ color: "var(--color-muted)", marginTop: 2 }}>0.90.2 · rpc mode</div>
            <div style={{ color: "var(--color-accent-success)" }}>{t("settings.previewBashSuccess")}</div>
          </div>
        </div>

        {/* 迷你输入条(composer 药丸:surface + shadow-md + 圆形发送键,复刻) */}
        <div style={{ marginTop: "auto", padding: "var(--spacing-xs) var(--spacing-sm)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", borderRadius: "28px", border: "1px solid var(--color-border)", background: "var(--color-surface)", boxShadow: "var(--shadow-md)", padding: "6px var(--spacing-sm)" }}>
            <span style={{ flex: 1, color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>{t("settings.previewComposer")}</span>
            <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, borderRadius: "50%", background: "var(--color-primary)", color: "var(--color-primary-fg)" }}>
              <ArrowUp size={12} strokeWidth={2.5} />
            </span>
          </div>
        </div>
      </div>

      {/* 名称行(全局主题渲染) */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", fontSize: "var(--font-size-sm)" }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", border: active ? "2px solid var(--color-primary)" : "1px solid var(--color-border)", flexShrink: 0 }} />
        {label}
      </div>
    </ListItem>
  );
}
