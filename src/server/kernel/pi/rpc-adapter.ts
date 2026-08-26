// RPC 适配层(支柱①)—— gateway,消费 SubprocessHandle 收发 JSONL。
//
// 依据 docs/modules/02 + docs/structure/17 §7.1.2 + DESIGN.md §1。
// 参考 pi SDK rpc-client.js 的核心机制:JSONL reader + id 配对 + event 分发。
//
// 关键纪律(依赖倒置):
// - rpc-adapter 不负责 spawn/kill 子进程——那是 shell/subprocess-lifecycle 的职责。
//   本层构造时收一个 SubprocessHandle(接口归 gateway 自有,见 subprocess-handle.ts),
//   只消费其 stdin/stdout 做 JSONL 读写 + id 配对 + event 分发。
// - gateway 只 import domain + 自身 protocol + 自身 subprocess-handle,不 import application/shell。
// - 用 Node 内置 string_decoder(标准库)。
// - JSONL reader 自写 LF-only 分帧(不用 readline,参考 pi SDK jsonl.js)。
import { StringDecoder } from "node:string_decoder";
import { RequestCorrelator } from "./correlator";
import type { SubprocessHandle, ProcessExit } from "./subprocess-handle";
import type { RpcCommand, RpcResponse, AgentSessionEvent, RpcExtensionUIRequest, RpcExtensionUIResponse } from "./rpc-types";

/** stdout 上一行 JSON 解析后的消息。 */
type ParsedLine = Record<string, unknown>;

/** RpcAdapter 选项(只含协议层参数;spawn 参数在 SubprocessHandle 实现侧)。 */
export interface RpcAdapterOptions {
  /** 默认命令超时(ms)。 */
  defaultTimeoutMs?: number;
}

/** pi 子进程退出错误。 */
export class RpcProcessError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly signal: string | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "RpcProcessError";
  }
}

/** 内核命令级失败响应(success:false)。message 原文带回内核错误(如 "Invalid entry ID for forking")。 */
export class RpcCommandError extends Error {
  constructor(
    message: string,
    public readonly command: string,
  ) {
    super(message);
    this.name = "RpcCommandError";
  }
}

/**
 * pi RPC 适配器:消费 SubprocessHandle、收发 JSONL、按 id 配对 response、转发 event。
 * 生命周期:start(绑 handle)→ send/onEvent → stop(调 handle.stop)。
 *
 * 构造收一个 SubprocessHandle(spawn 已由 shell 完成,或由 shell 的工厂同步创建)。
 */
export class RpcAdapter {
  private handle: SubprocessHandle;
  private correlator: RequestCorrelator<RpcResponse>;
  private eventListeners = new Set<(event: AgentSessionEvent) => void>();
  private extUiListeners = new Set<(req: RpcExtensionUIRequest) => void>();
  private busListeners = new Set<(frame: Record<string, unknown>) => void>();
  private exitError: Error | null = null;
  private stopping = false;
  private started = false;
  private extUiTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  onProcessExit: ((exit: ProcessExit, expected: boolean) => void) | null = null;
  stderr = "";

  constructor(handle: SubprocessHandle, options: RpcAdapterOptions = {}) {
    this.handle = handle;
    this.correlator = new RequestCorrelator<RpcResponse>({
      prefix: "req",
      defaultTimeoutMs: options.defaultTimeoutMs ?? 30000,
    });
  }

  /** 子进程是否存活。 */
  get alive(): boolean {
    return this.handle.alive;
  }

  /** 最近退出错误(进程已死时)。 */
  get lastError(): Error | null {
    return this.exitError;
  }

  /**
   * 绑定 SubprocessHandle 的事件 + attach stdout JSONL reader。
   * spawn 由 shell 在传入 handle 前完成(或 handle 内部惰性 spawn);本方法只做"接线"。
   */
  async start(): Promise<void> {
    if (this.started) throw new Error("已在运行");
    this.started = true;
    this.exitError = null;
    this.stopping = false;
    this.stderr = "";

    const handle = this.handle;

    // stderr 两路分工:累积调试串(进程退出时拼错误)+ 行级扫描 $bus 上行帧。
    // 内核 0.83.0 起 output-guard(takeOverStdout)把 extension 的 stdout.write 重定向到
    // stderr,stdout 只留 RPC 协议帧——bus/subagent 等扩展的上行帧($bus)实际落在 stderr,
    // 只读 stdout 会让握手整链静默断(ping 无人应答 → 工具不注册)。旧内核帧仍在 stdout,
    // 两条流都路由、按 $bus 识别;一帧只出现在一条流上,无重复投递。
    let stderrLineBuf = "";
    handle.onStderr((data: Buffer) => {
      const text = data.toString();
      this.stderr += text;
      stderrLineBuf += text;
      let nl: number;
      while ((nl = stderrLineBuf.indexOf("\n")) >= 0) {
        const line = stderrLineBuf.slice(0, nl);
        stderrLineBuf = stderrLineBuf.slice(nl + 1);
        let parsed: { $bus?: unknown };
        try {
          parsed = JSON.parse(line) as { $bus?: unknown };
        } catch {
          continue; // 非 JSON 行(内核日志等),已留在调试串
        }
        if (parsed?.$bus === true) this.dispatchBusFrame(parsed as unknown as Record<string, unknown>);
      }
    });

    // exit 事件
    handle.onceExit((exit: ProcessExit) => {
      const expected = this.stopping;
      if (!expected) {
        const err = new RpcProcessError(
          `pi 进程退出(code=${exit.code}, signal=${exit.signal})。stderr: ${this.stderr.slice(-500)}`,
          exit.code,
          exit.signal,
          this.stderr,
        );
        this.exitError = err;
        this.correlator.rejectAll(err);
      }
      this.onProcessExit?.(exit, expected);
    });

    // error 事件
    handle.onceError((error: Error) => {
      const err = this.exitError ?? new Error(`pi 进程错误: ${error.message}`);
      this.exitError = err;
      this.correlator.rejectAll(err);
    });

    // JSONL reader(stdout)
    attachJsonlLineReader(handle.stdout!, (line) => this.handleLine(line));

    // 不 sleep 等就绪(评估 P2:100ms 是赌就绪的固定 sleep,慢机不够快机白等)。
    // 就绪由 session-store.waitReady 发 get_state 探测确认;此处仅检查进程是否已退出。
    if (!handle.alive) {
      throw this.exitError ?? new Error("pi 进程启动后立即退出");
    }
  }

  /** 发命令,返回 Promise(response)。opts.timeoutMs 覆盖默认超时(abort 等需快速兜底的命令用)。 */
  send(command: RpcCommand, opts?: { timeoutMs?: number }): Promise<RpcResponse> {
    if (!this.handle.stdin) throw new Error("pi 未启动");
    if (this.exitError) throw this.exitError;
    if (!this.handle.alive) throw this.exitError ?? new Error("pi 已退出");

    const [id, promise] = this.correlator.register(opts);
    const fullCommand = { ...command, id };
    const line = JSON.stringify(fullCommand) + "\n";
    this.handle.stdin.write(line);
    return promise;
  }

  /** 注册事件监听(内核推的 AgentSessionEvent)。返回取消函数。 */
  onEvent(cb: (event: AgentSessionEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  /** 注册 Extension UI 请求监听。返回取消函数。 */
  onExtensionUI(cb: (req: RpcExtensionUIRequest) => void): () => void {
    this.extUiListeners.add(cb);
    return () => this.extUiListeners.delete(cb);
  }

  /** $bus 上行帧统一分派(stdout 与 stderr 两条流共用;监听器抛错隔离)。 */
  private dispatchBusFrame(frame: Record<string, unknown>): void {
    for (const cb of this.busListeners) {
      try {
        cb(frame);
      } catch (err) {
        console.error("[rpc-adapter] bus 帧监听抛错已隔离:", err);
      }
    }
  }

  /** 注册 Session Bus 帧监听($bus === true 的上行帧;session-bus 路由器经此收 bus_request)。返回取消函数。 */
  onBusFrame(cb: (frame: Record<string, unknown>) => void): () => void {
    this.busListeners.add(cb);
    return () => this.busListeners.delete(cb);
  }

  /** 发送 Extension UI 响应到 pi stdin(不走 correlator,fire-and-forget 写入)。 */
  sendExtensionUIResponse(response: RpcExtensionUIResponse): void {
    if (!this.handle.stdin) throw new Error("pi 未启动");
    const line = JSON.stringify({ ...response, type: "extension_ui_response" }) + "\n";
    this.handle.stdin.write(line);
    const timer = this.extUiTimeouts.get(response.id);
    if (timer) { clearTimeout(timer); this.extUiTimeouts.delete(response.id); }
  }

  /** 停止子进程:委托 SubprocessHandle.stop(shell 实现关 stdin→SIGTERM→SIGKILL 策略)。 */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    try {
      await this.handle.stop();
    } finally {
      this.started = false;
      for (const [, t] of this.extUiTimeouts) clearTimeout(t);
      this.extUiTimeouts.clear();
      this.correlator.rejectAll(new Error("pi 已停止"));
    }
  }

  /** 处理 stdout 一行 JSON:先 extension_ui_request → 再 response+id → 其余 event。 */
  private handleLine(line: string): void {
    let data: ParsedLine;
    try {
      data = JSON.parse(line) as ParsedLine;
    } catch {
      return; // 非 JSON 行忽略(stderr 混入等)
    }

    // 1. Extension UI 请求(优先,先于 response/event)
    if (data.type === "extension_ui_request") {
      const req = data as unknown as RpcExtensionUIRequest;
      if (typeof req.id === "string") {
        const timer = setTimeout(() => {
          this.extUiTimeouts.delete(req.id);
          this.sendExtensionUIResponse({ type: "extension_ui_response", id: req.id, cancelled: true });
        }, 60000);
        this.extUiTimeouts.set(req.id, timer);
      }
      for (const cb of this.extUiListeners) {
        cb(req);
      }
      return;
    }

    // 1.5 Session Bus 上行帧($bus 标记;extension 的 bus_request 等,转路由器,不落普通事件流)
    if ((data as { $bus?: unknown }).$bus === true) {
      this.dispatchBusFrame(data as unknown as Record<string, unknown>);
      return;
    }

    // 2. response(带 id → 配对)。success:false 必须 reject 而非 resolve——
    // 根因:此前错误响应当正常值放行,fork 等命令的调用方看不到失败
    // (内核拒 fork 后 UI 静默停在旧会话、中间副本泄漏),也违背 session-store
    // 既有注释假设的"RPC 拒绝抛错"契约(setModel 双写注释)。 reject 后错误
    // 经 session-store.send 的 rpcError 上报通道照常广播。
    if (data.type === "response" && typeof data.id === "string") {
      const res = data as unknown as RpcResponse;
      if (res.success === false) {
        this.correlator.reject(data.id, new RpcCommandError(res.error, res.command));
      } else {
        this.correlator.resolve(data.id, res);
      }
      return;
    }

    // 3. extension_ui_response(桌面端发给内核的,回 stdout 忽略)
    if (data.type === "extension_ui_response") return;

    // 4. 其余当 event 转发
    for (const cb of this.eventListeners) {
      cb(data as unknown as AgentSessionEvent);
    }
  }
}

/**
 * LF-only JSONL reader(不用 readline,参考 pi SDK jsonl.js)。
 * readline 会拆 U+2028/U+2029(JSON 字符串内合法),故自写按 \n 切。
 */
function attachJsonlLineReader(
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
  // stream end: flush 残留
  buffer += decoder.end();
  if (buffer.trim()) onLine(buffer.replace(/\r$/, ""));
}
