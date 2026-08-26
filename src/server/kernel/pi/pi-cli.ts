// pi CLI 驱动(install/update/remove 扩展)—— spawn pi 子进程,进度经回调流出。
// 流出适配器:api/ipc 不直接 spawn(构造与执行分开,进程细节归 client)。
import { spawn } from "node:child_process";

export interface PiCliResult {
  ok: boolean;
  error: string | null;
}

export function runPiCli(
  args: string[],
  onProgress: (line: string) => void,
): Promise<PiCliResult> {
  // win32 的全局 pi 是 pi.cmd(批处理),必须经 shell(cmd.exe)解析;unix 直 exec 不经 shell。
  const child = spawn("pi", args, { shell: process.platform === "win32" });
  child.stdout?.on("data", (d) => onProgress(d.toString()));
  child.stderr?.on("data", (d) => onProgress(d.toString()));
  return new Promise<PiCliResult>((resolve) => {
    child.on("exit", (code) => {
      if (code === 0) resolve({ ok: true, error: null });
      else resolve({ ok: false, error: `pi ${args[0]} 退出码 ${code}` });
    });
  });
}
