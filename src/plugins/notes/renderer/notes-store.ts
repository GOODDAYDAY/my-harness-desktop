// notes 数据层 —— 两层 JSON 文件的并集读写，全部 IO 的唯一出入口（设计 §2.4：组件不碰 IPC）。
//
// 全局层 ~/.pi-desktop/notes.json（config-file 白名单内）；项目层 <cwd>/.pi-desktop/notes.json
// （config-file:getProject/setProject）。合并是"并集按 order 排序"，不是配置那种同 key 覆盖——
// 一条笔记只存在于一个文件，id 全局唯一，无遮蔽语义（设计 §2.2）。
//
// 写后 main 广播 settings:changed → 两侧视图订阅 system:settingsChanged 重读（设计 §5），
// 故这里写完不重发事件、不做缓存。

import type { PluginContext } from "@pi-desktop/core";

export interface NoteItem {
  id: string;
  title?: string;
  content: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export type NoteLayer = "global" | "project";

export interface LayeredNote extends NoteItem {
  layer: NoteLayer;
}

const GLOBAL_PATH = "~/.pi-desktop/notes.json";
// relPath 是相对 .pi-desktop/ 的(main 侧 resolveRelPath 自动拼 .pi-desktop/ 前缀,
// 对照 tool-manager 传 config/tool-groups.json)——此前误传 .pi-desktop/notes.json
// 导致落点翻倍成 <cwd>/.pi-desktop/.pi-desktop/notes.json。
const PROJECT_REL = "notes.json";

type Ctx = Pick<PluginContext, "configFile">;

/** 宽容解析：只收 content 非空的条目；缺字段补默认。返回 { notes, dirty }——
 *  手工编辑丢了 id 的条目补发 UUID 并标脏（设计 QA-8），load 时写回。 */
function asNotes(doc: Record<string, unknown> | null): { notes: NoteItem[]; dirty: boolean } {
  const raw = (doc as { notes?: unknown } | null)?.notes;
  if (!Array.isArray(raw)) return { notes: [], dirty: false };
  const notes: NoteItem[] = [];
  let dirty = false;
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    if (typeof o.content !== "string" || !o.content.trim()) continue;
    const hasId = typeof o.id === "string" && o.id.length > 0;
    if (!hasId) dirty = true;
    notes.push({
      id: hasId ? (o.id as string) : crypto.randomUUID(),
      title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : undefined,
      content: o.content,
      order: typeof o.order === "number" ? o.order : Number.MAX_SAFE_INTEGER,
      createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
      updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
    });
  }
  return { notes, dirty };
}

async function readLayer(ctx: Ctx, cwd: string, layer: NoteLayer): Promise<{ notes: NoteItem[]; dirty: boolean }> {
  if (layer === "global") return asNotes(await ctx.configFile.get(GLOBAL_PATH));
  return asNotes(await ctx.configFile.getProject(cwd, PROJECT_REL));
}

async function writeLayer(ctx: Ctx, cwd: string, layer: NoteLayer, items: NoteItem[]): Promise<void> {
  const doc = { notes: items } as unknown as Record<string, unknown>;
  if (layer === "global") await ctx.configFile.set(GLOBAL_PATH, doc, "replace");
  else await ctx.configFile.setProject(cwd, PROJECT_REL, doc, "replace");
}

/** 两层读全，返回按 order 升序合并的扁平列表（同 order 按 updatedAt 倒序兜底）。 */
export async function loadNotes(ctx: Ctx, cwd: string): Promise<LayeredNote[]> {
  const [g, p] = await Promise.all([readLayer(ctx, cwd, "global"), readLayer(ctx, cwd, "project")]);
  // 补发 UUID 的脏层立即写回，保证 id 稳定（后续编辑/排序按 id 操作）
  if (g.dirty) await writeLayer(ctx, cwd, "global", g.notes);
  if (p.dirty) await writeLayer(ctx, cwd, "project", p.notes);
  const merged: LayeredNote[] = [
    ...g.notes.map((n) => ({ ...n, layer: "global" as const })),
    ...p.notes.map((n) => ({ ...n, layer: "project" as const })),
  ];
  merged.sort((a, b) => (a.order !== b.order ? a.order - b.order : b.updatedAt - a.updatedAt));
  return merged;
}

/** 新条目默认落项目层(面板语义),可指定层(设置页分层 section 的 ＋ 入口);order 取合并列表末尾。 */
export async function createNote(ctx: Ctx, cwd: string, input: { title?: string; content: string }, layer: NoteLayer = "project"): Promise<void> {
  const items = (await readLayer(ctx, cwd, layer)).notes;
  const merged = await loadNotes(ctx, cwd);
  const order = merged.length > 0 ? Math.max(...merged.map((n) => n.order)) + 1 : 0;
  const now = Date.now();
  const item: NoteItem = {
    id: crypto.randomUUID(),
    title: input.title?.trim() || undefined,
    content: input.content,
    order,
    createdAt: now,
    updatedAt: now,
  };
  await writeLayer(ctx, cwd, layer, [...items, item]);
}

export async function updateNote(ctx: Ctx, cwd: string, id: string, patch: { title?: string; content: string }): Promise<void> {
  const merged = await loadNotes(ctx, cwd);
  const target = merged.find((n) => n.id === id);
  if (!target) return;
  const items = (target.layer === "global" ? (await readLayer(ctx, cwd, "global")).notes : (await readLayer(ctx, cwd, "project")).notes).map(
    (n) => (n.id === id ? { ...n, title: patch.title?.trim() || undefined, content: patch.content, updatedAt: Date.now() } : n),
  );
  await writeLayer(ctx, cwd, target.layer, items);
}

export async function removeNote(ctx: Ctx, cwd: string, id: string): Promise<void> {
  const merged = await loadNotes(ctx, cwd);
  const target = merged.find((n) => n.id === id);
  if (!target) return;
  const items = (await readLayer(ctx, cwd, target.layer)).notes.filter((n) => n.id !== id);
  await writeLayer(ctx, cwd, target.layer, items);
}

/** 拖拽后按新位置把合并列表重编号 0..n-1，按层拆回两个文件（设计 §4.2）。 */
export async function reorderNotes(ctx: Ctx, cwd: string, orderedIds: string[]): Promise<void> {
  const merged = await loadNotes(ctx, cwd);
  const pos = new Map(orderedIds.map((id, i) => [id, i]));
  const renumbered = merged.map((n) => ({ ...n, order: pos.get(n.id) ?? n.order }));
  await Promise.all([
    writeLayer(ctx, cwd, "global", renumbered.filter((n) => n.layer === "global")),
    writeLayer(ctx, cwd, "project", renumbered.filter((n) => n.layer === "project")),
  ]);
}

/** 层间迁移：条目本体（含 order、时间戳）原样搬到另一层，是移动不是复制（设计 §2.3）。 */
export async function moveLayer(ctx: Ctx, cwd: string, id: string): Promise<void> {
  const merged = await loadNotes(ctx, cwd);
  const target = merged.find((n) => n.id === id);
  if (!target) return;
  const [g, p] = await Promise.all([readLayer(ctx, cwd, "global"), readLayer(ctx, cwd, "project")]);
  const { id: nid, title, content, order, createdAt, updatedAt } = target;
  const bare: NoteItem = { id: nid, title, content, order, createdAt, updatedAt };
  if (target.layer === "project") {
    await Promise.all([
      writeLayer(ctx, cwd, "project", p.notes.filter((n) => n.id !== id)),
      writeLayer(ctx, cwd, "global", [...g.notes, bare]),
    ]);
  } else {
    await Promise.all([
      writeLayer(ctx, cwd, "global", g.notes.filter((n) => n.id !== id)),
      writeLayer(ctx, cwd, "project", [...p.notes, bare]),
    ]);
  }
}
