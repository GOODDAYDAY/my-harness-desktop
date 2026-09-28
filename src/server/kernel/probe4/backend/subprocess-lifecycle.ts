// probe4 子进程生命周期 —— spawn/kill probe4 内核 CLI(node probe4-cli.mjs)。
//
// 依据 docs/design/minimal-kernel.md §2.1 / §4.1。与 pi/dsh 同构:spawn 一个独立内核进程、
// 关 stdin→1s→SIGTERM→2s→SIGKILL 停止策略。实现 SubprocessHandle 接口(pi 侧定义的通用
// 子进程句柄契约,probe4 与 dsh 同源复用——接口是机制、非 pi 专属)。

import { spawn, type ChildProcess } from "node:child_process";
import type { SubprocessHandle, ProcessExit } from "../../core/subprocess-handle";

/** probe4 spawn 选项(内核专属参数,由工厂闭包拼装,不进中性契约)。 */
export interface Probe4SubprocessSpawnOptions {
  /** probe4-cli.mjs 绝对路径。 */
  cliPath: string;
  /** probe4 会话根(agentDir)。 */
  agentDir: string;
  /** 项目根(cwd,桶名 + spawn cwd)。 */
  cwd: string;
  /** 要打开/新建的 lineage id(--session)。 */
  sessionId: string;
}

/** Probe4SubprocessHandle:SubprocessHandle 的 probe4 实现(spawn node probe4-cli.mjs)。 */
export class Probe4SubprocessHandle implements SubprocessHandle {
  private child: ChildProcess;
  private exitFired = false;

  constructor(opts: Probe4SubprocessSpawnOptions) {
    // 用 process.execPath(当前 node 绝对路径)而非字面 "node"——tsx/vitest 等环境 PATH 里
    // 未必有 node(曾踩 spawn node ENOENT),execPath 永远可用。
    this.child = spawn(
      process.execPath,
      [opts.cliPath, "--agent-dir", opts.agentDir, "--cwd", opts.cwd, "--session", opts.sessionId],
      { cwd: opts.cwd, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"], shell: false },
    );
  }

  get stdin() { return this.child.stdin; }
  get stdout() { return this.child.stdout; }

  get alive(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }

  async stop(): Promise<void> {
    const child = this.child;
    try {
      child.stdin?.end();
      await new Promise<void>((r) => { const t = setTimeout(r, 1000); child.once("exit", () => { clearTimeout(t); r(); }); });
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((r) => { const t = setTimeout(r, 2000); child.once("exit", () => { clearTimeout(t); r(); }); });
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    } finally {
      if (!this.exitFired) this.exitFired = true;
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

/** 工厂:spawn 一个 probe4 内核子进程,返回 SubprocessHandle。 */
export function createProbe4Subprocess(opts: Probe4SubprocessSpawnOptions): SubprocessHandle {
  return new Probe4SubprocessHandle(opts);
}
