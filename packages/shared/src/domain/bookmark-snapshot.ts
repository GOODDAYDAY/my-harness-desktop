// 收藏快照：插点抽象的圆心纯函数 + 快照文件格式（零依赖，只 import 圆心内部）。
//
// 依据 docs/design/bookmark-snapshot-fork-unify.md §2/§3。这是「收藏 = 在某节点插点」
// 的地基：物化一条 lineage 到锚点为止的完整前缀（自包含快照），与内核存储格式无关——
// 快照是中立 `NeutralEntry[]`，发起时经既有 seed 投影投到任意内核（pi / dsh）。
//
// 与坐标书签（session-neutral-layer.md §12 去 opaque）的关系：本文件是那次设计的定向反转
// 的另一半——从「存坐标、发起时现场 fork」回到「存物化快照、发起时同步快照」，快照自包含。

import type { KernelId } from "./kernel";
import type { NeutralEntry, NeutralSession } from "./session-neutral";
import { lineageContent } from "./session-neutral";

/** 快照格式版本：向后不兼容的字段变更时递增；读旧版本显式报错，不静默降级。 */
export const BOOKMARK_SNAPSHOT_VERSION = 1;

/** 收藏快照：一条自包含的 lineage 前缀（物化拷贝），落盘到项目级 bookmarks 目录。 */
export interface BookmarkSnapshot {
  version: typeof BOOKMARK_SNAPSHOT_VERSION;
  /** 快照 id（crypto.randomUUID()），也是快照文件名 `<id>.json`。 */
  id: string;
  label: string;
  preview: string;
  createdAt: string;
  /** 来源内核：仅记录（展示/默认投影参考），不参与投影路由——投影走能力探测。 */
  sourceKernel: KernelId;
  /** 来源中立会话 id：仅溯源，发起时不以它读源会话（快照自包含）。 */
  sourceNeutralSessionId: string;
  /** 锚点：fork "at" 的 entry 中立 id（{lineageId}:{seq}），快照内容含此 entry。 */
  boundaryEntryId: string;
  lineage: {
    /** 快照自身的 lineage id（物化后的新身份，与源 lineage 解耦）。 */
    lineageId: string;
    /** 物化的完整前缀（NeutralEntry[]，含 boundary）。发起时 seed 用。 */
    entries: NeutralEntry[];
  };
}

/** 物化前缀的结果：前缀条目 + 锚点的中立坐标（跨内核稳定）。 */
export interface MaterializedPrefix {
  /** 完整前缀（含锚点）。发起时 seed 用。 */
  entries: NeutralEntry[];
  /** 锚点的中立坐标（neutralEntryId，{lineageId}:{seq}），fork "at" 的落点。 */
  boundaryEntryId: string;
}

/**
 * 物化一条 lineage 到锚点为止的完整前缀（纯函数，零依赖）。
 *
 * 复用 `lineageContent` 沿 fork 链现算的完整线性内容，再截到锚点（含）。
 * 结果 = 「从某节点复制一份完全相同的数据出来」的物化形态——fork 与收藏共用的插点地基。
 *
 * `anchorId` 是渲染层给的节点 id：实际是 `kernelEntryId`（JSONL 行级 id，经
 * NeutralMessage.id 透出）。同时兼容 `neutralEntryId`（调用方若已持有中立坐标）。
 * 返回的 `boundaryEntryId` 恒为 `neutralEntryId`——快照锚点要跨内核稳定，不存内核私有 id。
 *
 * 返回 `null` = 锚点不在内容里（数据损坏 / 压缩已移除该 entry），调用方显式降级，
 * 不静默把「整条 lineage」当快照（那会把锚点之后的条目也卷进快照，语义错误）。
 */
export function materializeLineagePrefix(
  session: NeutralSession,
  lineageId: string,
  anchorId: string,
): MaterializedPrefix | null {
  const content = lineageContent(session, lineageId);
  const idx = content.findIndex(
    (e) => e.kernelEntryId === anchorId || e.neutralEntryId === anchorId,
  );
  if (idx < 0) return null;
  return { entries: content.slice(0, idx + 1), boundaryEntryId: content[idx].neutralEntryId };
}

/** 序列化快照（JSON）。字段名即文件格式契约，不改键名。 */
export function serializeBookmarkSnapshot(snapshot: BookmarkSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/**
 * 反序列化快照。版本不符抛错（显式，不静默吞）——旧版本快照需要显式迁移，
 * 而非悄悄按新形状解析出错。
 */
export function parseBookmarkSnapshot(raw: string): BookmarkSnapshot {
  const parsed = JSON.parse(raw) as BookmarkSnapshot;
  if (parsed == null || typeof parsed !== "object" || parsed.version !== BOOKMARK_SNAPSHOT_VERSION) {
    throw new Error(
      `快照版本不兼容：期望 ${BOOKMARK_SNAPSHOT_VERSION}，收到 ${String((parsed as { version?: unknown })?.version)}`,
    );
  }
  if (typeof parsed.id !== "string" || !Array.isArray(parsed.lineage?.entries)) {
    throw new Error("快照结构损坏：缺少 id 或 lineage.entries");
  }
  return parsed;
}
