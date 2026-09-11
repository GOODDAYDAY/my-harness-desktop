// SubprocessHandle —— 内核层共有的子进程句柄契约(壳机制,归 kernel/core)。
//
// 依据 docs/design/kernel-plugin.md「一个内核 = 一个插件,内核之间零耦合」与
// docs/structure/17 §7.1.2(适配器不负责 spawn/kill 子进程):
// 各内核的 transport / rpc-adapter 构造时收一个 SubprocessHandle,只消费其
// stdin/stdout 做 JSONL 读写 + id 配对 + event 分发;spawn/kill 由各内核自己的
// subprocess-lifecycle 实现(会变的细节留外层,接口留机制层)。
//
// 依赖倒置:接口归内核机制层拥有(不 import 任何具体内核、不 import shell),
// 实现由各内核提供、构造期注入。换运行时(utilityProcess→sidecar)只写新实现,
// 消费方一行不改。
//
// **本文件曾在 pi/backend/ 下**——dsh 与 minimal 都经 `../../pi/backend/subprocess-handle`
// 引用它,于是「删掉 pi 内核插件」会让 dsh/minimal 直接编译不过,三个内核被一个共享
// 类型偷偷焊成一体(卸载验收不成立)。收到 core/ 后,内核之间零 import,任一内核
// 可独立卸载(§目标 13 的可卸载性,守卫见 scripts/dependency-audit.mjs 检验 ⑧)。
//
// 本接口只抽消费方真正用到的子进程能力,最小集,不暴露 ChildProcess 全貌。
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
