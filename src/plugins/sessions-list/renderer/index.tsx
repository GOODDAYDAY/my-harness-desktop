// sessions-list 插件 renderer —— 左栏"对话"分组:会话列表 + 搜索 + 新建。
//
// 数据:ctx.sessions.list(currentCwd)(核心会话能力,无需权限声明)。
// 交互:点选 = switchSession + 面包屑标题 + nonce 触发 timeline 重 resync;
// "+" = newSession(直接开,不弹确认)。
import { useEffect, useState } from "react";
import { Plus, Search, FileJson } from "lucide-react";
import { registerSidebarComponent, usePluginContext, useUiStore, useSessionStore, Section, type SessionInfo } from "@pi-desktop/react";

const PLUGIN_ID = "sessions-list";
registerSidebarComponent("SessionsSection", SessionsSection);

function SessionsSection(): React.ReactNode {
  const ctx = usePluginContext(PLUGIN_ID);
  const {
    currentCwd, currentSessionPath, sessionNonce,
    setCurrentSessionPath, setSessionTitle,
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

  // 动态预览:一轮结束(agentSettled)后重扫列表,副标题的最后一条消息跟着更新
  useEffect(() => {
    return ctx.sessions.onEvent((event) => {
      if (event.type !== "agentSettled" || !currentCwd) return;
      void ctx.sessions.list(currentCwd).then(setSessions);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd]);

  const newSession = async (): Promise<void> => {
    // 新会话是本地概念:清空视图即可,进程在首次发送时按需起
    setCurrentSessionPath(null);
    setSessionTitle(null);
    await useSessionStore.getState().startNewChat(currentCwd);
  };

  const select = async (s: SessionInfo): Promise<void> => {
    try {
      // 纯文件读秒开,不启 pi;选中态/面包屑立即更新
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

  // ChatGPT 式时间分组:今天/昨天/过去 7 天/更早(搜索时平铺不分组)
  const groups = query ? [{ label: "", items: filtered }] : groupByTime(filtered);

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
      <div className="flex items-center gap-1.5 px-2 pb-1.5 text-[var(--color-muted)]">
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
        <div key={g.label} className="flex flex-col">
          {g.label && (
            <div className="px-2.5 pt-2.5 pb-1 text-xs text-[var(--color-muted)]">{g.label}</div>
          )}
          {g.items.map((s) => (
            <SessionRow key={s.id} session={s} active={currentSessionPath === s.path} onClick={() => void select(s)} onOpenRaw={() => void ctx.dialog.openFile(s.path)} />
          ))}
        </div>
      ))}
    </Section>
  );
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

function SessionRow({ session, active, onClick, onOpenRaw }: { session: SessionInfo; active: boolean; onClick: () => void; onOpenRaw: () => void }): React.ReactNode {
  const [hovered, setHovered] = useState(false);
  // 标题:name ?? id;副标题:最后一条消息预览 ?? 创建时间
  const title = session.name ?? session.id;
  const sub = session.lastMessage ?? new Date(session.created).toLocaleString();
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="flex items-center gap-2 px-2.5 py-2 rounded-[var(--radius-md)] cursor-pointer select-none"
      style={{
        background: active || hovered ? "var(--color-surface)" : "transparent",
        color: active ? "var(--color-fg)" : "var(--color-muted)",
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="truncate text-[14px] text-[var(--color-fg)]">{title}</div>
        <div className="truncate text-xs opacity-60 mt-0.5">{sub}</div>
      </div>
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
  );
}

const plusBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "22px", height: "22px", border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)", cursor: "pointer",
};
