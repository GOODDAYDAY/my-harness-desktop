// 圆心:会话级中立坐标系 —— 中立会话身份 / 锚点 / 树 / 模型引用,零依赖。
//
// 依据 docs/design/session-neutral-layer.md。这是「中立契约」的另一半:消息/事件/树形投影
// 中立了(见 backend.ts),但会话身份和锚点还留在内核私有里——本文把它们也中立化。
// 主线:换内核 = 换投影实现,中立会话层一行不动。
//
// 本文件零依赖(只 import domain 内部的 kernel + 中性事件),是圆心最内层的原子。

import type { KernelId } from "./kernel";
import type { NeutralMessage } from "./events/session-state";

/** 中立会话身份:壳生成、跨内核稳定的会话 id(UUID)。壳的会话列表/书签/分组都以它为主键。 */
export interface NeutralSessionId {
  value: string;
}

/** 一个内核里,中立会话 id → 私有会话 id 的投影。映射表持久化,回切找回原会话。 */
export interface KernelSessionBinding {
  kernel: KernelId;
  neutralSessionId: string;
  /** 内核私有会话标识:pi = JSONL 文件路径,dsh = session id / childSessionId。 */
  kernelPrivateId: string;
  /** 绑定时间(诊断/排序用)。 */
  boundAt: string;
}

/** 中立锚点:中立会话树里的坐标,完全内核无关。替代 backend.ts 的 Anchor.opaque 私有 token。 */
export interface NeutralAnchor {
  /** 中立 lineage id(LineageTree 里的 lineage.id)。 */
  lineageId: string;
  /** 该 lineage 内的中立 entry 坐标({lineageId}:{seq},见 neutralEntryId)。 */
  entryId: string;
}

/** 中立会话树:完整的中立会话结构,含 entries。比 LineageTree(只有分叉关系)多了 entries。 */
export interface NeutralSession {
  neutralSessionId: string;
  /** 会话头元数据:内核归属、项目、时间戳等。 */
  header: NeutralSessionHeader;
  lineages: NeutralLineage[];
}

export interface NeutralSessionHeader {
  kernel: KernelId;
  cwd: string;
  createdAt: string;
}

export interface NeutralLineage {
  lineageId: string;
  /** 从哪条父 lineage 的哪个中立 entry 切出来;null = 根 lineage。 */
  fork: { parentLineageId: string; boundaryEntryId: string } | null;
  /** 该 lineage 的完整 entry 序列(按时间序,每条含中立 entryId)。 */
  entries: NeutralEntry[];
}

export interface NeutralEntry {
  /** 中立 entry id({lineageId}:{seq},见 neutralEntryId)。稳定,跨内核不变。 */
  neutralEntryId: string;
  /** 内核私有 entry id(投影时的 opaque 线索,仅 adapter 用,不进中立契约对外面)。 */
  kernelEntryId?: string;
  /** 中性消息(role/content/…)。 */
  message: NeutralMessage;
}

/** 中立模型引用:壳记录的「当前模型」的中立 id。壳自己的模型语义,非内核 provider/model。 */
export interface NeutralModelRef {
  /** 壳的中立模型 id(如 "fast" / "pro" / "reasoning")。 */
  ref: string;
  /** 可选:中立推理档位(壳自己的档位,非 pi thinkingLevel / dsh reasoningEffort)。 */
  effort?: string;
}

/** 中立 entryId 生成:{lineageId}:{seq},seq 是条目在所属 lineage 内的 0-based 序号。 */
export function neutralEntryId(lineageId: string, seq: number): string {
  return `${lineageId}:${seq}`;
}
