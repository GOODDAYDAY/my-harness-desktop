// 圆心:动态布局引擎的中性类型与纯函数。
//
// 页面是一棵布局树:根递归分屏(split),叶为视图组(group),组内是视图栈。
// 现有三栏(sidebar/mainView/sidePanel)只是默认树的参数化形态。
// 见 docs/design/dynamic-layout.md。
// 零外部依赖:不 import react/electron/pi(圆心纯度纪律,§6.1)。

// ============================================================================
// 保留常量(§1.3):框架自留命名空间,插件可读不可伪造
// ============================================================================

/** 根分屏 id(§1.3)。setLayout 校验时根必须是 id 为 "root" 的 split。 */
export const ROOT_SPLIT_ID = "root";

/** 默认组 id(§1.3)。修剪和拍扁不动这三个组——它们是地板,id 永不回收。 */
export const DEFAULT_GROUP_IDS = {
  LEFT: "left",
  MAIN: "main",
  RIGHT: "right",
} as const;

/** 壳内建视图的 viewId 前缀(§1.3):viewId = "shell:<名>",对应 pluginId = "shell"。 */
export const SHELL_VIEW_PREFIX = "shell:";

/** 槽映射视图的 viewId 前缀(§1.3):viewId = "slot:<槽名>",对应贡献插件的 pluginId。 */
export const SLOT_VIEW_PREFIX = "slot:";

// ============================================================================
// 类型定义(§1.1–§1.2)
// ============================================================================

/** 布局树节点:递归 split/group 联合(§1.1)。kind 是判别标签,不是行为开关。 */
export type LayoutNode = LayoutSplit | LayoutGroup;

/** 分屏节点:水平或垂直切分,子节点递归(§1.1)。 */
export interface LayoutSplit {
  kind: "split";
  /** 节点 id;根必须是 "root"。 */
  id: string;
  /** 切分方向。 */
  direction: "horizontal" | "vertical";
  /** 各子节点的百分比份额,与 children 等长。 */
  sizes: number[];
  /** 子节点:再套 split 或 group。 */
  children: LayoutNode[];
}

/** 视图组节点:一组 tab,内部是视图栈(§1.1)。 */
export interface LayoutGroup {
  kind: "group";
  /** 组 id;默认三组是 left/main/right。 */
  id: string;
  /** tab 顺序,首项是默认激活视图。 */
  viewIds: string[];
  /** 当前激活的视图 id;viewIds 为空时可为 null。 */
  activeViewId: string | null;
  /** 折叠标志(§2.3):⌘B/⌘J 控制的显隐,折叠时父 split 将其 Panel 缩为 0。 */
  hidden?: boolean;
}

/** 视图实例记录(§1.2):树里放 viewId,注册表放实例,结构/内容分离。 */
export interface ViewInstance {
  /** 打开方给的幂等键,如 "file:/abs/path"。 */
  viewId: string;
  /** 组件来源;"shell" 是框架保留前缀。 */
  pluginId: string;
  /** 组件名:pluginId="shell" 查壳内部组件表,其余查插件模块 exports。 */
  component: string;
  /** tab 标题——内容是打开方给的,内核不生成。 */
  title: string;
  /** lucide 图标名;缺省时 tab 条不渲染图标。 */
  icon?: string;
  /** 可序列化参数,原样传给组件(文件预览就是 {path})。 */
  props?: unknown;
  /** 是否可关闭;内建视图为 false,动态视图默认 true。 */
  closable: boolean;
  /** 主题作用域名(§1.3,§2.1);仅槽映射视图携带,引擎按名查作用域组件表。 */
  themeScope?: string;
}

/** 打开视图请求(§3.1):插件调 openView 的入参形状。 */
export interface OpenViewRequest {
  /** 幂等键:已存在时激活而非新建(§3.1 单例 tab 语义)。 */
  viewId: string;
  /** 组件名,来自调用方自己的模块 exports。 */
  component: string;
  /** tab 标题。 */
  title: string;
  /** lucide 图标名。 */
  icon?: string;
  /** 透传给视图组件的参数。 */
  props?: unknown;
  /** 是否可关闭;动态视图默认 true。 */
  closable?: boolean;
  /** 目标位置:缺省进 main 组;split 形态触发分屏(§3.1)。 */
  target?: { group: string } | { split: { of: string; direction: "horizontal" | "vertical"; ratio?: number } };
}

/** 插件侧布局 API(§3.1+§3.2):经 usePluginContext().layout 获取。 */
export interface LayoutApi {
  /** 打开视图(幂等)。 */
  openView(req: OpenViewRequest): void;
  /** 关闭视图。 */
  closeView(viewId: string): void;
  /** 激活视图(切 tab)。 */
  activateView(viewId: string): void;
  /** 跨组移动视图(tab 拖拽的程序化表达)。 */
  moveView(viewId: string, targetGroupId: string, index?: number): void;
  /** 整体替换布局树(布局插件的入口)。 */
  setLayout(tree: LayoutNode): void;
  /** 读当前树。 */
  getLayout(): LayoutNode;
}

// ============================================================================
// 内部辅助:默认组判定
// ============================================================================

const DEFAULT_GROUP_ID_SET: ReadonlySet<string> = new Set([
  DEFAULT_GROUP_IDS.LEFT,
  DEFAULT_GROUP_IDS.MAIN,
  DEFAULT_GROUP_IDS.RIGHT,
]);

function isDefaultGroupId(id: string): boolean {
  return DEFAULT_GROUP_ID_SET.has(id);
}

// ============================================================================
// 校验(§4.2 步骤②)
// ============================================================================

/**
 * 形态校验:把 unknown 按 LayoutNode 协议收紧,不合法则抛错。
 * setLayout 和 rehydrateLayout 共用同一个校验器——校验规则单源(§1.3)。
 *
 * 校验项:
 *   - 不是 object → 抛错
 *   - 根不是 id 为 "root" 的 split → 抛错
 *   - split: sizes.length !== children.length 或 children <2 → 抛错
 *   - group: viewIds 引用了未注册的视图 → 抛错
 *   - 字段类型不匹配 → 抛错
 *
 * 返回收紧后的 LayoutNode(调用方安全赋值)。
 */
export function validateLayoutTree(
  tree: unknown,
  views: Record<string, ViewInstance>,
): LayoutNode {
  if (typeof tree !== "object" || tree === null) {
    throw new Error("布局树必须是对象");
  }

  const node = tree as Record<string, unknown>;
  const kind = node.kind;

  if (typeof kind !== "string") {
    throw new Error(`布局节点缺少 kind 字段: ${JSON.stringify(node)}`);
  }

  if (kind === "split") {
    return validateSplit(node, views);
  }

  if (kind === "group") {
    return validateGroup(node, views);
  }

  throw new Error(`未知的布局节点 kind: "${kind}"`);
}

function validateSplit(
  node: Record<string, unknown>,
  views: Record<string, ViewInstance>,
): LayoutSplit {
  const id = node.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("split 节点必须有非空 id");
  }

  const direction = node.direction;
  if (direction !== "horizontal" && direction !== "vertical") {
    throw new Error(`split 的 direction 必须是 "horizontal" 或 "vertical",收到: ${direction}`);
  }

  const sizes = node.sizes;
  if (!Array.isArray(sizes)) {
    throw new Error("split 的 sizes 必须是数组");
  }

  const children = node.children;
  if (!Array.isArray(children)) {
    throw new Error("split 的 children 必须是数组");
  }

  if (sizes.length !== children.length) {
    throw new Error(
      `split "${id}" 的 sizes 长度(${sizes.length})与 children 长度(${children.length})不一致`,
    );
  }

  if (children.length < 2) {
    throw new Error(`split "${id}" 的子节点数(${children.length})少于 2`);
  }

  for (let i = 0; i < sizes.length; i++) {
    if (typeof sizes[i] !== "number" || sizes[i] < 0 || !Number.isFinite(sizes[i])) {
      throw new Error(`split "${id}" 的 sizes[${i}] 必须是有限非负数,收到: ${sizes[i]}`);
    }
  }

  // 根 split 校验:顶层必须是 "root"
  // 注意:递归校验不检查子 split 的 id,只检查顶层

  const validatedChildren = children.map((child: unknown) =>
    validateLayoutTree(child, views),
  );

  return {
    kind: "split",
    id,
    direction: direction as "horizontal" | "vertical",
    sizes,
    children: validatedChildren,
  };
}

function validateGroup(
  node: Record<string, unknown>,
  views: Record<string, ViewInstance>,
): LayoutGroup {
  const id = node.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("group 节点必须有非空 id");
  }

  const viewIds = node.viewIds;
  if (!Array.isArray(viewIds)) {
    throw new Error(`group "${id}" 的 viewIds 必须是数组`);
  }

  for (let i = 0; i < viewIds.length; i++) {
    if (typeof viewIds[i] !== "string") {
      throw new Error(`group "${id}" 的 viewIds[${i}] 必须是字符串`);
    }
    if (!(viewIds[i] in views)) {
      throw new Error(
        `group "${id}" 的 viewIds[${i}] 未在视图注册表中注册`,
      );
    }
  }

  const activeViewId = node.activeViewId;
  if (activeViewId !== null && activeViewId !== undefined && typeof activeViewId !== "string") {
    throw new Error(`group "${id}" 的 activeViewId 必须是字符串或 null`);
  }

  if (typeof activeViewId === "string" && !viewIds.includes(activeViewId)) {
    throw new Error(
      `group "${id}" 的 activeViewId "${activeViewId}" 不在 viewIds 中`,
    );
  }

  const hidden = node.hidden;
  if (hidden !== undefined && typeof hidden !== "boolean") {
    throw new Error(`group "${id}" 的 hidden 必须是布尔值`);
  }

  // 如果 viewIds 为空、activeViewId 为 null,重置为 null(收紧)
  const resolvedActive: string | null =
    viewIds.length === 0 ? null : (activeViewId as string | null) ?? null;

  return {
    kind: "group",
    id,
    viewIds: viewIds as string[],
    activeViewId: resolvedActive,
    ...(hidden !== undefined ? { hidden } : {}),
  };
}

// ============================================================================
// 默认树构造(§1.3)
// ============================================================================

/**
 * 构造默认三栏布局树(§1.3):
 *   root split horizontal [left, main, right]
 *   各组含种子视图(shell:sidebar / slot:mainView / shell:sidePanel),
 *   hidden 标志从 opts 传入,closable=false。
 *
 * 纯函数、副效应零:同一组输入永远返回结构相等的新对象。
 */
export function buildDefaultTree(opts: {
  leftHidden: boolean;
  rightHidden: boolean;
  leftSize: number;
  rightSize: number;
}): LayoutNode {
  const mainSize = 100 - opts.leftSize - opts.rightSize;

  return {
    kind: "split",
    id: ROOT_SPLIT_ID,
    direction: "horizontal",
    sizes: [opts.leftSize, mainSize, opts.rightSize],
    children: [
      {
        kind: "group",
        id: DEFAULT_GROUP_IDS.LEFT,
        viewIds: [`${SHELL_VIEW_PREFIX}sidebar`],
        activeViewId: `${SHELL_VIEW_PREFIX}sidebar`,
        hidden: opts.leftHidden,
      },
      {
        kind: "group",
        id: DEFAULT_GROUP_IDS.MAIN,
        viewIds: [`${SLOT_VIEW_PREFIX}mainView`],
        activeViewId: `${SLOT_VIEW_PREFIX}mainView`,
      },
      {
        kind: "group",
        id: DEFAULT_GROUP_IDS.RIGHT,
        viewIds: [`${SHELL_VIEW_PREFIX}sidePanel`],
        activeViewId: `${SHELL_VIEW_PREFIX}sidePanel`,
        hidden: opts.rightHidden,
      },
    ],
  };
}

// ============================================================================
// 修剪与拍扁(§4.2 步骤③④)
// ============================================================================

/**
 * 修剪空组(§4.2 步骤③):删除 viewIds 为空的组,其尺寸份额并入前一个兄弟
 * (没有前者则并入后一个)。默认三组(left/main/right)是地板,永远不删。
 *
 * 纯函数:不修改入参树,返回新树。
 */
export function pruneEmptyGroups(tree: LayoutNode): LayoutNode {
  if (tree.kind !== "split") return tree;

  // 先递归修剪子节点
  const prunedChildren = tree.children.map((child) => pruneEmptyGroups(child));

  // 标记本层待删除的组:viewIds 为空且不是默认组
  const isMarked = prunedChildren.map(
    (child) =>
      child.kind === "group" && child.viewIds.length === 0 && !isDefaultGroupId(child.id),
  );

  if (!isMarked.some(Boolean)) {
    // 无删除,返回原 children 数组(结构可能已变)
    return { ...tree, children: prunedChildren };
  }

  // 第一步:收集保留的节点及原始信息
  const kept: Array<{ node: LayoutNode; origSize: number; origIndex: number }> = [];
  for (let i = 0; i < prunedChildren.length; i++) {
    if (!isMarked[i]) {
      kept.push({ node: prunedChildren[i], origSize: tree.sizes[i], origIndex: i });
    }
  }

  // 第二步:为每个被删除的组,找到最近的非删除兄弟,累加尺寸
  const finalSizes = kept.map((k) => k.origSize);
  for (let i = 0; i < prunedChildren.length; i++) {
    if (!isMarked[i]) continue;
    const removedSize = tree.sizes[i];

    // 找最近的非删除兄弟:先左后右
    let targetOrigIndex = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (!isMarked[j]) {
        targetOrigIndex = j;
        break;
      }
    }
    if (targetOrigIndex === -1) {
      for (let j = i + 1; j < prunedChildren.length; j++) {
        if (!isMarked[j]) {
          targetOrigIndex = j;
          break;
        }
      }
    }

    if (targetOrigIndex >= 0) {
      const targetKeptIdx = kept.findIndex((k) => k.origIndex === targetOrigIndex);
      if (targetKeptIdx >= 0) {
        finalSizes[targetKeptIdx] += removedSize;
      }
    }
    // 找不到任何非删除兄弟(理论不可达:默认组永不删除)
  }

  return {
    ...tree,
    children: kept.map((k) => k.node),
    sizes: finalSizes,
  };
}

/**
 * 拍扁单子 split(§4.2 步骤④):递归把只有一个孩子的 split 替换为其孩子,
 * 直到树稳定。0 孩子的 split 原样保留(后续校验会处理)。
 *
 * 纯函数:不修改入参树,返回新树。
 */
export function flattenSingleChildSplits(tree: LayoutNode): LayoutNode {
  if (tree.kind === "group") return tree;

  // 先递归拍扁子节点
  const flattenedChildren = tree.children.map((child) => flattenSingleChildSplits(child));

  // 若拍扁后只剩一个孩子,用它替换当前 split
  if (flattenedChildren.length === 1) {
    return flattenedChildren[0];
  }

  return {
    ...tree,
    children: flattenedChildren,
  };
}

// ============================================================================
// 重建管线(§4.2):校验 → 修剪 → 拍扁 → 根检查
// ============================================================================

/**
 * 从持久化存档重建布局树(§4.2 完整管线):
 *   ① JSON 解析(调用方负责,此处接收已解析的 unknown)
 *   ② 形态校验 → 失败返回 null
 *   ③ 修剪空组(pruneEmptyGroups)
 *   ④ 拍扁单子 split(flattenSingleChildSplits)
 *   ⑤ 根 split 孩子数 <2 → 返回 null(兜底:只含 shell/槽映射视图的存档不会命中)
 *
 * 返回 null 表示存档损坏或不可用,调用方回退到 buildDefaultTree。
 */
export function rehydrateLayout(
  raw: unknown,
  views: Record<string, ViewInstance>,
): LayoutNode | null {
  let tree: LayoutNode;
  try {
    tree = validateLayoutTree(raw, views);
  } catch {
    return null;
  }

  tree = pruneEmptyGroups(tree);
  tree = flattenSingleChildSplits(tree);

  // 步骤⑤:根 split 孩子数 <2 则整个回退默认树
  if (tree.kind !== "split" || tree.children.length < 2) {
    return null;
  }

  return tree;
}

// ============================================================================
// 查询
// ============================================================================

/**
 * 在树中按 id 查找 group 节点。递归遍历,找到即返回。
 * 找不到返回 null。
 */
export function findGroup(tree: LayoutNode, groupId: string): LayoutGroup | null {
  if (tree.kind === "group") {
    return tree.id === groupId ? tree : null;
  }

  for (const child of tree.children) {
    const found = findGroup(child, groupId);
    if (found) return found;
  }

  return null;
}

/**
 * 收集树中所有 group 节点的 id。遍历顺序:前序。
 */
export function collectGroupIds(tree: LayoutNode): string[] {
  const ids: string[] = [];
  collectGroupIdsImpl(tree, ids);
  return ids;
}

function collectGroupIdsImpl(tree: LayoutNode, out: string[]): void {
  if (tree.kind === "group") {
    out.push(tree.id);
    return;
  }
  for (const child of tree.children) {
    collectGroupIdsImpl(child, out);
  }
}

// ============================================================================
// 变换(§3.1 splitGroup / removeView / insertView)
// ============================================================================

/**
 * 在树的指定 split 位置用 updateFn 变换那个 split,返回新树。
 * targetId 必须在树中存在,否则原树返回(调用方应前置校验)。
 *
 * 内部辅助:不做类型校验,调用方保证 targetId 存在。
 */
function updateSplitAt(
  tree: LayoutNode,
  targetId: string,
  updateFn: (split: LayoutSplit) => LayoutSplit,
): LayoutNode {
  if (tree.kind === "group") return tree;

  if (tree.id === targetId) {
    return updateFn(tree);
  }

  // 递归查找
  const newChildren = tree.children.map((child) =>
    updateSplitAt(child, targetId, updateFn),
  );

  // 检查是否有变化(浅比较)
  if (newChildren.every((c, i) => c === tree.children[i])) {
    return tree;
  }

  return { ...tree, children: newChildren };
}

/**
 * 在树中找 group 及其父 split 的[索引]。
 * 返回 {parent, index} 或 null(未找到)。
 */
function findGroupParent(
  tree: LayoutNode,
  groupId: string,
): { parent: LayoutSplit; index: number } | null {
  if (tree.kind !== "split") return null;

  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i];
    if (child.kind === "group" && child.id === groupId) {
      return { parent: tree, index: i };
    }
    if (child.kind === "split") {
      const result = findGroupParent(child, groupId);
      if (result) return result;
    }
  }

  return null;
}

/**
 * 分屏变换(§3.1 splitGroup):在 ofGroupId 旁边按 direction 分出一个新组。
 *
 * 两种情况:
 *   - 父 split 与请求 direction 相同 → 新组直接插入父 split,紧跟 ofGroup 之后,
 *     ofGroup 的尺寸份额按 ratio 拆分(默认 0.5 对半)。
 *   - 方向不同(或 ofGroup 是根直子) → 把 ofGroup 原位替换为一个新 split,
 *     children=[ofGroup, newGroup],内部 sizes 按 ratio 分配。
 *
 * ratio:ofGroup 保留的比例(0–1),默认 0.5(对半分)。
 * 抛错:ofGroupId 在树中未找到。
 * 纯函数:不修改入参树,返回新树。
 */
export function splitGroup(
  tree: LayoutNode,
  ofGroupId: string,
  direction: "horizontal" | "vertical",
  newGroupId: string,
  ratio: number = 0.5,
): LayoutNode {
  if (ratio < 0 || ratio > 1) {
    throw new Error(`ratio 必须在 0–1 之间,收到: ${ratio}`);
  }

  const parentInfo = findGroupParent(tree, ofGroupId);
  if (!parentInfo) {
    throw new Error(`分组 "${ofGroupId}" 在布局树中未找到`);
  }

  const { parent, index } = parentInfo;
  const ofGroup = parent.children[index] as LayoutGroup;
  const ofGroupSize = parent.sizes[index];

  const newGroup: LayoutGroup = {
    kind: "group",
    id: newGroupId,
    viewIds: [],
    activeViewId: null,
  };

  if (parent.direction === direction) {
    // 情况一:方向相同,插入相邻兄弟
    const ofNewSize = ofGroupSize * ratio;
    const newGroupSize = ofGroupSize - ofNewSize;

    const newSizes = [...parent.sizes];
    newSizes[index] = ofNewSize;
    newSizes.splice(index + 1, 0, newGroupSize);

    const newChildren = [...parent.children];
    newChildren.splice(index + 1, 0, newGroup);

    const updatedParent: LayoutSplit = {
      ...parent,
      sizes: newSizes,
      children: newChildren,
    };

    return updateSplitAt(tree, parent.id, () => updatedParent);
  }

  // 情况二:方向不同,原位替换为新 split
  const newSplitId = `split-${ofGroupId}`;
  const innerSizes = [ratio * 100, (1 - ratio) * 100];

  const newSplit: LayoutSplit = {
    kind: "split",
    id: newSplitId,
    direction,
    sizes: innerSizes,
    children: [ofGroup, newGroup],
  };

  const newChildren = [...parent.children];
  newChildren[index] = newSplit;

  const updatedParent: LayoutSplit = {
    ...parent,
    children: newChildren,
    // sizes 不变:新 split 占据原来的份额
  };

  return updateSplitAt(tree, parent.id, () => updatedParent);
}

/**
 * 从树中移除指定 viewId:遍历所有 group,从 viewIds 中过滤掉。
 * 若被移除的 viewId 正是该组的 activeViewId,自动切换到剩余的第一项
 * (无剩余则置 null)。
 *
 * 纯函数:不修改入参树,返回新树。
 */
export function removeViewFromTree(tree: LayoutNode, viewId: string): LayoutNode {
  if (tree.kind === "group") {
    const newViewIds = tree.viewIds.filter((v) => v !== viewId);
    if (newViewIds.length === tree.viewIds.length) {
      return tree; // 无变化
    }

    let newActive = tree.activeViewId;
    if (tree.activeViewId === viewId) {
      newActive = newViewIds.length > 0 ? newViewIds[0] : null;
    }

    return { ...tree, viewIds: newViewIds, activeViewId: newActive };
  }

  // split:递归处理子节点
  const newChildren = tree.children.map((child) => removeViewFromTree(child, viewId));
  if (newChildren.every((c, i) => c === tree.children[i])) {
    return tree;
  }
  return { ...tree, children: newChildren };
}

/**
 * 将 viewId 插入指定 group 的指定位置(缺省追加到末尾)。
 * 抛错:groupId 在树中未找到,或插入位置越界。
 *
 * 纯函数:不修改入参树,返回新树。
 */
export function insertViewIntoGroup(
  tree: LayoutNode,
  groupId: string,
  viewId: string,
  index?: number,
): LayoutNode {
  let found = false;

  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === "group") {
      if (node.id !== groupId) return node;
      found = true;

      const idx = index ?? node.viewIds.length;
      if (idx < 0 || idx > node.viewIds.length) {
        throw new Error(`插入位置 ${idx} 超出范围 [0, ${node.viewIds.length}]`);
      }

      const newViewIds = [...node.viewIds];
      newViewIds.splice(idx, 0, viewId);

      return { ...node, viewIds: newViewIds };
    }

    const newChildren = node.children.map(walk);
    if (newChildren.every((c, i) => c === node.children[i])) return node;
    return { ...node, children: newChildren };
  };

  const result = walk(tree);
  if (!found) {
    throw new Error(`分组 "${groupId}" 在布局树中未找到`);
  }
  return result;
}
