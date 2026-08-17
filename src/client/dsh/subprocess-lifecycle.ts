// dsh 子进程生命周期 —— spawn dsh CLI(server mode)、关 stdin→SIGTERM→SIGKILL 停止。
//
// 与 client/pi/subprocess-lifecycle 同层:子进程生命周期是 shell 的职责,返回 gateway 的
// SubprocessHandle。dsh 侧差异只在一处——底座命令是 `dsh --profile <profile>`(sdk-jsonrpc-server
// 插件读 stdin JSON-RPC 常驻),不像 pi 那样 `--mode rpc`。
import { spawn, type ChildProcess } from "node:child_process";
import type { SubprocessHandle, ProcessExit } from "../pi/subprocess-handle";

/** dsh spawn 选项。 */
export interface DshSubprocessSpawnOptions {
  /** dsh CLI 入口(绝对路径,如 apps/cli 的 bin)。不传则走 PATH 上的 `dsh`。 */
  cliPath?: string;
  /** 工作目录。 */
  cwd?: string;
  /** dsh 底座 server profile 名(默认 jsonrpc-agent:加载 sdk-jsonrpc-server + DeepSeek + 会话/工具)。 */
  profile?: string;
  /** 环境变量(注入认证 DEEPSEEK_API_KEY 等)。 */
  env?: Record<string, string>;
}

/** 拼 dsh spawn 调用:`node <cliPath> --profile <p>` 或 `dsh --profile <p>`(shell)。 */
function computeDshSpawn(opts: DshSubprocessSpawnOptions): { cmd: string; args: string[]; shell: boolean } {
  const profile = opts.profile ?? "jsonrpc-agent";
  if (opts.cliPath) {
    return { cmd: "node", args: [opts.cliPath, "--profile", profile], shell: false };
  }
  return { cmd: "dsh", args: ["--profile", profile], shell: true };
}

/** DshSubprocessHandle:SubprocessHandle 的 dsh 实现(spawn + 关 stdin→1s→SIGTERM→2s→SIGKILL)。 */
export class DshSubprocessHandle implements SubprocessHandle {
  private child: ChildProcess;
  private exitFired = false;

  constructor(opts: DshSubprocessSpawnOptions = {}) {
    const s = computeDshSpawn(opts);
    this.child = spawn(s.cmd, s.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
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
