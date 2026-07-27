// 左侧栏 —— 可拖动宽度 + 会话列表 + 设置按钮。
// 宽度拖动:右边框拖拽改变宽度,持久化到 electron-store(prefs:sidebarWidth)。
import { useEffect, useState, useRef, useCallback } from "react";
import { Settings, FolderOpen, Search } from "lucide-react";
import { useUiStore, usePiApi } from "@pi-desktop/react";
import { ChatRow } from "../ui/chat-row";

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

  // 启动:读持久化宽度
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

  // 拖动调整宽度
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
        {/* 顶部:打开目录 */}
        <div className="px-2 pt-2 pb-1.5">
          <ChatRow onClick={() => void openDirectory()} icon={<FolderOpen className="size-4.5" />}>
            {currentCwd ? "切换目录" : "打开目录"}
          </ChatRow>
          {currentCwd && (
            <div className="mt-1 px-2.5 text-xs text-[var(--color-muted)] font-[var(--font-family-mono)] truncate">
              {currentCwd}
            </div>
          )}
          <div className="mt-0.5">
            <ChatRow onClick={() => {}} icon={<Search className="size-4.5" />}>搜索</ChatRow>
          </div>
        </div>

        {/* 会话列表 */}
        <div className="flex-1 overflow-y-auto px-2 pt-1 flex flex-col gap-0.5">
          {!currentCwd && (
            <div className="px-2.5 py-4 text-xs text-[var(--color-muted)] text-center">
              点击"打开目录"选择项目
            </div>
          )}
          {currentCwd && loading && (
            <div className="px-2.5 py-2 text-xs text-[var(--color-muted)]">加载会话…</div>
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
            <div className="px-2.5 py-2 text-xs text-[var(--color-muted)]">该目录下暂无会话</div>
          )}
        </div>

        {/* 底部:设置行 */}
        <div className="px-2 pb-2 pt-1 border-t border-[var(--color-border)]">
          <ChatRow onClick={() => setMainView("settings")} icon={<Settings className="size-4.5" />}>
            设置
          </ChatRow>
        </div>
      </div>

      {/* 拖动条:右侧 4px 宽,cursor: col-resize */}
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
