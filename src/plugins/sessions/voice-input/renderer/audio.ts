// audio.ts —— 麦克风采集 + 解码 + 重采样(纯 Web API,零依赖)。
//
// 语音转文字插件的采集层:getUserMedia 拿麦克风流 → MediaRecorder 录成 webm/opus →
// decodeAudioData 解码成 AudioBuffer → 重采样到 16kHz 单声道 Float32Array(Whisper 输入)。
// 全部走浏览器/Electron 内建 API,不引入原生模块,模型与引擎归 stt-engine.ts。

/** 录音句柄:start 开始,stop 返回 16kHz 单声道 PCM 采样(供 STT 引擎消费)。 */
export interface MicRecorder {
  start(): void;
  /** 停止并返回 16kHz 单声道 Float32Array。重复调用幂等(返回缓存结果)。 */
  stop(): Promise<Float32Array>;
  /** 取消(丢弃录音,不触发 stop 的 decode)。 */
  cancel(): void;
  /** 释放麦克风流。 */
  dispose(): void;
}

/** 选可用的 webm/opus 录制格式;都不支持则回退浏览器默认。 */
function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

/** 单次录音封装:持有 MediaStream + MediaRecorder,stop 时解码重采样成 16k 单声道 PCM。 */
export class MicRecorderImpl implements MicRecorder {
  private readonly stream: MediaStream;
  private readonly recorder: MediaRecorder;
  private readonly chunks: Blob[] = [];
  private stopped = false;
  private decoded: Promise<Float32Array> | null = null;

  private constructor(stream: MediaStream) {
    this.stream = stream;
    const mimeType = pickMimeType();
    this.recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    this.recorder.ondataavailable = (e: BlobEvent): void => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
  }

  /** 打开麦克风并创建录音器。getUserMedia 被拒(权限/无设备)时抛错,由调用方显形。 */
  static async create(): Promise<MicRecorder> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("no-getUserMedia");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    return new MicRecorderImpl(stream);
  }

  start(): void {
    this.recorder.start(250); // 每 250ms 出一片,减少内存峰值
  }

  stop(): Promise<Float32Array> {
    if (this.decoded) return this.decoded;
    if (this.stopped && this.chunks.length === 0) {
      this.decoded = Promise.resolve(new Float32Array(0));
      return this.decoded;
    }
    this.decoded = new Promise<Float32Array>((resolve, reject) => {
      this.recorder.onstop = (): void => {
        try {
          const blob = new Blob(this.chunks, { type: this.recorder.mimeType || "audio/webm" });
          void blobTo16kMono(blob).then(resolve, reject);
        } catch (err) {
          reject(err);
        }
      };
      if (this.recorder.state !== "inactive") this.recorder.stop();
      else this.recorder.onstop(new Event("stop"));
    });
    this.stopped = true;
    return this.decoded;
  }

  cancel(): void {
    if (this.recorder.state !== "inactive") {
      // 停止但不解码:onstop 仍会触发,用 stopped 标记拦住
      this.stopped = true;
      this.chunks.length = 0;
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.dispose();
  }

  dispose(): void {
    this.stream.getTracks().forEach((track) => track.stop());
  }
}

/** 单例 AudioContext(解码用,避免反复创建触浏览器上限)。 */
let sharedCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext();
  return sharedCtx;
}

/** webm/opus blob → 16kHz 单声道 Float32Array。 */
export async function blobTo16kMono(blob: Blob): Promise<Float32Array> {
  if (blob.size === 0) return new Float32Array(0);
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = getAudioCtx();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  return resampleTo16kMono(audioBuffer);
}

/** AudioBuffer(任意采样率/声道)→ 16kHz 单声道 Float32Array(均值混音 + 线性插值重采样)。 */
export function resampleTo16kMono(buffer: AudioBuffer): Float32Array {
  const targetRate = 16000;
  const srcRate = buffer.sampleRate;
  if (srcRate === targetRate && buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0).slice();
  }
  const srcLength = buffer.length;
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const outLength = Math.max(1, Math.ceil((srcLength * targetRate) / srcRate));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    // 目标采样点对应的源位置(线性插值)
    const pos = (i * srcRate) / targetRate;
    const i0 = Math.floor(pos);
    const i1 = Math.min(srcLength - 1, i0 + 1);
    const frac = pos - i0;
    let acc = 0;
    for (let c = 0; c < channels.length; c++) {
      const a = channels[c][i0] ?? 0;
      const b = channels[c][i1] ?? 0;
      acc += a + (b - a) * frac;
    }
    out[i] = acc / channels.length;
  }
  return out;
}

/** 静音判定(均方根 RMS 低于阈值)。Whisper 对静音/纯音会幻觉出文字(" you" / "(whistling)"),
 *  转写前先拦一道:低于阈值的录音直接报「没识别到语音」,不进引擎、不产生幻觉文本。 */
export function isSilence(samples: Float32Array, threshold = 0.004): boolean {
  if (samples.length === 0) return true;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  return rms < threshold;
}
