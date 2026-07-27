// 左侧栏 —— VSCode 式四栏位(目录 + 文件树 + 会话 + 设置)。
//
// 布局参考 VSCode 资源管理器:
// ① 目录栏(顶部,离上远):打开/切换目录按钮 + 路径
// ② 文件栏:react-complex-tree,VSCode 式文件树,展开/折叠
// ③ 会话栏:搜索 + 会话列表
// ④ 设置栏(最底):设置按钮
// ②③ 上下分割 + 侧栏左右宽度都走 react-resizable-panels(替代手写 mousemove 拖拽,
// 自带触摸/键盘/边界约束);侧栏宽度在 ChatView(index.tsx)的横向 PanelGroup 管。
import { useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
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

  return (
    <div className="flex flex-col h-full w-full bg-[var(--color-bg)] border-r border-[var(--color-border)]">
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

      {/* ②③ 文件栏/会话栏:纵向 PanelGroup(20%~85% 约束同原 fileRatio) */}
      <PanelGroup direction="vertical" className="flex-1 min-h-0">
        <Panel defaultSize={60} minSize={20} maxSize={85} className="min-h-0">
          <div className="h-full overflow-y-auto pt-1">
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
        </Panel>

        <PanelResizeHandle
          className="shrink-0 border-t border-[var(--color-border)]"
          style={{ height: "4px", cursor: "row-resize", transition: "background 0.15s" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-primary)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        />

        <Panel className="min-h-0">
          <div className="h-full px-2 pt-1 flex flex-col gap-0.5 overflow-y-auto">
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
        </Panel>
      </PanelGroup>

      {/* 分割线 */}
      <div className="border-t border-[var(--color-border)] shrink-0" />

      {/* ④ 设置栏 */}
      <div className="px-2 pb-2 pt-1 shrink-0">
        <ChatRow onClick={() => setMainView("settings")} icon={<Settings className="size-4.5" />}>
          设置
        </ChatRow>
      </div>
    </div>
  );
}
