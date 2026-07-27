// 左侧栏 —— 四栏位布局(目录栏 + 文件栏 + 会话栏 + 设置栏)。
// 可拖动宽度,持久化到 electron-store(prefs:sidebarWidth)。
import { useEffect, useState, useCallback } from "react";
import { Settings, FolderOpen, Search } from "lucide-react";
import { useUiStore, usePiApi } from "@pi-desktop/react";
import { ChatRow } from "../ui/chat-row";
import { FileTree } from "./file-tree";

interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
}

export function Sidebar(): React.ReactNode {
  const pi = usePiApi();
  const { setMainView, currentCwd, setCurrentCwd, setCurrentSessionPath, currentSessionPath } = useUiStore();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    void pi.prefs.get<number>("sidebarWidth").then((w) => {
      if (w && w >= 180 && w <= 500) setSidebarWidth(w);
    });
  }, [pi]);

  const refreshSessions = async (cwd: string): Promise<void> => {
    if (!cwd) return;
    setLoading(true);
    try {
      const list = (await pi.sessions.list(cwd)) as SessionInfo[];
      setSessions(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (currentCwd) void refreshSessions(currentCwd);
  }, [currentCwd]);

  const openDirectory = async (): Promise<void> => {
    try {
      const dir = await pi.dialog.openDirectory();
      if (!dir) return;
      await pi.rpc.stop();
      setCurrentCwd(dir);
      setCurrentSessionPath(null);
      await pi.rpc.start(dir);
      await refreshSessions(dir);
    } catch (err) {
      console.error("[sidebar] 打开目录失败:", err);
    }
  };

  const selectSession = async (session: SessionInfo): Promise<void> => {
    setCurrentSessionPath(session.path);
    await pi.rpc.send({ type: "switch_session", sessionPath: session.path });
  };

  const sessionLabel = (s: SessionInfo): string => s.name ?? new Date(s.created).toLocaleString();

  const startDrag = useCallback((e: React.MouseEvent): void => {
    e.preventDefault();
    setDragging(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (ev: MouseEvent): void => {
      const newWidth = Math.max(180, Math.min(500, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
    };
    const onUp = (): void => {
      setDragging(false);
      void pi.prefs.set("sidebarWidth", sidebarWidth);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth, pi]);

  return (
    <>
      <div className="shrink-0 flex flex-col h-full bg-[var(--color-bg)] border-r border-[var(--color-border)]" style={{ width: sidebarWidth }}>
        {/* ① 目录栏(离顶部远一点) */}
        <div className="px-2 pt-4 pb-2">
          <ChatRow onClick={() => void openDirectory()} icon={<FolderOpen className="size-4.5" />}>
            {currentCwd ? "切换目录" : "打开目录"}
          </ChatRow>
          {currentCwd && (
            <div className="mt-1 px-2.5 text-[var(--font-size-sm)] text-[var(--color-muted)] font-[var(--font-family-mono)] truncate">
              {currentCwd}
            </div>
          )}
        </div>

        {/* 分割线 */}
        <div className="border-t border-[var(--color-border)]" />

        {/* ② 文件栏(react-complex-tree,VSCode 式) */}
        <div className="flex-1 overflow-y-auto pt-1 min-h-0">
          {!currentCwd ? (
            <div className="px-2.5 py-4 text-[var(--font-size-sm)] text-[var(--color-muted)] text-center">
              打开目录后显示文件
            </div>
          ) : loading ? (
            <div className="px-2.5 py-2 text-[var(--font-size-sm)] text-[var(--color-muted)]">加载…</div>
          ) : (
            <FileTree cwd={currentCwd} />
          )}
        </div>

        {/* 可上下拖动的分割线(文件栏 ↔ 会话栏) */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            const startY = e.clientY;
            const fileDiv = e.currentTarget.previousElementSibling as HTMLElement;
            const sessionDiv = e.currentTarget.nextElementSibling as HTMLElement;
            const fileH = fileDiv.getBoundingClientRect().height;
            const sessionH = sessionDiv.getBoundingClientRect().height;
            const onMove = (ev: MouseEvent): void => {
              const dy = ev.clientY - startY;
              const newFileH = Math.max(100, fileH + dy);
              const newSessionH = Math.max(100, sessionH - dy);
              fileDiv.style.height = `${newFileH}px`;
              fileDiv.style.flex = "none";
              sessionDiv.style.height = `${newSessionH}px`;
              sessionDiv.style.maxHeight = "none";
            };
            const onUp = (): void => {
              document.removeEventListener("mousemove", onMove);
              document.removeEventListener("mouseup", onUp);
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
          }}
          style={{ height: "4px", cursor: "row-resize", borderTop: "1px solid var(--color-border)", flexShrink: 0, background: "transparent", transition: "background 0.15s" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-primary)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        />

        {/* ③ 会话栏(搜索 + 会话列表) */}
        <div className="px-2 pt-1 flex flex-col gap-0.5 overflow-y-auto" style={{ height: "200px", flexShrink: 0 }}>
          <ChatRow onClick={() => {}} icon={<Search className="size-4.5" />}>搜索</ChatRow>
          {currentCwd && loading && (
            <div className="px-2.5 py-2 text-[var(--font-size-sm)] text-[var(--color-muted)]">加载会话…</div>
          )}
          {sessions.map((s) => (
            <ChatRow
              key={s.id}
              active={currentSessionPath === s.path}
              onClick={() => void selectSession(s)}
            >
              {sessionLabel(s)}
            </ChatRow>
          ))}
          {currentCwd && !loading && sessions.length === 0 && (
            <div className="px-2.5 py-2 text-[var(--font-size-sm)] text-[var(--color-muted)]">暂无会话</div>
          )}
        </div>

        {/* 分割线 */}
        <div className="border-t border-[var(--color-border)]" />

        {/* ④ 设置栏 */}
        <div className="px-2 pb-2 pt-1">
          <ChatRow onClick={() => setMainView("settings")} icon={<Settings className="size-4.5" />}>
            设置
          </ChatRow>
        </div>
      </div>

      {/* 拖动条 */}
      <div
        onMouseDown={startDrag}
        style={{
          width: "4px",
          flexShrink: 0,
          cursor: "col-resize",
          background: dragging ? "var(--color-primary)" : "transparent",
          transition: "background 0.15s",
        }}
      />
    </>
  );
}
