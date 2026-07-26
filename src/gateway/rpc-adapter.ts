// RPC 适配层(支柱①)—— gateway,起 pi --mode rpc 子进程 + 收发 JSONL。
//
// 依据 docs/modules/02 + docs/guides/19 + DESIGN.md §1。
// 参考 pi SDK rpc-client.js 的核心机制:spawn + JSONL reader + id 配对 + exit/error。
//
// 关键纪律:
// - gateway 只 import domain + 自身 protocol,不 import application/shell/plugins。
// - 用 Node 内置 child_process(标准库)。
// - JSONL reader 自写 LF-only 分帧(不用 readline,参考 pi SDK jsonl.js)。
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RequestCorrelator } from "./correlator";
import type { RpcCommand, RpcResponse, AgentSessionEvent, RpcExtensionUIRequest } from "./protocol/rpc-types";

/** stdout 上一行 JSON 解析后的消息。 */
type ParsedLine = Record<string, unknown>;

/** RpcAdapter 选项。 */
export interface RpcAdapterOptions {
  /** pi CLI 入口路径(绝对)。不传则自动定位。 */
  cliPath?: string;
  /** agent 工作目录。 */
  cwd?: string;
  /** 额外 CLI 参数(如 --session)。 */
  args?: string[];
  /** 环境变量(注入认证等)。 */
  env?: Record<string, string>;
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

/**
 * pi RPC 适配器:起子进程、收发 JSONL、按 id 配对 response、转发 event。
 * 生命周期:start → send/onEvent → stop。
 */
export class RpcAdapter {
  private options: RpcAdapterOptions;
  private child: ChildProcess | null = null;
  private correlator: RequestCorrelator<RpcResponse>;
  private eventListeners = new Set<(event: AgentSessionEvent) => void>();
  private extUiListeners = new Set<(req: RpcExtensionUIRequest) => void>();
  private exitError: Error | null = null;
  private stopping = false;
  stderr = "";

  constructor(options: RpcAdapterOptions = {}) {
    this.options = options;
    this.correlator = new RequestCorrelator<RpcResponse>({
      prefix: "req",
      defaultTimeoutMs: options.defaultTimeoutMs ?? 30000,
    });
  }

  /** 自动定位 pi CLI 入口:优先 ~/.pi-desktop/pi,回退全局 pi。 */
  static resolveCliPath(): string {
    // 优先 ~/.pi-desktop/pi(我们装的)
    const home = process.env["HOME"] ?? "";
    const installed = join(home, ".pi-desktop", "pi", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    if (existsSync(installed)) return installed;
    // 回退:全局 pi 命令(靠 PATH 解析,spawn 时 shell=true)
    return "pi";
  }

  /** 子进程是否存活。 */
  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /** 最近退出错误(进程已死时)。 */
  get lastError(): Error | null {
    return this.exitError;
  }

  /** 起 pi --mode rpc 子进程。 */
  async start(): Promise<void> {
    if (this.child) throw new Error("已在运行");
    const cliPath = this.options.cliPath ?? RpcAdapter.resolveCliPath();
    const isGlobal = cliPath === "pi";
    const args = ["--mode", "rpc"];
    if (this.options.args) args.push(...this.options.args);

    const spawnArgs = isGlobal ? [cliPath, ...args] : ["node", [cliPath, ...args]];
    const spawnOpts = {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"] as const,
      shell: isGlobal, // 全局 pi 需要 shell 解析 PATH
    };

    this.child = spawn(
      spawnArgs[0] as string,
      spawnArgs.slice(1) as string[],
      spawnOpts as Parameters<typeof spawn>[2],
    );

    const child = this.child;
    this.exitError = null;
    this.stopping = false;
    this.stderr = "";

    // stderr 收集(调试用)
    child.stderr?.on("data", (data: Buffer) => {
      this.stderr += data.toString();
    });

    // exit 事件
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      if (this.stopping) return; // 期望退出,不设 exitError
      const err = new RpcProcessError(
        `pi 进程退出(code=${code}, signal=${signal})。stderr: ${this.stderr.slice(-500)}`,
        code,
        signal,
        this.stderr,
      );
      this.exitError = err;
      this.correlator.rejectAll(err);
      this.child = null;
    });

    // error 事件
    child.once("error", (error) => {
      if (this.child !== child) return;
      const err = new Error(`pi 进程错误: ${error.message}`);
      this.exitError = err;
      this.correlator.rejectAll(err);
      this.child = null;
    });

    // stdin error
    child.stdin?.on("error", (error) => {
      if (this.child !== child) return;
      const err = this.exitError ?? new Error(`pi stdin 错误: ${error.message}`);
      this.exitError = err;
      this.correlator.rejectAll(err);
    });

    // JSONL reader(stdout)
    attachJsonlLineReader(child.stdout!, (line) => this.handleLine(line));

    // 等 100ms 让进程初始化(参考 pi SDK)
    await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode !== null) {
      throw this.exitError ?? new Error("pi 进程启动后立即退出");
    }
  }

  /** 发命令,返回 Promise(response)。 */
  send(command: RpcCommand): Promise<RpcResponse> {
    if (!this.child || !this.child.stdin) throw new Error("pi 未启动");
    if (this.exitError) throw this.exitError;
    if (this.child.exitCode !== null) throw this.exitError ?? new Error("pi 已退出");

    const [id, promise] = this.correlator.register();
    const fullCommand = { ...command, id };
    const line = JSON.stringify(fullCommand) + "\n";
    this.child.stdin.write(line);
    return promise;
  }

  /** 注册事件监听(底座推的 AgentSessionEvent)。返回取消函数。 */
  onEvent(cb: (event: AgentSessionEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  /** 注册 Extension UI 请求监听。返回取消函数。 */
  onExtensionUI(cb: (req: RpcExtensionUIRequest) => void): () => void {
    this.extUiListeners.add(cb);
    return () => this.extUiListeners.delete(cb);
  }

  /** 停止子进程:关 stdin → 1s → SIGTERM → 2s → SIGKILL。 */
  async stop(): Promise<void> {
    if (!this.child) return;
    this.stopping = true;
    const child = this.child;
    try {
      child.stdin?.end();
      // 等 1s 期望退出
      await new Promise<void>((r) => {
        const t = setTimeout(r, 1000);
        child.once("exit", () => { clearTimeout(t); r(); });
      });
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((r) => {
          const t = setTimeout(r, 2000);
          child.once("exit", () => { clearTimeout(t); r(); });
        });
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }
    } finally {
      this.child = null;
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
      for (const cb of this.extUiListeners) {
        cb(data as unknown as RpcExtensionUIRequest);
      }
      return;
    }

    // 2. response(带 id → 配对 resolve)
    if (data.type === "response" && typeof data.id === "string") {
      this.correlator.resolve(data.id, data as unknown as RpcResponse);
      return;
    }

    // 3. extension_ui_response(桌面端发给底座的,回 stdout 忽略)
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
