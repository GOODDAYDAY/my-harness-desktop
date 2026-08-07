// 跨平台版 `env -u ELECTRON_RUN_AS_NODE`（替代 POSIX 的 env 命令）：
// Apps Studio / VSCode 这类 Electron 宿主终端的集成终端会把 ELECTRON_RUN_AS_NODE 注入
// 环境，导致 electron 以纯 Node 模式启动、require("electron") 拿不到 app（commit b2c788c
// 引入的免疫语义）。Windows 没有 env 命令，由这里摘掉该变量再 spawn 子进程，三平台行为一致。
// 用法：node scripts/run.cjs <command> [args...]
const { spawn } = require("node:child_process");

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error("usage: node scripts/run.cjs <command> [args...]");
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Windows 上 npm 加进 PATH 的 node_modules/.bin 是 .cmd 垫片，必须经 shell 解析才能找到
const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32", env });

child.on("error", (err) => {
  console.error(`[run.cjs] spawn ${cmd} failed:`, err.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
