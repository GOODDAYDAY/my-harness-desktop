// 底座 rpc-mode.js 补丁:fork case 透传 position(上游 PR 未发版前的桥)。
//
// 背景(docs/design/bookmark-fork-at.md §4.3):底座 0.83.0 的 RPC fork case 不读
// command.position,assistant 锚点恒撞 "before" 的 role 校验。补丁用精确字符串匹配
// 改一行;底座发版天然支持后目标行消失,补丁幂等跳过,届时本文件与
// assets/scripts/patch-pi-rpc.cjs 一起删。
//
// ⚠ 契约双源(临时桥的宿命):匹配串在 patch-pi-rpc.cjs 有一份镜像(postinstall 场景
// 无法 import TS)——改一边必须改另一边。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 补丁结果:打了 / 已是目标形态(含底座升级天然支持) / 文件不存在。 */
export type PatchOutcome = "patched" | "already" | "missing";

const RPC_MODE_REL = join(
  "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "rpc", "rpc-mode.js",
);
const FORK_LINE_OLD = "const result = await runtimeHost.fork(command.entryId);";
const FORK_LINE_NEW =
  "const opts = command.position ? { position: command.position } : undefined;\n" +
  "                    const result = await runtimeHost.fork(command.entryId, opts);";

/** 给数据根安装目录的底座打 fork position 补丁。幂等,可重复执行。 */
export function patchRpcModeForkPosition(installDir: string): PatchOutcome {
  const file = join(installDir, RPC_MODE_REL);
  if (!existsSync(file)) return "missing";
  const src = readFileSync(file, "utf8");
  if (!src.includes(FORK_LINE_OLD)) return "already";
  writeFileSync(file, src.replace(FORK_LINE_OLD, FORK_LINE_NEW), "utf8");
  return "patched";
}

// ---- entry_appended 补丁(2026-08-06 实证根因)----
//
// 底座 AgentSessionEvent 联合声明了 entry_appended,但常规消息持久化路径从不发射——
// 全 dist 唯一发射点在扩展 appendCustomEntry 回调(0.74→0.83 逐版核实)。桌面端的
// 消息 id 水合(applyEvent entryAppended 分支)、时间线 data-message-id、收藏/重试/
// 回退按钮、review 划词锚定全部建立在该事件之上;事件缺席 = 新回复的消息永远拿不到
// entryId(实证:完整一轮事件流零 entryAppended),按钮只剩不依赖 id 的复制,
// 划词浮钮不出——切走再切回(文件重读带 id)才"自愈"。
//
// 补丁在 message_end 持久化点补发射:appendMessage 返回 entryId,getEntry 取条目,
// _emit 走 RPC stdout 进桌面事件流。写序 message_end → entry_appended 与
// renderer 水合契约(先定稿后水合)一致。
//
// 匹配串含前导注释行:打完后旧两行组合不再存在(第二行形态已变),重跑幂等跳过;
// 底座发版若改写该语句(含天然支持 entry_appended),匹配失败安全跳过。
const AGENT_SESSION_REL = join(
  "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "agent-session.js",
);
const PERSIST_OLD =
  "                // Regular LLM message - persist as SessionMessageEntry\n" +
  "                this.sessionManager.appendMessage(event.message);";
const PERSIST_NEW =
  "                // Regular LLM message - persist as SessionMessageEntry\n" +
  "                const __desktopEntryId = this.sessionManager.appendMessage(event.message);\n" +
  "                const __desktopEntry = this.sessionManager.getEntry(__desktopEntryId);\n" +
  "                if (__desktopEntry) this._emit({ type: \"entry_appended\", entry: __desktopEntry });";

/** 给底座的常规消息持久化路径补 entry_appended 发射。幂等,可重复执行。 */
export function patchAgentSessionEntryAppended(installDir: string): PatchOutcome {
  const file = join(installDir, AGENT_SESSION_REL);
  if (!existsSync(file)) return "missing";
  const src = readFileSync(file, "utf8");
  if (!src.includes(PERSIST_OLD)) return "already";
  writeFileSync(file, src.replace(PERSIST_OLD, PERSIST_NEW), "utf8");
  return "patched";
}
