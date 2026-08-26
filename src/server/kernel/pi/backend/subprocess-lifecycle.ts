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
import { resolveMyHarnessDesktopDir } from "../../../application/config/paths";
import type { SubprocessHandle, ProcessExit } from "./subprocess-handle";

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

/** 自动定位 pi CLI 入口(不含模式参数):优先全局 pi(走 PATH),回退数据根 pi/ 的 cli.js。
 *  rpc 会话进程与一次性进程(pi-oneshot)共用同一定位,模式参数由调用方各自拼。
 *  数据根经 resolveMyHarnessDesktopDir 分流(dev 态 -dev 目录),内核随目录隔离。 */
export function resolvePiCli(): { cmd: string; baseArgs: string[]; cwd?: string; shell: boolean } {
  const myHarnessDesktopDir = resolveMyHarnessDesktopDir();
  const cliJs = join(myHarnessDesktopDir, "pi", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const pkgRoot = join(myHarnessDesktopDir, "pi", "node_modules", "@earendil-works", "pi-coding-agent");
  if (existsSync(cliJs)) {
    return { cmd: "node", baseArgs: [cliJs], cwd: pkgRoot, shell: false };
  }
  return { cmd: "pi", baseArgs: [], shell: true };
}

/** 定位 pi CLI 并拼上 --mode rpc。返回 { cmd, args, cwd, shell } 供 spawn 用。 */
export function resolvePiSpawn(): { cmd: string; args: string[]; cwd?: string; shell: boolean } {
  const cli = resolvePiCli();
  return { cmd: cli.cmd, args: [...cli.baseArgs, "--mode", "rpc"], cwd: cli.cwd, shell: cli.shell };
}

/** 由 cli.js 绝对路径拼 spawn 调用(docs/design/custom-cli-path.md §2.4):
 *  RPC 会话(PiSubprocessHandle)与一次性进程(pi-oneshot)共用——"node 跑、无 shell、
 *  cli.js 作首参"这份知识只此一份;模式参数(--mode rpc / --print ...)由调用方各自拼。
 *  返回形状与 resolvePiCli 对齐(cwd 可选:自定义场景无 pkgRoot 语义,调用方 cwd 优先)。 */
export function cliInvocationFromPath(cliPath: string): { cmd: string; baseArgs: string[]; cwd?: string; shell: boolean } {
  return { cmd: "node", baseArgs: [cliPath], shell: false };
}

/** 拼本次 spawn 的完整调用。cliPath 分支不触碰 resolvePiSpawn——自定义场景不需要
 *  数据根定位,也让这条分支在非 Electron 环境(CLI 复用、集成测试)可用。 */
function computePiSpawn(opts: PiSubprocessSpawnOptions): { cmd: string; args: string[]; cwd?: string; shell: boolean } {
  if (opts.cliPath) {
    const c = cliInvocationFromPath(opts.cliPath);
    return { cmd: c.cmd, args: [...c.baseArgs, "--mode", "rpc", ...(opts.args ?? [])], cwd: opts.cwd, shell: c.shell };
  }
  const base = resolvePiSpawn();
  return { cmd: base.cmd, args: [...base.args, ...(opts.args ?? [])], cwd: opts.cwd ?? base.cwd, shell: base.shell };
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
    const piSpawn = computePiSpawn(opts);
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
