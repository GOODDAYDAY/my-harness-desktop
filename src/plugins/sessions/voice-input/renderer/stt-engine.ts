// stt-engine.ts —— 语音转文字引擎(transformers.js Whisper,懒加载 + 模型按需下载)。
//
// 设计目标(§1.2 机制与内容分离 + §7.7 非必要不修改内核):
// - 本插件是纯内容插件,STT 能力全部在本插件内,不动桌面内核;
// - 引擎库(@huggingface/transformers,现成开源 STT 项目)只在首次转写时动态 import,
//   不随插件首屏打包加载;
// - 模型权重(几十~几百 MB)绝不进 git,首次使用时从 HuggingFace Hub 按需下载,
//   transformers.js 默认缓存到浏览器 Cache API,二次使用离线命中缓存;
// - 模型可选(tiny/base/small),选择持久化到插件 config(项目级/全局自动兜底)。
//
// 模型清单:onnx-community/whisper-*(transformers.js v3 官方推荐的多语 Whisper ONNX,
// 含中文)。体积为约值,供设置页提示。
import type { PluginContext } from "@my-harness-desktop/shared";

export interface SttModel {
  id: string;
  label: string;
  size: string;
}

export const STT_MODELS: SttModel[] = [
  { id: "onnx-community/whisper-tiny", label: "tiny", size: "~40 MB" },
  { id: "onnx-community/whisper-base", label: "base", size: "~77 MB" },
  { id: "onnx-community/whisper-small", label: "small", size: "~244 MB" },
];

export const DEFAULT_MODEL = "onnx-community/whisper-base";

const MODEL_KEY = "model";
const LANGUAGE_KEY = "language";

/** 可选的转写语言(Whisper 无自动检测,须显式指定,否则默认英文会把中文转成英文)。 */
export const STT_LANGUAGES: { id: string; label: string }[] = [
  { id: "chinese", label: "中文" },
  { id: "english", label: "English" },
  { id: "german", label: "Deutsch" },
];

/** UI locale → Whisper 语言码(未命中回退中文)。locale 形如 "zh-CN"/"en"/"de"。 */
const LOCALE_TO_LANG: Record<string, string> = {
  "zh-CN": "chinese", "zh-TW": "chinese", "zh": "chinese",
  en: "english", "en-US": "english", "en-GB": "english",
  de: "german", "de-DE": "german",
};

/** 转写输出的宽松形状(避免静态 import 重型库拿类型;动态 import 结果不强类型)。 */
type AsrOutput = { text?: string } | Array<{ text?: string }>;
type AsrPipeline = ((samples: Float32Array, opts?: Record<string, unknown>) => Promise<AsrOutput>) & {
  /** transformers.js pipeline 自带释放方法(换模型时释放旧权重)。 */
  dispose?: () => Promise<void>;
  /** pipeline 持有的 tokenizer(流式转写建 WhisperTextStreamer 用)。 */
  tokenizer?: unknown;
};

/** 模型下载进度回调形状(transformers.js progress_callback)。 */
export interface DownloadProgress {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number;
}

let pipelinePromise: Promise<AsrPipeline> | null = null;
let loadedModel: string | null = null;

/** 读当前选择的模型 id(插件 config,非法/未设回退默认)。 */
export async function getModelId(ctx: PluginContext): Promise<string> {
  try {
    const v = await ctx.config.get<string>(MODEL_KEY);
    if (typeof v === "string" && STT_MODELS.some((m) => m.id === v)) return v;
  } catch {
    // config 不可用时按默认走,不阻塞转写
  }
  return DEFAULT_MODEL;
}

export async function setModelId(ctx: PluginContext, id: string): Promise<void> {
  await ctx.config.set(MODEL_KEY, id);
}

/** 读转写语言:显式 config 优先,否则按 UI locale 推导,回退中文。 */
export async function getLanguage(ctx: PluginContext): Promise<string> {
  try {
    const v = await ctx.config.get<string>(LANGUAGE_KEY);
    if (typeof v === "string" && STT_LANGUAGES.some((l) => l.id === v)) return v;
  } catch {
    // config 不可用时按 locale 推导
  }
  const locale = ctx.i18n?.locale ?? "";
  return LOCALE_TO_LANG[locale] ?? LOCALE_TO_LANG[locale.split("-")[0]] ?? "chinese";
}

export async function setLanguage(ctx: PluginContext, id: string): Promise<void> {
  await ctx.config.set(LANGUAGE_KEY, id);
}

/** 懒加载 transformers.js 并构建指定模型的 ASR pipeline(同模型复用,换模型重建 + 释放旧权重)。
 *  progress_callback 是 pipeline() 的**构造期**选项(非 call 期),故经此透传下载进度。 */
function loadPipeline(modelId: string, onProgress?: (p: DownloadProgress) => void): Promise<AsrPipeline> {
  if (pipelinePromise && loadedModel === modelId) return pipelinePromise;
  // 换模型:释放旧 pipeline,避免多个 Whisper 权重常驻内存(每个几十~几百 MB)
  const prev = pipelinePromise;
  pipelinePromise = null;
  loadedModel = modelId;
  if (prev) {
    void prev.then((p) => { try { void p.dispose?.(); } catch { /* 释放失败不阻塞 */ } });
  }
  pipelinePromise = (async (): Promise<AsrPipeline> => {
    const mod = await import("@huggingface/transformers");
    const { pipeline, env } = mod as unknown as {
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<AsrPipeline>;
      env: { allowLocalModels: boolean };
    };
    // 允许从远程(HF Hub)下载模型权重;首次使用触发下载,之后命中浏览器缓存。
    env.allowLocalModels = false;
    // dtype "q8" 用 8-bit 量化权重(_quantized.onnx):体积约 1/3~1/4,质量损失极小,
    // 与设置页标注的体积一致(tiny ~40MB / base ~77MB / small ~244MB)。fp32 会拉到 ~3 倍。
    return await pipeline("automatic-speech-recognition", modelId, {
      dtype: "q8",
      ...(onProgress ? { progress_callback: onProgress } : {}),
    });
  })();
  return pipelinePromise;
}

function extractText(out: AsrOutput): string {
  if (Array.isArray(out)) return out.map((o) => o?.text ?? "").join(" ").trim();
  return (out?.text ?? "").trim();
}

/** 转写 16kHz 单声道 PCM 采样为文本。模型未下载时首次调用会触发下载(可能较慢)。
 *  language 显式指定:Whisper 无自动检测,不指定默认英文,会把中文转成英文。 */
export async function transcribe(ctx: PluginContext, samples: Float32Array): Promise<string> {
  if (samples.length === 0) return "";
  const modelId = await getModelId(ctx);
  const language = await getLanguage(ctx);
  const transcriber = await loadPipeline(modelId);
  const out = await transcriber(samples, { language });
  return extractText(out);
}

/** 流式转写:边解码边把**累计全文**经 onPartial 推给调用方(「随着输入看到文字」的最终态)。
 *  用 transformers.js 的 WhisperTextStreamer(callback_function 逐片段回调),onPartial 收的是
 *  从起头到当前的累计文本(非增量),调用方可直接渲染/回填。返回最终全文(与最后一次 onPartial 一致)。
 *  语言同 transcribe;模型未下载时首次调用触发下载。 */
export async function transcribeStreaming(
  ctx: PluginContext,
  samples: Float32Array,
  onPartial: (text: string) => void,
): Promise<string> {
  if (samples.length === 0) return "";
  const modelId = await getModelId(ctx);
  const language = await getLanguage(ctx);
  const transcriber = await loadPipeline(modelId);
  const mod = await import("@huggingface/transformers");
  const { WhisperTextStreamer } = mod as unknown as {
    WhisperTextStreamer: new (tokenizer: unknown, opts?: Record<string, unknown>) => unknown;
  };
  let full = "";
  const streamer = new WhisperTextStreamer(transcriber.tokenizer, {
    time_precision: 0.02,
    callback_function: (fragment: string) => {
      full += fragment;
      onPartial(full);
    },
  });
  await transcriber(samples, { language, streamer });
  return full.trim();
}

/** 主动下载指定模型(设置页「下载模型」按钮):对静音跑一次 pipeline,强制触发权重下载。
 *  onProgress 透传 transformers.js 的 progress_callback 进度(构造期选项)。 */
export async function downloadModel(
  modelId: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const transcriber = await loadPipeline(modelId, onProgress);
  // 1 秒静音:足够触发权重下载,又不会产生可读文本
  const silence = new Float32Array(16000);
  await transcriber(silence);
}
