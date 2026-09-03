// pi 旧会话文件的一次性中立层导入(session-single-source §4.3)。
//
// 背景:中立层成为列表/打开的唯一读源后,只有「文件名 ≡ ns」的新派生文件能被反查;
// 旧命名(<时间戳>_<id>.jsonl)与派生路径不匹配,对新架构隐形。本模块在启动对账时
// 把旧文件逐份读入中立层立档——这是「壳不读内核存储」的两个显式例外之一
// (离线迁移工具,不是会话流的运行时读路径)。
//
// 纪律:幂等(已有中立会话的跳过);损坏文件跳过不中断;读内核存储只经 pi-catalog 的面。

import { readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { piReadSession } from "../../kernel/pi/backend/pi-catalog";
import { neutralEntryId, type NeutralEntry, type NeutralSession } from "@my-harness-desktop/shared";
import type { NeutralSessionStore } from "./neutral-session-store";

export interface LegacyImportResult {
  /** 新立档的会话数。 */
  imported: number;
  /** 已有中立层跳过数。 */
  skipped: number;
  /** 读取失败/缺 cwd 跳过数。 */
  failed: number;
}

/** 把旧 pi 会话文件读成一个中立会话(单 lineage,条目带 kernelEntryId 投影线索)。 */
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

/** 启动对账:扫 pi 会话根下全部桶的 .jsonl,无中立层的逐份导入。
 *  ns 取值:文件头 custom.neutralSessionId 优先(新派生文件的文件名即 ns,多数已有);
 *  缺省(真旧命名)生成新 ns——旧文件留作「打开原始文件」底稿,投影路径按新 ns 派生。 */
export function importLegacyPiSessions(agentDir: string, neutralStore: NeutralSessionStore): LegacyImportResult {
  const result: LegacyImportResult = { imported: 0, skipped: 0, failed: 0 };
  const root = join(agentDir, "sessions");
  if (!existsSync(root)) return result;
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
      // ns 候选:文件名(新派生文件 = <ns>.jsonl)即可反查;旧命名再读头行 custom 域。
      const byName = basename(file, ".jsonl");
      const detail = piReadSession(fullPath);
      if (!detail || detail.messages.length === 0 || !detail.info.cwd) {
        result.failed += 1;
        continue;
      }
      const custom = detail.info.custom as Record<string, unknown> | undefined;
      const ns = (typeof custom?.neutralSessionId === "string" ? custom.neutralSessionId : undefined) ?? byName;
      if (neutralStore.get(ns)) {
        result.skipped += 1;
        continue;
      }
      const session = toNeutralSession(ns, detail);
      if (!session) {
        result.failed += 1;
        continue;
      }
      neutralStore.put(session);
      result.imported += 1;
    }
  }
  return result;
}
