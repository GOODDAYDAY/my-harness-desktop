// 内核旧会话 → 中立层的一次性导入（**壳侧机制**，内核无关）。
//
// 为什么壳侧只留这么薄的一层：把旧格式读成中立会话是**内核专属知识**（pi 的老 JSONL 命名、
// dsh 的 zstd 归档各不相同），由各内核经 `KernelPlugin.readLegacySessions()` 自己交；
// 而"写进中立层、幂等跳过已存在的"是**壳的机制**（中立层是壳的 canonical 真相源，
// 内核不感知它）。这条分界线让 application 层不再需要 import 任何内核实现——
// 历史上它为了做这事 import 过 pi-catalog，是 dependency-audit 里唯一一条明文豁免，现已取消。
//
// 纪律：幂等（已有中立会话的跳过）；某个内核读取失败不影响其它内核（逐个 try/catch 计数）。

import type { KernelPlugin, NeutralSession } from "@my-harness-desktop/shared";
import type { NeutralSessionStore } from "./neutral-session-store";

export interface LegacyImportResult {
  /** 新立档的会话数。 */
  imported: number;
  /** 已有中立层跳过数。 */
  skipped: number;
  /** 内核侧读取失败的会话数（损坏/缺 cwd 等，内核自己计数）。 */
  failed: number;
  /** 读取时抛异常的内核 id（不静默：内核坏了要看得见）。 */
  failedKernels: string[];
}

/** 启动对账：逐个内核问"你有没有还没进中立层的旧会话"，有的就补进中立层。 */
export function importLegacySessions(plugins: readonly KernelPlugin[], neutralStore: NeutralSessionStore): LegacyImportResult {
  const result: LegacyImportResult = { imported: 0, skipped: 0, failed: 0, failedKernels: [] };
  for (const plugin of plugins) {
    if (!plugin.readLegacySessions) continue;
    let sessions: NeutralSession[];
    try {
      sessions = plugin.readLegacySessions();
    } catch (e) {
      result.failedKernels.push(plugin.id);
      console.error(`[legacy-import] 内核 ${plugin.id} 的旧会话读取失败:`, e instanceof Error ? e.message : e);
      continue;
    }
    for (const session of sessions) {
      if (neutralStore.get(session.neutralSessionId)) {
        result.skipped += 1;
        continue;
      }
      neutralStore.put(session);
      result.imported += 1;
    }
  }
  return result;
}
