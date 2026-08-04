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
