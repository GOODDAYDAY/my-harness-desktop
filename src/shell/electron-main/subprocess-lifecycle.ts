// 子进程生命周期 —— shell/electron-main,spawn/kill pi 子进程。
//
// 依据 docs/structure/17 §7.1.2:子进程生命周期管理是 shell 的职责(不在 gateway)。
// 本文件实现 gateway/SubprocessHandle 接口:spawn `pi --mode rpc`、关 stdin→SIGTERM→SIGKILL
// 停止策略、resolvePiSpawn(pi CLI 入口定位)。rpc-adapter 只消费返回的 handle。
//
// 依赖方向:shell 可 import 内层 gateway 的接口(SubprocessHandle);不反向。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SubprocessHandle, ProcessExit } from "../../gateway/subprocess-handle";

/** spawn 选项(对应原 RpcAdapterOptions 的 spawn 部分,shell 侧用)。 */
export interface PiSubprocessSpawnOptions {
  /** pi CLI 入口路径(绝对)。不传则自动定位。 */
  cliPath?: string;
  /** agent 工作目录。 */
  cwd?: string;
  /** 额外 CLI 参数(如 --session)。 */
  args?: string[];
  /** 环境变量(注入认证等)。 */
  env?: Record<string, string>;
}

/** 自动定位 pi CLI 入口:优先全局 pi(走 PATH),回退 ~/.pi-desktop/pi(用 node 跑 cli.js)。
 *  返回 { cmd, args, cwd, shell } 供 spawn 用。 */
export function resolvePiSpawn(): { cmd: string; args: string[]; cwd?: string; shell: boolean } {
  // 优先:全局 pi 命令(走 PATH,最稳)
  // 回退:~/.pi-desktop/pi 的 cli.js(用 node 跑,cwd 设为包根)
  const home = process.env["HOME"] ?? "";
  const cliJs = join(home, ".pi-desktop", "pi", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const pkgRoot = join(home, ".pi-desktop", "pi", "node_modules", "@earendil-works", "pi-coding-agent");
  if (existsSync(cliJs)) {
    return { cmd: "node", args: [cliJs, "--mode", "rpc"], cwd: pkgRoot, shell: false };
  }
  return { cmd: "pi", args: ["--mode", "rpc"], shell: true };
}

/**
 * PiSubprocessHandle:SubprocessHandle 的 shell 实现。
 * spawn 在构造时完成;stop 走"关 stdin→1s→SIGTERM→2s→SIGKILL"策略。
 * onceExit/onceError/onStderr 转发到底层 ChildProcess 事件;exit 只发一次。
 */
export class PiSubprocessHandle implements SubprocessHandle {
  private child: ChildProcess;
  private exitFired = false;

  constructor(opts: PiSubprocessSpawnOptions = {}) {
    const base = resolvePiSpawn();
    const piSpawn = opts.cliPath
      ? { cmd: "node", args: [opts.cliPath, "--mode", "rpc", ...(opts.args ?? [])], cwd: opts.cwd, shell: false }
      : { cmd: base.cmd, args: [...base.args, ...(opts.args ?? [])], cwd: opts.cwd ?? base.cwd, shell: base.shell };
    // opts.cwd(用户工作目录)优先于 resolvePiSpawn 的 cwd(pi 安装目录)。
    // resolvePiSpawn 的 cwd(pkgRoot)只用于 node cli.js 找依赖,不应覆盖用户 cwd。
    const spawnOpts = {
      cwd: piSpawn.cwd ?? opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      shell: piSpawn.shell,
    };
    this.child = spawn(piSpawn.cmd, piSpawn.args, spawnOpts);
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
      // 兜底:确保 exit 事件触发(即使 kill 未发 exit)
      if (!this.exitFired) {
        this.exitFired = true;
      }
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

/** 工厂:spawn 一个 pi 子进程,返回 SubprocessHandle。 */
export function createPiSubprocess(opts: PiSubprocessSpawnOptions = {}): SubprocessHandle {
  return new PiSubprocessHandle(opts);
}
