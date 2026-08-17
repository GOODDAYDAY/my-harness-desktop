// pi-model-manager 导入弹窗 —— 粘贴/选文件读入 models.json 片段,校验后干跑合并出预览报告,
// 确认把 merged 交父组件走框架 onChange(导入本身不落盘,dirty/save 由框架统一管)。
// 弹窗形态与 llm-recorder record-modal 同款:fixed backdrop + stopPropagation 面板 + Esc/背景/× 关闭。
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button, usePluginContext } from "@pi-desktop/react";
import { mergeModelsConfig, type ModelsConfig, type ModelsMergeReport, type ProviderConfig } from "@pi-desktop/contract";

type ParseResult =
  | { ok: true; config: ModelsConfig }
  | { ok: false; key: "empty" | "json" | "shape"; detail?: string };

/** 导入文本解析:宽容两层形状(带 providers 包装 / 整个对象即 providers),严校验最小形状
 *  (provider 是对象、models 是数组、model 有 string id);model 缺 name 补 id——导入方常只写 id。
 *  其余字段原样透传(底座宽容忽略未知字段,不在此逐字段校验)。 */
function parseImportText(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, key: "empty" };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, key: "json", detail: e instanceof Error ? e.message : String(e) };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, key: "shape", detail: "root is not an object" };
  }
  const boxed = raw as Record<string, unknown>;
  const providers = (typeof boxed.providers === "object" && boxed.providers !== null ? boxed.providers : boxed) as Record<string, unknown>;
  if (Array.isArray(providers)) return { ok: false, key: "shape", detail: "providers is an array" };
  for (const [pid, p] of Object.entries(providers)) {
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      return { ok: false, key: "shape", detail: `providers.${pid} is not an object` };
    }
    const models = (p as Record<string, unknown>).models;
    if (models !== undefined && !Array.isArray(models)) {
      return { ok: false, key: "shape", detail: `providers.${pid}.models is not an array` };
    }
    for (const [i, m] of ((models as unknown[]) ?? []).entries()) {
      if (typeof m !== "object" || m === null || typeof (m as Record<string, unknown>).id !== "string") {
        return { ok: false, key: "shape", detail: `providers.${pid}.models[${i}] has no string id` };
      }
      const mm = m as Record<string, unknown>;
      if (typeof mm.name !== "string") mm.name = mm.id;
    }
  }
  return { ok: true, config: { providers: providers as Record<string, ProviderConfig> } };
}

export function ImportModal({ config, onConfirm, onClose }: {
  config: ModelsConfig;
  onConfirm: (merged: ModelsConfig) => void;
  onClose: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ merged: ModelsConfig; report: ModelsMergeReport } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // config 引用变化(弹窗开着时框架刷新重读了 models.json)则作废旧预览——
  // preview.merged 基于旧 base,此时确认会盖掉新读入的内容;清掉强制重新校验。
  useEffect(() => { setPreview(null); }, [config]);

  const onTextChange = (v: string): void => {
    setText(v);
    setError(null);
    setPreview(null); // 文本变了预览即失效,重新校验——防拿旧报告的 merged 合新文本
  };

  const pickFile = async (): Promise<void> => {
    try {
      const file = await ctx.dialog.openTextFile({ filters: [{ name: "JSON", extensions: ["json"] }] });
      if (file) onTextChange(file.content);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPreview(null);
    }
  };

  const validate = (): void => {
    const parsed = parseImportText(text);
    if (!parsed.ok) {
      setPreview(null);
      setError(
        parsed.key === "empty" ? t("models.importEmpty")
          : parsed.key === "json" ? t("models.importBadJson", { error: parsed.detail })
            : t("models.importBadShape", { detail: parsed.detail }),
      );
      return;
    }
    setError(null);
    setPreview(mergeModelsConfig(config, parsed.config));
  };

  const reportZero = preview
    && preview.report.providersAdded === 0 && preview.report.providersMerged === 0
    && preview.report.modelsAdded === 0 && preview.report.modelsMerged === 0;

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <span style={{ fontWeight: 600 }}>{t("models.importTitle")}</span>
          <button onClick={onClose} title={t("models.importCancel")} style={closeBtnStyle}>
            <X size={16} />
          </button>
        </div>
        <div style={{ padding: "var(--spacing-md)", display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", minHeight: 0 }}>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("models.importDesc")}</div>
          <textarea
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            placeholder='{"providers": {"my-provider": {"baseUrl": "https://...", "apiKey": "sk-...", "models": [{"id": "model-id"}]}}}'
            spellCheck={false}
            style={{
              flex: 1, minHeight: "200px", resize: "vertical",
              padding: "var(--spacing-sm)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
              background: "var(--color-surface)", color: "var(--color-fg)",
              fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)", boxSizing: "border-box",
            }}
          />
          {error && <div style={{ color: "var(--color-accent-error)", fontSize: "var(--font-size-sm)", wordBreak: "break-all" }}>{error}</div>}
          {preview && (
            <div style={{ color: "var(--color-accent-success)", fontSize: "var(--font-size-sm)" }}>
              {t("models.importReport", { ...preview.report })}
            </div>
          )}
          <div style={{ display: "flex", gap: "var(--spacing-sm)", justifyContent: "flex-end", flexShrink: 0 }}>
            <Button variant="secondary" onClick={() => void pickFile()}>{t("models.importSelectFile")}</Button>
            <Button variant="secondary" onClick={validate} disabled={!text.trim()}>{t("models.importValidate")}</Button>
            <Button
              variant="primary"
              disabled={!preview || !!reportZero}
              onClick={() => { if (preview) { onConfirm(preview.merged); onClose(); } }}
            >
              {t("models.importConfirm")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

const backdropStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0, 0, 0, 0.5)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
};

const panelStyle: React.CSSProperties = {
  width: "min(640px, 92vw)", maxHeight: "min(560px, 86vh)",
  display: "flex", flexDirection: "column",
  background: "var(--color-bg)", border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-lg, 0 8px 32px rgba(0,0,0,0.4))",
};

const headerStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "var(--spacing-sm) var(--spacing-md)",
  borderBottom: "1px solid var(--color-border)", flexShrink: 0,
  fontSize: "var(--font-size-sm)",
};

const closeBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 24, height: 24, border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)", cursor: "pointer", flexShrink: 0,
};
