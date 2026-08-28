// settings.tsx —— 语音输入设置页:模型选择 + 按需下载。
//
// 模型权重不进 git(几十~几百 MB),这里提供「选模型 + 下载模型」入口:点下载主动触发
// transformers.js 从 HuggingFace Hub 拉权重并缓存到浏览器 Cache,二次使用离线命中。
// 不下载也能用——首次转写时引擎自动按需下载,此页只是把「下载」做成显式可预期动作。
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Download, Check } from "lucide-react";
import { usePluginContext, SettingsSection } from "@my-harness-desktop/react";
import {
  STT_MODELS, STT_LANGUAGES, DEFAULT_MODEL, getModelId, setModelId, getLanguage, setLanguage, downloadModel, type DownloadProgress,
} from "./stt-engine";

export function VoiceSettings(): ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [language, setLanguageId] = useState<string>("chinese");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    void getModelId(ctx).then(setModel);
    void getLanguage(ctx).then(setLanguageId);
  }, [ctx]);

  const choose = async (id: string): Promise<void> => {
    setModel(id);
    setDone(false);
    await setModelId(ctx, id);
  };

  const download = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setDone(false);
    setProgress({ status: "initiate" });
    try {
      await downloadModel(model, (p) => setProgress(p));
      setDone(true);
    } catch (err) {
      console.error("[voice-input] 模型下载失败:", err);
      setProgress({ status: "error" });
    } finally {
      setBusy(false);
    }
  };

  const pct = progress?.progress != null && progress.progress >= 0 && progress.progress <= 1
    ? Math.round(progress.progress * 100)
    : null;

  return (
    <SettingsSection
      title={t("voice.settingsTitle")}
      description={t("voice.settingsDesc")}
    >
      <div className="flex flex-col gap-3">
        {/* 模型选择 */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">{t("voice.modelLabel")}</span>
          <div className="flex flex-wrap gap-2">
            {STT_MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => void choose(m.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] border text-[length:var(--font-size-sm)] cursor-pointer ${
                  model === m.id
                    ? "border-[var(--color-primary)] text-[var(--color-fg)]"
                    : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                }`}
                style={model === m.id ? { background: "color-mix(in srgb, var(--color-primary) 12%, transparent)" } : { background: "transparent" }}
              >
                {model === m.id && <Check className="size-3.5" />}
                <span>{m.label}</span>
                <span className="text-[length:var(--font-size-xs)] opacity-70">{m.size}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 语言选择(Whisper 无自动检测,须显式指定) */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">{t("voice.languageLabel")}</span>
          <div className="flex flex-wrap gap-2">
            {STT_LANGUAGES.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => { setLanguageId(l.id); void setLanguage(ctx, l.id); }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] border text-[length:var(--font-size-sm)] cursor-pointer ${
                  language === l.id
                    ? "border-[var(--color-primary)] text-[var(--color-fg)]"
                    : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                }`}
                style={language === l.id ? { background: "color-mix(in srgb, var(--color-primary) 12%, transparent)" } : { background: "transparent" }}
              >
                {language === l.id && <Check className="size-3.5" />}
                <span>{l.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 下载 */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void download()}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] border-none bg-[var(--color-primary)] text-[var(--color-primary-fg)] text-[length:var(--font-size-sm)] cursor-pointer disabled:opacity-40"
          >
            <Download className="size-3.5" />
            {busy ? t("voice.downloading") : t("voice.download")}
          </button>
          {done && <span className="text-[length:var(--font-size-xs)] text-[var(--color-accent-success)]">{t("voice.downloaded")}</span>}
        </div>

        {/* 进度 */}
        {progress && progress.status !== "error" && progress.status !== "done" && (
          <div className="flex items-center gap-2 text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
            {pct != null && (
              <div className="h-1.5 flex-1 rounded-full overflow-hidden" style={{ background: "var(--color-border)" }}>
                <div className="h-full" style={{ width: `${pct}%`, background: "var(--color-primary)" }} />
              </div>
            )}
            <span>{progress.file ?? progress.status}</span>
            {pct != null && <span>{pct}%</span>}
          </div>
        )}
        {progress?.status === "error" && (
          <div className="text-[length:var(--font-size-xs)] text-[var(--color-accent-error)]">{t("voice.downloadFailed")}</div>
        )}

        <div className="text-[length:var(--font-size-xs)] text-[var(--color-muted)]">{t("voice.downloadHint")}</div>
      </div>
    </SettingsSection>
  );
}
