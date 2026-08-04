// sessions-list 插件 renderer —— 左栏"会话"分组:会话列表 + 搜索 + 新建。
//
// 数据:ctx.sessions.list(currentCwd)(核心会话能力,无需权限声明)。
// 交互:点选 = switchSession + 面包屑标题 + nonce 触发 timeline 重 resync;
// "+" = newSession(直接开,不弹确认)。
// 分组:已置顶(恒在最上,带 Pin)> 时间四档(今天/昨天/过去7天/更早,各可折叠)
//       > 已归档(默认折叠,带 Archive)。pinned/archived 写 JSONL 头行,updateHeader 一处写。
// 状态标识:执行中(onKernelEvent 按 sessionKey 维护 busyMap,messageStart→agentSettled,
// 含后台会话)> 未读(readState 存插件 config,活跃会话自动跟随已读,非活跃有新 entry 亮圆点)。
import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import * as React from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { motion, AnimatePresence, Reorder, useDragControls } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Plus, Search, FileJson, Pencil, Pin, PinOff, Archive, ArchiveRestore, MessageSquare, LoaderCircle, X, RotateCw, Check, Trash2, ChevronRight, ChevronDown } from "lucide-react";
import { usePluginContext, useUiStore, useSessionStore, useSessionGroupings, Section, type SessionInfo } from "@pi-desktop/react";
import { deriveSessionTitle } from "@pi-desktop/contract";


/** 头行可选字段补丁(与 updateHeader 契约一致)。 */
type HeaderPatch = { name?: string; pinned?: boolean; archived?: boolean };

/** 渲染分组:pinned(已置顶)/ time(时间档)/ archive(已归档)。 */
type GroupKind = "pinned" | "time" | "archive";
interface Group {
  /** 稳定分组 id,持久化 customOrder 的 key:pinned / today / yesterday / last7days / earlier / archived。 */
  groupId: string;
  label: string;
  items: SessionInfo[];
  kind: GroupKind;
  defaultOpen?: boolean;
}

interface ChildSession {
  session: SessionInfo;
  parentPath: string;
}

export function SessionsSection(): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const {
    currentCwd, currentSessionPath, sessionNonce,
    setCurrentSessionPath, setSessionTitle,
  } = useUiStore();
  const streaming = useSessionStore((s) => s.streaming);
  const piAlive = useSessionStore((s) => s.snapshot !== null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshState, setRefreshState] = useState<"idle" | "refreshing" | "refreshed">("idle");
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 执行中会话集合:sessionKey(=会话文件路径)→ true。运维流事件驱动,含后台会话;
  // 活跃会话的流式另有全局 streaming 标识,两者在渲染层合并(谁亮都算执行中)。
  const [busyByPath, setBusyByPath] = useState<Record<string, true>>({});
  // 已读位标:sessionPath → 最后一条已读 entry 的 id。存插件 config(plugins-data 私有区,
  // 官方指引的插件私有数据落点);ref 保最新值,防连续 markRead 闭包旧值互相覆盖。
  const [readState, setReadState] = useState<Record<string, string>>({});
  const readStateRef = useRef<Record<string, string>>({});
  // 位标未从盘上读回前禁止推进:markRead 整对象写回,基于空 ref 写会冲掉盘上其他会话的 key。
  const readLoadedRef = useRef(false);
  // 用户拖拽出的组内自定义序:groupId → path 数组(完整可见顺序)。存插件 config,
  // 与 readState 同落点同机制——reload 拉回后 applyCustomOrder 纯函数重建,不丢。
  const [customOrder, setCustomOrder] = useState<Record<string, string[]>>({});
  const customOrderRef = useRef<Record<string, string[]>>({});
  const customOrderLoadedRef = useRef(false);

  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  // 挂载时加载已读位标;加载前 readState={} 天然不亮未读(无位标=从未读过,不误报)。
  // 加载完成后补一次 reload:此间被闸门的已读跟随(活跃会话位标推进)借此齐平。
  useEffect(() => {
    void Promise.all([
      ctx.config.get<Record<string, string>>("readState"),
      ctx.config.get<Record<string, string[]>>("customOrder"),
    ]).then(([rs, co]) => {
      const v = rs ?? {};
      readStateRef.current = v;
      setReadState(v);
      readLoadedRef.current = true;
      const co_v = co ?? {};
      customOrderRef.current = co_v;
      setCustomOrder(co_v);
      customOrderLoadedRef.current = true;
      void reload();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 已读位标推进到指定 entry;无变化不写盘。fire-and-forget(config.set 有写队列串行化)。 */
  const markRead = (path: string, entryId: string): void => {
    if (!readLoadedRef.current) return;
    const cur = readStateRef.current;
    if (cur[path] === entryId) return;
    const next = { ...cur, [path]: entryId };
    readStateRef.current = next;
    setReadState(next);
    void ctx.config.set("readState", next);
  };

  const setBusy = (path: string, busy: boolean): void => {
    setBusyByPath((prev) => {
      if (busy) return prev[path] ? prev : { ...prev, [path]: true };
      if (!prev[path]) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
  };

  const syncTitleFromList = (list: SessionInfo[]): void => {
    const activePath = useUiStore.getState().currentSessionPath;
    if (!activePath) return;
    const active = list.find((s) => s.path === activePath);
    if (active) useUiStore.getState().setSessionTitle(deriveSessionTitle(active));
  };

  /** 列表落盘后的统一处理:标题水合 + 活跃会话已读跟随。
   *  "打开着=已读"语义:覆盖点开会话(currentSessionPath 变化触发重拉)与活跃会话
   *  新消息定稿(事件触发 reload)两个时机,单一写入口。 */
  const applyList = (list: SessionInfo[]): void => {
    setSessions(list);
    syncTitleFromList(list);
    const activePath = useUiStore.getState().currentSessionPath;
    const active = activePath ? list.find((s) => s.path === activePath) : undefined;
    if (active?.lastEntryId) markRead(active.path, active.lastEntryId);
  };

  const reload = async (): Promise<void> => {
    if (!currentCwd) return;
    applyList(await ctx.sessions.list(currentCwd));
  };

  const refresh = async (): Promise<void> => {
    if (refreshState !== "idle") return;
    setRefreshState("refreshing");
    try {
      await Promise.all([
        reload(),
        new Promise((r) => setTimeout(r, 400)),
      ]);
      setRefreshState("refreshed");
      refreshTimer.current = setTimeout(() => setRefreshState("idle"), 800);
    } catch {
      setRefreshState("idle");
    }
  };

  // 列表初始加载 + 切会话时刷新(currentSessionPath 变化 → 重拉列表,保证切回来是最新的)
  useEffect(() => {
    if (!currentCwd) { setSessions([]); return; }
    setLoading(true);
    void ctx.sessions.list(currentCwd)
      .then((list) => applyList(list))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd, sessionNonce, currentSessionPath]);

  // 列表刷新走运维流(onKernelEvent):全量会话、带 sessionKey 归属——任何会话(后台含)
  // 的 sessionStart(新文件)/messageStart(自动命名落 session_info)/messageEnd(定稿)/
  // agentSettled 都可能改变本目录列表。不能用 sessions.onEvent:那只含激活会话(视图流)。
  // 同一订阅顺手维护 busyMap:messageStart 置忙、agentSettled 清忙,processExit/rpcError
  // 兜底清忙(崩溃/超时后不留卡死的执行中标识)。
  useEffect(() => {
    return ctx.sessions.onKernelEvent((event) => {
      if (event.kind === "processExit" || event.kind === "rpcError") {
        setBusy(event.sessionKey, false);
        return;
      }
      if (event.kind !== "session") return;
      const t = event.event.type;
      if (t === "messageStart") setBusy(event.sessionKey, true);
      else if (t === "agentSettled") setBusy(event.sessionKey, false);
      if (!currentCwd) return;
      if (t === "sessionStart" || t === "messageStart" || t === "agentSettled" || t === "messageEnd") {
        void reload();
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
    // 乐观设置(勿删,防「高亮等 IPC」退化成体验挂/竞态):点击瞬间同步写 currentSessionPath
    // 拿到即时高亮;main 侧 SessionStore.setContext 会随后 dispatch synthetic sessionStart
    // 权威水合同一字段([见 src/application/sessions/session-store.ts activate 注释])。
    // 乐观层管点击瞬间高亮即时性(async IPC 事件有毫秒级差,不能等);
    // 权威层管最终一致性(main 真相源推 synthetic sessionStart,见 src/application/sessions/
    // session-store.ts / packages/react/src/session-store.ts sendText 注释)。勿删本行。
    // 先记旧值:openSession 失败时回滚选中态,不留“指向打不开会话”的残局
    const { currentSessionPath: prevPath, sessionTitle: prevTitle } = useUiStore.getState();
    try {
      setCurrentSessionPath(s.path);
      setSessionTitle(deriveSessionTitle(s));
      await useSessionStore.getState().openSession(s.path);
    } catch (err) {
      console.error("[sessions-list] 打开会话失败:", err);
      setCurrentSessionPath(prevPath);
      setSessionTitle(prevTitle);
    }
  };

  /** 批量归档:对一组会话逐个写头行 archived:true(同一目录锁在 withDirLock 里排队串行)。
      失败也照常 reload——已写成功的部分要立刻在 UI 可见,错误进 console。 */
  const archiveAll = async (items: SessionInfo[]): Promise<void> => {
    try {
      await Promise.all(items.map((s) => ctx.sessions.updateHeader(s.path, { archived: true })));
    } catch (err) {
      console.error("[sessions-list] 批量归档失败:", err);
    } finally {
      void reload();
    }
  };

  /** 删除单个会话(真删 JSONL,不可恢复);错误进 console,删后 reload 立即反映。 */
  const deleteOne = async (s: SessionInfo): Promise<void> => {
    try {
      await ctx.sessions.deleteSessions([s.path]);
    } catch (err) {
      console.error("[sessions-list] 删除会话失败:", err);
    } finally {
      void reload();
    }
  };

  /** 一键删除整组(真删 JSONL,不可恢复):剔除当前活跃会话(进程 append 会复活文件)。 */
  const deleteAll = async (items: SessionInfo[]): Promise<void> => {
    const targets = items.map((s) => s.path).filter((p) => p !== currentSessionPath);
    if (targets.length === 0) return;
    try {
      await ctx.sessions.deleteSessions(targets);
    } catch (err) {
      console.error("[sessions-list] 批量删除失败:", err);
    } finally {
      void reload();
    }
  };

  const filtered = query
    ? sessions.filter((s) => (s.name ?? "").includes(query) || s.created.includes(query))
    : sessions;

  const groupings = useSessionGroupings();

  const { topLevel, childrenByParent } = useMemo(() => {
    const children: ChildSession[] = [];
    const childPaths = new Set<string>();
    for (const s of filtered) {
      if (!s.custom) continue;
      for (const g of groupings) {
        const parentPath = s.custom[g.parentPathKey];
        if (typeof parentPath === "string" && parentPath) {
          children.push({ session: s, parentPath });
          childPaths.add(s.path);
          break;
        }
      }
    }
    const childrenMap = new Map<string, ChildSession[]>();
    for (const c of children) {
      const list = childrenMap.get(c.parentPath) ?? [];
      list.push(c);
      childrenMap.set(c.parentPath, list);
    }
    return {
      topLevel: filtered.filter((s) => !childPaths.has(s.path)),
      childrenByParent: childrenMap,
    };
  }, [filtered, groupings]);

  // 排序修正:scanner 返回的是 modified 降序,组内按 created 降序保底(创建时间恒定,不跳)。
  // 拖拽出的 customOrder 在 GroupBlock 渲染时再 applyCustomOrder 重排,这里只动默认序。
  const topLevelSorted = useMemo(
    () => [...topLevel].sort((a, b) => b.created.localeCompare(a.created)),
    [topLevel],
  );

  const groups = query
    ? [{ groupId: "search", label: "", items: filtered, kind: "time" as GroupKind, defaultOpen: true }]
    : buildGroups(topLevelSorted);

  const setGroupOrder = useCallback((groupId: string, paths: string[]): void => {
    const next = { ...customOrderRef.current, [groupId]: paths };
    customOrderRef.current = next;
    setCustomOrder(next);
  }, []);
  const persistOrder = useCallback((): void => {
    void ctx.config.set("customOrder", customOrderRef.current);
  }, [ctx]);

  return (
    <Section
      title={t("sessions.title")}
      actions={
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => { setSearchOpen((v) => !v); }}
            title={t("sessions.search")}
            aria-label={t("sessions.search")}
            className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            style={searchOpen ? { color: "var(--color-primary)" } : undefined}
          >
            <Search style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />
          </button>
          <button
            onClick={() => void refresh()}
            disabled={refreshState !== "idle"}
            title={t("sessions.refresh")}
            aria-label={t("sessions.refresh")}
            className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:cursor-default"
          >
            {refreshState === "refreshed" ? (
              <Check className="size-3.5" style={{ color: "var(--color-accent-success)" }} />
            ) : (
              <RotateCw className={`size-3.5 ${refreshState === "refreshing" ? "animate-spin" : ""}`} style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />
            )}
          </button>
          <button onClick={() => void newSession()} title={t("sessions.new")} style={plusBtnStyle} className="shrink-0 hover:text-[var(--color-fg)]">
            <Plus style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />
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
                className="w-full bg-transparent border-none outline-none text-[length:var(--font-size-base)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)]"
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
      {loading && <div className="px-2.5 py-2 text-[length:var(--font-size-base)] text-[var(--color-muted)]">{t("sessions.loading")}</div>}
      {!loading && !currentCwd && (
        <div className="px-2.5 py-2 text-[length:var(--font-size-base)] text-[var(--color-muted)]">{t("sessions.openFolderFirst")}</div>
      )}
      {!loading && currentCwd && filtered.length === 0 && (
        <div className="px-2.5 py-2 text-[length:var(--font-size-base)] text-[var(--color-muted)]">{query ? t("sessions.noMatch") : t("sessions.empty")}</div>
      )}
      <AnimatePresence mode="popLayout">
      {groups.map((g) => {
        const orderedItems = applyCustomOrder(g.items, customOrder[g.groupId]);
        return (
        <GroupBlock
          key={g.kind + g.label}
          group={g}
          orderedItems={orderedItems}
          onReorder={(paths) => setGroupOrder(g.groupId, paths)}
          onArchiveAll={
            g.kind === "time"
              ? () => void archiveAll(g.items)
              : undefined
          }
          onDeleteAll={
            g.kind === "archive"
              ? () => void deleteAll(g.items)
              : undefined
          }
        >
          {orderedItems.map((s) => (
            <SortableRow key={s.path} path={s.path} dragEnabled={!query && g.kind !== "archive"} onDragEnd={persistOrder}>
              <SessionRow
                session={s}
                flat={!!query}
                active={currentSessionPath === s.path}
                piAlive={piAlive && currentSessionPath === s.path}
                executing={(streaming && currentSessionPath === s.path) || !!busyByPath[s.path]}
                unread={
                  currentSessionPath !== s.path &&
                  !!s.lastEntryId &&
                  readState[s.path] != null &&
                  readState[s.path] !== s.lastEntryId
                }
                deletable={currentSessionPath !== s.path}
                onDelete={() => deleteOne(s)}
                onClick={() => void select(s)}
                onOpenRaw={() => void ctx.dialog.openFile(s.path)}
                onUpdate={async (patch) => {
                  await ctx.sessions.updateHeader(s.path, patch);
                  if (patch.name != null && currentSessionPath === s.path) {
                    setSessionTitle(deriveSessionTitle({ ...s, name: patch.name }));
                  }
                  void reload();
                }}
                children={childrenByParent.get(s.path)}
                onSelectChild={(child) => void select(child)}
                activeChildPath={currentSessionPath ?? undefined}
                busyByPath={busyByPath}
              />
            </SortableRow>
          ))}
        </GroupBlock>
        );
      })}
      </AnimatePresence>
    </Section>
  );
}

function SortableRow({ path, dragEnabled, onDragEnd, children }: { path: string; dragEnabled: boolean; onDragEnd?: () => void; children: React.ReactElement }): React.ReactNode {
  const controls = useDragControls();
  const { t } = useTranslation();
  return (
    <Reorder.Item
      as="div"
      value={path}
      dragListener={false}
      dragControls={controls}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      onPointerDown={(e) => {
        if (!dragEnabled) return;
        if ((e.target as HTMLElement).closest("input,textarea,button,[contenteditable]")) return;
        controls.start(e);
      }}
      onDragEnd={() => onDragEnd?.()}
      whileDrag={dragEnabled ? {
        scale: 1.02,
        zIndex: 10,
        boxShadow: "var(--shadow-md)",
        background: "var(--color-surface)",
        color: "var(--color-surface-fg)",
        borderRadius: "var(--radius-sm)",
      } : undefined}
      title={dragEnabled ? String(t("sessions.dragToReorder")) : undefined}
      style={{ paddingBottom: "var(--sidebar-row-gap)", position: "relative", cursor: dragEnabled ? "grab" : undefined, listStyle: "none" }}
    >
      {children}
    </Reorder.Item>
  );
}

/** 组内归位:不在自定义数组里的按 created 降序在前(新会话置顶),自定义数组按记录顺序过滤掉
 *  已不在组里的路径后接在后。纯函数——reload 拉回列表 + config 后重新跑一遍得到同一结果。 */
function applyCustomOrder(items: SessionInfo[], order: string[] | undefined): SessionInfo[] {
  if (!order || order.length === 0) return items;
  const orderSet = new Set(order);
  const inOrder: SessionInfo[] = [];
  const rest: SessionInfo[] = [];
  for (const s of items) (orderSet.has(s.path) ? inOrder : rest).push(s);
  rest.sort((a, b) => b.created.localeCompare(a.created));
  const ordered = order
    .map((p) => inOrder.find((s) => s.path === p))
    .filter((s): s is SessionInfo => s !== undefined);
  return [...rest, ...ordered];
}

/** 分组:pinned 在最上 → 时间四档 → archive 在最下(归档不进时间分组)。
 *  label 存 i18n key(GroupBlock 渲染时 t(label)),buildGroups 是纯数据不依赖 t。
 *  groupId 是持久化 customOrder 的稳定 key(label→groupId 映射后写进 Group)。 */
const LABEL_TO_GROUP_ID: Record<string, string> = {
  "sessions.pinned": "pinned",
  "sessions.today": "today",
  "sessions.yesterday": "yesterday",
  "sessions.last7days": "last7days",
  "sessions.earlier": "earlier",
  "sessions.archived": "archived",
};
function buildGroups(items: SessionInfo[]): Group[] {
  const pinned = items.filter((s) => s.pinned && !s.archived);
  const archived = items.filter((s) => s.archived);
  const rest = items.filter((s) => !s.pinned && !s.archived);
  const byTime = groupByTime(rest);
  const groups: Group[] = [];
  if (pinned.length) groups.push({ groupId: "pinned", label: "sessions.pinned", items: pinned, kind: "pinned", defaultOpen: true });
  for (const g of byTime) groups.push({ groupId: LABEL_TO_GROUP_ID[g.label] ?? g.label, label: g.label, items: g.items, kind: "time", defaultOpen: true });
  if (archived.length) groups.push({ groupId: "archived", label: "sessions.archived", items: archived, kind: "archive", defaultOpen: false });
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
function GroupBlock({ group, orderedItems, onReorder, children, onArchiveAll, onDeleteAll }: {
  group: Group;
  orderedItems: SessionInfo[];
  onReorder: (paths: string[]) => void;
  children: React.ReactNode;
  onArchiveAll?: () => void;
  onDeleteAll?: () => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(group.defaultOpen ?? true);
  const [hovered, setHovered] = useState(false);
  const [armed, setArmed] = useState(false);
  const ids = useMemo(() => orderedItems.map((s) => s.path), [orderedItems]);
  const list = (
    <Reorder.Group as="div" axis="y" values={ids} onReorder={onReorder} className="flex flex-col">
      <AnimatePresence mode="popLayout">{children}</AnimatePresence>
    </Reorder.Group>
  );
  if (!group.label) return <motion.div layout className="flex flex-col">{list}</motion.div>;
  return (
    <motion.div layout className="flex flex-col">
      <div
        className="flex items-center pr-2.5"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => { setHovered(false); setArmed(false); }}
      >
        <button
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 min-w-0 items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer text-left"
          style={{ outline: "none", paddingLeft: "10px", paddingTop: "10px", paddingBottom: "14px" }}
        >
          {group.kind === "pinned" && <Pin className="size-3" />}
          {group.kind === "archive" && <Archive className="size-3" />}
          <span>{t(group.label)}</span>
        </button>
        {group.kind === "time" && onArchiveAll && (
          <button
            onClick={(e) => { e.stopPropagation(); onArchiveAll(); }}
            title={t("sessions.archiveAllTitle")}
            className="ml-auto flex items-center gap-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer px-1.5 py-0.5 rounded-[var(--radius-sm)]"
            style={{ outline: "none", opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none", transition: "opacity 0.15s ease" }}
          >
            <Archive className="size-3" /> {t("sessions.archiveAll")}
          </button>
        )}
        {group.kind === "archive" && onDeleteAll && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!armed) { setArmed(true); return; }
              setArmed(false);
              onDeleteAll();
            }}
            title={t("sessions.deleteAllTitle")}
            className="ml-auto flex items-center gap-1 text-xs bg-transparent border-none cursor-pointer px-1.5 py-0.5 rounded-[var(--radius-sm)]"
            style={{ outline: "none", opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none", transition: "opacity 0.15s ease", color: armed ? "var(--color-accent-danger)" : "var(--color-muted)" }}
          >
            <Trash2 className="size-3" /> {armed ? t("sessions.deleteAllConfirm", { count: group.items.length }) : t("sessions.deleteAll")}
          </button>
        )}
      </div>
      <div className="pi-collapsible" data-state={open ? "open" : "closed"}>
        {list}
      </div>
    </motion.div>
  );
}

function SessionRow({ session, flat, active, piAlive, executing, unread, deletable, onClick, onOpenRaw, onDelete, onUpdate, children: childSessions, onSelectChild, activeChildPath, busyByPath }: {
  session: SessionInfo;
  flat: boolean;
  active: boolean;
  piAlive: boolean;
  executing: boolean;
  unread: boolean;
  deletable?: boolean;
  onClick: () => void;
  onOpenRaw: () => void;
  onDelete?: () => Promise<void>;
  onUpdate: (patch: HeaderPatch) => Promise<void>;
  children?: ChildSession[];
  onSelectChild?: (s: SessionInfo) => void;
  activeChildPath?: string;
  busyByPath?: Record<string, true>;
}): React.ReactNode {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [childrenExpanded, setChildrenExpanded] = useState(false);
  // 标题:name ?? id 前 8 位(整串 UUID 太吵);副标题:最后一条消息预览 ?? 创建时间
  const title = session.name ?? session.id.slice(0, 8);
  const sub = session.lastMessage ?? new Date(session.created).toLocaleString();

  if (confirmingDelete) {
    return (
      <div
        className="flex items-center gap-2 px-2.5 py-2 rounded-[var(--radius-sm)]"
        style={{ border: "1px solid var(--color-accent-danger)", color: "var(--color-accent-danger)" }}
      >
        <Trash2 className="size-4 shrink-0" />
        <span className="flex-1 text-[length:var(--font-size-base)]">{t("sessions.deleteConfirm")}</span>
        <button
          onClick={() => { setConfirmingDelete(false); void onDelete?.(); }}
          title={t("sessions.deleteConfirmYes")}
          className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer hover:text-[var(--color-fg)]"
          style={{ color: "var(--color-accent-danger)" }}
        >
          <Check className="size-4" />
        </button>
        <button
          onClick={() => setConfirmingDelete(false)}
          title={t("sessions.deleteConfirmNo")}
          className="flex items-center justify-center size-6 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          <X className="size-4" />
        </button>
      </div>
    );
  }

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
          className="w-full px-2 py-1 text-[length:var(--font-size-base)] rounded-[var(--radius-sm)] border border-[var(--color-primary)] bg-[var(--color-bg)] text-[var(--color-fg)] outline-none"
        />
      </div>
    );
  }

  return (
    <div>
      <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          data-session-path={session.path}
          onClick={onClick}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap"
          style={{
            padding: "var(--sidebar-row-py) var(--sidebar-row-px)",
            background: active ? "var(--sidebar-row-bg-active)" : hovered ? "var(--sidebar-row-bg-hover)" : "var(--sidebar-row-bg)",
            border: active ? "var(--sidebar-row-border-active)" : hovered ? "var(--sidebar-row-border-hover)" : "var(--sidebar-row-border)",
            borderRadius: "var(--sidebar-row-radius)",
            boxShadow: active ? "var(--sidebar-row-shadow-active)" : "var(--sidebar-row-shadow)",
            color: active ? "var(--color-fg)" : "var(--color-muted)",
            transition: "background 0.12s, border-color 0.12s, box-shadow 0.12s",
          }}
        >
          <div className="shrink-0 flex items-center justify-center" style={{ width: "var(--sidebar-icon-box)", height: "var(--sidebar-icon-box)" }}>
            {session.pinned
            ? <Pin className="text-[var(--color-primary)]" style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />
            : executing
            ? <LoaderCircle className="text-[var(--color-primary)] animate-spin" style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />
            : piAlive
            ? <MessageSquare className="text-[var(--color-primary)]" fill="currentColor" style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />
            : <MessageSquare className="text-[var(--color-muted)]" style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="truncate text-[length:var(--font-size-lg)] font-semibold leading-tight text-[var(--color-fg)]">{title}</div>
            <div className="truncate text-[length:var(--font-size-sm)] leading-tight text-[var(--color-muted)] mt-0.5">{sub}</div>
          </div>
          {/* 搜索平铺时,归档项给个 Archive 角标提示 */}
          {flat && session.archived && (
            <Archive className="size-3.5 shrink-0 text-[var(--color-muted)]" />
          )}
          {/* 未读圆点:hover 时让位给操作区(行宽有限,操作语义优先于状态提示) */}
          {unread && !hovered && !childSessions?.length && (
            <span
              title={t("sessions.unread")}
              aria-label={t("sessions.unread")}
              className="size-2 shrink-0 rounded-full bg-[var(--color-primary)]"
            />
          )}
          {childSessions && childSessions.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setChildrenExpanded((v) => !v); }}
              title={childrenExpanded ? t("sessions.collapse") : t("sessions.expand")}
              className="flex items-center justify-center size-5 shrink-0 rounded-[var(--radius-sm)] bg-transparent border-none cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            >
              {childrenExpanded
                ? <ChevronDown className="size-3.5" />
                : <ChevronRight className="size-3.5" />}
            </button>
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
          {/* 删除:不可恢复,仅 deletable(非当前活跃会话);点后进整行内联确认态,不直接删 */}
          {deletable && onDelete && (
            <ContextMenu.Item onSelect={() => setConfirmingDelete(true)} style={{ ...ctxItemStyle, color: "var(--color-accent-danger)" }}>
              <Trash2 className="size-3.5" /> {t("sessions.delete")}
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
    {childSessions && childSessions.length > 0 && (
      <div className="pi-collapsible" data-state={childrenExpanded ? "open" : "closed"}>
        <div className="flex flex-col">
          {childSessions.map((c) => {
            const childActive = activeChildPath === c.session.path;
            const childExecuting = !!busyByPath?.[c.session.path];
            return (
              <div
                key={c.session.path}
                onClick={() => onSelectChild?.(c.session)}
                className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap"
                style={{
                  paddingLeft: "32px",
                  paddingRight: "var(--sidebar-row-px)",
                  paddingTop: "var(--sidebar-row-py)",
                  paddingBottom: "var(--sidebar-row-py)",
                  background: childActive ? "var(--sidebar-row-bg-active)" : "transparent",
                  borderRadius: "var(--sidebar-row-radius)",
                  color: childActive ? "var(--color-fg)" : "var(--color-muted)",
                  transition: "background 0.12s",
                  fontSize: "var(--font-size-sm)",
                }}
              >
                <div className="shrink-0 flex items-center justify-center" style={{ width: "var(--sidebar-icon-box)", height: "var(--sidebar-icon-box)" }}>
                  {childExecuting
                    ? <LoaderCircle className="text-[var(--color-primary)] animate-spin" style={{ width: "var(--sidebar-icon-size)", height: "var(--sidebar-icon-size)" }} />
                    : <MessageSquare className="text-[var(--color-muted)]" style={{ width: "calc(var(--sidebar-icon-size) * 0.8)", height: "calc(var(--sidebar-icon-size) * 0.8)" }} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="truncate leading-tight">{c.session.name ?? c.session.id.slice(0, 8)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    )}
    </div>
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
  fontSize: "var(--font-size-base)", color: "var(--color-fg)",
  fontFamily: "var(--font-family-sans)",
  cursor: "pointer", outline: "none",
};

const plusBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "22px", height: "22px", border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)", cursor: "pointer",
};
