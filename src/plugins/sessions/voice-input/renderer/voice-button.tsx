// voice-button.tsx —— composerVoice 槽贡献的语音输入按钮(麦克风 → 转写 → 回填文字)。
//
// 交互状态机:idle(麦克风图标)→ recording(红色脉冲,点击停止)→ transcribing(转写中)。
// 转写完成后调 onTranscribed(text) 把文字写回输入框(追加语义,用户改后手动发送,§5 核心)。
// 与 stickers 的「加入输入框」同一思路:插件只负责产出文字,「写进哪个输入框」由挂载点决定。
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Square, Loader2 } from "lucide-react";
import { usePluginContext, type ComposerVoiceProps } from "@my-harness-desktop/react";
import { MicRecorderImpl, isSilence, type MicRecorder } from "./audio";
import { transcribe } from "./stt-engine";

type VoiceState = "idle" | "recording" | "transcribing";

export function VoiceButton({ onTranscribed, disabled }: ComposerVoiceProps): ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MicRecorder | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashError = useCallback((msg: string): void => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(null), 4000);
  }, []);

  const toggle = useCallback(async (): Promise<void> => {
    if (disabled) return;
    if (state === "transcribing") return;

    if (state === "recording") {
      const rec = recorderRef.current;
      if (!rec) { setState("idle"); return; }
      recorderRef.current = null;
      try {
        setState("transcribing");
        const samples = await rec.stop();
        // 静音/纯音先拦一道:Whisper 会对静音幻觉出文字,不进引擎
        if (isSilence(samples)) {
          flashError(t("voice.empty"));
          return;
        }
        const text = await transcribe(ctx, samples);
        if (text) onTranscribed(text);
        else flashError(t("voice.empty"));
      } catch (err) {
        console.error("[voice-input] 转写失败:", err);
        flashError(t("voice.error"));
      } finally {
        rec.dispose();
        setState("idle");
      }
      return;
    }

    // idle → 开始录音
    try {
      const rec = await MicRecorderImpl.create();
      recorderRef.current = rec;
      rec.start();
      setState("recording");
    } catch (err) {
      console.error("[voice-input] 麦克风不可用:", err);
      flashError(t("voice.micDenied"));
    }
  }, [ctx, disabled, state, onTranscribed, flashError, t]);

  const title = error ?? (state === "recording" ? t("voice.recording") : state === "transcribing" ? t("voice.transcribing") : t("voice.mic"));

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={disabled}
      title={title}
      className={`flex items-center justify-center size-8 rounded-full border-none cursor-pointer shrink-0 ${disabled ? "opacity-30 cursor-default" : ""}`}
      style={{
        background: state === "recording" ? "var(--color-accent-error)" : "transparent",
        color: state === "recording" ? "var(--color-bg)" : "var(--color-muted)",
      }}
    >
      {state === "transcribing" ? (
        <Loader2 className="size-4.5 animate-spin" />
      ) : state === "recording" ? (
        <Square className="size-3.5" fill="currentColor" style={{ animation: "pulse 1.4s ease-in-out infinite" }} />
      ) : (
        <Mic className="size-4.5" />
      )}
    </button>
  );
}
