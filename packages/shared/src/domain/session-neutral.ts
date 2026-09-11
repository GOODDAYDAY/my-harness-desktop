// 圆心:会话级中立坐标系 —— 中立会话身份 / 锚点 / 树 / 模型引用,零依赖。
//
// 依据 docs/design/session-neutral-layer.md。这是「中立契约」的另一半:消息/事件/树形投影
// 中立了(见 backend.ts),但会话身份和锚点还留在内核私有里——本文把它们也中立化。
// 主线:换内核 = 换投影实现,中立会话层一行不动。
//
// 本文件零依赖(只 import domain 内部的 kernel + 中性事件),是圆心最内层的原子。

import type { KernelId } from "./kernel";
import type { NeutralMessage, TreeNode } from "./events/session-state";
import { deduplicateAdjacent } from "./events/session-state";
import { messageContentText, sessionMessagePreview } from "./text";

/** 中立会话身份:壳生成、跨内核稳定的会话 id(UUID)。壳的会话列表/书签/分组都以它为主键。 */
export interface NeutralSessionId {
  value: string;
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

/** 中立会话摘要(列表行读口,docs/design/neutral-storage-split.md §2.3):
 *  header/entries 分文件后,列表只读 header 文件——摘要类型刻意不带 lineages,
 *  让「列表想拿 entries」在类型层写不出来。rootLineageId 单列:clone/seed 会话的
 *  根 lineageId ≠ ns(派生保留源 lineageId),投影地址按根 lineageId 派生,不能凭 ns 猜。 */
export interface NeutralSessionSummary {
  neutralSessionId: string;
  /** 根 lineage id(fork=null 那条);空会话(尚无 lineage)回退 neutralSessionId。 */
  rootLineageId: string;
  header: NeutralSessionHeader;
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
  /** 派生溯源(bookmark-snapshot-fork-unify §4.3):「这个会话从哪来」的永久记录——
   *  fork/收藏发起派生时落;boundaryEntryId 是归一后的中立坐标(非入参原始值)。 */
  derivedFrom?: { kind: "fork" | "bookmark"; sourceNeutralSessionId: string; boundaryEntryId: string };
  /** 「中立层有内容、内核侧未物化」的瞬态标记(§4.3/§6.5):deriveSession 派生时置 true;
   *  createProc 据此把 materializedLineageId 初始化为空串(必不相等 → 首发强制物化);
   *  物化成功清除;失败保持(持久标记,崩溃重启后下次首发自动重试)。 */
  pendingSeed?: boolean;
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

/** 从单条 entry 派生列表行 header 字段(lastMessage/lastEntryId/updatedAt)。
 *  纯函数:时间只来自入参——nowIso 由外层注入(增量 append 时 = now),缺省时回落 entry 时间戳。 */
export function derivedHeaderFromEntry(
  entry: NeutralEntry,
  nowIso?: string,
): Pick<NeutralSessionHeader, "lastMessage" | "lastEntryId" | "updatedAt"> {
  const text = messageContentText(entry.message.content);
  const updatedAt = nowIso
    ?? (typeof entry.message.timestamp === "number" ? new Date(entry.message.timestamp).toISOString() : undefined);
  return {
    lastMessage: text ? sessionMessagePreview(text) : undefined,
    lastEntryId: entry.neutralEntryId || undefined,
    updatedAt,
  };
}

/** 从整棵树派生列表行 header 字段(全量 snapshot 兜底重建):lastEntryId/updatedAt 取「最新 entry」
 *  (有 timestamp 按 timestamp 最大,否则回落倒拓扑序首条);lastMessage 取「最新有非空文本的 entry」——
 *  末条是无文本的 divider/空消息时不把旧预览顶掉。空会话返回 {}。 */
export function derivedHeaderFromSession(
  session: NeutralSession,
): Pick<NeutralSessionHeader, "lastMessage" | "lastEntryId" | "updatedAt"> {
  const sorted = sortLineagesTopologically(session.lineages);
  // 候选序:倒拓扑(最新分支的末条在前),再按 timestamp 降序稳定排序(无 timestamp 视为 -Infinity)
  const latestFirst: NeutralEntry[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    for (let j = sorted[i].entries.length - 1; j >= 0; j--) latestFirst.push(sorted[i].entries[j]);
  }
  latestFirst.sort((a, b) => {
    const ta = typeof a.message.timestamp === "number" ? a.message.timestamp : -Infinity;
    const tb = typeof b.message.timestamp === "number" ? b.message.timestamp : -Infinity;
    if (ta === tb) return 0; // 稳定:保留倒拓扑序
    return ta > tb ? -1 : 1;
  });
  const latest = latestFirst[0];
  const latestWithText = latestFirst.find((e) => messageContentText(e.message.content).trim().length > 0);
  const text = latestWithText ? messageContentText(latestWithText.message.content) : undefined;
  return {
    lastMessage: text ? sessionMessagePreview(text) : undefined,
    lastEntryId: latest?.neutralEntryId || undefined,
    updatedAt: latest && typeof latest.message.timestamp === "number" ? new Date(latest.message.timestamp).toISOString() : undefined,
  };
}

/** 追加一条 entry 并同步回填列表行 header 字段(appendNeutralEntry + derivedHeaderFromEntry 的组合)。
 *  增量写路径的唯一入口:append 即内容变更 → lastMessage/lastEntryId/updatedAt 随 header 一并更新。
 *  lastMessage 只在 append 的 entry 有非空文本时才更新——无文本条目(divider/空消息)不顶掉旧预览。 */
export function appendNeutralEntryWithHeader(
  session: NeutralSession,
  lineageId: string,
  entry: NeutralEntry,
  nowIso?: string,
): NeutralSession {
  const appended = appendNeutralEntry(session, lineageId, entry);
  const lineage = appended.lineages.find((l) => l.lineageId === lineageId);
  const last = lineage?.entries[lineage.entries.length - 1];
  if (!last) return appended;
  const derived = derivedHeaderFromEntry(last, nowIso);
  const merged = {
    lastMessage: derived.lastMessage ?? session.header.lastMessage,
    lastEntryId: derived.lastEntryId,
    updatedAt: derived.updatedAt,
  };
  return { ...appended, header: { ...appended.header, ...merged } };
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
    // **遇到已绑定的条目就停**（勿回退成"一直往前找第一个未绑的同 role 条目"）。
    //
    // 根因（实测，fork/物化会话丢回复）：回填的语义是"写穿刚 append 的那条还没 id，
    // 等 entryAppended 把权威 id 带回来补上"——候选**只可能在本回合的尾巴上**。
    // 而"往前找第一个未绑同 role 条目"会穿过整个历史，摸到**上一段历史留下的未绑条目**：
    // fork/seed 物化出来的会话，中立层里那些继承来的条目**都没有 kernelEntryId**
    // （它们是投影出来的，不是内核写的）。于是新一轮 assistant 的 id 被绑到了**旧的**
    // seeded assistant 条目上 → 紧接着同一条的 messageEnd 一看"该 id 已存在"→ **幂等跳过** →
    // 这条回复**在中立层里静默消失**（DOM 读中立层，于是用户看不到回复）。
    // 已绑定的条目是"上一回合的既成内容"的分界：越过它就说明本回合的尾巴已经结束。
    if (e.kernelEntryId !== undefined) break;
  }
  return session;
}

/** 回填 user 消息的权威字段(kernelEntryId + message.id + message.timestamp)。
 *  乐观写入时 user entry 无 id/timestamp;entryAppended 回执后补上权威值——保证 refresh(读中立层)
 *  与 live(事件流)看到同一 id/时间。此前只回填 kernelEntryId(NeutralEntry 元字段),message.id/timestamp
 *  仍缺 → refresh 的 user 消息无时间徽标(MessageMeta 对无 timestamp 返回 null),与 live 不一致。
 *  纯函数,不 mutate 入参;仅当权威字段确实存在时才覆盖(避免用 undefined 抹掉已有值)。 */
export function backfillUserAuthority(
  session: NeutralSession,
  lineageId: string,
  kernelEntryId: string,
  messageId: string | undefined,
  timestamp: number | undefined,
): NeutralSession {
  const idx = session.lineages.findIndex((l) => l.lineageId === lineageId);
  if (idx < 0) return session;
  const lineage = session.lineages[idx];
  for (let i = lineage.entries.length - 1; i >= 0; i--) {
    const e = lineage.entries[i];
    if (e.kernelEntryId === undefined && e.message.role === "user") {
      const next = lineage.entries.map((x, j) => (j === i ? {
        ...x,
        kernelEntryId,
        message: {
          ...x.message,
          ...(messageId != null ? { id: messageId } : {}),
          ...(timestamp != null ? { timestamp } : {}),
        },
      } : x));
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

// ============ 逐条明细树投影(session-single-source §209:get_tree → 中立层读)============

/** divider kind → 树 entryType 映射(树消费侧词表:user/assistant/toolResult/model_change/
 *  thinking_level_change/compaction/branch_summary/session_info…,见 session-tree 插件
 *  groupOf/dotColor)。内核树的 entryType 是内核私有词表,中立层按语义映射,不直抄。 */
const DIVIDER_ENTRY_TYPE: Record<string, string> = {
  model: "model_change",
  thinking: "thinking_level_change",
  compaction: "compaction",
  branch: "branch_summary",
  info: "session_info",
};

/** 单条中立 entry → 树节点(preview:对话取文本首行压平;model 分隔线取 provider · modelId
 *  双段;rename 取新名;其余分隔线取 detail;空 → undefined 不伪造)。 */
function neutralEntryToTreeNode(entry: NeutralEntry): TreeNode {
  const m = entry.message;
  const entryType = m.role === "divider"
    ? (DIVIDER_ENTRY_TYPE[String(m.kind ?? "")] ?? "divider")
    : m.role;
  let preview: string | undefined;
  if (m.role === "divider") {
    const args = (m.i18nArgs ?? {}) as Record<string, unknown>;
    if (m.kind === "model") {
      preview = [args.provider, args.modelId].filter((x): x is string => typeof x === "string" && !!x).join(" · ") || undefined;
    } else if (typeof args.name === "string") {
      preview = args.name;
    } else if (typeof m.detail === "string") {
      preview = m.detail;
    }
  } else {
    preview = sessionMessagePreview(messageContentText(m.content));
  }
  return {
    entryId: entry.neutralEntryId,
    entryType,
    preview,
    timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
  };
}

/** 中立会话 → 逐条明细树(TreeNode[],与内核 get_tree 同形状)。
 *  结构规则:每条 lineage 内部是线性链(后一条是前一条的 child);fork lineage 的链头
 *  挂到父 lineage 的 boundary 节点做额外 child;boundary 悬空(损坏/外部坐标)降级为
 *  挂到森林根(不丢分支、不静默挂错父)。拓扑序保证父链先建(sortLineagesTopologically)。
 *  纯函数、零依赖——渲染层会话树/detail 视图与 sync 快照共用同一投影(契约单源)。 */
export function neutralSessionToTree(session: NeutralSession): TreeNode[] {
  const forest: TreeNode[] = [];
  const byEntryId = new Map<string, TreeNode>();
  for (const lineage of sortLineagesTopologically(session.lineages)) {
    let prev: TreeNode | null = null;
    let head: TreeNode | null = null;
    for (const entry of lineage.entries) {
      const node = neutralEntryToTreeNode(entry);
      byEntryId.set(entry.neutralEntryId, node);
      if (prev) {
        prev.children = [...(prev.children ?? []), node];
        prev.isLeaf = false;
      } else {
        head = node;
      }
      prev = node;
    }
    if (!head) continue;
    if (!lineage.fork) {
      forest.push(head);
      continue;
    }
    const boundaryNode = byEntryId.get(lineage.fork.boundaryEntryId);
    if (boundaryNode) {
      boundaryNode.children = [...(boundaryNode.children ?? []), head];
      boundaryNode.isLeaf = false;
    } else {
      forest.push(head); // boundary 悬空:降级挂根,不丢分支
    }
  }
  // isLeaf 终态:无 children 即叶(初始 undefined 视为叶,统一落 true 供渲染侧直读)
  const markLeaves = (nodes: TreeNode[]): void => {
    for (const n of nodes) {
      if (!n.children || n.children.length === 0) n.isLeaf = true;
      else markLeaves(n.children);
    }
  };
  markLeaves(forest);
  return forest;
}

// ============ seed 投影组装(session-single-source §4.1)============

/** seed 投影的对话 role 白名单:只有对话内容进内核投影;divider/custom 等展示条目
 *  与 display 元数据永不进 AI 上下文(图是交流机制,不是 AI 输入)。
 *  两内核同一份——契约单源,适配器不再各自过滤。 */
export const SEED_PROJECTION_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "toolResult"]);

/** 压缩摘要代身的协议前缀(发往内核的协议指令,与渲染层 stripToolLimitNote 同先河——
 *  非 UI 文案,勿 i18n)。 */
const SEED_SUMMARY_PREFIX = "[此前会话的压缩摘要]";

/** 压缩边界条目判定:role=divider 且 kind=compaction(sessionEntryToNeutral 的 divider 形状)。 */
function isCompactionBoundary(e: NeutralEntry): boolean {
  const m = e.message as { role?: unknown; kind?: unknown };
  return m.role === "divider" && m.kind === "compaction";
}

/** 边界条目的摘要文本(detail 字段;无摘要返回 null——调用方退回全量投影,宁多灌不丢语义)。 */
function compactionSummaryOf(e: NeutralEntry): string | null {
  const d = (e.message as { detail?: unknown }).detail;
  return typeof d === "string" && d ? d : null;
}

/**
 * seed 投影组装(契约单源,壳的 seed 调用点统一经此):活跃 lineage 的完整线性内容
 * → 压缩截断 → role 白名单。
 * - 压缩截断:最新一条「带摘要的」压缩边界条目以摘要代身(合成一条 user 消息承载摘要,
 *  摘要文本是内核压缩的产物,前缀标记它是摘要而非用户原话),丢弃其前条目;
 *  无边界 / 边界无摘要 → 全量投影(保守)。
 * - role 白名单:只留对话内容;divider/custom/工具卡片等展示条目与 display 不进内核。
 * 纯函数、零依赖——两个内核的 seed 路径(dsh 经 session/seed,pi 经写文件)吃同一份输出。 */
export function assembleSeedProjection(session: NeutralSession, lineageId: string): NeutralEntry[] {
  const full = lineageContent(session, lineageId);
  let cut = -1;
  let summary: string | null = null;
  for (let i = full.length - 1; i >= 0; i--) {
    if (isCompactionBoundary(full[i])) {
      const s = compactionSummaryOf(full[i]);
      if (s) {
        cut = i;
        summary = s;
      }
      break; // 最新边界无摘要也不往前找——更早的摘要对应更旧的上下文形态,无意义
    }
  }
  const tail = cut >= 0 ? full.slice(cut + 1) : full;
  const head: NeutralEntry[] = summary != null
    ? [{ neutralEntryId: "", message: { role: "user", content: `${SEED_SUMMARY_PREFIX}\n${summary}` } }]
    : [];
  return [...head, ...tail].filter((e) => SEED_PROJECTION_ROLES.has(e.message.role));
}

// ============ 中立层变更通知与镜像归约(session-single-source §3.2)============

/**
 * 中立层变更通知(写穿回执):壳的唯一写口每写一次产一条,经 WS 广播给渲染层镜像。
 * - entry:某条 lineage 里落了一条/回填了一条——载荷带条目本体(通知即数据,不回拉),
 *   header 附带写后值(append 会派生 lastMessage/lastEntryId/updatedAt,随条目一起新鲜)。
 * - header:头域变更(改名/归档置顶/模型域写回)——没有条目本体,只带写后的头。
 * - lineage:整枝变更(fork 插新分支);session:全量替换(快照重建/书签发起的重投影)。
 */
export type NeutralChange =
  | { ns: string; kind: "entry"; lineageId: string; entry: NeutralEntry; header: NeutralSessionHeader }
  | { ns: string; kind: "header"; header: NeutralSessionHeader }
  | { ns: string; kind: "lineage"; lineage: NeutralLineage; header: NeutralSessionHeader }
  | { ns: string; kind: "session"; session: NeutralSession };

/**
 * 变更通知归约(镜像端与壳端共用,契约单源):把一条变更应用到中立会话镜像。
 * - entry:按中立 entryId 幂等——同 id 替换(回填场景:后到权威字段覆盖先到占位),无则 append。
 * - header:浅合并(写后值整体覆盖对应字段);lineage:整枝 upsert;session:全量替换。
 * 纯函数,不 mutate 入参。
 */
export function applyNeutralChange(session: NeutralSession, change: NeutralChange): NeutralSession {
  switch (change.kind) {
    case "entry": {
      const idx = session.lineages.findIndex((l) => l.lineageId === change.lineageId);
      const lineage = idx >= 0 ? session.lineages[idx] : null;
      let next: NeutralSession;
      if (lineage && lineage.entries.some((e) => e.neutralEntryId === change.entry.neutralEntryId)) {
        const entries = lineage.entries.map((e) => (e.neutralEntryId === change.entry.neutralEntryId ? change.entry : e));
        next = { ...session, lineages: session.lineages.map((l, i) => (i === idx ? { ...l, entries } : l)) };
      } else {
        next = appendNeutralEntry(session, change.lineageId, change.entry);
      }
      return { ...next, header: change.header };
    }
    case "header":
      return { ...session, header: { ...session.header, ...change.header } };
    case "lineage":
      return { ...upsertNeutralLineage(session, change.lineage), header: change.header };
    case "session":
      return change.session;
  }
}

// ============ 镜像内容读口(session-single-source §3.2,契约单源)============

/** 中立会话 → 活跃 lineage 的消息视图:完整线性内容 → 展示图合回 __image →
 *  锚点 id 提升为中立 entryId(收藏/分叉/锚定全走中立坐标)→ 相邻去重。
 *  壳(openSession/sync)与渲染层镜像(neutral-mirror)共用这一份推导,不写两遍。 */
export function neutralMessagesOfSession(session: NeutralSession, lineageId?: string | null): NeutralMessage[] {
  const lid = lineageId ?? session.lineages.find((l) => l.fork === null)?.lineageId ?? session.neutralSessionId;
  return deduplicateAdjacent(lineageContent(session, lid).map((e) => ({
    ...e.message,
    id: e.neutralEntryId,
    ...(e.display?.image ? { __image: e.display.image } : {}),
  })));
}

// ============ 克隆(session-single-source §4.2:clone 归壳)============

/** 分叉边界归一:把调用方给的 boundary(可能是中立 entryId `{lineageId}:{seq}`,也可能是
 *  内核私有条目 id)解析成父 lineage 里的中立 entryId。解析不出(陈旧/外部坐标)则原样透传——
 *  投影语义对未知边界是安全兜底(继承完整父前缀),不丢调用方信息、也不静默挂错父。 */
export function resolveBoundaryEntryId(session: NeutralSession, parentLineageId: string, boundary: string): string {
  const parent = session.lineages.find((l) => l.lineageId === parentLineageId);
  if (!parent) return boundary;
  if (parent.entries.some((e) => e.neutralEntryId === boundary)) return boundary;
  const byKernel = parent.entries.find((e) => e.kernelEntryId && e.kernelEntryId === boundary);
  return byKernel?.neutralEntryId ?? boundary;
}

/**
 * 归一 fork 边界并应用 position 截断语义(bookmark-snapshot-fork-unify §4.4):
 *  - "at"(默认):父前缀继承到 boundary 锚点(含)→ 传锚点本身;
 *  - "before":父前缀继承到锚点**前一条**(不含锚点)→ 传前一条的 neutralEntryId;
 *    锚点是父内容第一条时返回空串(零继承前缀,从根分叉)。
 *  这消除 retry/rewind「重复待重发 user 消息」:fork 用 before 排除锚点,再 prompt 重发一次,
 *  前缀里不再带着原 user 消息(否则同一条 user 出现两次)。
 */
export function resolveForkBoundary(
  session: NeutralSession,
  parentLineageId: string,
  boundary: string | undefined,
  position: "before" | "at",
): string {
  if (!boundary) return "";
  const neutral = resolveBoundaryEntryId(session, parentLineageId, boundary);
  if (position === "at") return neutral;
  const content = lineageContent(session, parentLineageId);
  const idx = content.findIndex((e) => e.neutralEntryId === neutral || e.kernelEntryId === boundary);
  if (idx <= 0) return "";
  return content[idx - 1].neutralEntryId;
}

/**
 * 克隆一个中立会话为全新会话(纯壳操作,内核不参与):
 * 整树复制,根 lineage 取新 ns;分支 lineage 用确定性派生 id(`<newNs>-fork-<序>`),
 * fork 引用与 boundaryEntryId 随 id 映射一并改写;条目的中立 entryId 按新 lineage 重派生,
 * kernelEntryId/message.id 清除(目标内核 seed 时重分配——投影线索不跨会话携带)。
 * 纯函数:nowIso 由调用方注入(创建时间),不在圆心读环境。
 */
export function cloneNeutralSession(session: NeutralSession, newNs: string, opts: { name?: string; nowIso: string }): NeutralSession {
  // 第一遍:lineage id 映射(根 → newNs;分支按拓扑序派生确定性 id)
  const sorted = sortLineagesTopologically(session.lineages);
  const idMap = new Map<string, string>();
  let forkSeq = 0;
  for (const l of sorted) {
    idMap.set(l.lineageId, l.fork === null ? newNs : `${newNs}-fork-${forkSeq++}`);
  }
  const lineages: NeutralLineage[] = sorted.map((l) => {
    const newId = idMap.get(l.lineageId)!;
    const entries: NeutralEntry[] = l.entries.map((e, i) => ({
      neutralEntryId: neutralEntryId(newId, i),
      message: { ...e.message, id: undefined },
      ...(e.display ? { display: e.display } : {}),
    }));
    if (!l.fork) return { lineageId: newId, fork: null, entries };
    // fork 引用换绑:父 lineage id 经 idMap 翻译;boundary 先按源树归一为中立 id 再换绑。
    const newParent = idMap.get(l.fork.parentLineageId) ?? newNs;
    const sourceBoundary = resolveBoundaryEntryId(session, l.fork.parentLineageId, l.fork.boundaryEntryId);
    const seqPart = sourceBoundary.includes(":") ? Number(sourceBoundary.split(":").pop()) : NaN;
    return {
      lineageId: newId,
      fork: {
        parentLineageId: newParent,
        boundaryEntryId: Number.isFinite(seqPart) ? neutralEntryId(newParent, seqPart) : "",
      },
      entries,
    };
  });
  const header: NeutralSessionHeader = {
    ...session.header,
    name: opts.name ?? session.header.name,
    createdAt: opts.nowIso,
    updatedAt: opts.nowIso,
  };
  return { neutralSessionId: newNs, header, lineages };
}

/**
 * 派生重投影(bookmark-snapshot-fork-unify §5.3):fork/收藏发起把「一条 lineage 的前缀」
 * 重投影进新会话——中立 entryId 按新 ns 重算(`{newNs}:{seq}`,seq 从 0 递增),
 * kernelEntryId 与 message.id 清空(中立坐标跟壳走,内核坐标由目标内核重建)。
 * 纯函数,零依赖,由 deriveSession 内部调用。
 */
export function reprojectEntries(entries: NeutralEntry[], newNs: string): NeutralEntry[] {
  return entries.map((e, i) => ({
    neutralEntryId: neutralEntryId(newNs, i),
    message: { ...e.message, id: undefined },
    ...(e.display ? { display: e.display } : {}),
  }));
}
