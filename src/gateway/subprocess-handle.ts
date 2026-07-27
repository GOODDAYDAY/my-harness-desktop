// SubprocessHandle —— gateway 自有的子进程句柄契约。
//
// 依据 docs/structure/17 §7.1.2:rpc-adapter 不负责 spawn/kill 子进程——
// 那是 shell/electron-main/subprocess-lifecycle.ts 的职责。rpc-adapter 构造时收一个
// SubprocessHandle(本接口),只消费其 stdin/stdout 做 JSONL 读写 + id 配对 + event 分发。
//
// 依赖倒置:接口归 gateway 拥有(比 application 更内层,不 import shell),
// 实现由 shell 提供、构造期注入。换运行时(utilityProcess→sidecar)只写新实现,
// rpc-adapter 一行不改。
//
// 本接口只抽 rpc-adapter 真正用到的子进程能力,最小集,不暴露 ChildProcess 全貌。
import type { Readable, Writable } from "node:stream";

/** 子进程退出信息。 */
export interface ProcessExit {
  code: number | null;
  signal: string | null;
}

/**
 * 子进程句柄:rpc-adapter 只消费的子进程能力面。
 * 实现负责 spawn + kill 策略(shell/subprocess-lifecycle);本接口不规定 spawn 细节。
 */
export interface SubprocessHandle {
  /** stdin(写命令)。实现保证 start 后可用、stop 后置 null。 */
  readonly stdin: Writable | null;
  /** stdout(读 JSONL 响应/event)。实现保证 start 后可用。 */
  readonly stdout: Readable | null;
  /** 进程是否仍存活(exitCode===null && !killed)。 */
  readonly alive: boolean;
  /** 结束子进程:实现自行决定 kill 策略(关 stdin→SIGTERM→SIGKILL 等),resolve 于完全停止。 */
  stop(): Promise<void>;
  /** 监听 exit(实现保证 stop 也会触发,或实现自行保证只发一次期望退出)。 */
  onceExit(cb: (exit: ProcessExit) => void): void;
  /** 监听 spawn/error 级错误(进程起不来、stdin 写失败等)。 */
  onceError(cb: (error: Error) => void): void;
  /** 监听 stderr 输出(调试收集)。 */
  onStderr(cb: (chunk: Buffer) => void): void;
}
