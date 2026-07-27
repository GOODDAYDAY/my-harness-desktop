// sessions-list 插件 renderer —— 左栏"会话"分组:会话列表 + 搜索 + 新建。
//
// 数据:ctx.sessions.list(currentCwd)(核心会话能力,无需权限声明)。
// 交互:点选 = switchSession + 面包屑标题 + nonce 触发 timeline 重 resync;
// "+" = newSession(直接开,不弹确认)。
// 分组:已置顶(恒在最上,带 Pin)> 时间四档(今天/昨天/过去7天/更早,各可折叠)
//       > 已归档(默认折叠,带 Archive)。pinned/archived 写 JSONL 头行,updateHeader 一处写。
import { useEffect, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Plus, Search, FileJson, Pencil, Pin, Archive } from "lucide-react";
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
  const {
    currentCwd, currentSessionPath, sessionNonce,
    setCurrentSessionPath, setSessionTitle,
  } = useUiStore();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = (): void => {
    if (!currentCwd) return;
    void ctx.sessions.list(currentCwd).then(setSessions);
  };

  useEffect(() => {
    if (!currentCwd) { setSessions([]); return; }
    setLoading(true);
    void ctx.sessions.list(currentCwd)
      .then(setSessions)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd, sessionNonce]);

  // 动态预览:一轮结束(agentSettled)后重扫列表,副标题的最后一条消息跟着更新
  useEffect(() => {
    return ctx.sessions.onEvent((event) => {
      if (event.type !== "agentSettled" || !currentCwd) return;
      void ctx.sessions.list(currentCwd).then(setSessions);
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

  const filtered = query
    ? sessions.filter((s) => (s.name ?? "").includes(query) || s.created.includes(query))
    : sessions;

  // 搜索时平铺(归档项带 Archive 角标,仍可搜到);非搜索走分组
  const groups = query
    ? [{ label: "", items: filtered, kind: "time" as GroupKind, defaultOpen: true }]
    : buildGroups(filtered);

  return (
    <Section
      title="会话"
      actions={
        <button onClick={() => void newSession()} title="新会话 (⌘N)" style={plusBtnStyle}>
          <Plus className="size-4" />
        </button>
      }
    >
      <div className="flex items-center gap-1.5 px-2 pb-2 text-[var(--color-muted)]">
        <Search className="size-3.5 shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索会话"
          className="w-full bg-transparent border-none outline-none text-[14px] text-[var(--color-fg)] placeholder:text-[var(--color-muted)]"
        />
      </div>
      {loading && <div className="px-2.5 py-2 text-[14px] text-[var(--color-muted)]">加载会话…</div>}
      {!loading && !currentCwd && (
        <div className="px-2.5 py-2 text-[14px] text-[var(--color-muted)]">打开文件夹后显示会话</div>
      )}
      {!loading && currentCwd && filtered.length === 0 && (
        <div className="px-2.5 py-2 text-[14px] text-[var(--color-muted)]">{query ? "无匹配会话" : "暂无会话"}</div>
      )}
      {groups.map((g) => (
        <GroupBlock key={g.kind + g.label} group={g}>
          {g.items.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              flat={!!query}
              active={currentSessionPath === s.path}
              onClick={() => void select(s)}
              onOpenRaw={() => void ctx.dialog.openFile(s.path)}
              onUpdate={async (patch) => {
                await ctx.sessions.updateHeader(s.path, patch);
                if (patch.name != null && currentSessionPath === s.path) {
                  setSessionTitle(patch.name || s.id);
                }
                refresh();
              }}
            />
          ))}
        </GroupBlock>
      ))}
    </Section>
  );
}

/** 分组:pinned 在最上 → 时间四档 → archive 在最下(归档不进时间分组)。 */
function buildGroups(items: SessionInfo[]): Group[] {
  const pinned = items.filter((s) => s.pinned && !s.archived);
  const archived = items.filter((s) => s.archived);
  const rest = items.filter((s) => !s.pinned && !s.archived);
  const byTime = groupByTime(rest);
  const groups: Group[] = [];
  if (pinned.length) groups.push({ label: "已置顶", items: pinned, kind: "pinned", defaultOpen: true });
  for (const g of byTime) groups.push({ label: g.label, items: g.items, kind: "time", defaultOpen: true });
  if (archived.length) groups.push({ label: "已归档", items: archived, kind: "archive", defaultOpen: false });
  return groups;
}

/** 按创建时间分组:今天 / 昨天 / 过去 7 天 / 更早(各组内保持 mtime 降序)。 */
function groupByTime(items: SessionInfo[]): { label: string; items: SessionInfo[] }[] {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const today = dayStart.getTime();
  const yesterday = today - 86400000;
  const week = today - 7 * 86400000;
  const buckets: { label: string; items: SessionInfo[]; min: number }[] = [
    { label: "今天", items: [], min: today },
    { label: "昨天", items: [], min: yesterday },
    { label: "过去 7 天", items: [], min: week },
    { label: "更早", items: [], min: -Infinity },
  ];
  for (const s of items) {
    const t = new Date(s.created).getTime();
    buckets.find((b) => t >= b.min)?.items.push(s);
  }
  return buckets.filter((b) => b.items.length > 0);
}

/** 分组容器:有 label 才画折叠头(搜索平铺时 kind=time 但 label 为空 → 不画头)。
 *  复用 index.css 的 .pi-collapsible 动画(与 Section 同一套)。 */
function GroupBlock({ group, children }: { group: Group; children: React.ReactNode }): React.ReactNode {
  const [open, setOpen] = useState(group.defaultOpen ?? true);
  if (!group.label) return <div className="flex flex-col">{children}</div>;
  return (
    <div className="flex flex-col">
      <button
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 pt-2.5 pb-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer text-left"
        style={{ outline: "none" }}
      >
        {group.kind === "pinned" && <Pin className="size-3" />}
        {group.kind === "archive" && <Archive className="size-3" />}
        <span>{group.label}</span>
      </button>
      <div className="pi-collapsible" data-state={open ? "open" : "closed"}>
        {children}
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
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  // 标题:name ?? id;副标题:最后一条消息预览 ?? 创建时间
  const title = session.name ?? session.id;
  const sub = session.lastMessage ?? new Date(session.created).toLocaleString();

  if (editing) {
    return (
      <div className="px-2.5 py-2.5">
        <input
          autoFocus
          defaultValue={session.name ?? ""}
          placeholder={session.id}
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
          className="flex items-center gap-2 px-2.5 py-2.5 rounded-[var(--radius-md)] cursor-pointer select-none"
          style={{
            background: active || hovered ? "var(--color-surface)" : "transparent",
            color: active ? "var(--color-fg)" : "var(--color-muted)",
          }}
        >
          {session.pinned && <Pin className="size-3.5 shrink-0 text-[var(--color-primary)]" />}
          <div className="flex-1 min-w-0">
            <div className="truncate text-[14px] text-[var(--color-fg)]">{title}</div>
            <div className="truncate text-xs opacity-60 mt-0.5">{sub}</div>
          </div>
          {/* 搜索平铺时,归档项给个 Archive 角标提示 */}
          {flat && session.archived && (
            <Archive className="size-3.5 shrink-0 text-[var(--color-muted)]" title="已归档" />
          )}
          {/* 打开原始文件(hover 才现,不点穿行选中) */}
          {hovered && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenRaw(); }}
              title="打开原始文件"
              className="shrink-0 flex items-center justify-center size-6 rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer"
            >
              <FileJson className="size-4" />
            </button>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content style={ctxMenuStyle}>
          <ContextMenu.Item onSelect={() => setEditing(true)} style={ctxItemStyle}>
            <Pencil className="size-3.5" /> 重命名
          </ContextMenu.Item>
          <ContextMenu.Item
            onSelect={() => void onUpdate({ pinned: !session.pinned })}
            style={ctxItemStyle}
          >
            <Pin className="size-3.5" /> {session.pinned ? "取消置顶" : "置顶"}
          </ContextMenu.Item>
          <ContextMenu.Item
            onSelect={() => void onUpdate({ archived: !session.archived })}
            style={ctxItemStyle}
          >
            <Archive className="size-3.5" /> {session.archived ? "取消归档" : "归档"}
          </ContextMenu.Item>
          <ContextMenu.Item onSelect={onOpenRaw} style={ctxItemStyle}>
            <FileJson className="size-3.5" /> 打开原始文件
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
