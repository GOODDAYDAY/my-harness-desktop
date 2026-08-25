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
  /** 列表行字段(§kernel-forkless-branch §10):会话名(真相源,不再是内核 session_info 条目)。 */
  name?: string;
  /** 最近修改时间(ISO;列表排序/「最近」分组用)。 */
  updatedAt?: string;
  /** 末条消息预览(副标题)。 */
  lastMessage?: string;
  /** 未读位标:最后一条 entry 的中立 entry id({lineageId}:{seq})。 */
  lastEntryId?: string;
  /** 置顶。 */
  pinned?: boolean;
  /** 归档。 */
  archived?: boolean;
  /** desktop 私有域(保留键 pinned/archived/toolConfig 平铺顶层,插件域不得占用)。 */
  custom?: Record<string, unknown>;
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
  /** 展示元数据:交流机制,不进 AI 投影。图等归中立层维护,发送时过滤
   *  (neutral-session-first.md §4)。 */
  display?: DisplayMeta;
}

/** 展示元数据:只给人看,永不进 pi/dsh 的 AI 投影。图/贴纸等交流机制归中立层维护。
 *  「图是交流机制、不是 AI 输入」这条(sticker-plugin.md §1.2)在此显式成类型:
 *  展示图走 display,vision 图走 sendMessage 的 images 参数,两条不相交路径。 */
export interface DisplayMeta {
  /** 配图(IM 配图风格:图挂在 user 消息上方)。src 存逻辑路径,图文件本体在全局数据根。 */
  image?: { src: string; title?: string };
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

// ============ 中立会话树的纯函数 mutation(neutral-first,零依赖) ============
// 这些是「kernel 版本」的增改纯函数:session-store 读 → 应用纯函数 → 写回,
// 或直接组合。图/展示元数据、fork 结构都经这里维护,不进 AI 投影。

/** 空中立会话:根 lineage 尚不存在(首条 entry append 时按根创建)。 */
export function emptyNeutralSession(id: string, header: NeutralSessionHeader): NeutralSession {
  return { neutralSessionId: id, header, lineages: [] };
}

/** 追加一条 entry 到指定 lineage 末尾(纯函数,不 mutate 入参)。
 *  lineage 不存在 → 当作根 lineage 创建(fork=null)。neutralEntryId 缺省按 seq 生成。 */
export function appendNeutralEntry(session: NeutralSession, lineageId: string, entry: NeutralEntry): NeutralSession {
  const idx = session.lineages.findIndex((l) => l.lineageId === lineageId);
  if (idx < 0) {
    const id = entry.neutralEntryId || neutralEntryId(lineageId, 0);
    return {
      ...session,
      lineages: [...session.lineages, { lineageId, fork: null, entries: [{ ...entry, neutralEntryId: id }] }],
    };
  }
  const lineage = session.lineages[idx];
  const id = entry.neutralEntryId || neutralEntryId(lineageId, lineage.entries.length);
  const next: NeutralLineage = { ...lineage, entries: [...lineage.entries, { ...entry, neutralEntryId: id }] };
  return { ...session, lineages: session.lineages.map((l, i) => (i === idx ? next : l)) };
}

/** 追加/替换一条分支 lineage(纯函数)。同 lineageId 已存在则替换。 */
export function upsertNeutralLineage(session: NeutralSession, lineage: NeutralLineage): NeutralSession {
  const rest = session.lineages.filter((l) => l.lineageId !== lineage.lineageId);
  return { ...session, lineages: [...rest, lineage] };
}

/** 回填一条 entry 的 kernelEntryId(乐观写入 → 权威 id):按「lineage 内最后一个 kernelEntryId
 *  缺失且同 role」的 entry 定位回填。匹配不到则 append。纯函数,不 mutate 入参。 */
export function backfillKernelEntryId(
  session: NeutralSession,
  lineageId: string,
  kernelEntryId: string,
  role: string,
): NeutralSession {
  const idx = session.lineages.findIndex((l) => l.lineageId === lineageId);
  if (idx < 0) return session;
  const lineage = session.lineages[idx];
  for (let i = lineage.entries.length - 1; i >= 0; i--) {
    const e = lineage.entries[i];
    if (e.kernelEntryId === undefined && e.message.role === role) {
      const next = lineage.entries.map((x, j) => (j === i ? { ...x, kernelEntryId } : x));
      return { ...session, lineages: session.lineages.map((l, j) => (j === idx ? { ...l, entries: next } : l)) };
    }
  }
  return session;
}

// ============ 完整线性内容(kernel-forkless §11)============

/** 一条 lineage 的完整线性内容:沿 fork 链向上,取父 lineage 到分叉点为止的前缀
 *  (boundary 是「含端点的继承前缀」——父条目从根到 boundaryEntryId 都继承,之后的丢弃),
 *  再拼自身独有条目。root lineage(fork=null)就是自己的 entries。
 *
 *  防御(损坏数据,§11 第 4 点):父引用悬空 → 当根处理(无前缀);环 → visited 停,不无限递归。
 *  纯函数、零依赖——「分叉归壳」的地基,seed 投影 / 切分支投影共用。 */
export function lineageContent(session: NeutralSession, lineageId: string): NeutralEntry[] {
  const byId = new Map(session.lineages.map((l) => [l.lineageId, l]));
  const visited = new Set<string>();
  const acc: NeutralEntry[] = [];
  const walk = (id: string): void => {
    if (visited.has(id)) return; // 环:停止,不无限递归
    visited.add(id);
    const l = byId.get(id);
    if (!l) return; // 悬空引用:当根处理,无前缀
    if (l.fork) {
      walk(l.fork.parentLineageId);
      // 父前缀截到 boundaryEntryId(含)之后的部分丢弃——分支从 boundary 之后前行
      const boundaryIdx = acc.findIndex((e) => e.neutralEntryId === l.fork!.boundaryEntryId);
      if (boundaryIdx >= 0) acc.length = boundaryIdx + 1;
    }
    acc.push(...l.entries);
  };
  walk(lineageId);
  return acc;
}
