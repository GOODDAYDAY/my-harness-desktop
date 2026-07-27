// sessions-list 插件 renderer —— 左栏"对话"分组:会话列表 + 搜索 + 新建。
//
// 数据:ctx.sessions.list(currentCwd)(核心会话能力,无需权限声明)。
// 交互:点选 = switchSession + 面包屑标题 + nonce 触发 timeline 重 resync;
// "+" = newSession(直接开,不弹确认)。
import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { registerSidebarComponent, usePluginContext, useUiStore, Section, type SessionInfo } from "@pi-desktop/react";

const PLUGIN_ID = "sessions-list";
registerSidebarComponent("SessionsSection", SessionsSection);

function SessionsSection(): React.ReactNode {
  const ctx = usePluginContext(PLUGIN_ID);
  const {
    currentCwd, currentSessionPath, sessionNonce,
    setCurrentSessionPath, setSessionTitle, bumpSession,
  } = useUiStore();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!currentCwd) { setSessions([]); return; }
    setLoading(true);
    void ctx.sessions.list(currentCwd)
      .then(setSessions)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd, sessionNonce]);

  const newSession = async (): Promise<void> => {
    try {
      await ctx.sessions.newSession();
      setSessionTitle(null);
      bumpSession();
    } catch (err) {
      console.error("[sessions-list] 新建会话失败:", err);
    }
  };

  const select = async (s: SessionInfo): Promise<void> => {
    try {
      setCurrentSessionPath(s.path);
      setSessionTitle(s.name ?? new Date(s.created).toLocaleString());
      await ctx.sessions.switchSession(s.path);
      bumpSession();
    } catch (err) {
      console.error("[sessions-list] 切换会话失败:", err);
    }
  };

  const filtered = query
    ? sessions.filter((s) => (s.name ?? "").includes(query) || s.created.includes(query))
    : sessions;

  return (
    <Section
      title="对话"
      count={sessions.length}
      actions={
        <button onClick={() => void newSession()} title="新会话 (⌘N)" style={plusBtnStyle}>
          <Plus className="size-4" />
        </button>
      }
    >
      <div className="flex items-center gap-1.5 px-2 pb-1 text-[var(--color-muted)]">
        <Search className="size-3.5 shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索会话"
          className="w-full bg-transparent border-none outline-none text-[var(--font-size-sm)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)]"
        />
      </div>
      {loading && <div className="px-2.5 py-2 text-[var(--font-size-sm)] text-[var(--color-muted)]">加载会话…</div>}
      {!loading && !currentCwd && (
        <div className="px-2.5 py-2 text-[var(--font-size-sm)] text-[var(--color-muted)]">打开文件夹后显示会话</div>
      )}
      {!loading && currentCwd && filtered.length === 0 && (
        <div className="px-2.5 py-2 text-[var(--font-size-sm)] text-[var(--color-muted)]">{query ? "无匹配会话" : "暂无会话"}</div>
      )}
      {filtered.map((s) => (
        <SessionRow key={s.id} session={s} active={currentSessionPath === s.path} onClick={() => void select(s)} />
      ))}
    </Section>
  );
}

function SessionRow({ session, active, onClick }: { session: SessionInfo; active: boolean; onClick: () => void }): React.ReactNode {
  const [hovered, setHovered] = useState(false);
  const title = session.name ?? "新对话";
  const sub = session.name ? new Date(session.created).toLocaleString() : "首条消息即标题";
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="flex items-center gap-2 px-2.5 py-1.5 mx-0.5 rounded-[var(--radius-md)] cursor-pointer select-none"
      style={{
        background: active || hovered ? "var(--color-surface)" : "transparent",
        color: active ? "var(--color-fg)" : "var(--color-muted)",
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="truncate text-[var(--font-size-sm)] text-[var(--color-fg)]">{title}</div>
        <div className="truncate text-xs opacity-70">{sub}</div>
      </div>
    </div>
  );
}

const plusBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "22px", height: "22px", border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)", cursor: "pointer",
};
