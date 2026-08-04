#!/usr/bin/env node
// Patch pi RPC mode: fork case 透传 position.
// Called by postinstall — safe to re-run, no-ops if target not found or already patched.
// 覆盖两个数据根:稳定版 ~/.pi-desktop/pi + dev 版 ~/.pi-desktop-dev/pi(分流见 client/paths.ts)。
// ⚠ 契约双源:匹配串镜像自 src/client/pi/patch-rpc-mode.ts(应用内装底座后运行时重打
// 走那份)——改一边必须改另一边;底座发版天然支持 position 后两边一起删。
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const home = require("node:os").homedir();
const roots = [".pi-desktop/pi", ".pi-desktop-dev/pi"];
const rel = join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "rpc", "rpc-mode.js");
const old = 'const result = await runtimeHost.fork(command.entryId);';
const rep = 'const opts = command.position ? { position: command.position } : undefined;\n                    const result = await runtimeHost.fork(command.entryId, opts);';
for (const root of roots) {
  const file = join(home, root, rel);
  if (!existsSync(file)) { console.log(`[patch:pi-rpc] ${file} not found, skipping`); continue; }
  const src = readFileSync(file, "utf8");
  if (!src.includes(old)) { console.log(`[patch:pi-rpc] fork pattern not found in ${root} (already patched or base upgraded), skipping`); continue; }
  writeFileSync(file, src.replace(old, rep), "utf8");
  console.log(`[patch:pi-rpc] Patched ${root} rpc-mode.js fork case to pass position`);
}
