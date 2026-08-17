// 圆心:底座后端契约 —— 把「底座该提供什么」抽成中性接口,pi 和 dsh 各是一个实现。
//
// 依据 docs/design/base-interface-lineage.md §2。圆心只定义接口形状 + 中性类型,
// 实现归 client/pi(pi 后端)与将来的 client/dsh(dsh 后端)——依赖倒置,内层拥有抽象。
//
// 设计锚点(§2.1):抽的是语义层(桌面需要底座提供哪些操作),不是传输层(消息怎么一行行传)。
// 传输(JSONL / JSON-RPC)、增量拉取、行帧、id 配对,都是后端私有,不进本契约。
//
// 不变量(§2.6):
// - 存储退进后端:桌面不读任何一方的存储格式,只认中性事件与 LineageTree。
// - fork 锚点必须是回合边界:pi 的「只接受 user 锚点」与 dsh 的「boundary 不落 open turn」,
//   在本契约归一为「boundary 指向父 lineage 里一个完整回合之后的位置」。

import type { SessionEvent, TreeNode } from "./events/session-state";

/**
 * 分叉点引用:不透明字符串。pi 后端把它当 entryId,dsh 后端把它当 seq 的字符串化。
 * 语义上它总指向「父 lineage 里一个完整回合之后的位置」——两个底座各自的锚点表示,
 * 归一成同一个不透明引用。桌面不解析它的内容,只当 token 在 fork/bookmark/resume 间回传。
 */
export type BoundaryRef = string;

/** 一条 lineage 在父 lineage 上的分叉位置。根 lineage 无父,没有此结构。 */
export interface LineageFork {
  /** 父 lineage 的 id。 */
  parentLineageId: string;
  /** 在父 lineage 上的分叉位置(不透明;pi=entryId,dsh=seq)。 */
  boundary: BoundaryRef;
}

/** 一条 lineage:一条有序事件流 + 一个分叉点。根 lineage 的 fork 为 null。 */
export interface Lineage {
  /** 后端自留的 lineage 标识(pi=分支锚点条目 id,dsh=子会话 id)。桌面当不透明 id 用。 */
  id: string;
  /** 从哪条父 lineage 的哪个位置切出来;null = 根 lineage。 */
  fork: LineageFork | null;
}

/** 一个会话的全部 lineage(含根)。父子关系由各 lineage.fork.parentLineageId 导出。 */
export interface LineageTree {
  /** 根 lineage 的 id。 */
  rootId: string;
  /** 含 root 在内的全部 lineage。 */
  lineages: Lineage[];
}

/** bookmark 的可重启锚点。 */
export interface Anchor {
  /** 桌面可读:哪个 lineage 的哪个点(用于显示「这是哪个分支的哪个点」)。 */
  lineageId: string;
  /** 桌面可读:在 lineage 上的分叉位置。 */
  boundary: BoundaryRef;
  /**
   * 后端自留的持久化线索(pi=JSONL 拷贝路径,dsh=childSessionId)。
   * 桌面一律不解析,只当 token 回传给 resume——存储格式彻底退进后端。
   */
  opaque: string;
}

/**
 * 底座后端:一个可整体替换的底座实现。五个会话分支操作(§2.4)是核心,
 * 消息 / 模型 / 中断是另一块两边现成的接口面,一并收进契约但不展开细节。
 *
 * 实现方义务:
 * - fork 不改动原 lineage,新 lineage 带共享前缀独立前行。
 * - boundary 必须落在父 lineage 的一个完整回合之后,违反即拒绝并返回错误。
 * - anchor 天然按后端划界:本后端建的锚点只能本后端 resume,收到别家锚点报错。
 */
export interface BaseBackend {
  /** 子进程是否存活。 */
  readonly alive: boolean;

  /** 起底座子进程(按需;实现自定 spawn 参数)。 */
  start(): Promise<void>;

  /** 停底座子进程。 */
  stop(): Promise<void>;

  /** 订阅中性事件流(驱动 timeline)。返回取消函数。 */
  onEvent(cb: (event: SessionEvent) => void): () => void;

  /** §2.4.1 从某条 lineage 的某点切出新 lineage;boundary 省略=从当前末尾切。返回新 lineage id。 */
  fork(parentLineageId: string, boundary?: BoundaryRef): Promise<string>;

  /** §2.4.2 拿一个会话的全部 lineage 及父子/分叉点关系。 */
  getTree(sessionId: string): Promise<LineageTree>;

  /** §2.4.3 拿一条 lineage 的线性中性事件序列(重放为视图流)。 */
  getEntries(lineageId: string): Promise<SessionEvent[]>;

  /** §2.4.4 把一个分叉点持久化成可重启锚点。 */
  bookmark(lineageId: string, boundary: BoundaryRef): Promise<Anchor>;

  /** §2.4.5 从一个锚点重启一条 lineage,返回重启后的 lineage id。 */
  resume(anchor: Anchor): Promise<string>;

  /** 发一条用户消息(唯一会起进程的入口;resolve 只代表底座接受,输出靠事件流)。 */
  sendMessage(text: string): Promise<void>;

  /** 中断当前生成。 */
  abort(): Promise<void>;

  /** 切模型。 */
  setModel(provider: string, modelId: string): Promise<void>;
}

/**
 * 把入口级树投影成 lineage 树——§2.3「节点从条目换成分叉点」的纯函数实现。
 *
 * 一个 lineage = 沿首子(主干)走到尽头的最大线性链;某节点有 >1 个子节点即分叉点:
 * 首子延续当前 lineage,其余子各开一条分支 lineage,其 `fork.boundary` = 分叉点节点的 entryId。
 * 输入可能是森林(多个根):第一个根是 rootId,其余根各作一条独立根 lineage(fork = null)。
 *
 * 主干选择(首子)是当前约定;若底座以 `leafId` 定义主干(当前活跃叶子路径),调用方可在
 * 投影前先按 leafId 重排 children,把活跃分支放到首位。投影本身不感知 leafId。
 */
export function projectLineageTree(roots: TreeNode[]): LineageTree {
  const lineages: Lineage[] = [];
  const first = roots[0];
  const rootId = first?.entryId ?? "";

  const walk = (node: TreeNode, lineageId: string): void => {
    const children = node.children ?? [];
    if (children.length === 0) return;
    walk(children[0], lineageId);
    for (let i = 1; i < children.length; i++) {
      const child = children[i];
      const branchId = child.entryId;
      lineages.push({
        id: branchId,
        fork: { parentLineageId: lineageId, boundary: node.entryId },
      });
      walk(child, branchId);
    }
  };

  if (first) {
    lineages.push({ id: rootId, fork: null });
    walk(first, rootId);
  }
  for (let i = 1; i < roots.length; i++) {
    const root = roots[i];
    lineages.push({ id: root.entryId, fork: null });
    walk(root, root.entryId);
  }
  return { rootId, lineages };
}
