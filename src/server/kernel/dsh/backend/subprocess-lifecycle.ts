// dsh 子进程生命周期 —— spawn dsh JSON-RPC 运行时(dsh-jsonrpc-agent)、关 stdin→SIGTERM→SIGKILL。
//
// 与 client/pi/subprocess-lifecycle 同层:子进程生命周期是 shell 的职责,返回 gateway 的
// SubprocessHandle。dsh 侧差异:JSON-RPC server 不是 `dsh --profile`(那是 profile launcher),
// 而是独立可执行文件 `dsh-jsonrpc-agent`(@deepseek-ai/dsh-sdk-jsonrpc-demo 的 bin),
// 经 DSH_CORDIS_CONFIG(或 argv[2])指定 cordis.yml 插件组合,读 stdin JSON-RPC 常驻。
import { spawn, type ChildProcess } from "node:child_process";
import type { SubprocessHandle, ProcessExit } from "../../pi/backend/subprocess-handle";

/** dsh spawn 选项。 */
export interface DshSubprocessSpawnOptions {
  /** dsh-jsonrpc-agent 入口(绝对路径,如 node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/bin.js)。 */
  cliPath?: string;
  /** 工作目录。 */
  cwd?: string;
  /** cordis.yml 插件组合路径(注入 DSH_CORDIS_CONFIG;缺失则运行时自行报 usage 退出)。 */
  cordisConfig?: string;
  /** 环境变量(注入认证 DEEPSEEK_API_KEY 等)。 */
  env?: Record<string, string>;
}

/** 拼 dsh spawn 调用:`node <cliPath> <cordis.yml>` 或 `dsh-jsonrpc-agent <cordis.yml>`(shell)。 */
function computeDshSpawn(opts: DshSubprocessSpawnOptions): { cmd: string; args: string[]; shell: boolean } {
  const cordisArg = opts.cordisConfig ? [opts.cordisConfig] : [];
  if (opts.cliPath) {
    return { cmd: "node", args: [opts.cliPath, ...cordisArg], shell: false };
  }
  return { cmd: "dsh-jsonrpc-agent", args: cordisArg, shell: true };
}

/** DshSubprocessHandle:SubprocessHandle 的 dsh 实现(spawn + 关 stdin→1s→SIGTERM→2s→SIGKILL)。 */
export class DshSubprocessHandle implements SubprocessHandle {
  private child: ChildProcess;
  private exitFired = false;

  constructor(opts: DshSubprocessSpawnOptions = {}) {
    const s = computeDshSpawn(opts);
    this.child = spawn(s.cmd, s.args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...opts.env,
        ...(opts.cordisConfig ? { DSH_CORDIS_CONFIG: opts.cordisConfig } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      shell: s.shell,
    });
  }

  get stdin() { return this.child.stdin; }
  get stdout() { return this.child.stdout; }

  get alive(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child.stdin?.end();
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
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }

  onceExit(cb: (exit: ProcessExit) => void): void {
    this.child.once("exit", (code, signal) => {
      if (this.exitFired) return;
      this.exitFired = true;
      cb({ code, signal });
    });
  }

  onceError(cb: (error: Error) => void): void {
    this.child.once("error", (error) => cb(error));
    this.child.stdin?.on("error", (error) => cb(error));
  }

  onStderr(cb: (chunk: Buffer) => void): void {
    this.child.stderr?.on("data", cb);
  }
}

/** 工厂:spawn 一个 dsh 子进程,返回 SubprocessHandle。 */
export function createDshSubprocess(opts: DshSubprocessSpawnOptions = {}): SubprocessHandle {
  return new DshSubprocessHandle(opts);
}
