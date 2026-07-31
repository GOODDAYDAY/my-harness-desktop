// 字体 tab:字号倍率 + mono/sans 字体选择 + 实时示例 + 本插件设置(showFontPreview)。
//
// 经 @pi-desktop/react 受控 API(守薄壳 H1:不直连 shell):
// - 字体偏好(fontScale/fontMonoChoice/fontSansTone)→ useUiStore(落 electron-store)
// - 插件自身偏好(showFontPreview)→ usePluginContext().config(落 plugins-data)
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useUiStore,
  SettingsSection,
  MONO_CHOICES,
  SANS_TONES,
  usePluginContext,
  type SettingsComponentProps,
} from "@pi-desktop/react";

interface ThemeManagerConfig {
  showFontPreview?: boolean;
}
const DEFAULT_CONFIG: ThemeManagerConfig = { showFontPreview: true };

export function FontTab({ refreshSignal }: Pick<SettingsComponentProps, "refreshSignal">): React.ReactNode {
  const { t } = useTranslation();
  const { fontScale, fontMonoChoice, fontSansTone, setFontScale, setFontMonoChoice, setFontSansTone } = useUiStore();
  const ctx = usePluginContext();
  const [showFontPreview, setShowFontPreview] = useState<boolean>(DEFAULT_CONFIG.showFontPreview!);

  useEffect(() => {
    void ctx.config
      .get<boolean>("showFontPreview")
      .then((v) => setShowFontPreview(v ?? DEFAULT_CONFIG.showFontPreview!));
  }, [ctx, refreshSignal]);

  const toggleFontPreview = async (on: boolean): Promise<void> => {
    try {
      await ctx.config.set("showFontPreview", on);
      setShowFontPreview(on);
    } catch (err) {
      console.error("[theme-manager] 写配置失败,已回滚", err);
    }
  };

  // 当前选中的字体栈(示例区实时渲染用),取不到时回落全局 token
  const monoStack = MONO_CHOICES.find((c) => c.id === fontMonoChoice)?.stack ?? "var(--font-family-mono)";
  const sansStack = SANS_TONES.find((tone) => tone.id === fontSansTone)?.stack ?? "var(--font-family-sans)";

  return (
    <>
      <SettingsSection title={t("settings.font")} description={t("settings.fontDesc")}>
        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
            {t("settings.fontScale")} · {fontScale.toFixed(2)}
          </div>
          <div style={{ width: "100%", boxSizing: "border-box" }}>
            <input type="range" min={0.5} max={2} step={0.05} value={fontScale}
              onChange={(e) => setFontScale(Number(e.target.value))} style={{ width: "100%" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
              <span>{t("settings.fontSmall")}</span><span>{t("settings.fontLarge")}</span>
            </div>
          </div>
        </div>

        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>{t("settings.monoFont")}</div>
          <div style={{ display: "flex", gap: "var(--spacing-sm)", flexWrap: "wrap" }}>
            {MONO_CHOICES.map((c) => {
              const selected = fontMonoChoice === c.id;
              return (
                <button key={c.id} onClick={() => setFontMonoChoice(c.id as typeof fontMonoChoice)}
                  style={{ padding: "var(--spacing-xs) var(--spacing-md)",
                    border: `1px solid ${selected ? "var(--color-primary)" : "var(--color-border)"}`,
                    borderRadius: "var(--radius-sm)",
                    background: selected ? "var(--color-surface)" : "transparent",
                    color: "var(--color-fg)", cursor: "pointer",
                    fontFamily: c.stack, fontSize: "var(--font-size-sm)" }}>
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>{t("settings.sansTone")}</div>
          <div style={{ display: "flex", gap: "var(--spacing-sm)", flexWrap: "wrap" }}>
            {SANS_TONES.map((tone) => {
              const selected = fontSansTone === tone.id;
              return (
                <button key={tone.id} onClick={() => setFontSansTone(tone.id as typeof fontSansTone)}
                  style={{ padding: "var(--spacing-xs) var(--spacing-md)",
                    border: `1px solid ${selected ? "var(--color-primary)" : "var(--color-border)"}`,
                    borderRadius: "var(--radius-sm)",
                    background: selected ? "var(--color-surface)" : "transparent",
                    color: "var(--color-fg)", cursor: "pointer",
                    fontFamily: tone.stack, fontSize: "var(--font-size-sm)" }}>
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </SettingsSection>

      {showFontPreview && (
        <SettingsSection title={t("settings.fontExample")}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
            <div>
              <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", marginBottom: "var(--spacing-xs)" }}>
                {t("settings.monoExample")}
              </div>
              <pre
                style={{
                  fontFamily: monoStack,
                  fontSize: "var(--font-size-sm)",
                  lineHeight: 1.6,
                  margin: 0,
                  color: "var(--color-fg)",
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-md)",
                  padding: "var(--spacing-md)",
                  whiteSpace: "pre-wrap",
                }}
              >
{`const sessions = await pi.sessions.list({ cwd });
for (const s of sessions) console.log(s.name);`}
              </pre>
            </div>
            <div>
              <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", marginBottom: "var(--spacing-xs)" }}>
                {t("settings.sansExample")}
              </div>
              <p
                style={{
                  fontFamily: sansStack,
                  fontSize: "var(--font-size-base)",
                  lineHeight: 1.7,
                  margin: 0,
                  color: "var(--color-fg)",
                }}
              >
                {t("settings.fontSampleText")}
              </p>
            </div>
          </div>
        </SettingsSection>
      )}

      <SettingsSection title={t("settings.pluginOwn")} description={t("settings.pluginOwnDesc")}>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
          <input type="checkbox" checked={showFontPreview} onChange={(e) => void toggleFontPreview(e.target.checked)} />
          <span style={{ fontSize: "var(--font-size-sm)" }}>{t("settings.showFontPreview")}</span>
        </label>
      </SettingsSection>
    </>
  );
}
