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

// entry_appended 补丁:底座常规消息持久化不发射 entry_appended(唯一发射点是扩展
// appendCustomEntry,0.74→0.83 逐版核实),桌面端消息 id 水合/收藏/重试/review 划词锚定
// 全依赖该事件——事件缺席 = 新回复消息永远无 entryId,按钮只剩复制、浮钮不出。
// 在 message_end 持久化点补发射;匹配串含前导注释行,打完后旧组合消失,重跑幂等跳过。
const rel2 = join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "agent-session.js");
const old2 = '                // Regular LLM message - persist as SessionMessageEntry\n' +
  '                this.sessionManager.appendMessage(event.message);';
const rep2 = '                // Regular LLM message - persist as SessionMessageEntry\n' +
  '                const __desktopEntryId = this.sessionManager.appendMessage(event.message);\n' +
  '                const __desktopEntry = this.sessionManager.getEntry(__desktopEntryId);\n' +
  '                if (__desktopEntry) this._emit({ type: "entry_appended", entry: __desktopEntry });';
for (const root of roots) {
  const file = join(home, root, rel2);
  if (!existsSync(file)) { console.log(`[patch:pi-entry-appended] ${file} not found, skipping`); continue; }
  const src = readFileSync(file, "utf8");
  if (!src.includes(old2)) { console.log(`[patch:pi-entry-appended] persist pattern not found in ${root} (already patched or base upgraded), skipping`); continue; }
  writeFileSync(file, src.replace(old2, rep2), "utf8");
  console.log(`[patch:pi-entry-appended] Patched ${root} agent-session.js to emit entry_appended on message persist`);
}
