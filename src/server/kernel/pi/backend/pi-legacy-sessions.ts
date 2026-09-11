// pi 旧会话文件的读取面 —— 把 pi 的老 JSONL 读成**中立会话**（session-single-source §4.3）。
//
// 归属（本轮搬家，勿搬回去）：这件事在**内核侧**，不在 application 侧。
// 背景是：中立层成为列表/打开的唯一读源后，只有「文件名 ≡ ns」的新派生文件能被反查；
// pi 的旧命名（<时间戳>_<id>.jsonl）与派生路径不匹配，对新架构隐形，需要一次性立档。
// 但"读 pi 的老文件格式"是**pi 的私有知识**，而"写进中立层、幂等跳过已存在的"是**壳的机制**。
// 混在 application 里的代价是实打实的：那曾是一条 application→kernel 的**明文依赖豁免**
// （dependency-audit 的 DOCUMENTED_EXCEPTIONS 里唯一一条），等于在"application 不许 import
// 内核实现"这条红线旁边开了个永久口子。现在口子没有了：本文件返回中立会话，壳负责落库。
//
// 纪律:损坏文件跳过不中断（诚实降级，不伪造）；不读中立层、不写中立层（那是壳的事）。

import { readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { piReadSession } from "./pi-catalog";
import { neutralEntryId, type NeutralEntry, type NeutralSession } from "@my-harness-desktop/shared";

/** 把旧 pi 会话文件读成一个中立会话（单 lineage，条目带 kernelEntryId 投影线索）。 */
function toNeutralSession(ns: string, detail: NonNullable<ReturnType<typeof piReadSession>>): NeutralSession | null {
  const cwd = detail.info.cwd;
  if (!cwd) return null; // 缺 cwd 无法归桶,跳过(诚实,不猜)
  const entries: NeutralEntry[] = detail.messages.map((m, i) => ({
    neutralEntryId: neutralEntryId(ns, i),
    kernelEntryId: typeof m.id === "string" ? m.id : undefined,
    message: m,
  }));
  return {
    neutralSessionId: ns,
    header: {
      kernel: "pi",
      cwd,
      createdAt: detail.info.created,
      name: detail.info.name,
      updatedAt: detail.info.modified,
      pinned: detail.info.pinned,
      archived: detail.info.archived,
      custom: detail.info.custom,
    },
    lineages: [{ lineageId: ns, fork: null, entries }],
  };
}

/**
 * 扫 pi 会话根下全部桶的 `.jsonl`，把能读成中立会话的都读出来（**不落库、不去重**）。
 *
 * ns 取值：文件头 `custom.neutralSessionId` 优先（新派生文件的文件名即 ns，多数已有）；
 * 缺省（真旧命名）用文件名当 ns——旧文件留作「打开原始文件」的底稿，投影路径按新 ns 派生。
 * 去重与写库是调用方（壳）的事：那属于中立层机制，不属于内核。
 */
export function readLegacyPiSessions(agentDir: string): { sessions: NeutralSession[]; failed: number } {
  const sessions: NeutralSession[] = [];
  let failed = 0;
  const root = join(agentDir, "sessions");
  if (!existsSync(root)) return { sessions, failed };
  for (const bucket of readdirSync(root)) {
    const bucketDir = join(root, bucket);
    let files: string[];
    try {
      files = readdirSync(bucketDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue; // 非目录/不可读,跳过
    }
    for (const file of files) {
      const fullPath = join(bucketDir, file);
      const byName = basename(file, ".jsonl");
      const detail = piReadSession(fullPath);
      if (!detail || detail.messages.length === 0 || !detail.info.cwd) {
        failed += 1;
        continue; // 损坏/空/缺 cwd：跳过不中断（诚实降级）
      }
      const custom = detail.info.custom as Record<string, unknown> | undefined;
      const ns = (typeof custom?.neutralSessionId === "string" ? custom.neutralSessionId : undefined) ?? byName;
      const session = toNeutralSession(ns, detail);
      if (!session) {
        failed += 1;
        continue;
      }
      sessions.push(session);
    }
  }
  return { sessions, failed };
}
