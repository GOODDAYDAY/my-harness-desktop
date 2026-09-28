// probe4 传输 —— JSONL 行协议(命令进、事件出),不配对请求 id(单线执行器,同一时刻一个回合)。
//
// 依据 docs/design/minimal-kernel.md §4.2。与 dsh 的 JsonRpcTransport 同构:只消费
// SubprocessHandle(stdin/stdout),不负责 spawn/kill(那归 subprocess-lifecycle)。LF-only
// 行读(不用 readline,防拆 U+2028/U+2029)。

import { StringDecoder } from "node:string_decoder";
import type { SubprocessHandle } from "../../core/subprocess-handle";
import type { ProcessExitInfo } from "@my-harness-desktop/shared";

/** probe4 协议事件(命令进、事件出的「出」侧)。 */
export type Probe4Event = { type: string } & Record<string, unknown>;

/** probe4 传输:JSONL 命令写、事件行读 + 分发。 */
export class Probe4Transport {
  private listeners = new Set<(e: Probe4Event) => void>();
  private started = false;
  private stopping = false;
  private stderrBuf = "";
  /** 崩溃收尾回调(§4.6.3):backend.onProcessExit 注册,onceExit 时调用。 */
  onExit: ((exit: ProcessExitInfo, expected: boolean, stderr: string) => void) | null = null;

  constructor(private readonly handle: SubprocessHandle) {}

  /** 绑 stdout 行读 + 崩溃收尾。spawn 由 shell 完成,本方法只接线。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    attachLineReader(this.handle.stdout!, (line) => this.handleLine(line));
    this.handle.onStderr((chunk) => {
      const text = chunk.toString();
      this.stderrBuf += text;
      console.error("[probe4] stderr:", text);
    });
    this.handle.onceError((err) => console.error("[probe4] 子进程错误:", err.message));
    this.handle.onceExit((exit) => {
      this.onExit?.({ code: exit.code, signal: exit.signal }, this.stopping, this.stderrBuf);
    });
  }

  /** 子进程是否存活(委托 handle)。 */
  get alive(): boolean {
    return this.handle.alive;
  }

  /** 停子进程(委托 handle)。 */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.handle.stop();
  }

  /** 订阅事件流(翻译由 Probe4Backend 投成中性事件)。返回退订。 */
  onEvent(cb: (e: Probe4Event) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 发一条命令(fire-and-forget;send/abort/setModel 等)。 */
  send(command: Record<string, unknown>): void {
    if (!this.handle.stdin) throw new Error("probe4 未启动");
    this.handle.stdin.write(JSON.stringify(command) + "\n");
  }

  /** 发一条命令并等一个指定类型的响应事件(getTree/getEntries/seed 等)。单线执行器,
   *  下一个 type 匹配的事件即本次响应,无需请求 id。 */
  request<T extends Probe4Event>(command: Record<string, unknown>, expectedType: string, timeoutMs = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const off = this.onEvent((e) => {
        if (e.type !== expectedType) return;
        off();
        resolve(e as T);
      });
      const timer = setTimeout(() => { off(); reject(new Error(`probe4 命令 ${expectedType} 超时`)); }, timeoutMs);
      this.send(command);
      void timer;
    });
  }

  private handleLine(line: string): void {
    let e: Probe4Event;
    try { e = JSON.parse(line) as Probe4Event; } catch { return; }
    for (const cb of [...this.listeners]) {
      try { cb(e); } catch (err) { console.error("[probe4] 事件监听抛错已隔离:", err); }
    }
  }
}

/** LF-only 行读(同 pi/dsh 纪律:不用 readline,防拆 U+2028/U+2029)。 */
function attachLineReader(stream: { on(event: "data", cb: (chunk: Buffer) => void): void }, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line) onLine(line);
    }
  });
  buffer += decoder.end();
  if (buffer.trim()) onLine(buffer.replace(/\r$/, ""));
}
