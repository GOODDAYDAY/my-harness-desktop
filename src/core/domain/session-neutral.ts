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

/**
 * 拓扑排序 lineage:按 `fork.parentLineageId` 依赖排,父 lineage 先于子分支,根(fork=null)最前。
 *
 * 为什么需要:seed 投影是"边写边记 idMap",只有父 lineage 写完后,分支的
 * `fork.boundaryEntryId` 才能在 idMap 里命中。父后于子 → 分叉点缺失 → 分支挂到根。
 * 不依赖 `getTree` 的返回顺序(pi 恰好根在前,dsh 无保证)。
 *
 * 边界(损坏数据):
 * - 有环 → DFS 遇 `visiting` 已含的节点直接 return(不无限递归),环内按 DFS 发现序输出;
 * - `parentLineageId` 悬空 → 按无父处理(当根),不抛错中断整次排序。
 */
export function sortLineagesTopologically(lineages: NeutralLineage[]): NeutralLineage[] {
  const byId = new Map(lineages.map((l) => [l.lineageId, l]));
  const out: NeutralLineage[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (l: NeutralLineage): void => {
    if (done.has(l.lineageId)) return;
    if (visiting.has(l.lineageId)) return; // 环:降级为已访问,不无限递归
    visiting.add(l.lineageId);
    if (l.fork) {
      const parent = byId.get(l.fork.parentLineageId);
      if (parent) visit(parent);
    }
    visiting.delete(l.lineageId);
    done.add(l.lineageId);
    out.push(l);
  };
  for (const l of lineages) visit(l);
  return out;
}

/**
 * 归一 fork 边界(§7.4):把 `fork.boundaryEntryId` 从内核私有 boundary 反查成父 lineage 里
 * `kernelEntryId` 匹配的那条 entry 的 `neutralEntryId`。反查不到(dsh 坐标系不同 / 数据损坏 /
 * 隐藏条目)→ 空串(seed 时该分支按根处理,不静默挂错父)。
 * 返回新数组(不 mutate 入参);前置:入参已拓扑序(父 lineage 在前,§7.3)。
 */
export function resolveForkBoundaries(lineages: NeutralLineage[]): NeutralLineage[] {
  const byId = new Map(lineages.map((l) => [l.lineageId, l]));
  return lineages.map((l) => {
    if (!l.fork) return l;
    const fork = l.fork; // 捕获非空(闭包内 TypeScript 不保留属性窄化)
    const parent = byId.get(fork.parentLineageId);
    const anchor = parent?.entries.find((e) => e.kernelEntryId === fork.boundaryEntryId);
    return {
      ...l,
      fork: {
        parentLineageId: fork.parentLineageId,
        boundaryEntryId: anchor?.neutralEntryId ?? "",
      },
    };
  });
}
