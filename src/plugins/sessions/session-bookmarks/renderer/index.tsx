import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Pencil, Plus, GitBranch, Loader2, Bookmark } from "lucide-react";
import { usePluginContext, useUiStore, EmptyState } from "@pi-desktop/react";
import { cwdToBucketName, messageContentText } from "@pi-desktop/contract";

interface BookmarkMeta {
  id: string;
  label: string;
  preview: string;
  createdAt: string;
  cwd: string;
  entryId: string;
  originalSessionPath: string;
  /** 运行时标记:收藏目录是否仍存在(非持久,加载时计算)。 */
  exists?: boolean;
}

interface BookmarkRequest {
  sessionPath: string;
  entryId: string;
  preview: string;
}

function joinPath(base: string, ...parts: string[]): string {
  return [base.replace(/\/$/, ""), ...parts].join("/");
}

/** 书签会话副本(fork 用)的项目级数据目录:<cwd>/.pi-desktop/session-bookmarks/<id>.jsonl。
 *  元数据走统一通道 ctx.config 的 "bookmarks" key(项目级 <cwd>/.pi-desktop/config/session-bookmarks.json,
 *  跟随项目、git 可追踪);副本是数据不是配置,住项目级数据目录。 */
function bookmarkDataDir(cwd: string): string {
  return joinPath(cwd, ".pi-desktop", "session-bookmarks");
}
function bookmarkSessionFile(cwd: string, id: string): string {
  return joinPath(bookmarkDataDir(cwd), `${id}.jsonl`);
}

/** 一次性懒迁移:旧全局桶 ~/.pi-desktop/plugins-data/session-bookmarks/<cwd-hash>/ 迁回项目级。
 *  cwdToBucketName 不可逆(横线歧义),但正向可算——打开项目时算自己的旧桶名检查,
 *  有就把 index/meta 读进统一通道、jsonl 经 copySession 搬到项目级数据目录。
 *  旧桶搬迁后残留(删除需写白名单外路径,通道不开放;残留只读无危害)。
 *  评估 P1-D1 当年把书签逼出项目目录(无门控 configFile 通道绕过 fs:project 沙箱);
 *  现由统一通道回家——路径框架推导,插件不碰路径。
 *  哨兵纪律:读到非空旧 index 立刻落 "legacyMigrated" 标记——旧桶残留永不删,
 *  无标记时「删光全部收藏」会在下次加载重新迁移、收藏复活(根因:迁移无完成态)。 */
async function migrateLegacyBucket(ctx: ReturnType<typeof usePluginContext>, cwd: string): Promise<BookmarkMeta[] | null> {
  const legacyDir = joinPath("~/.pi-desktop/plugins-data/session-bookmarks", cwdToBucketName(cwd));
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
  const { currentCwd, currentSessionPath } = useUiStore();
  const [bookmarks, setBookmarks] = useState<BookmarkMeta[]>([]);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [forking, setForking] = useState<string | null>(null);
  const [forkError, setForkError] = useState<{ bm: BookmarkMeta; message: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BookmarkMeta | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [dialogState, setDialogState] = useState<{
    req: BookmarkRequest | null;
    label: string;
  }>({ req: null, label: "" });

  const loadBookmarks = useCallback(async () => {
    if (!currentCwd || !ctx.fs) return;
    const fs = ctx.fs;
    try {
      // 统一通道读项目级元数据;空且未迁移过则试一次性懒迁移(旧全局桶回家)
      let metas = (await ctx.config.get<BookmarkMeta[]>("bookmarks")) ?? [];
      if (metas.length === 0 && !(await ctx.config.get<boolean>("legacyMigrated"))) {
        metas = (await migrateLegacyBucket(ctx, currentCwd)) ?? [];
      }
      // exists 标记:对应 jsonl 副本是否在项目级数据目录
      const entries = await fs.listDir(bookmarkDataDir(currentCwd)).catch(() => [] as { name: string; isDir: boolean }[]);
      const files = new Set(entries.filter((e) => !e.isDir).map((e) => e.name));
      const validated = metas.map((b) => ({ ...b, exists: files.has(`${b.id}.jsonl`) }));
      setBookmarks(validated.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch {
      setBookmarks([]);
    }
  }, [ctx, currentCwd]);

  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks]);

  // 命令型事件(一次性请求)不用 replayLast——回放已消费的请求会重复弹对话框;
  // keep-alive 保证本组件始终挂载,事件到达时订阅必已就绪。
  useEffect(() => {
    const handler = (payload: unknown) => {
      setDialogState({ req: payload as BookmarkRequest, label: "" });
    };
    const off1 = ctx.events.on("timeline:bookmarkRequested", handler);
    const off2 = ctx.events.on("session-tree:bookmarkRequested", handler);
    return () => { off1(); off2(); };
  }, [ctx.events]);

  const confirmDialog = async (): Promise<void> => {
    if (!dialogState.req || !dialogState.label.trim()) return;
    const req = dialogState.req;
    const label = dialogState.label;
    setDialogState({ req: null, label: "" });
    await createBookmark(req, label);
  };

  const cancelDialog = (): void => {
    setDialogState({ req: null, label: "" });
  };

  const createBookmark = async (
    req: BookmarkRequest,
    label: string,
  ): Promise<void> => {
    if (!currentCwd || !req.sessionPath) return;
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
    await ctx.sessions.copySession(req.sessionPath, bookmarkSessionFile(currentCwd, id));
    const index = (await ctx.config.get<BookmarkMeta[]>("bookmarks")) ?? [];
    index.push(meta);
    await ctx.config.set("bookmarks", index);
    await loadBookmarks();
  };

  const forkFromBookmark = async (bm: BookmarkMeta): Promise<void> => {
    setForking(bm.id);
    setForkError(null);
    try {
      // 前置校验(纯文件读,不启动):底座 RPC fork 只接受 user 消息锚点(position:"before"
      // 校验 role);存量收藏可能是 assistant 锚点(旧版 timeline 右键不挑 role)——
      // 挡在原地给可读错误,不让底座抛英文 RPC 错
      const bmSessionPath = bookmarkSessionFile(bm.cwd, bm.id);
      const detail = await ctx.sessions.openSession(bmSessionPath);
      if (!detail) { setForkError({ bm, message: t("bookmarks.errorSessionNotFound") }); return; }
      const anchor = detail.messages.find((m) => m.id === bm.entryId);
      if (!anchor) { setForkError({ bm, message: t("bookmarks.errorEntryNotFound") }); return; }
      if (anchor.role !== "user") { setForkError({ bm, message: t("bookmarks.errorNotForkable") }); return; }
      // 原子用例(契约语义=开新会话[当前时间]+预制内容[到收藏点的分支]):
      // 中间路径生成、fork 后路径对账、中间副本清理全在框架内,插件不碰会话目录布局。
      await ctx.tree.forkFromSession(bm.cwd, bmSessionPath, bm.entryId);
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

  const deleteBookmark = async (bm: BookmarkMeta): Promise<void> => {
    const index = (await ctx.config.get<BookmarkMeta[]>("bookmarks")) ?? [];
    await ctx.config.set("bookmarks", index.filter((b) => b.id !== bm.id));
    await ctx.fs?.removePath(bookmarkSessionFile(bm.cwd, bm.id));
    await loadBookmarks();
  };

  const filtered = bookmarks.filter(
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
          filtered.map((bm) => (
            <div
              key={bm.id}
              className="group flex items-start gap-2 px-3 py-2 border-b border-[var(--color-border)] hover:bg-[var(--color-surface)] cursor-pointer"
              onClick={() => bm.exists && forking !== bm.id && deleteTarget?.id !== bm.id && void forkFromBookmark(bm)}
            >
              {deleteTarget?.id === bm.id ? (
                // 原位删除确认:项内展开替代遮罩弹窗——光标零位移,确认/取消就在点垃圾桶的位置
                <div className="flex-1 min-w-0 flex items-center gap-2 py-0.5">
                  <span className="flex-1 min-w-0 truncate text-xs text-[var(--color-accent-error)]">
                    {t("bookmarks.deleteInlineConfirm", { label: bm.label })}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(null);
                      void deleteBookmark(bm);
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
              ) : (
                <>
              <div className="flex-1 min-w-0">
                {editingId === bm.id ? (
                  <input
                    type="text"
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void renameBookmark(bm, editLabel);
                        setEditingId(null);
                      } else if (e.key === "Escape") {
                        setEditingId(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-primary)] rounded-[var(--radius-xs)] px-1 py-0.5 text-[length:var(--font-size-sm)] text-[var(--color-fg)] outline-none"
                  />
                ) : (
                  <div className={`text-[length:var(--font-size-sm)] font-medium truncate ${bm.exists ? "text-[var(--color-fg)]" : "text-[var(--color-muted)] line-through"}`}>
                    {bm.label}
                  </div>
                )}
                <div className="text-xs text-[var(--color-muted)] truncate mt-0.5">{bm.preview}</div>
                <div className="text-[10px] text-[var(--color-muted)] mt-0.5">
                  {formatRelativeTime(bm.createdAt, i18n.language)}
                </div>
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
                </>
              )}
            </div>
          ))
        )}
      </div>

      {dialogState.req && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-50" onClick={cancelDialog}>
          <div className="bg-[var(--color-surface)] rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 w-72 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="text-[length:var(--font-size-sm)] font-medium text-[var(--color-fg)] mb-2">{t("bookmarks.dialogTitle")}</div>
            <div className="text-xs text-[var(--color-muted)] mb-3 truncate">{dialogState.req.preview}</div>
            <input
              type="text"
              value={dialogState.label}
              onChange={(e) => setDialogState((s) => ({ ...s, label: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmDialog();
                if (e.key === "Escape") cancelDialog();
              }}
              placeholder={t("bookmarks.labelPlaceholder")}
              autoFocus
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[length:var(--font-size-sm)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary)]"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={cancelDialog} className="px-3 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer">
                {t("bookmarks.cancel")}
              </button>
              <button
                onClick={() => void confirmDialog()}
                disabled={!dialogState.label.trim()}
                className="px-3 py-1 text-xs rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] border-none cursor-pointer disabled:opacity-40"
              >
                {t("bookmarks.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddForm && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-50" onClick={() => setShowAddForm(false)}>
          <div className="bg-[var(--color-surface)] rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 w-80 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <AddForm
              defaultSessionPath={currentSessionPath ?? ""}
              onResolve={async (sessionPath, entryId) => {
                const detail = await ctx.sessions.openSession(sessionPath);
                if (!detail) return { error: t("bookmarks.errorSessionNotFound") };
                const msg = detail.messages.find((m) => m.id === entryId);
                if (!msg) return { error: t("bookmarks.errorEntryNotFound") };
                // 与 forkFromBookmark 同一约束:底座 fork 只接受 user 消息锚点
                if (msg.role !== "user") return { error: t("bookmarks.errorNotForkable") };
                const preview = messageContentText(msg.content).replace(/\s+/g, " ").trim().slice(0, 30) || t("bookmarks.emptyPreview");
                return { preview };
              }}
              onCancel={() => setShowAddForm(false)}
              onSubmit={async (sessionPath, entryId, label, preview) => {
                await createBookmark({ sessionPath, entryId, preview }, label);
                setShowAddForm(false);
              }}
            />
          </div>
        </div>
      )}
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

