import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Trash2, Pencil, Plus, GitBranch, Loader2, Bookmark, Check, X } from "lucide-react";
import {  usePluginContext, useUiStore, EmptyState } from "@pi-desktop/react";


interface BookmarkMeta {
  id: string;
  label: string;
  preview: string;
  createdAt: string;
  cwd: string;
  entryId: string;
  originalSessionPath: string;
  /** 运行时标记:原始会话文件是否仍存在(非持久,加载时计算)。 */
  exists?: boolean;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? p : p;
}

function joinPath(base: string, ...parts: string[]): string {
  return [base.replace(/\/$/, ""), ...parts].join("/");
}

/** 书签存储根:用户级 ~/.pi-desktop/plugins-data/session-bookmarks/<cwd-bucket>/。
 *  评估 P1-D1:此前用项目级 <cwd>/.pi-desktop/bookmarks/ 经无门控的 configFile 通道,
 *  绕过 fs:project 只读沙箱。现迁到用户级 plugins-data(在 config-file 白名单内),
 *  按 cwd 分桶保持"书签跟随项目"语义,不再写项目目录。 */
function bookmarksDir(cwd: string): string {
  const bucket = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-").replace(/^/, "--").replace(/$/, "--");
  return joinPath("~/.pi-desktop/plugins-data/session-bookmarks", bucket);
}

export function BookmarksTab({ isActive }: { isActive: boolean }): React.ReactNode {
  const ctx = usePluginContext();
  const { currentCwd, currentSessionPath } = useUiStore();
  const [bookmarkRequest, setBookmarkRequest] = useState<{ sessionPath: string; entryId: string; preview: string } | null>(null);
  const [bookmarks, setBookmarks] = useState<BookmarkMeta[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [forking, setForking] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [dialogState, setDialogState] = useState<{
    req: { sessionPath: string; entryId: string; preview: string } | null;
    label: string;
  }>({ req: null, label: "" });
  const abortRef = useRef<AbortController | null>(null);

  const loadBookmarks = useCallback(async () => {
    if (!currentCwd) return;
    const dir = bookmarksDir(currentCwd);
    try {
      const indexRaw = await ctx.configFile.get(dir + "/index.json");
      const index = (Array.isArray(indexRaw) ? indexRaw : []) as BookmarkMeta[];
      const entries = await ctx.fs!.listDir(dir).catch(() => [] as { name: string; isDir: boolean }[]);
      const dirNames = new Set(entries.filter((e) => e.isDir).map((e) => e.name));
      const validated = index.map((b) => ({
        ...b,
        exists: dirNames.has(b.id),
      }));
      for (const entry of entries.filter((e) => e.isDir && !index.find((b) => b.id === e.name))) {
        try {
          const meta = await ctx.configFile.get(`${dir}/${entry.name}/meta.json`) as unknown as BookmarkMeta | null;
          if (meta && meta.id) validated.push({ ...meta, exists: true });
        } catch {}
      }
      setBookmarks(validated.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch {
      setBookmarks([]);
    }
  }, [ctx, currentCwd]);

  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks]);

  useEffect(() => {
    const handler = (payload: unknown) => {
      const req = payload as { sessionPath: string; entryId: string; preview: string };
      setBookmarkRequest(req);
    };
    const off1 = ctx.events.on("timeline:bookmarkRequested", handler, { replayLast: true });
    const off2 = ctx.events.on("session-tree:bookmarkRequested", handler, { replayLast: true });
    return () => { off1(); off2(); };
  }, [ctx.events]);

  useEffect(() => {
    if (!bookmarkRequest) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setDialogState({ req: bookmarkRequest, label: "" });
    return () => {
      ac.abort();
    };
  }, [bookmarkRequest]);

  const confirmDialog = async (): Promise<void> => {
    if (!dialogState.req || !dialogState.label.trim()) return;
    const req = dialogState.req;
    setDialogState({ req: null, label: "" });
    setBookmarkRequest(null);
    await createBookmark({ sessionPath: req.sessionPath, entryId: req.entryId, preview: req.preview }, dialogState.label);
  };

  const cancelDialog = (): void => {
    setDialogState({ req: null, label: "" });
    setBookmarkRequest(null);
  };

  const createBookmark = async (
    req: { sessionPath: string; entryId: string; preview: string },
    label: string,
  ): Promise<void> => {
    if (!currentCwd || !req.sessionPath) return;
    const id = crypto.randomUUID();
    const dir = bookmarksDir(currentCwd);
    const targetDir = `${dir}/${id}`;
    const meta: BookmarkMeta = {
      id,
      label: label.trim(),
      preview: req.preview,
      createdAt: new Date().toISOString(),
      cwd: currentCwd,
      entryId: req.entryId,
      originalSessionPath: req.sessionPath,
    };
    await ctx.sessions.copySession(expandHome(req.sessionPath), targetDir + "/session.jsonl");
    await ctx.configFile.set(targetDir + "/meta.json", meta as unknown as Record<string, unknown>, "replace");
    const indexRaw = await ctx.configFile.get(dir + "/index.json");
    const index = (Array.isArray(indexRaw) ? indexRaw : []) as BookmarkMeta[];
    index.push(meta);
    await ctx.configFile.set(dir + "/index.json", index as unknown as Record<string, unknown>, "replace");
    await loadBookmarks();
  };

  const forkFromBookmark = async (bm: BookmarkMeta): Promise<void> => {
    setForking(bm.id);
    try {
      const newId = crypto.randomUUID();
      const bucketDir = joinPath("~/.pi/agent/sessions", bm.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-").replace(/^/, "--").replace(/$/, "--"));
      const newPath = `${bucketDir}/${newId}.jsonl`;
      const bmSessionPath = `${bookmarksDir(bm.cwd)}/${bm.id}/session.jsonl`;
      await ctx.sessions.copySession(expandHome(bmSessionPath), expandHome(newPath));
      await ctx.sessions.setContext(bm.cwd, newPath);
      await ctx.sessions.start(bm.cwd, newPath);
      await ctx.tree.fork(bm.entryId);
    } catch (err) {
      console.error("[session-bookmarks] fork failed", err);
    } finally {
      setForking(null);
    }
  };

  const renameBookmark = async (bm: BookmarkMeta, newLabel: string): Promise<void> => {
    const dir = bookmarksDir(bm.cwd);
    const meta = { ...bm, label: newLabel.trim() };
    await ctx.configFile.set(`${dir}/${bm.id}/meta.json`, meta as unknown as Record<string, unknown>, "replace");
    const indexRaw = await ctx.configFile.get(dir + "/index.json");
    const index = (Array.isArray(indexRaw) ? indexRaw : []) as BookmarkMeta[];
    const updated = index.map((b) => (b.id === bm.id ? meta : b));
    await ctx.configFile.set(dir + "/index.json", updated as unknown as Record<string, unknown>, "replace");
    await loadBookmarks();
  };

  const deleteBookmark = async (bm: BookmarkMeta): Promise<void> => {
    const dir = bookmarksDir(bm.cwd);
    const indexRaw = await ctx.configFile.get(dir + "/index.json");
    const index = (Array.isArray(indexRaw) ? indexRaw : []) as BookmarkMeta[];
    const updated = index.filter((b) => b.id !== bm.id);
    await ctx.configFile.set(dir + "/index.json", updated as unknown as Record<string, unknown>, "replace");
    await ctx.fs!.removePath(`${dir}/${bm.id}`);
    await loadBookmarks();
  };

  const filtered = bookmarks.filter(
    (b) =>
      b.label.toLowerCase().includes(search.toLowerCase()) ||
      b.preview.toLowerCase().includes(search.toLowerCase()),
  );

  if (!currentCwd) {
    return <EmptyState icon={<Bookmark className="size-8" />} title="先打开文件夹" />;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-[var(--color-border)]">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索收藏..."
          className="flex-1 bg-transparent border border-[var(--color-border)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--font-size-sm)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary)]"
        />
        <button
          onClick={() => setShowAddForm(true)}
          title="手动添加"
          className="flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] cursor-pointer bg-transparent"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {filtered.length === 0 ? (
          <div className="p-4 text-[var(--color-muted)] text-[var(--font-size-sm)] text-center">
            {search ? "无匹配收藏" : "暂无收藏。右键消息或点击 + 添加。"}
          </div>
        ) : (
          filtered.map((bm) => (
            <div
              key={bm.id}
              className="group flex items-start gap-2 px-3 py-2 border-b border-[var(--color-border)] hover:bg-[var(--color-surface)] cursor-pointer"
              onClick={() => bm.exists && forking !== bm.id && void forkFromBookmark(bm)}
            >
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
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-primary)] rounded-[var(--radius-xs)] px-1 py-0.5 text-[var(--font-size-sm)] text-[var(--color-fg)] outline-none"
                  />
                ) : (
                  <div className={`text-[var(--font-size-sm)] font-medium truncate ${bm.exists ? "text-[var(--color-fg)]" : "text-[var(--color-muted)] line-through"}`}>
                    {bm.label}
                  </div>
                )}
                <div className="text-xs text-[var(--color-muted)] truncate mt-0.5">{bm.preview}</div>
                <div className="text-[10px] text-[var(--color-muted)] mt-0.5">
                  {new Date(bm.createdAt).toLocaleDateString()} {new Date(bm.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                {forking === bm.id ? (
                  <Loader2 className="size-3.5 animate-spin text-[var(--color-muted)]" />
                ) : (
                  bm.exists && <span title="点击 fork"><GitBranch className="size-3.5 text-[var(--color-muted)]" /></span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingId(bm.id);
                    setEditLabel(bm.label);
                  }}
                  className="text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer p-0.5"
                  title="重命名"
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`确定删除收藏 "${bm.label}"？`)) void deleteBookmark(bm);
                  }}
                  className="text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer p-0.5"
                  title="删除"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {dialogState.req && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-50" onClick={cancelDialog}>
          <div className="bg-[var(--color-surface)] rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 w-72 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="text-[var(--font-size-sm)] font-medium text-[var(--color-fg)] mb-2">收藏此节点</div>
            <div className="text-xs text-[var(--color-muted)] mb-3 truncate">{dialogState.req.preview}</div>
            <input
              type="text"
              value={dialogState.label}
              onChange={(e) => setDialogState((s) => ({ ...s, label: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmDialog();
                if (e.key === "Escape") cancelDialog();
              }}
              placeholder="收藏名称"
              autoFocus
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--font-size-sm)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary)]"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={cancelDialog} className="px-3 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer">
                取消
              </button>
              <button
                onClick={() => void confirmDialog()}
                disabled={!dialogState.label.trim()}
                className="px-3 py-1 text-xs rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] border-none cursor-pointer disabled:opacity-40"
              >
                确定
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
              onCancel={() => setShowAddForm(false)}
              onSubmit={async (sessionPath, entryId, label) => {
                await createBookmark({ sessionPath, entryId, preview: "" }, label);
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
  onCancel,
  onSubmit,
}: {
  defaultSessionPath: string;
  onCancel: () => void;
  onSubmit: (sessionPath: string, entryId: string, label: string) => Promise<void>;
}): React.ReactNode {
  const [sessionPath, setSessionPath] = useState(defaultSessionPath);
  const [entryId, setEntryId] = useState("");
  const [label, setLabel] = useState("");
  return (
    <>
      <div className="text-[var(--font-size-sm)] font-medium text-[var(--color-fg)] mb-3">手动添加收藏</div>
      <div className="space-y-2">
        <input
          type="text"
          value={sessionPath}
          onChange={(e) => setSessionPath(e.target.value)}
          placeholder="会话文件路径"
          className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-2 py-1.5 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary)]"
        />
        <input
          type="text"
          value={entryId}
          onChange={(e) => setEntryId(e.target.value)}
          placeholder="entryId"
          className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-2 py-1.5 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary)]"
        />
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="收藏名称"
          className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-2 py-1.5 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-muted)] outline-none focus:border-[var(--color-primary)]"
          autoFocus
        />
      </div>
      <div className="flex justify-end gap-2 mt-3">
        <button onClick={onCancel} className="px-3 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer">
          取消
        </button>
        <button
          onClick={() => void onSubmit(sessionPath, entryId, label)}
          disabled={!sessionPath.trim() || !entryId.trim() || !label.trim()}
          className="px-3 py-1 text-xs rounded-[var(--radius-sm)] bg-[var(--color-primary)] text-[var(--color-bg)] border-none cursor-pointer disabled:opacity-40"
        >
          添加
        </button>
      </div>
    </>
  );
}

