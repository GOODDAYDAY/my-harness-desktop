// 字体 tab:字号倍率 + mono/英文/中文三组字体选择 + 实时示例 + 本插件设置(showFontPreview)。
//
// 字体选项来源改查 fontPresets 槽(ctx.fonts.list() → registry.fontPresetsItems()):
// 选项集合是内容(由 font-presets 等插件贡献),本页不再静态 import 常量列表——
// 新增字体选项 = 第三方插件往 manifest 加一条,本页自动可见,内核一行不动。
// 文案走 i18n(t(p.labelKey)),语言包由贡献方自己的 languages 槽供给。
//
// 经 @pi-desktop/react 受控 API(守薄壳 H1:不直连 shell):
// - 字体偏好(fontScale/fontMonoChoice/fontEnglishChoice/fontChineseChoice)→ useUiStore(落 electron-store)
// - 插件自身偏好(showFontPreview)→ usePluginContext().config(落 plugins-data)
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useUiStore,
  SettingsSection,
  usePluginContext,
  type SettingsComponentProps,
} from "@pi-desktop/react";
import type { FontPresetContribution } from "@pi-desktop/contract";

interface ThemeManagerConfig {
  showFontPreview?: boolean;
}
const DEFAULT_CONFIG: ThemeManagerConfig = { showFontPreview: true };

const stackCodeStyle: React.CSSProperties = {
  display: "block",
  marginTop: "var(--spacing-sm)",
  padding: "var(--spacing-xs) var(--spacing-sm)",
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-xs)",
  color: "var(--color-muted)",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  userSelect: "text",
};

/** 按钮预览的回落后缀:按钮字体 = {stack}, {previewSuffix}——等宽落 monospace、
 *  英文落 sans-serif、中文落 serif(按钮是独立预览,栈不是栈尾时不带 generic)。 */
const PREVIEW_SUFFIX: Record<FontPresetContribution["category"], string> = {
  mono: "monospace",
  english: "sans-serif",
  chinese: "serif",
};

/** 分组标题 i18n key。 */
const GROUP_TITLE_KEY: Record<FontPresetContribution["category"], string> = {
  mono: "settings.monoFont",
  english: "settings.englishFont",
  chinese: "settings.chineseFont",
};

export function FontTab({ refreshSignal }: Pick<SettingsComponentProps, "refreshSignal">): React.ReactNode {
  const { t } = useTranslation();
  const { fontScale, fontMonoChoice, fontEnglishChoice, fontChineseChoice, setFontScale, setFontMonoChoice, setFontEnglishChoice, setFontChineseChoice, setFontPreviewDragging } = useUiStore();
  const ctx = usePluginContext();
  const [fontItems, setFontItems] = useState<FontPresetContribution[]>([]);
  const [showFontPreview, setShowFontPreview] = useState<boolean>(DEFAULT_CONFIG.showFontPreview!);

  // 查 fontPresets 槽:选项集合由插件贡献,本页只渲染。字体选项随插件增删,刷新即重查。
  useEffect(() => {
    void ctx.fonts.list().then(setFontItems);
  }, [ctx, refreshSignal]);

  useEffect(() => {
    void ctx.config
      .get<boolean>("showFontPreview")
      .then((v) => setShowFontPreview(v ?? DEFAULT_CONFIG.showFontPreview!));
  }, [ctx, refreshSignal]);

  const toggleFontPreview = async (on: boolean): Promise<void> => {
    try {
      await ctx.config.set("showFontPreview", on, { scope: "global" });
      setShowFontPreview(on);
    } catch (err) {
      console.error("[theme-manager] 写配置失败,已回滚", err);
    }
  };

  // 按 category 分组渲染(声明序即展示序,保注册序)
  const groups: { category: FontPresetContribution["category"]; items: FontPresetContribution[] }[] = [
    { category: "mono", items: fontItems.filter((p) => p.category === "mono") },
    { category: "english", items: fontItems.filter((p) => p.category === "english") },
    { category: "chinese", items: fontItems.filter((p) => p.category === "chinese") },
  ];

  const choiceOf = (category: FontPresetContribution["category"]): string =>
    category === "mono" ? fontMonoChoice : category === "english" ? fontEnglishChoice : fontChineseChoice;
  const setChoiceOf = (category: FontPresetContribution["category"]): ((id: string) => void) =>
    category === "mono" ? setFontMonoChoice : category === "english" ? setFontEnglishChoice : setFontChineseChoice;

  // 当前选中的字体栈(示例区实时渲染用),取不到时回落全局 token
  const monoStack = fontItems.find((p) => p.category === "mono" && p.id === fontMonoChoice)?.stack ?? "var(--font-family-mono)";
  const englishItem = fontItems.find((p) => p.category === "english" && p.id === fontEnglishChoice);
  const chineseItem = fontItems.find((p) => p.category === "chinese" && p.id === fontChineseChoice);
  // sans 栈与 merge.ts 同构的三段拼接:英文段 + 中文段 + generic(中文段的回落方向)。
  // 仅在两项都命中时展示拼接(偏好里存了无效 id 时回落全局 token,与主题合并的兜底同语义)。
  const sansStack = englishItem && chineseItem
    ? [englishItem.stack, chineseItem.stack, chineseItem.generic ?? "sans-serif"].join(", ")
    : "var(--font-family-sans)";

  return (
    <>
      <SettingsSection title={t("settings.font")} description={t("settings.fontDesc")}>
        <div>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>
            {t("settings.fontScale")} · {fontScale.toFixed(2)}
          </div>
          <div style={{ width: "100%", boxSizing: "border-box" }}>
            <input type="range" min={0.5} max={2} step={0.05} value={fontScale}
              onChange={(e) => setFontScale(Number(e.target.value))}
              onPointerDown={() => setFontPreviewDragging(true)}
              onPointerUp={() => setFontPreviewDragging(false)}
              style={{ width: "100%" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
              <span>{t("settings.fontSmall")}</span><span>{t("settings.fontLarge")}</span>
            </div>
          </div>
        </div>

        {groups.map(({ category, items }) => (
          <div key={category}>
            <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-sm)" }}>{t(GROUP_TITLE_KEY[category])}</div>
            <div style={{ display: "flex", gap: "var(--spacing-sm)", flexWrap: "wrap" }}>
              {items.map((p) => {
                const selected = choiceOf(category) === p.id;
                return (
                  <button key={p.id} title={p.stack} onClick={() => setChoiceOf(category)(p.id)}
                    style={{ padding: "var(--spacing-xs) var(--spacing-md)",
                      border: `1px solid ${selected ? "var(--color-primary)" : "var(--color-border)"}`,
                      borderRadius: "var(--radius-sm)",
                      background: selected ? "var(--color-surface)" : "transparent",
                      color: "var(--color-fg)", cursor: "pointer",
                      fontFamily: `${p.stack}, ${PREVIEW_SUFFIX[category]}`, fontSize: "var(--font-size-sm)" }}>
                    {t(p.labelKey)}
                  </button>
                );
              })}
            </div>
            <code style={stackCodeStyle}>
              {category === "mono" ? monoStack : sansStack}
            </code>
          </div>
        ))}
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
