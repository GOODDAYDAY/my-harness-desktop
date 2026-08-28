// audio.test.ts —— 纯函数单测:重采样 + 静音判定(不含 DOM/MediaRecorder,可裸跑)。
import { describe, it, expect } from "vitest";
import { resampleTo16kMono, isSilence } from "./audio";

/** 最小 AudioBuffer-like:只暴露 resampleTo16kMono 用到的面。 */
function fakeBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  return {
    sampleRate,
    length: channels[0]?.length ?? 0,
    numberOfChannels: channels.length,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer;
}

describe("resampleTo16kMono", () => {
  it("单声道 16k 原样拷贝(不改采样率不混音)", () => {
    const src = new Float32Array([0, 0.5, 1, 0.5, 0]);
    const out = resampleTo16kMono(fakeBuffer([src], 16000));
    expect(out.length).toBe(src.length);
    expect(Array.from(out)).toEqual(Array.from(src));
  });

  it("立体声混音取均值", () => {
    const L = new Float32Array([1, 1, 1, 1]);
    const R = new Float32Array([-1, -1, -1, -1]);
    const out = resampleTo16kMono(fakeBuffer([L, R], 16000));
    expect(out.length).toBe(4);
    for (const v of out) expect(v).toBeCloseTo(0, 5);
  });

  it("48k → 16k 降采样后长度约 1/3", () => {
    const src = new Float32Array(4800).fill(0.1);
    const out = resampleTo16kMono(fakeBuffer([src], 48000));
    expect(out.length).toBe(1600);
    for (const v of out) expect(v).toBeCloseTo(0.1, 5);
  });
});

describe("isSilence", () => {
  it("全零采样判定为静音", () => {
    expect(isSilence(new Float32Array(16000))).toBe(true);
  });

  it("低幅度噪声判定为静音", () => {
    const s = new Float32Array(16000).map(() => (Math.random() - 0.5) * 0.001);
    expect(isSilence(s)).toBe(true);
  });

  it("正常语音幅度判定为非静音", () => {
    const s = new Float32Array(16000).map(() => (Math.random() - 0.5) * 0.5);
    expect(isSilence(s)).toBe(false);
  });

  it("空采样判定为静音", () => {
    expect(isSilence(new Float32Array(0))).toBe(true);
  });
});
