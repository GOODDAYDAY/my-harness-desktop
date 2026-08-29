// audio.ts —— 麦克风实时 PCM 采集(纯 Web API,零依赖)。
//
// 语音转文字插件的采集层:getUserMedia 拿麦克风流 → AudioContext(sampleRate=16000) 实时重采样 →
// ScriptProcessorNode 抓 16kHz 单声道 PCM。不经过 MediaRecorder/webm 容器——
// 好处是录制中即可 samplesSoFar() 拿实时采样做流式预览(「随着输入看到文字」的关键)。
// ScriptProcessorNode 虽 deprecated,但全平台可用且最简单;此处只做单向采集,无回授(静音连出)。

/** 录音句柄:start 开始录制;samplesSoFar 拿实时采样;stop 返回完整采样。 */
export interface MicRecorder {
  start(): void;
  /** 当前已录采样(16kHz 单声道,不停止录音;录制中实时预览用)。 */
  samplesSoFar(): Float32Array;
  /** 停止并返回 16kHz 单声道 Float32Array。重复调用幂等。 */
  stop(): Promise<Float32Array>;
  /** 取消(丢弃录音)。 */
  cancel(): void;
  /** 释放麦克风流与音频图。 */
  dispose(): void;
}

/** 拼接若干 Float32Array 片段为一段连续采样。 */
function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** 单次录音封装:持有 MediaStream + AudioContext + ScriptProcessorNode,实时累积 16k 单声道 PCM。 */
export class MicRecorderImpl implements MicRecorder {
  private readonly stream: MediaStream;
  private readonly audioCtx: AudioContext;
  private readonly chunks: Float32Array[] = [];
  private stopped = false;

  private constructor(stream: MediaStream) {
    this.stream = stream;
    // sampleRate 16000:AudioContext 把麦克风输入重采样到 16kHz,processor 直接拿单声道目标采样。
    this.audioCtx = new AudioContext({ sampleRate: 16000 });
    // 某些环境 AudioContext 初始为 suspended(无手势/策略),显式 resume 一次;create 由点击触发,通常已 running。
    void this.audioCtx.resume().catch(() => { /* 无法恢复则等下一次手势 */ });
    const source = this.audioCtx.createMediaStreamSource(stream);
    const processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e: AudioProcessingEvent): void => {
      if (this.stopped) return;
      // 拷贝:onaudioprocess 的 inputBuffer 会被复用,不拷贝就存了同一块内存。
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    // 静音连出:保持音频图活跃(processor 需要连到 destination 才会持续回调),但不把麦克风外放。
    const mute = this.audioCtx.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(this.audioCtx.destination);
  }

  /** 打开麦克风并建实时采集图。getUserMedia 被拒(权限/无设备)时抛错,由调用方显形。 */
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
    // 采集图在构造时已建好并持续回调,无需显式启动。
  }

  samplesSoFar(): Float32Array {
    return concatFloat32(this.chunks);
  }

  stop(): Promise<Float32Array> {
    if (this.stopped) return Promise.resolve(concatFloat32(this.chunks));
    this.stopped = true;
    const samples = concatFloat32(this.chunks);
    this.dispose();
    return Promise.resolve(samples);
  }

  cancel(): void {
    this.stopped = true;
    this.dispose();
  }

  dispose(): void {
    try {
      this.stream.getTracks().forEach((track) => track.stop());
      void this.audioCtx.close().catch(() => { /* 关闭失败不阻塞 */ });
    } catch {
      // 释放失败不影响调用方
    }
  }
}

/** AudioBuffer(任意采样率/声道)→ 16kHz 单声道 Float32Array(均值混音 + 线性插值重采样)。
 *  实时采集已直接出 16k,此函数保留给离线音频回放/单测。 */
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
