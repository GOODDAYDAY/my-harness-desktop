// dsh JSON-RPC 2.0 行传输 —— 消费 SubprocessHandle 收发 newline-delimited JSON-RPC。
//
// 依据 docs/design/base-interface-lineage.md §4.2(dsh 底座走 stdio JSON-RPC)。
// 与 pi 的 RpcAdapter 同层(传输层),但协议不同:pi 是 31 命令闭联合,这里是 JSON-RPC 2.0
// (request 带 id 配对,notification 无 id,response 带 id 回配对)。
//
// 依赖倒置:本层只消费 SubprocessHandle(stdin/stdout),不负责 spawn/kill——那是
// shell 的职责(同 pi 的 createPiSubprocess 纪律)。换运行时只写新 spawn 实现,本层一行不改。
import { StringDecoder } from "node:string_decoder";
import type { SubprocessHandle, ProcessExit } from "../pi/subprocess-handle";

/** JSON-RPC 请求帧。 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

/** JSON-RPC 响应帧(成功 result / 失败 error)。 */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** JSON-RPC 通知帧(服务端推客户端,无 id)。 */
interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** dsh 侧命令级失败(响应带 error 时抛出)。 */
export class DshRpcError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly method: string,
  ) {
    super(message);
    this.name = "DshRpcError";
  }
}

/**
 * dsh JSON-RPC 传输:request 带 id 配对,notification 分发给监听器。
 * 生命周期:start(绑 handle + attach 行读)→ request/notify/onNotification → stop。
 */
export class JsonRpcTransport {
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private notificationListeners = new Set<(method: string, params: unknown) => void>();
  private started = false;
  private exitError: Error | null = null;

  constructor(
    private readonly handle: SubprocessHandle,
    private readonly defaultTimeoutMs = 30000,
  ) {}

  get alive(): boolean {
    return this.handle.alive;
  }

  /** 绑 handle 事件 + attach stdout 行读。spawn 由 shell 完成,本方法只接线。 */
  start(): void {
    if (this.started) throw new Error("已在运行");
    this.started = true;
    this.exitError = null;

    this.handle.onceExit((exit: ProcessExit) => {
      const err = new Error(`dsh 进程退出(code=${exit.code}, signal=${exit.signal})`);
      this.exitError = err;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    });
    this.handle.onceError((error: Error) => {
      const err = this.exitError ?? error;
      this.exitError = err;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    });
    // 运行时 stderr(启动失败/缺依赖/认证错)打到主进程日志,否则静默吞掉无法排查。
    this.handle.onStderr((chunk) => {
      console.error(`[dsh-json-rpc stderr] ${chunk.toString().trimEnd()}`);
    });

    attachLineReader(this.handle.stdout!, (line) => this.handleLine(line));
  }

  /** 发请求,按 id 配对 resolve;error 响应 reject 为 DshRpcError。 */
  request<T>(method: string, params?: unknown, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    if (!this.handle.stdin) throw new Error("dsh 未启动");
    if (this.exitError) throw this.exitError;
    const id = String(this.nextId++);
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params } satisfies JsonRpcRequest) + "\n";
    this.handle.stdin.write(line);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`dsh 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  /** 发通知(无 id,fire-and-forget)。 */
  notify(method: string, params?: unknown): void {
    if (!this.handle.stdin) throw new Error("dsh 未启动");
    const line = JSON.stringify({ jsonrpc: "2.0", method, params } satisfies JsonRpcNotification) + "\n";
    this.handle.stdin.write(line);
  }

  /** 注册通知监听(服务端推的 session.event 等)。返回取消函数。 */
  onNotification(cb: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(cb);
    return () => this.notificationListeners.delete(cb);
  }

  /** 停子进程(委托 SubprocessHandle.stop)。 */
  async stop(): Promise<void> {
    if (!this.started) return;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("dsh 已停止")); }
    this.pending.clear();
    this.started = false;
    await this.handle.stop();
  }

  /** 处理一行 JSON:response(带 id)配对;notification(带 method 无 id)分发。 */
  private handleLine(line: string): void {
    let data: JsonRpcResponse | JsonRpcNotification;
    try {
      data = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      return; // 非 JSON 行忽略
    }
    if ("id" in data && typeof data.id === "string" && !("method" in data)) {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      if (data.error) {
        pending.reject(new DshRpcError(data.error.message, data.error.code, ""));
      } else {
        pending.resolve(data.result);
      }
      return;
    }
    if ("method" in data && typeof data.method === "string") {
      for (const cb of this.notificationListeners) {
        try {
          cb(data.method, data.params);
        } catch (err) {
          console.error("[dsh-json-rpc] 通知监听抛错已隔离:", err);
        }
      }
    }
  }
}

/** LF-only 行读(同 pi 的 attachJsonlLineReader 纪律:不用 readline,防拆 U+2028/U+2029)。 */
function attachLineReader(
  stream: { on(event: "data", cb: (chunk: Buffer) => void): void },
  onLine: (line: string) => void,
): void {
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
