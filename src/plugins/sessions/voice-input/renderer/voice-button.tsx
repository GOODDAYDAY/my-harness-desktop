// voice-button.tsx —— composerVoice 槽贡献的语音输入按钮(麦克风 → 流式转写 → 回填文字)。
//
// 交互状态机:idle(麦克风图标)→ recording(红色脉冲,实时流式预览)→ transcribing(边解码边流式出字)。
// 流式两层:
//   ① 录制中:每 ~2s 用 samplesSoFar() 转写「已录部分」,实时预览文字随说话增长(§7 流式展示);
//   ② 停止后:用 WhisperTextStreamer 对完整录音做 token 级流式转写,文字边出边展示;
// 最终全文经 onTranscribed(text) 回填输入框(追加语义,用户改后手动发送)。
// 预览文字经 portal 浮在按钮上方,不进输入框——只有最终全文才回填,避免草稿被半截文字污染。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Mic, Square, Loader2 } from "lucide-react";
import { usePluginContext, type ComposerVoiceProps } from "@my-harness-desktop/react";
import { MicRecorderImpl, isSilence, type MicRecorder } from "./audio";
import { transcribe, transcribeStreaming } from "./stt-engine";

type VoiceState = "idle" | "recording" | "transcribing";

/** 流式预览面板:portal 到 body,浮在按钮上方,录制中/转写中显示累计文字。 */
function StreamingPreview({ anchor, text, state, t }: {
  anchor: DOMRect | null;
  text: string;
  state: VoiceState;
  t: (k: string) => string;
}): ReactNode {
  if (!anchor) return null;
  const empty = !text.trim();
  return createPortal(
    <div
      style={{
        position: "fixed",
        left: Math.max(8, anchor.left),
        top: anchor.top - 8,
        transform: "translateY(-100%)",
        maxWidth: "min(480px, calc(100vw - 16px))",
        minWidth: "200px",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-lg)",
        padding: "8px 12px",
        zIndex: 99999,
      }}
    >
      {empty ? (
        <span className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">
          {state === "recording" ? t("voice.listening") : t("voice.transcribing")}
        </span>
      ) : (
        <div className="text-[length:var(--font-size-base)] text-[var(--color-fg)] whitespace-pre-wrap break-words">
          {text}
          {state === "recording" && (
            <span className="inline-block align-middle ml-1 size-2 rounded-full bg-[var(--color-accent-error)]" style={{ animation: "pulse 1.4s ease-in-out infinite" }} />
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

export function VoiceButton({ onTranscribed, disabled }: ComposerVoiceProps): ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [state, setState] = useState<VoiceState>("idle");
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const recorderRef = useRef<MicRecorder | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 流式预览的并发护栏:录制中周期性 partial 一次只跑一个(避免 Whisper 推理重叠),
  // 序号只在「完整最终转写」时递增,防止过期的 partial 覆盖更新的预览。
  const partialTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const partialBusyRef = useRef(false);
  const partialSeqRef = useRef(0);

  const flashError = useCallback((msg: string): void => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(null), 4000);
  }, []);

  // 更新预览锚点(按钮位置变化时重算)。
  useEffect(() => {
    if (state !== "idle" && btnRef.current) {
      setAnchor(btnRef.current.getBoundingClientRect());
    }
  }, [state, partial]);

  const stopPartialLoop = useCallback((): void => {
    if (partialTimerRef.current) {
      clearInterval(partialTimerRef.current);
      partialTimerRef.current = null;
    }
  }, []);

  // 录制中周期性流式预览:每 2s 转写已录部分,文字随说话增长。
  const startPartialLoop = useCallback((): void => {
    const tick = async (): Promise<void> => {
      if (partialBusyRef.current) return; // 上一次还没算完,跳过避免推理重叠
      const rec = recorderRef.current;
      if (!rec) return;
      const samples = rec.samplesSoFar();
      if (samples.length < 8000 || isSilence(samples)) return; // <0.5s 或静音不转写
      partialBusyRef.current = true;
      const seq = ++partialSeqRef.current;
      try {
        const text = await transcribe(ctx, samples);
        if (seq === partialSeqRef.current) setPartial(text);
      } catch {
        // 预览失败静默(不影响最终转写;错误留给最终态)
      } finally {
        partialBusyRef.current = false;
      }
    };
    void tick();
    partialTimerRef.current = setInterval(() => { void tick(); }, 2000);
  }, [ctx]);

  const toggle = useCallback(async (): Promise<void> => {
    if (disabled) return;
    if (state === "transcribing") return;

    if (state === "recording") {
      stopPartialLoop();
      const rec = recorderRef.current;
      recorderRef.current = null;
      if (!rec) { setState("idle"); return; }
      try {
        setState("transcribing");
        const samples = await rec.stop();
        if (isSilence(samples)) {
          flashError(t("voice.empty"));
          return;
        }
        partialSeqRef.current++;
        const text = await transcribeStreaming(ctx, samples, (p) => {
          setPartial(p);
        });
        if (text) onTranscribed(text);
        else flashError(t("voice.empty"));
      } catch (err) {
        console.error("[voice-input] 转写失败:", err);
        flashError(t("voice.error"));
      } finally {
        setPartial("");
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
      setPartial("");
      setState("recording");
      startPartialLoop();
    } catch (err) {
      console.error("[voice-input] 麦克风不可用:", err);
      flashError(t("voice.micDenied"));
    }
  }, [ctx, disabled, state, onTranscribed, flashError, startPartialLoop, stopPartialLoop, t]);

  // 卸载清尾:停预览循环 + 释放录音。
  useEffect(() => () => {
    stopPartialLoop();
    recorderRef.current?.dispose();
  }, [stopPartialLoop]);

  const title = error ?? (state === "recording" ? t("voice.recording") : state === "transcribing" ? t("voice.transcribing") : t("voice.mic"));

  return (
    <>
      {state !== "idle" && (
        <StreamingPreview anchor={anchor} text={partial} state={state} t={t} />
      )}
      <button
        ref={btnRef}
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
    </>
  );
}
