// stickers 数据层 —— 两层并集读写,全部 IO 的唯一出入口(设计 §2.4:组件不碰 IPC)。
//
// 通道:统一项目级配置通道(ctx.config)。全局层 = config 全局文件的 stickers key,
// 项目层 = 当前项目 <cwd>/.pi-desktop/config/stickers.json 的 stickers key。
// 合并是"并集按 order 排序",不是配置那种同 key 覆盖——一条贴纸只存在于一层,
// id 全局唯一,无遮蔽语义(设计 §2.2);经 getScope 读单层原始快照区分层。
//
// banner 图:存 ~/.pi-desktop/stickers/banners/<id>.<ext>(全局数据根,恒不分层),
// config 只存逻辑路径(设计 docs/design/sticker-plugin.md §2.2)。banner 是交流机制、
// 跨项目复用,所以不跟项目层走——删项目层条目,图文件还在。
//
// 写后 main 广播 settings:changed → 两侧视图订阅 system:settingsChanged 重读(设计 §5),
// 故这里写完不重发事件、不做缓存。

import type { PluginContext } from "@pi-desktop/contract";

export interface StickerItem {
  id: string;
  title?: string;
  content: string;
  /** 可选展示图的逻辑路径(如 ~/.pi-desktop/stickers/banners/<id>.png);无图缺省。 */
  banner?: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export type StickerLayer = "global" | "project";

export interface LayeredSticker extends StickerItem {
  layer: StickerLayer;
}

type Ctx = Pick<PluginContext, "config" | "configFile">;

/** banner 目录(逻辑前缀,expandDesktopPath 运行时映射到当前数据根)。恒全局,不分层。 */
const BANNER_DIR = "~/.pi-desktop/stickers/banners";

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
};

/** 写 banner 图文件(解码后落盘,返回逻辑路径)。扩展名由 mime 推,兜底 png。 */
async function writeBanner(ctx: Ctx, id: string, base64: string, mimeType: string): Promise<string> {
  const ext = IMAGE_EXT[mimeType] ?? "png";
  const path = `${BANNER_DIR}/${id}.${ext}`;
  await ctx.configFile.writeBinary(path, base64);
  return path;
}

/** 宽容解析:只收 content 非空的条目;缺字段补默认。返回 { stickers, dirty }——
 *  手工编辑丢了 id 的条目补发 UUID 并标脏(设计 QA-8),load 时写回。 */
function asStickers(doc: Record<string, unknown> | null): { stickers: StickerItem[]; dirty: boolean } {
  const raw = (doc as { stickers?: unknown } | null)?.stickers;
  if (!Array.isArray(raw)) return { stickers: [], dirty: false };
  const stickers: StickerItem[] = [];
  let dirty = false;
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    if (typeof o.content !== "string" || !o.content.trim()) continue;
    const hasId = typeof o.id === "string" && o.id.length > 0;
    if (!hasId) dirty = true;
    const item: StickerItem = {
      id: hasId ? (o.id as string) : crypto.randomUUID(),
      title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : undefined,
      content: o.content,
      order: typeof o.order === "number" ? o.order : Number.MAX_SAFE_INTEGER,
      createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
      updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
    };
    if (typeof o.banner === "string" && o.banner.length > 0) item.banner = o.banner;
    stickers.push(item);
  }
  return { stickers, dirty };
}

async function readLayer(ctx: Ctx, layer: StickerLayer): Promise<{ stickers: StickerItem[]; dirty: boolean }> {
  return asStickers(await ctx.config.getScope(layer));
}

async function writeLayer(ctx: Ctx, layer: StickerLayer, items: StickerItem[]): Promise<void> {
  await ctx.config.set("stickers", items, { scope: layer });
}

/** 两层读全,返回按 order 升序合并的扁平列表(同 order 按 updatedAt 倒序兜底)。 */
export async function loadStickers(ctx: Ctx): Promise<LayeredSticker[]> {
  const [g, p] = await Promise.all([readLayer(ctx, "global"), readLayer(ctx, "project")]);
  // 补发 UUID 的脏层立即写回,保证 id 稳定(后续编辑/排序按 id 操作)
  if (g.dirty) await writeLayer(ctx, "global", g.stickers);
  if (p.dirty) await writeLayer(ctx, "project", p.stickers);
  const merged: LayeredSticker[] = [
    ...g.stickers.map((n) => ({ ...n, layer: "global" as const })),
    ...p.stickers.map((n) => ({ ...n, layer: "project" as const })),
  ];
  merged.sort((a, b) => (a.order !== b.order ? a.order - b.order : b.updatedAt - a.updatedAt));
  return merged;
}

/** 从 banner 逻辑路径推 mime(扩展名映射;导出时还原 mimeType)。 */
function bannerMimeOf(banner: string): string {
  const i = banner.lastIndexOf(".");
  const ext = i === -1 ? "" : banner.slice(i + 1).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? "image/png";
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

/** 导出全部贴纸为可移植 JSON:含标题/内容/层,以及 banner 图 base64(导入端还原成文件)。
 *  图跨机迁移的唯一途径——路径是本机的,只有图数据能带走。 */
export async function exportStickers(ctx: Ctx): Promise<string> {
  const merged = await loadStickers(ctx);
  const out: Record<string, unknown>[] = [];
  for (const s of merged) {
    const item: Record<string, unknown> = { title: s.title, content: s.content, layer: s.layer };
    if (s.banner) {
      const b64 = await ctx.configFile.readBinary(s.banner);
      if (b64) item.banner = { base64: b64, mimeType: bannerMimeOf(s.banner) };
    }
    out.push(item);
  }
  return JSON.stringify({ stickers: out, exportedAt: new Date().toISOString() }, null, 2);
}

/** 导入贴纸(exportStickers 的反向):读 JSON,每条建贴纸(有 banner 则写图文件)。
 *  导入总是新建(不覆盖既有 id),避免两机合并时的 id 冲突。返回导入/跳过数。 */
export async function importStickers(ctx: Ctx, json: string): Promise<{ imported: number; skipped: number }> {
  const parsed = JSON.parse(json) as { stickers?: unknown };
  if (!Array.isArray(parsed?.stickers)) throw new Error("不是有效的贴纸导出文件");
  let imported = 0;
  let skipped = 0;
  for (const raw of parsed.stickers) {
    const o = (raw ?? {}) as Record<string, unknown>;
    if (typeof o.content !== "string" || !o.content.trim()) { skipped++; continue; }
    const layer: StickerLayer = o.layer === "global" ? "global" : "project";
    const b = o.banner as { base64?: string; mimeType?: string } | undefined;
    await createSticker(ctx, {
      title: typeof o.title === "string" ? o.title : undefined,
      content: o.content,
      banner: b?.base64 ? { base64: b.base64, mimeType: b.mimeType ?? "image/png" } : undefined,
    }, layer);
    imported++;
  }
  return { imported, skipped };
}

/** 内置贴纸(随插件分发,无特权差异——就是普通全局贴纸,首次自动导入,可编辑/删除)。
 *  纯文本常用语:内置 banner 图没有可靠分发渠道(插件目录不在 configFile 白名单),
 *  图由用户上传,内置只给文本。 */
export const BUILTIN_STICKERS: { title?: string; content: string }[] = [
  { title: "整理日报", content: "把今天的工作整理成一份日报，按 完成/进行中/阻塞 分类" },
  { title: "写周报", content: "根据我们对话的内容，帮我写一份周报" },
  { title: "总结代码", content: "总结一下这段代码：它的职责、关键逻辑、可能的改进点" },
  { title: "代码审查", content: "帮我 review 当前改动，重点看潜在 bug、边界情况和可读性" },
  { title: "生成测试", content: "为这个函数写几个单元测试，覆盖正常、边界和异常输入" },
  { title: "继续", content: "继续" },
];

/** 内置贴纸首次导入标记(全局层独立 key,set("stickers") 不覆盖)。 */
const BUILTIN_SEED_KEY = "_seedBuiltin";

/** 首次启动导入内置贴纸到全局层(仅一次,由 marker 防重复;用户删了不补)。
 *  返回是否执行了导入。失败静默(下次 reload 重试)。 */
export async function seedBuiltinStickers(ctx: Ctx): Promise<boolean> {
  try {
    const doc = await ctx.config.getScope("global");
    if ((doc as { [k: string]: unknown })[BUILTIN_SEED_KEY] === true) return false;
    const items = (await readLayer(ctx, "global")).stickers;
    const now = Date.now();
    const next = [...items];
    for (const b of BUILTIN_STICKERS) {
      next.push({
        id: crypto.randomUUID(), title: b.title, content: b.content,
        order: next.length, createdAt: now, updatedAt: now,
      });
    }
    await writeLayer(ctx, "global", next);
    await ctx.config.set(BUILTIN_SEED_KEY, true, { scope: "global" });
    return true;
  } catch {
    return false;
  }
}

/** 新条目默认落项目层(面板语义),可指定层(设置页分层 section 的 ＋ 入口);order 取合并列表末尾。
 *  banner 可选:给 {base64, mimeType} 则写 banner 文件并把逻辑路径存进条目。 */
export async function createSticker(ctx: Ctx, input: { title?: string; content: string; banner?: { base64: string; mimeType: string } | null }, layer: StickerLayer = "project"): Promise<void> {
  const items = (await readLayer(ctx, layer)).stickers;
  const merged = await loadStickers(ctx);
  const order = merged.length > 0 ? Math.max(...merged.map((n) => n.order)) + 1 : 0;
  const now = Date.now();
  const id = crypto.randomUUID();
  const item: StickerItem = {
    id,
    title: input.title?.trim() || undefined,
    content: input.content,
    order,
    createdAt: now,
    updatedAt: now,
  };
  if (input.banner) item.banner = await writeBanner(ctx, id, input.banner.base64, input.banner.mimeType);
  await writeLayer(ctx, layer, [...items, item]);
}

export async function updateSticker(ctx: Ctx, id: string, patch: { title?: string; content: string; banner?: { base64: string; mimeType: string } | null }): Promise<void> {
  const merged = await loadStickers(ctx);
  const target = merged.find((n) => n.id === id);
  if (!target) return;
  const items = (await readLayer(ctx, target.layer)).stickers.map(async (n) => {
    if (n.id !== id) return n;
    const next: StickerItem = { ...n, title: patch.title?.trim() || undefined, content: patch.content, updatedAt: Date.now() };
    // banner:null = 移除图;banner:对象 = 写新图文件换路径;缺省 = 不动
    if (patch.banner === null) delete next.banner;
    else if (patch.banner) next.banner = await writeBanner(ctx, id, patch.banner.base64, patch.banner.mimeType);
    return next;
  });
  await writeLayer(ctx, target.layer, await Promise.all(items));
}

export async function removeSticker(ctx: Ctx, id: string): Promise<void> {
  const merged = await loadStickers(ctx);
  const target = merged.find((n) => n.id === id);
  if (!target) return;
  const items = (await readLayer(ctx, target.layer)).stickers.filter((n) => n.id !== id);
  await writeLayer(ctx, target.layer, items);
  // 不删 banner 图文件:会话历史消息的展示仍引用它(设计 QA-3)
}

/** 拖拽后按新位置把合并列表重编号 0..n-1,按层拆回两层各写(设计 §4.2)。 */
export async function reorderStickers(ctx: Ctx, orderedIds: string[]): Promise<void> {
  const merged = await loadStickers(ctx);
  const pos = new Map(orderedIds.map((id, i) => [id, i]));
  const renumbered = merged.map((n) => ({ ...n, order: pos.get(n.id) ?? n.order }));
  await Promise.all([
    writeLayer(ctx, "global", renumbered.filter((n) => n.layer === "global")),
    writeLayer(ctx, "project", renumbered.filter((n) => n.layer === "project")),
  ]);
}

/** 层间迁移:条目本体(含 order、时间戳、banner 路径)原样搬到另一层,追加到目标层末尾。 */
export async function moveLayer(ctx: Ctx, id: string): Promise<void> {
  const merged = await loadStickers(ctx);
  const target = merged.find((n) => n.id === id);
  if (!target) return;
  const [g, p] = await Promise.all([readLayer(ctx, "global"), readLayer(ctx, "project")]);
  const { id: nid, title, content, banner, order, createdAt, updatedAt } = target;
  const bare: StickerItem = { id: nid, title, content, banner, order, createdAt, updatedAt };
  if (target.layer === "project") {
    await Promise.all([
      writeLayer(ctx, "project", p.stickers.filter((n) => n.id !== id)),
      writeLayer(ctx, "global", [...g.stickers, bare]),
    ]);
  } else {
    await Promise.all([
      writeLayer(ctx, "global", g.stickers.filter((n) => n.id !== id)),
      writeLayer(ctx, "project", [...p.stickers, bare]),
    ]);
  }
}

/** 拖拽迁移：条目搬到 targetLayer 的第 targetIndex 个位置（null/越界 = 追加末尾），合并列表重编号。
 *  与 moveLayer 的区别：moveLayer 只知道"搬到哪层"（追加末尾），moveToLayer 知道"搬到哪层的哪个位置"。 */
export async function moveToLayer(ctx: Ctx, id: string, targetLayer: StickerLayer, targetIndex: number | null = null): Promise<void> {
  const merged = await loadStickers(ctx);
  const item = merged.find((n) => n.id === id);
  if (!item || item.layer === targetLayer) return;
  const remaining = merged.filter((n) => n.id !== id);
  const moved: LayeredSticker = { ...item, layer: targetLayer };
  const layerItems = remaining.filter((n) => n.layer === targetLayer);
  let insertAt: number;
  if (targetIndex === null || targetIndex >= layerItems.length) {
    const last = layerItems[layerItems.length - 1];
    insertAt = last ? remaining.indexOf(last) + 1 : 0;
  } else {
    insertAt = remaining.indexOf(layerItems[targetIndex]);
  }
  remaining.splice(insertAt, 0, moved);
  const renumbered = remaining.map((n, i) => ({ ...n, order: i }));
  await Promise.all([
    writeLayer(ctx, "global", renumbered.filter((n) => n.layer === "global")),
    writeLayer(ctx, "project", renumbered.filter((n) => n.layer === "project")),
  ]);
}
