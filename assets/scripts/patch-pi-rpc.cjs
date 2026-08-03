#!/usr/bin/env node
// Patch pi RPC mode: fork case 透传 position.
// Called by postinstall — safe to re-run, no-ops if target not found or already patched.
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const home = require("node:os").homedir();
const file = join(home, ".pi-desktop/pi/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js");
if (!existsSync(file)) { console.log("[patch:pi-rpc] rpc-mode.js not found, skipping"); process.exit(0); }
const old = 'const result = await runtimeHost.fork(command.entryId);';
const rep = 'const opts = command.position ? { position: command.position } : undefined;\n                    const result = await runtimeHost.fork(command.entryId, opts);';
let src = readFileSync(file, "utf8");
if (!src.includes(old)) { console.log("[patch:pi-rpc] fork pattern not found (already patched or base upgraded), skipping"); process.exit(0); }
src = src.replace(old, rep);
writeFileSync(file, src, "utf8");
console.log("[patch:pi-rpc] Patched rpc-mode.js fork case to pass position");
