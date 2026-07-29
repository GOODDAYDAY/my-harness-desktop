// RequestCorrelator<T> —— gateway 层,id 配对 + timeout 兜底工具。
//
// 依据 docs/modules/02 §4.5。rpc-adapter 和 extension-ui 各持一个实例。
// 参考 pi SDK rpc-client.js 的 pendingRequests Map + ��增 requestId。
// 零外部依赖:只用 TS 内置类型。

/** RPC 请求超时错误(结构化 code,下游按 err.code 判定,不靠中文 substring 匹配)。 */
export class RpcTimeoutError extends Error {
  code = "timeout" as const;
  constructor(public timeoutMs: number, public reqId: string) {
    super(`请求超时(${timeoutMs}ms): ${reqId}`);
    this.name = "RpcTimeoutError";
  }
}

/** pending 请求条目。 */
interface PendingEntry<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * id 配对工具:register 分配递增 id + 存 pending,resolve/reject 按 id 配对。
 * 超时自动 reject(defaultTimeoutMs)。进程退出时 rejectAll 一次性 reject 全部。
 */
export class RequestCorrelator<T = unknown> {
  private pending = new Map<string, PendingEntry<T>>();
  private counter = 0;
  private prefix: string;
  private defaultTimeoutMs: number;

  constructor(opts?: { prefix?: string; defaultTimeoutMs?: number }) {
    this.prefix = opts?.prefix ?? "req";
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? 30000;
  }

  /** 注册一个 pending 请求,分配 id,返回 [id, promise]。 */
  register(opts?: { id?: string; timeoutMs?: number }): [string, Promise<T>] {
    const id = opts?.id ?? `${this.prefix}_${++this.counter}`;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new RpcTimeoutError(timeoutMs, id));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    return [id, promise];
  }

  /** 按 id 配对 resolve。 */
  resolve(id: string, value: T): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(value);
    return true;
  }

  /** 按 id 配对 reject。 */
  reject(id: string, error: Error): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.reject(error);
    return true;
  }

  /** 一次性 reject 全部(进程退出时调)。 */
  rejectAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** 当前 pending 数量。 */
  get size(): number {
    return this.pending.size;
  }
}
