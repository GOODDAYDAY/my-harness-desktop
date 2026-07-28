// sessions-list 插件 renderer —— 左栏"会话"分组:会话列表 + 搜索 + 新建。
//
// 数据:ctx.sessions.list(currentCwd)(核心会话能力,无需权限声明)。
// 交互:点选 = switchSession + 面包屑标题 + nonce 触发 timeline 重 resync;
// "+" = newSession(直接开,不弹确认)。
// 分组:已置顶(恒在最上,带 Pin)> 时间四档(今天/昨天/过去7天/更早,各可折叠)
//       > 已归档(默认折叠,带 Archive)。pinned/archived 写 JSONL 头行,updateHeader 一处写。
import { useEffect, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Plus, Search, FileJson, Pencil, Pin, PinOff, Archive, ArchiveRestore, MessageSquare, X, RotateCw } from "lucide-react";
import { registerSidebarComponent, usePluginContext, useUiStore, useSessionStore, Section, type SessionInfo } from "@pi-desktop/react";

const PLUGIN_ID = "sessions-list";
registerSidebarComponent("SessionsSection", SessionsSection);

/** 头行可选字段补丁(与 updateHeader 契约一致)。 */
type HeaderPatch = { name?: string; pinned?: boolean; archived?: boolean };

/** 渲染分组:pinned(已置顶)/ time(时间档)/ archive(已归档)。 */
type GroupKind = "pinned" | "time" | "archive";
interface Group {
  label: string;
  items: SessionInfo[];
  kind: GroupKind;
  /** 默认是否展开;已归档默认收起 */
  defaultOpen?: boolean;
}

function SessionsSection(): React.ReactNode {
  const ctx = usePluginContext(PLUGIN_ID);
  const { t } = useTranslation();
  const {
    currentCwd, currentSessionPath, sessionNonce,
    setCurrentSessionPath, setSessionTitle,
  } = useUiStore();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const reload = async (): Promise<void> => {
    if (!currentCwd) return;
    const list = await ctx.sessions.list(currentCwd);
    setSessions(list);
  };

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  };

  // 列表初始加载 + 切会话时刷新(currentSessionPath 变化 → 重拉列表,保证切回来是最新的)
  useEffect(() => {
    if (!currentCwd) { setSessions([]); return; }
    setLoading(true);
    void ctx.sessions.list(currentCwd)
      .then(setSessions)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd, sessionNonce, currentSessionPath]);

  // 列表刷新:sessionStart(pi 建新文件)+ messageEnd(消息定稿)+ agentSettled(整轮完)后重扫。
  // 三个事件覆盖新会话从创建到回复完成的全生命周期,不管用户在哪个时机切走都能刷新。
  useEffect(() => {
    return ctx.sessions.onEvent((event) => {
      if (!currentCwd) return;
      if (event.type === "sessionStart" || event.type === "agentSettled" || event.type === "messageEnd") {
        void ctx.sessions.list(currentCwd).then(setSessions);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd]);

  const newSession = async (): Promise<void> => {
    setCurrentSessionPath(null);
    setSessionTitle(null);
    await useSessionStore.getState().startNewChat(currentCwd);
  };

  const select = async (s: SessionInfo): Promise<void> => {
    try {
      setCurrentSessionPath(s.path);
      setSessionTitle(s.name ?? new Date(s.created).toLocaleString());
      await useSessionStore.getState().openSession(s.path);
    } catch (err) {
      console.error("[sessions-list] 打开会话失败:", err);
    }
  };

  /** 批量归档:对一组会话逐个写头行 archived:true(各文件各自锁,并行)。 */
  const archiveAll = async (items: SessionInfo[]): Promise<void> => {
    await Promise.all(items.map((s) => ctx.sessions.updateHeader(s.path, { archived: true })));
    void reload();
  };

  const filtered = query
    ? sessions.filter((s) => (s.name ?? "").includes(query) || s.created.includes(query))
    : sessions;

  // 搜索时平铺(归档项带 Archive 角标,仍可搜到);非搜索走分组
  const groups = query
    ? [{ label: "", items: filtered, kind: "time" as GroupKind, defaultOpen: true }]
    : buildGroups(filtered);

  return (
    <Section
      title={t("sessions.title")}
      actions={
        // 标题行右侧只剩两个图标按钮(都 shrink-0,左栏再窄也不挤掉):
        // 搜索图标(点击动画展开下方输入框)+ 新会话加号。
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => { setSearchOpen((v) => !v); }}
            title={t("sessions.search")}
            aria-label={t("sessions.search")}
            className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            style={searchOpen ? { color: "var(--color-primary)" } : undefined}
          >
            <Search className="size-4" />
          </button>
          {/* 刷新:手动重扫会话列表(修新会话切走后列表未刷新/找不回的 bug) */}
          <button
            onClick={() => void refresh()}
            disabled={refreshing}
            title={t("sessions.refresh")}
            aria-label={t("sessions.refresh")}
            className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:cursor-default"
          >
            <RotateCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          <button onClick={() => void newSession()} title={t("sessions.new")} style={plusBtnStyle} className="shrink-0 hover:text-[var(--color-fg)]">
            <Plus className="size-4" />
          </button>
        </div>
      }
    >
      {/* 搜索展开框:点搜索图标 toggle,动画展开/收起;挂在标题行下方、列表之上。
          空查询时失焦或 Esc 自动收起;有内容时保持,清空即收。 */}
      <AnimatePresence>
        {searchOpen && (
          <motion.div
            key="search-box"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-1.5 px-2 pb-2 pt-1">
              <Search className="size-3.5 shrink-0 text-[var(--color-muted)]" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { if (query) setQuery(""); else setSearchOpen(false); } }}
                placeholder={t("sessions.search")}
                className="w-full bg-transparent border-none outline-none text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-muted)]"
              />
              {query && (
                <button
                  onClick={() => { setQuery(""); }}
                  title={t("sessions.search")}
                  className="shrink-0 text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer p-0"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {loading && <div className="px-2.5 py-2 text-[14px] text-[var(--color-muted)]">{t("sessions.loading")}</div>}
      {!loading && !currentCwd && (
        <div className="px-2.5 py-2 text-[14px] text-[var(--color-muted)]">{t("sessions.openFolderFirst")}</div>
      )}
      {!loading && currentCwd && filtered.length === 0 && (
        <div className="px-2.5 py-2 text-[14px] text-[var(--color-muted)]">{query ? t("sessions.noMatch") : t("sessions.empty")}</div>
      )}
      {groups.map((g) => (
        <GroupBlock
          key={g.kind + g.label}
          group={g}
          onArchiveAll={
            g.kind === "time"
              ? () => void archiveAll(g.items)
              : undefined
          }
        >
          {g.items.map((s) => (
            <motion.div
              key={s.id}
              layout
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              // 行间留 6px:放包裹层而非改 SessionRow 自身 py(后者撑圆角选中块,动它影响视觉)
              className=""
              style={{ paddingBottom: "6px" }}
            >
              <SessionRow
                session={s}
                flat={!!query}
                active={currentSessionPath === s.path}
                onClick={() => void select(s)}
                onOpenRaw={() => void ctx.dialog.openFile(s.path)}
                onUpdate={async (patch) => {
                  await ctx.sessions.updateHeader(s.path, patch);
                  if (patch.name != null && currentSessionPath === s.path) {
                    setSessionTitle(patch.name || s.id.slice(0, 8));
                  }
                  void reload();
                }}
              />
            </motion.div>
          ))}
        </GroupBlock>
      ))}
    </Section>
  );
}

/** 分组:pinned 在最上 → 时间四档 → archive 在最下(归档不进时间分组)。
 *  label 存 i18n key(GroupBlock 渲染时 t(label)),buildGroups 是纯数据不依赖 t。 */
function buildGroups(items: SessionInfo[]): Group[] {
  const pinned = items.filter((s) => s.pinned && !s.archived);
  const archived = items.filter((s) => s.archived);
  const rest = items.filter((s) => !s.pinned && !s.archived);
  const byTime = groupByTime(rest);
  const groups: Group[] = [];
  if (pinned.length) groups.push({ label: "sessions.pinned", items: pinned, kind: "pinned", defaultOpen: true });
  for (const g of byTime) groups.push({ label: g.label, items: g.items, kind: "time", defaultOpen: true });
  if (archived.length) groups.push({ label: "sessions.archived", items: archived, kind: "archive", defaultOpen: false });
  return groups;
}

/** 按创建时间分组:今天 / 昨天 / 过去 7 天 / 更早(各组内保持 mtime 降序)。label 存 i18n key。 */
function groupByTime(items: SessionInfo[]): { label: string; items: SessionInfo[] }[] {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const today = dayStart.getTime();
  const yesterday = today - 86400000;
  const week = today - 7 * 86400000;
  const buckets: { label: string; items: SessionInfo[]; min: number }[] = [
    { label: "sessions.today", items: [], min: today },
    { label: "sessions.yesterday", items: [], min: yesterday },
    { label: "sessions.last7days", items: [], min: week },
    { label: "sessions.earlier", items: [], min: -Infinity },
  ];
  for (const s of items) {
    const t = new Date(s.created).getTime();
    buckets.find((b) => t >= b.min)?.items.push(s);
  }
  return buckets.filter((b) => b.items.length > 0);
}

/** 分组容器:有 label 才画折叠头(搜索平铺时 kind=time 但 label 为空 → 不画头)。
 *  复用 index.css 的 .pi-collapsible 动画(与 Section 同一套)。
 *  time 分组折叠头右侧带"批量归档"(hover 显示),把整组会话标 archived。 */
function GroupBlock({ group, children, onArchiveAll }: {
  group: Group;
  children: React.ReactNode;
  onArchiveAll?: () => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(group.defaultOpen ?? true);
  const [hovered, setHovered] = useState(false);
  if (!group.label) return <div className="flex flex-col"><AnimatePresence mode="popLayout">{children}</AnimatePresence></div>;
  return (
    <div className="flex flex-col">
      <div
        className="flex items-center gap-1 px-2.5"
        style={{ paddingTop: "10px", paddingBottom: "14px" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <button
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer text-left"
          style={{ outline: "none" }}
        >
          {group.kind === "pinned" && <Pin className="size-3" />}
          {group.kind === "archive" && <Archive className="size-3" />}
          <span>{t(group.label)}</span>
        </button>
        {/* 批量归档:仅 time 分组有(已置顶/已归档组不画);hover 分组头才现 */}
        {group.kind === "time" && onArchiveAll && (
          <button
            onClick={(e) => { e.stopPropagation(); onArchiveAll(); }}
            title={t("sessions.archiveAllTitle")}
            className="ml-auto flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer px-1.5 py-0.5 rounded-[var(--radius-sm)]"
            style={{
              outline: "none",
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.15s ease",
            }}
          >
            <Archive className="size-3" /> {t("sessions.archiveAll")}
          </button>
        )}
      </div>
      <div className="pi-collapsible" data-state={open ? "open" : "closed"}>
        <div className="flex flex-col">
          <AnimatePresence mode="popLayout">{children}</AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function SessionRow({ session, flat, active, onClick, onOpenRaw, onUpdate }: {
  session: SessionInfo;
  /** 搜索平铺模式:归档项画 Archive 角标。 */
  flat: boolean;
  active: boolean;
  onClick: () => void;
  onOpenRaw: () => void;
  onUpdate: (patch: HeaderPatch) => Promise<void>;
}): React.ReactNode {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  // 标题:name ?? id 前 8 位(整串 UUID 太吵);副标题:最后一条消息预览 ?? 创建时间
  const title = session.name ?? session.id.slice(0, 8);
  const sub = session.lastMessage ?? new Date(session.created).toLocaleString();

  if (editing) {
    return (
      <div className="px-2.5 py-2.5">
        <input
          autoFocus
          defaultValue={session.name ?? ""}
          placeholder={session.id.slice(0, 8)}
          onKeyDown={async (e) => {
            if (e.key === "Enter") {
              const v = (e.target as HTMLInputElement).value.trim();
              setEditing(false);
              if (v !== (session.name ?? "")) await onUpdate({ name: v });
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
          onBlur={() => setEditing(false)}
          className="w-full px-2 py-1 text-[14px] rounded-[var(--radius-sm)] border border-[var(--color-primary)] bg-[var(--color-bg)] text-[var(--color-fg)] outline-none"
        />
      </div>
    );
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          onClick={onClick}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="flex items-center gap-2 px-2.5 py-2.5 rounded-[var(--radius-md)] cursor-pointer select-none whitespace-nowrap"
          style={{
            background: active || hovered ? "var(--color-surface)" : "transparent",
            color: active ? "var(--color-fg)" : "var(--color-muted)",
          }}
        >
          {/* 前导图标:置顶走 Pin(primary),非置顶补 MessageSquare(muted)——
              起点不再随置顶态跳,图标始终在,垂直居中于两行文本块。 */}
          {session.pinned
            ? <Pin className="size-3.5 shrink-0 mt-0.5 text-[var(--color-primary)]" />
            : <MessageSquare className="size-3.5 shrink-0 mt-0.5 text-[var(--color-muted)]" />}
          <div className="flex-1 min-w-0">
            <div className="truncate text-[length:var(--font-size-lg)] font-semibold leading-tight text-[var(--color-fg)]">{title}</div>
            <div className="truncate text-[length:var(--font-size-sm)] leading-tight text-[var(--color-muted)] mt-0.5">{sub}</div>
          </div>
          {/* 搜索平铺时,归档项给个 Archive 角标提示 */}
          {flat && session.archived && (
            <Archive className="size-3.5 shrink-0 text-[var(--color-muted)]" title="已归档" />
          )}
          {/* hover 操作区:置顶/归档/打开原始文件(hover 才现,stopPropagation 不点穿行选中) */}
          {hovered && (
            <div className="flex items-center gap-1 shrink-0 flex-nowrap">
              <button
                onClick={(e) => { e.stopPropagation(); void onUpdate({ pinned: !session.pinned }); }}
                title={session.pinned ? t("sessions.unpin") : t("sessions.pin")}
                className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                style={session.pinned ? { color: "var(--color-primary)" } : undefined}
              >
                {session.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); void onUpdate({ archived: !session.archived }); }}
                title={session.archived ? t("sessions.unarchive") : t("sessions.archive")}
                className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                style={session.archived ? { color: "var(--color-primary)" } : undefined}
              >
                {session.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onOpenRaw(); }}
                title={t("sessions.openRaw")}
                className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]"
              >
                <FileJson className="size-4" />
              </button>
            </div>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content style={ctxMenuStyle}>
          <ContextMenu.Item onSelect={() => setEditing(true)} style={ctxItemStyle}>
            <Pencil className="size-3.5" /> {t("sessions.rename")}
          </ContextMenu.Item>
          <ContextMenu.Item
            onSelect={() => void onUpdate({ pinned: !session.pinned })}
            style={ctxItemStyle}
          >
            <Pin className="size-3.5" /> {session.pinned ? t("sessions.unpin") : t("sessions.pin")}
          </ContextMenu.Item>
          <ContextMenu.Item
            onSelect={() => void onUpdate({ archived: !session.archived })}
            style={ctxItemStyle}
          >
            <Archive className="size-3.5" /> {session.archived ? t("sessions.unarchive") : t("sessions.archive")}
          </ContextMenu.Item>
          <ContextMenu.Item onSelect={onOpenRaw} style={ctxItemStyle}>
            <FileJson className="size-3.5" /> {t("sessions.openRaw")}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

const ctxMenuStyle: React.CSSProperties = {
  minWidth: "140px",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  boxShadow: "var(--shadow-md)",
  padding: "4px",
  zIndex: 99999,
};

const ctxItemStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "8px",
  padding: "6px 10px", borderRadius: "var(--radius-sm)",
  fontSize: "13px", color: "var(--color-fg)",
  fontFamily: "var(--font-family-sans)",
  cursor: "pointer", outline: "none",
};

const plusBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "22px", height: "22px", border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)", cursor: "pointer",
};
