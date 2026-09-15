// session-colors/core/pin —— 纯 TS 图钉模型:不 import react、不碰 ctx,可裸单测。
// 职责:两种钉的数据形状(会话行钉 Pin / 消息内容钉 ContentPin)、预览文本语义、
// 面板跨会话聚合口径(groupContentPins)与旧数据预览补填(backfillPreviews)。
import { messageContentText, type NeutralMessage } from "@my-harness-desktop/shared";

export interface Pin {
  id: string;
  color: string;
  x: number;
  y: number;
}

/** 内容钉(钉会话流消息,docs/design/content-pins.md):锚点 = messageId(JSONL 行级 id),
 *  x/y 相对消息元素([data-message-id])渲染框的百分比。Pin 是会话行钉,两者同族不同挂载面。 */
export interface ContentPin {
  id: string;
  messageId: string;
  color: string;
  x: number;
  y: number;
  /** 钉入时刻的消息文本快照(前 30 字):面板跨会话列出时零读取通道(设计 §6.3)。
   *  旧数据无此字段,回该会话时由 backfillPreviews 惰性补填。 */
  preview?: string;
}

export const CONTENT_PIN_DEFAULT = { x: 97, y: 6 };

export const PALETTE = [
  "#f38ba8", "#fab387", "#f9e2af", "#a6e3a1",
  "#89b4fa", "#cba6f7", "#f5c2e7",
];

/** 内容钉预览文本:与 messageActions 的 rowText 同语义(messageContentText 单源),
 *  空白折叠后截前 30 字;消息无文本(纯工具卡等)时退 i18nKey,再退 role。 */
export function messagePreview(m: NeutralMessage): string {
  const text = messageContentText(m.content).replace(/\s+/g, " ").trim().slice(0, 30);
  if (text) return text;
  const key = (m as { i18nKey?: unknown }).i18nKey;
  return typeof key === "string" ? key : m.role;
}

export interface ContentPinEntry {
  pin: ContentPin;
  /** messageId 命中的消息——仅当前会话分组解析(供实时预览与排序),其他会话分组为 undefined。 */
  message?: NeutralMessage;
}

export interface ContentPinGroup {
  path: string;
  isCurrent: boolean;
  entries: ContentPinEntry[];
}

/** 内容钉的跨会话聚合(面板列出口径,docs/design/content-pins.md §6.1):
 *  - 当前会话:口径 = 渲染口径——messageId 须在 currentMessages 里且 display !== false
 *    (孤儿钉不列),按消息在会话流中的先后排序(回看的认知顺序是内容顺序);
 *  - 其他会话:只保留在 projectPaths 里的(当前项目且会话文件存在,与行钉的
 *    "行不在侧栏 DOM 不列"同级),按 projectPaths 顺序;孤儿钉跨会话不可判定,保留列出;
 *  - colorFilter 非 null 时按色过滤,过滤后条目为空的组不列;当前会话组恒在最前。 */
export function groupContentPins(
  contentPins: Record<string, ContentPin[]>,
  currentSessionPath: string | null,
  currentMessages: readonly NeutralMessage[],
  projectPaths: readonly string[],
  colorFilter: string | null,
): ContentPinGroup[] {
  const match = (p: ContentPin): boolean => colorFilter === null || p.color === colorFilter;
  const groups: ContentPinGroup[] = [];

  if (currentSessionPath) {
    const list = (contentPins[currentSessionPath] ?? []).filter(match);
    if (list.length > 0) {
      const byId = new Map<string, NeutralMessage>();
      const indexOf = new Map<string, number>();
      currentMessages.forEach((m, i) => { if (m.id) { byId.set(m.id, m); indexOf.set(m.id, i); } });
      const entries: ContentPinEntry[] = list
        .map((pin) => ({ pin, message: byId.get(pin.messageId) }))
        .filter((e): e is { pin: ContentPin; message: NeutralMessage } => e.message !== undefined && e.message.display !== false)
        .sort((a, b) => (indexOf.get(a.pin.messageId) ?? 0) - (indexOf.get(b.pin.messageId) ?? 0));
      if (entries.length > 0) groups.push({ path: currentSessionPath, isCurrent: true, entries });
    }
  }

  for (const path of projectPaths) {
    if (path === currentSessionPath) continue;
    const list = (contentPins[path] ?? []).filter(match);
    if (list.length === 0) continue;
    groups.push({ path, isCurrent: false, entries: list.map((pin) => ({ pin })) });
  }

  return groups;
}

/** 旧数据预览快照的惰性补填:返回补填后的新数组;无可补(无缺 preview 的钉,
 *  或缺 preview 的钉在当前消息里都找不到)时返回 null,调用方据此跳过写盘。 */
export function backfillPreviews(
  pins: readonly ContentPin[],
  messages: readonly NeutralMessage[],
): ContentPin[] | null {
  if (!pins.some((p) => !p.preview)) return null;
  const byId = new Map<string, NeutralMessage>();
  for (const m of messages) { if (m.id) byId.set(m.id, m); }
  let changed = false;
  const next = pins.map((p) => {
    if (p.preview) return p;
    const m = byId.get(p.messageId);
    if (!m) return p;
    changed = true;
    return { ...p, preview: messagePreview(m) };
  });
  return changed ? next : null;
}

/** 会话键归一(设计 docs/design/session-scope.md §3.3.2):把存量 contentPins 的键统一到
 *  作用域 key 口径(ns 优先、投影路径兜底)。
 *
 *  为什么需要:此前「钉入」写的是 currentSessionPath 键、「读取」查的是
 *  `currentNeutralSessionId ?? currentSessionPath` 键——同一个会话在有 ns 时被劈成两个键,
 *  钉进去后当前会话立刻读不到自己的钉(键空间分裂,实测 bug)。统一口径后新数据只有一个键,
 *  但存量数据里仍有以投影路径为键的条目,必须迁移,否则老钉全部变成孤儿。
 *
 *  迁移规则:lookup(key) 命中(说明这个键是投影路径且能反查到 ns)→ 改键为 ns,与目标键
 *  已有的钉**合并**(用户数据不覆盖);未命中 → 保留原键(它本身可能就是 ns,或会话已删:
 *  孤儿钉按 groupContentPins 的既有口径照常列出,不丢)。
 *  返回 null 表示无需迁移(调用方据此跳过写盘)。 */
export function migrateContentPinKeys(
  contentPins: Record<string, ContentPin[]>,
  lookup: (key: string) => string | undefined,
): Record<string, ContentPin[]> | null {
  // 两遍:先算每个条目的目标键,再按目标键合并——避免「先写入的条目被后写入的覆盖」。
  const target = new Map<string, ContentPin[]>();
  let changed = false;
  for (const [key, list] of Object.entries(contentPins)) {
    const ns = lookup(key);
    const to = ns && ns !== key ? ns : key;
    if (to !== key) changed = true;
    const prev = target.get(to);
    if (prev) { target.set(to, [...prev, ...list]); changed = true; }   // 合并即数据有变
    else target.set(to, list);
  }
  if (!changed) return null;   // 无需迁移:调用方据此跳过写盘
  return Object.fromEntries(target);
}

/** 项目内会话的**唯一键清单**(作用域 key 口径)。
 *
 *  sessionInfos 是 path 与 ns 双键索引(§kernel-forkless §32 主键迁移过渡期),
 *  直接 Object.keys 会让同一个会话出现两次——跨会话聚合列表因此重复。
 *  这里按「ns 优先、无 ns 回落 path」去重,每个会话恰好一个键。 */
export function uniqueSessionKeys(
  sessionInfos: Record<string, { path: string; neutralSessionId?: string }>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const info of Object.values(sessionInfos)) {
    const key = info.neutralSessionId ?? info.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
