// pi 一次性进程 —— spawn `pi -p --no-session --no-tools <prompt>`,拿 stdout 文本。
//
// 机制定位:给插件一个"问一次底座"的通用能力(经 permissions "llm:oneshot" 门控),
// 不落会话文件(--no-session)、禁用全部工具(--no-tools,不可能动文件)、
// provider/key 走底座自己的 models.json(内核零感知)。
// prompt 内容由调用方(插件)拼装,本文件不知道什么叫 commit message(机制与内容分离)。
import { spawn } from "node:child_process";
import { resolvePiCli } from "./subprocess-lifecycle";

/** prompt 硬上限(ARG_MAX 保险;插件应在此前自行截断内容,如 diff)。 */
export const ONESHOT_PROMPT_MAX_BYTES = 256 * 1024;
/** stdout 上限(防异常输出撑爆内存)。 */
const STDOUT_MAX_BYTES = 1024 * 1024;

export interface PiOneshotOptions {
  /** 工作目录(一般是当前项目根;影响底座读项目级配置)。 */
  cwd?: string;
  /** 超时,默认 60s;超时 SIGKILL 并按失败返回。 */
  timeoutMs?: number;
}

/** 跑一次性 prompt,resolve stdout 文本;失败(超时/非零退出/spawn 错误)reject。 */
export function runPiOneshot(prompt: string, opts: PiOneshotOptions = {}): Promise<string> {
  if (Buffer.byteLength(prompt, "utf-8") > ONESHOT_PROMPT_MAX_BYTES) {
    return Promise.reject(new Error(`prompt 过大(>${ONESHOT_PROMPT_MAX_BYTES / 1024}KB),调用方应先截断`));
  }
  const cli = resolvePiCli();
  const args = [...cli.baseArgs, "--print", "--no-session", "--no-tools", prompt];
  const child = spawn(cli.cmd, args, {
    cwd: opts.cwd ?? cli.cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: cli.shell,
  });
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let out = "";
  let err = "";
  let truncated = false;
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`oneshot 超时(${timeoutMs / 1000}s)`));
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      if (truncated) return;
      out += d.toString();
      if (Buffer.byteLength(out, "utf-8") > STDOUT_MAX_BYTES) {
        truncated = true;
        child.kill("SIGKILL");
        clearTimeout(timer);
        rejectPromise(new Error("oneshot 输出超限"));
      }
    });
    child.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
    child.once("error", (e) => {
      clearTimeout(timer);
      rejectPromise(new Error(`oneshot spawn 失败: ${e.message}`));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out.trim());
      else rejectPromise(new Error(`oneshot 退出码 ${code}: ${err.trim().slice(0, 500)}`));
    });
  });
}
