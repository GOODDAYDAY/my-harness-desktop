// probe4 传输层的**行处理与监听器隔离**（r170；r168 普查排序的第二位、r169 记下的下一步）。
//
// ## 被测的两条性质
//
// ① **畸形事件行不炸**：`handleLine` 里 `try { JSON.parse } catch { return; }` ——
//    一行坏 JSON 只是被丢掉，传输层继续活着（否则内核吐一行噪音就把整条会话打断）。
// ② **监听器抛错隔离**：`for (const cb of [...this.listeners]) { try { cb(e) } catch (err) { console.error(…) } }`
//    —— 一个监听器炸了，**其它监听器仍然要收到这条事件**。
//    这条尤其重要：`Probe4Backend` 与壳的事件翻译、统计、重试横幅等多个消费方都挂在同一条流上，
//    若没有隔离，一个消费方的 bug 会让其余消费方**静默收不到后续事件**（症状是"会话卡住不动"）。
//    注意实现里遍历的是 `[...this.listeners]`（**快照**）——这样监听器在回调里退订也不会漏发/重发。
//
// ## 为什么可以用测试替身
//
// `SubprocessHandle` 是**进程边界**的接口（core/subprocess-handle.ts：依赖倒置，实现由各内核提供）。
// 被测对象是 transport 自己的行处理逻辑，不是子进程 ⇒ 用替身喂 stdout 数据是正当的
// （这与 r169 的 catalog 测试相反：那里被测的就是读盘，所以必须用真实文件、不能 mock fs）。
// 判据（r159/r160）：**替身替换的必须是"被测对象的协作者"，不能是"被测对象本身"**。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { SubprocessHandle } from "../../core/subprocess-handle";
import { Probe4Transport, type Probe4Event } from "./probe4-transport";

function fakeHandle(): { handle: SubprocessHandle; emit: (chunk: string) => void } {
  const stdout = new EventEmitter();
  const handle = {
    alive: true,
    stdout: stdout as never,
    stdin: null,
    stop: vi.fn(async () => {}),
    onceExit: vi.fn(),
    onceError: vi.fn(),
    onStderr: vi.fn(),
  } as unknown as SubprocessHandle;
  return { handle, emit: (chunk: string) => stdout.emit("data", Buffer.from(chunk, "utf-8")) };
}

describe("Probe4Transport：行处理与监听器隔离", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("① 合法行 ⇒ 所有监听器都收到解析后的事件", () => {
    const { handle, emit } = fakeHandle();
    const t = new Probe4Transport(handle);
    const a = vi.fn(); const b = vi.fn();
    t.onEvent(a); t.onEvent(b);
    t.start();
    emit(JSON.stringify({ type: "assistant", text: "hi" }) + "\n");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect((a.mock.calls[0][0] as Probe4Event).type).toBe("assistant");
  });

  it("② **畸形行不炸、也不派发**（丢掉这一行，传输层继续活着）", () => {
    const { handle, emit } = fakeHandle();
    const t = new Probe4Transport(handle);
    const got = vi.fn();
    t.onEvent(got);
    t.start();
    expect(() => emit("{ 坏行\n")).not.toThrow();
    expect(got, "坏行不该被当成事件派发").not.toHaveBeenCalled();
    // 关键：坏行之后**继续**能收好行（不是"炸了就整条流废了"）
    emit(JSON.stringify({ type: "ok" }) + "\n");
    expect(got, "坏行之后传输层必须仍然可用").toHaveBeenCalledTimes(1);
  });

  it("③ **一个监听器抛错 ⇒ 其它监听器仍收到事件**（隔离），且错误被记录不是吞掉", () => {
    const { handle, emit } = fakeHandle();
    const t = new Probe4Transport(handle);
    const bad = vi.fn(() => { throw new Error("消费方自己的 bug"); });
    const good = vi.fn();
    t.onEvent(bad);          // 先挂坏的
    t.onEvent(good);         // 再挂好的（顺序不能影响隔离）
    t.start();
    emit(JSON.stringify({ type: "assistant" }) + "\n");
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good, "坏的监听器抛错不该挡住后面的监听器").toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("事件监听抛错已隔离")),
      "隔离不等于静默：错误要被记录（否则消费方的 bug 无从发现）").toBe(true);
  });

  it("④ 退订后不再收事件；退订**发生在派发中**也不影响本轮其它监听器（遍历的是快照）", () => {
    const { handle, emit } = fakeHandle();
    const t = new Probe4Transport(handle);
    const second = vi.fn();
    let offSecond: (() => void) | null = null;
    const first = vi.fn(() => { offSecond?.(); });   // 在回调里退订另一个监听器
    t.onEvent(first);
    offSecond = t.onEvent(second);
    t.start();
    emit(JSON.stringify({ type: "a" }) + "\n");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second, "本轮遍历的是快照 ⇒ 派发中退订不影响本轮").toHaveBeenCalledTimes(1);
    emit(JSON.stringify({ type: "b" }) + "\n");
    expect(second, "下一轮就不该再收到了").toHaveBeenCalledTimes(1);
  });

  it("⑤ 跨 chunk 断行：一行被拆成两个 chunk 也要拼成完整事件（LF-only 行读）", () => {
    const { handle, emit } = fakeHandle();
    const t = new Probe4Transport(handle);
    const got = vi.fn();
    t.onEvent(got);
    t.start();
    const line = JSON.stringify({ type: "assistant", text: "跨块" });
    emit(line.slice(0, 10));        // 半个 JSON
    expect(got, "半行不该被派发").not.toHaveBeenCalled();
    emit(line.slice(10) + "\n");    // 补齐 + 换行
    expect(got).toHaveBeenCalledTimes(1);
    expect((got.mock.calls[0][0] as Probe4Event).text).toBe("跨块");
  });

  it("⑥ start() 幂等：重复调用不重复接线（否则每行事件会被派发多次）", () => {
    const { handle, emit } = fakeHandle();
    const t = new Probe4Transport(handle);
    const got = vi.fn();
    t.onEvent(got);
    t.start();
    t.start();
    t.start();
    emit(JSON.stringify({ type: "x" }) + "\n");
    expect(got, "三次 start 之后每行仍只派发一次").toHaveBeenCalledTimes(1);
  });
});
