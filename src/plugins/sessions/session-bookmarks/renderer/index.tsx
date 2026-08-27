import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Pencil, Plus, GitBranch, Loader2, Bookmark } from "lucide-react";
import { usePluginContext, useUiStore, EmptyState, Toast, SortableList } from "@my-harness-desktop/react";
import { cwdToBucketName, messageContentText, applyCustomOrder } from "@my-harness-desktop/shared";

// 收藏请求事件(本插件自有 channel):timeline/树行一击收藏经 invoke 分派,本 tab 订阅 + revealOn 揭示。
export const channels = ["bookmarks:addRequested"] as const;
// messageActions 槽动作组件:框架按 manifest component 名在 module exports 自动匹配(§7.4)。
export { BookmarkAction, ForkAction } from "./message-actions";

interface BookmarkMeta {
  id: string;
  label: string;
  preview: string;
  createdAt: string;
  cwd: string;
  entryId: string;
  originalSessionPath: string;
  /** 后端书签副本路径(anchor.opaque)。旧书签无此字段,resume 回退 bookmarkSessionFile 推导。 */
  bookmarkPath?: string;
  /** 运行时标记:收藏目录是否仍存在(非持久,加载时计算)。 */
  exists?: boolean;
}

interface BookmarkRequest {
  sessionPath: string;
  entryId: string;
  preview: string;
  /** 触发点给出的标签:timeline 一击收藏给默认 label(会话名/预览),树行原位输入给终值。 */
  label: string;
}

function joinPath(base: string, ...parts: string[]): string {
  return [base.replace(/\/$/, ""), ...parts].join("/");
}

/** 书签会话副本(fork 用)的项目级数据目录:<cwd>/.my-harness-desktop/session-bookmarks/<id>.jsonl。
 *  元数据走统一通道 ctx.config 的 "bookmarks" key(项目级 <cwd>/.my-harness-desktop/config/session-bookmarks.json,
 *  跟随项目、git 可追踪);副本是数据不是配置,住项目级数据目录。 */
function bookmarkDataDir(cwd: string): string {
  return joinPath(cwd, ".my-harness-desktop", "session-bookmarks");
}
function bookmarkSessionFile(cwd: string, id: string): string {
  return joinPath(bookmarkDataDir(cwd), `${id}.jsonl`);
}

/** 收藏快照目录(新快照模型 §bookmark-snapshot-fork-unify):<cwd>/.my-harness-desktop/bookmarks/<id>.json。
 *  快照由 session-store 物化写入(中立 NeutralEntry[] 自包含拷贝),渲染层只做 exists 判定 + 孤儿对账。 */
function snapshotDir(cwd: string): string {
  return joinPath(cwd, ".my-harness-desktop", "bookmarks");
}

/** 一次性懒迁移:旧全局桶 ~/.my-harness-desktop/plugins-data/session-bookmarks/<cwd-hash>/ 迁回项目级。
 *  cwdToBucketName 不可逆(横线歧义),但正向可算——打开项目时算自己的旧桶名检查,
 *  有就把 index/meta 读进统一通道、jsonl 经 copySession 搬到项目级数据目录。
 *  旧桶搬迁后残留(删除需写白名单外路径,通道不开放;残留只读无危害)。
 *  评估 P1-D1 当年把书签逼出项目目录(无门控 configFile 通道绕过 fs:project 沙箱);
 *  现由统一通道回家——路径框架推导,插件不碰路径。
 *  哨兵纪律:读到非空旧 index 立刻落 "legacyMigrated" 标记——旧桶残留永不删,
 *  无标记时「删光全部收藏」会在下次加载重新迁移、收藏复活(根因:迁移无完成态)。 */
async function migrateLegacyBucket(ctx: ReturnType<typeof usePluginContext>, cwd: string): Promise<BookmarkMeta[] | null> {
  const legacyDir = joinPath("~/.my-harness-desktop/plugins-data/session-bookmarks", cwdToBucketName(cwd));
  let indexRaw: unknown;
  try {
    indexRaw = await ctx.configFile.get(joinPath(legacyDir, "index.json"));
  } catch {
    return null;
  }
  if (!Array.isArray(indexRaw) || indexRaw.length === 0) return null;
  await ctx.config.set("legacyMigrated", true);
  const metas = (indexRaw as BookmarkMeta[]).filter((b) => b && typeof b.id === "string");
  for (const bm of metas) {
    try {
      await ctx.sessions.copySession(
        joinPath(legacyDir, bm.id, "session.jsonl"),
        bookmarkSessionFile(cwd, bm.id),
      );
    } catch (err) {
      console.warn(`[session-bookmarks] 旧书签副本搬迁失败,标不存在:${bm.id}`, err);
    }
  }
  await ctx.config.set("bookmarks", metas);
  return metas;
}

/** 相对时间(收藏时间显示):分档阈值 + Intl.RelativeTimeFormat 本地化,
 *  零依赖零文案 key——复数/语序由 ICU 处理,locale 随 i18n 切换。 */
function formatRelativeTime(iso: string, locale: string): string {
  const diffSec = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.trunc(diffSec), "second");
  if (abs < 3600) return rtf.format(Math.trunc(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.trunc(diffSec / 3600), "hour");
  if (abs < 604800) return rtf.format(Math.trunc(diffSec / 86400), "day");
  if (abs < 2592000) return rtf.format(Math.trunc(diffSec / 604800), "week");
  if (abs < 31536000) return rtf.format(Math.trunc(diffSec / 2592000), "month");
  return rtf.format(Math.trunc(diffSec / 31536000), "year");
}

export function BookmarksTab(): React.ReactNode {
  const ctx = usePluginContext();
  const { t, i18n } = useTranslation();
  const { currentCwd, currentNeutralSessionId } = useUiStore();
  const [bookmarks, setBookmarks] = useState<BookmarkMeta[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const orderRef = useRef<string[]>([]);
  /** 在途创建的副本 id(创建窗口豁免):copySession 落盘到 config.set 之间,孤儿对账不删。 */
  const pendingCreateRef = useRef(new Set<string>());
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [forking, setForking] = useState<string | null>(null);
  const [forkError, setForkError] = useState<{ bm: BookmarkMeta; message: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BookmarkMeta | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const loadBookmarks = useCallback(async () => {
    if (!currentCwd || !ctx.fs) return;
    const fs = ctx.fs;
    try {
      // 统一通道读项目级元数据;空且未迁移过则试一次性懒迁移(旧全局桶回家)
      let metas = (await ctx.config.get<BookmarkMeta[]>("bookmarks")) ?? [];
      if (metas.length === 0 && !(await ctx.config.get<boolean>("legacyMigrated"))) {
        metas = (await migrateLegacyBucket(ctx, currentCwd)) ?? [];
      }
      // exists 标记:对应快照文件 <id>.json 是否在项目级 bookmarks 目录
      const entries = await fs.listDir(snapshotDir(currentCwd)).catch(() => [] as { name: string; isDir: boolean }[]);
      const files = new Set(entries.filter((e) => !e.isDir).map((e) => e.name));
      // 孤儿对账:盘上有、元数据里没有、且非在途创建(创建窗口豁免)的快照 → 静默删。
      // 历史残留(元数据已删但快照未清等)跨加载周期自愈;在途创建由 pendingCreateRef 豁免——
      // fs:listDir 通道不携带 mtime,为对账改内核契约违背单文件原则(设计 bookmark-copy-lifecycle.md §2.4)。
      const metaIds = new Set(metas.map((b) => b.id));
      const pending = pendingCreateRef.current;
      for (const name of files) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -".json".length);
        if (metaIds.has(id) || pending.has(id)) continue;
        try {
          await fs.removePath(joinPath(snapshotDir(currentCwd), name));
        } catch { /* 静默:删不掉的对账下次再试 */ }
      }
      const validated = metas.map((b) => ({
        ...b,
        exists: files.has(`${b.id}.json`),
      }));
      setBookmarks(validated);
      const savedOrder = (await ctx.config.get<string[]>("bookmarkOrder")) ?? [];
      orderRef.current = savedOrder;
      setOrder(savedOrder);
    } catch {
      setBookmarks([]);
    }
  }, [ctx, currentCwd]);

  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks]);

  const createBookmark = useCallback(async (
    req: BookmarkRequest,
    label: string,
  ): Promise<string | null> => {
    if (!currentCwd || !req.sessionPath) return null;
    const id = crypto.randomUUID();
    const meta: BookmarkMeta = {
      id,
      label: label.trim(),
      preview: req.preview,
      createdAt: new Date().toISOString(),
      cwd: currentCwd,
      entryId: req.entryId,
      originalSessionPath: req.sessionPath,
    };
    // 创建窗口豁免:文件先落盘、元数据后写,中间对账可能看到"无主文件"——登记进
    // pendingCreateRef,孤儿对账跳过;完成后元数据已含 id,豁免即可撤销
    pendingCreateRef.current.add(id);
    try {
      // 走快照收藏:后端物化中立流前缀成自包含快照文件(去 opaque,存项目级 bookmarks 目录)。
      await ctx.sessions.bookmark(req.sessionPath, req.entryId, id, meta.label, meta.preview);
      const index = (await ctx.config.get<BookmarkMeta[]>("bookmarks")) ?? [];
      index.push({ ...meta });
      await ctx.config.set("bookmarks", index);
      await loadBookmarks();
      return id;
    } finally {
      pendingCreateRef.current.delete(id);
    }
  }, [ctx, currentCwd, loadBookmarks]);

  // timeline 一击收藏走 invoke:本组件未挂载时请求在总线入队,revealOn 揭示本 tab、
  // 挂载订阅后恰好一次冲刷(旧注释的 keep-alive 前提不成立——tab 关掉组件即卸载)。
  // timeline 来源创建后原位进入改标题(默认 label 只是占位);树行来源已原位输入完,静默创建。
  useEffect(() => {
    const handler = (editAfter: boolean) => (payload: unknown) => {
      const req = payload as BookmarkRequest;
      if (!req.label?.trim()) return;
      void createBookmark(req, req.label).then((id) => {
        if (editAfter && id) {
          setSearch("");
          setEditingId(id);
          setEditLabel(req.label.trim());
        }
      });
    };
    const off1 = ctx.events.on("bookmarks:addRequested", handler(true));
    const off2 = ctx.events.on("session-tree:bookmarkRequested", handler(false));
    return () => { off1(); off2(); };
  }, [ctx.events, createBookmark]);

  const forkFromBookmark = async (bm: BookmarkMeta): Promise<void> => {
    setForking(bm.id);
    setForkError(null);
    try {
      // 走快照发起:读快照 → seed 到目标内核 → fork 新 lineage(自包含,不依赖源会话)。
      const lineageId = await ctx.sessions.resume(bm.id);
      ctx.events.invoke("timeline:scrollTo", { messageId: bm.entryId });
      setToast(t("bookmarks.forkCreated", { label: bm.label }));
      void lineageId;
    } catch (err) {
      console.error("[session-bookmarks] fork failed", err);
      setForkError({ bm, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setForking(null);
    }
  };

  const renameBookmark = async (bm: BookmarkMeta, newLabel: string): Promise<void> => {
    const meta = { ...bm, label: newLabel.trim() };
    const index = (await ctx.config.get<BookmarkMeta[]>("bookmarks")) ?? [];
    await ctx.config.set("bookmarks", index.map((b) => (b.id === bm.id ? meta : b)));
    await loadBookmarks();
  };

  // 删除流程(设计 bookmark-copy-lifecycle.md §2.2):① 元数据必成(取消收藏本体),
  // ② 副本 best-effort(清理失败残留由孤儿对账兜底),③ bookmarkOrder 内存同步 + void 写回,
  // ④ UI 刷新。① 失败弹提示直接返回——唯一对用户可见的失败;②③ 成败不影响 ④。
  const deleteBookmark = async (bm: BookmarkMeta): Promise<void> => {
    try {
      const index = (await ctx.config.get<BookmarkMeta[]>("bookmarks")) ?? [];
      await ctx.config.set("bookmarks", index.filter((b) => b.id !== bm.id));
    } catch (err) {
      console.error("[session-bookmarks] 删除收藏失败(元数据)", err);
      setToast(t("bookmarks.deleteFailed"));
      return;
    }
    try {
      // 快照文件住项目级 bookmarks 目录,删除走内核 deleteBookmark 回收。
      await ctx.sessions.deleteBookmark(bm.id);
    } catch (err) {
      console.warn("[session-bookmarks] 副本清理失败,残留由对账兜底", err);
    }
    const nextOrder = orderRef.current.filter((id) => id !== bm.id);
    if (nextOrder.length !== orderRef.current.length) {
      orderRef.current = nextOrder;
      setOrder(nextOrder);
      void ctx.config.set("bookmarkOrder", nextOrder);
    }
    try {
      await loadBookmarks();
    } catch { /* loadBookmarks 内部自带兜底,不抛 */ }
  };

  const displayed = useMemo(
    () => applyCustomOrder(bookmarks, order, (b) => b.id, (b) => b.createdAt),
    [bookmarks, order],
  );
  const filtered = displayed.filter(
    (b) =>
      b.label.toLowerCase().includes(search.toLowerCase()) ||
      b.preview.toLowerCase().includes(search.toLowerCase()),
  );

  if (!currentCwd) {
    return <EmptyState icon={<Bookmark className="size-8" />} title={t("bookmarks.openFolderFirst")} />;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-[var(--color-border)]">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("bookmarks.searchPlaceholder")}
          className="flex-1 bg-transparent border border-[var(--color-border)] rounded-[var(--radius-sm)] px-2 py-1 text-[length:var(--font-size-sm)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary)]"
        />
        <button
          onClick={() => setShowAddForm(true)}
          title={t("bookmarks.addManually")}
          className="flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] cursor-pointer bg-transparent"
        >
          <Plus className="size-4" />
        </button>
      </div>

      {showAddForm && (
        <div className="shrink-0 px-3 py-2 border-b border-[var(--color-border)]">
          <AddForm
            defaultSessionPath={currentNeutralSessionId ?? ""}
            onResolve={async (sessionPath, entryId) => {
              const detail = await ctx.sessions.openSession(sessionPath);
              if (!detail) return { error: t("bookmarks.errorSessionNotFound") };
              const msg = detail.messages.find((m) => m.id === entryId);
              if (!msg) return { error: t("bookmarks.errorEntryNotFound") };
              if (msg.role !== "assistant") return { error: t("bookmarks.errorNotForkable") };
              const preview = messageContentText(msg.content).replace(/\s+/g, " ").trim().slice(0, 30) || t("bookmarks.emptyPreview");
              return { preview };
            }}
            onCancel={() => setShowAddForm(false)}
            onSubmit={async (sessionPath, entryId, label, preview) => {
              await createBookmark({ sessionPath, entryId, preview, label }, label);
              setShowAddForm(false);
            }}
          />
        </div>
      )}

      {forkError && (
        <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-[var(--color-border)] text-xs text-[var(--color-accent-error)]">
          <span className="flex-1 min-w-0 truncate">{t("bookmarks.forkFailed", { message: forkError.message })}</span>
          <button
            onClick={() => void forkFromBookmark(forkError.bm)}
            className="shrink-0 text-[var(--color-primary)] bg-transparent border-none cursor-pointer p-0"
          >
            {t("bookmarks.retry")}
          </button>
          <button
            onClick={() => setForkError(null)}
            className="shrink-0 text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer p-0"
          >
            {t("bookmarks.dismiss")}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {filtered.length === 0 ? (
          <div className="p-4 text-[var(--color-muted)] text-[length:var(--font-size-sm)] text-center">
            {search ? t("bookmarks.noMatch") : t("bookmarks.empty")}
          </div>
        ) : (
          <SortableList
            values={filtered.map((b) => b.id)}
            onReorder={(ids) => { orderRef.current = ids; setOrder(ids); }}
            onEnd={() => void ctx.config.set("bookmarkOrder", orderRef.current)}
            disabled={!!search}
          >
          {filtered.map((bm) => {
            // Enter/blur 共用一条提交路径(失焦语义对齐项目内联编辑器惯例,见 review 插件):
            // 有内容提交,空则丢弃保留原名;Escape 是唯一取消路径。timeline 一击收藏的自动
            // 改名和铅笔按钮的手动改名因此共享同一退出行为——点击任何其他位置即收编。
            const commitEdit = (): void => {
              setEditingId(null);
              const label = editLabel.trim();
              if (label && label !== bm.label) void renameBookmark(bm, label);
            };
            return (
            <SortableList.Item key={bm.id} value={bm.id}>
            <div
              className="group relative px-3 py-2 border-b border-[var(--color-border)] hover:bg-[var(--color-surface)] cursor-pointer"
              onClick={() => bm.exists && forking !== bm.id && deleteTarget?.id !== bm.id && void forkFromBookmark(bm)}
            >
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  {editingId === bm.id ? (
                    <input
                      type="text"
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          commitEdit();
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      onBlur={commitEdit}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      className="w-full bg-[var(--color-surface)] border border-[var(--color-primary)] rounded-[var(--radius-xs)] px-1 py-0.5 text-[length:var(--font-size-sm)] text-[var(--color-fg)] outline-none"
                    />
                  ) : (
                    <div className={`text-[length:var(--font-size-sm)] font-medium truncate ${bm.exists ? "text-[var(--color-fg)]" : "text-[var(--color-muted)] line-through"}`}>
                      {bm.label}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {forking === bm.id ? (
                    <Loader2 className="size-3.5 animate-spin text-[var(--color-muted)]" />
                  ) : (
                    bm.exists && <span title={t("bookmarks.forkTooltip")}><GitBranch className="size-3.5 text-[var(--color-muted)]" /></span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(bm.id);
                      setEditLabel(bm.label);
                    }}
                    className="text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer p-0.5"
                    title={t("bookmarks.rename")}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(bm);
                    }}
                    className="text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer p-0.5"
                    title={t("bookmarks.delete")}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex items-baseline gap-2 mt-0.5">
                <div className="flex-1 min-w-0 text-xs text-[var(--color-muted)] truncate">{bm.preview}</div>
                <div className="shrink-0 text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
                  {formatRelativeTime(bm.createdAt, i18n.language)}
                </div>
              </div>
              {deleteTarget?.id === bm.id && (
                // 原位删除确认:绝对定位覆盖整行——下层内容照常渲染撑起行高,确认条与行同高,
                // 光标零位移,确认/取消就在点垃圾桶的位置
                <div
                  className="absolute inset-0 z-10 flex items-center gap-2 px-3 bg-[var(--color-surface)]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="flex-1 min-w-0 truncate text-xs text-[var(--color-accent-error)]">
                    {t("bookmarks.deleteInlineConfirm", { label: bm.label })}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(null);
                      void deleteBookmark(bm).catch((err) => console.error("[session-bookmarks] deleteBookmark 未预期异常", err));
                    }}
                    className="shrink-0 px-2 py-0.5 text-xs rounded-[var(--radius-sm)] bg-[var(--color-accent-error)] text-[var(--color-bg)] border-none cursor-pointer"
                  >
                    {t("bookmarks.delete")}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(null);
                    }}
                    className="shrink-0 px-2 py-0.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer"
                  >
                    {t("bookmarks.cancel")}
                  </button>
                </div>
              )}
            </div>
            </SortableList.Item>
            );
          })}
          </SortableList>
        )}
      </div>

      {toast && <Toast message={toast} onClose={() => setToast(null)} variant="success" />}
    </div>
  );
}

function AddForm({
  defaultSessionPath,
  onResolve,
  onCancel,
  onSubmit,
}: {
  defaultSessionPath: string;
  onResolve: (sessionPath: string, entryId: string) => Promise<{ preview: string } | { error: string }>;
  onCancel: () => void;
  onSubmit: (sessionPath: string, entryId: string, label: string, preview: string) => Promise<void>;
}): React.ReactNode {
  const { t } = useTranslation();
  const [sessionPath, setSessionPath] = useState(defaultSessionPath);
  const [entryId, setEntryId] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const resolved = await onResolve(sessionPath.trim(), entryId.trim());
      if ("error" in resolved) {
        setError(resolved.error);
        return;
      }
      await onSubmit(sessionPath.trim(), entryId.trim(), label.trim(), resolved.preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="text-[length:var(--font-size-sm)] font-medium text-[var(--color-fg)] mb-3">{t("bookmarks.addTitle")}</div>
      <div className="space-y-2">
        <input
          type="text"
          value={sessionPath}
          onChange={(e) => setSessionPath(e.target.value)}
          placeholder={t("bookmarks.sessionPathPlaceholder")}
          className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-2 py-1.5 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary)]"
        />
        <input
          type="text"
          value={entryId}
          onChange={(e) => setEntryId(e.target.value)}
          placeholder={t("bookmarks.entryIdPlaceholder")}
          className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-2 py-1.5 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary)]"
        />
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("bookmarks.labelPlaceholder")}
          className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-2 py-1.5 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary)]"
          autoFocus
        />
      </div>
      {error && <div className="text-xs text-[var(--color-accent-error)] mt-2">{error}</div>}
      <div className="flex justify-end gap-2 mt-3">
        <button onClick={onCancel} className="px-3 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer">
          {t("bookmarks.cancel")}
        </button>
        <button
          onClick={() => void handleSubmit()}
          disabled={!sessionPath.trim() || !entryId.trim() || !label.trim() || submitting}
          className="px-3 py-1 text-xs rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] border-none cursor-pointer disabled:opacity-40"
        >
          {submitting ? t("bookmarks.validating") : t("bookmarks.add")}
        </button>
      </div>
    </>
  );
}

