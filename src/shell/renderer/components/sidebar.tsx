// 左侧栏 —— VSCode 式四栏位(目录 + 文件树 + 会话 + 设置)。
//
// 布局参考 VSCode 资源管理器:
// ① 目录栏(顶部,离上远):打开/切换目录按钮 + 路径
// ② 文件栏(flex-1):react-complex-tree,VSCode 式文件树,展开/折叠
// ③ 会话栏(底部 flex-shrink):搜索 + 会话列表
// ④ 设置栏(最底):设置按钮
// 栏间分割线可上下拖动(文件栏↔会话栏);侧栏宽度可左右拖动。
import { useEffect, useState, useCallback, useRef } from "react";
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
  // 文件栏/会话栏高度比例(文件栏占比,0.3~0.8)
  const [fileRatio, setFileRatio] = useState(0.6);
  const sidebarRef = useRef<HTMLDivElement>(null);

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

  // 侧栏左右拖动
  const startHorizontalDrag = useCallback((e: React.MouseEvent): void => {
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

  // 文件栏↔会话栏上下拖动
  const startVerticalDrag = useCallback((e: React.MouseEvent): void => {
    e.preventDefault();
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const startY = e.clientY;
    const startRatio = fileRatio;
    // 可拖区域 = 侧栏总高 - 目录栏高 - 设置栏高 - 分割线高
    const totalHeight = sidebar.getBoundingClientRect().height;
    const fixedHeight = 120; // 目录栏+设置栏+分割线的大概固定高度
    const draggableHeight = Math.max(200, totalHeight - fixedHeight);
    const onMove = (ev: MouseEvent): void => {
      const dy = ev.clientY - startY;
      const dr = dy / draggableHeight;
      const newRatio = Math.max(0.2, Math.min(0.85, startRatio + dr));
      setFileRatio(newRatio);
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [fileRatio]);

  return (
    <>
      <div ref={sidebarRef} className="shrink-0 flex flex-col h-full bg-[var(--color-bg)] border-r border-[var(--color-border)]" style={{ width: sidebarWidth }}>
        {/* ① 目录栏(离顶部远一点) */}
        <div className="px-2 pt-4 pb-2 shrink-0">
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
        <div className="border-t border-[var(--color-border)] shrink-0" />

        {/* ② 文件栏(flex,按比例分配高度) */}
        <div className="overflow-y-auto pt-1 min-h-0" style={{ flex: `${fileRatio} 1 0` }}>
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
          onMouseDown={startVerticalDrag}
          className="shrink-0 border-t border-[var(--color-border)]"
          style={{ height: "4px", cursor: "row-resize", transition: "background 0.15s" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-primary)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        />

        {/* ③ 会话栏(搜索 + 会话列表,按比例分配高度) */}
        <div className="px-2 pt-1 flex flex-col gap-0.5 overflow-y-auto min-h-0" style={{ flex: `${1 - fileRatio} 1 0` }}>
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
        <div className="border-t border-[var(--color-border)] shrink-0" />

        {/* ④ 设置栏 */}
        <div className="px-2 pb-2 pt-1 shrink-0">
          <ChatRow onClick={() => setMainView("settings")} icon={<Settings className="size-4.5" />}>
            设置
          </ChatRow>
        </div>
      </div>

      {/* 侧栏左右拖动条 */}
      <div
        onMouseDown={startHorizontalDrag}
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
