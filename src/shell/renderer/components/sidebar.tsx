// 左侧栏 —— OpenWebUI 式:顶部"打开目录"大圆角行 + 目录路径小字,会话列表用 ChatRow(hover 高亮无硬边框)。
//
// 依据 docs/plugins/11(session-manager):会话来自 ~/.pi/agent/sessions/<cwd桶>/。
// 布局激进参考 open-webui Sidebar.svelte:无硬边框方块,靠 hover/active 的 surface 背景区分;
// 全部内联 style 迁 className,token 经 CSS 变量消费。
import { useEffect, useState } from "react";
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

  // 启动 + cwd 变 → 扫会话
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

  // 打开目录
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

  // 选中会话 → switch_session → resync
  const selectSession = async (session: SessionInfo): Promise<void> => {
    setCurrentSessionPath(session.path);
    await pi.rpc.send({ type: "switch_session", sessionPath: session.path });
  };

  // 会话显示名
  const sessionLabel = (s: SessionInfo): string => s.name ?? new Date(s.created).toLocaleString();

  return (
    <div className="w-[240px] shrink-0 flex flex-col h-full bg-[var(--color-bg)] border-r border-[var(--color-border)]">
      {/* 顶部:打开目录大圆角行(OpenWebUI New Chat 式)+ 目录路径小字 */}
      <div className="px-2 pt-2 pb-1.5">
        <ChatRow
          onClick={() => void openDirectory()}
          icon={<FolderOpen className="size-4.5" />}
        >
          {currentCwd ? "切换目录" : "打开目录"}
        </ChatRow>
        {currentCwd && (
          <div className="mt-1 px-2.5 text-xs text-[var(--color-muted)] font-[var(--font-family-mono)] truncate">
            {currentCwd}
          </div>
        )}
        {/* 搜索行(预留,呼应 OpenWebUI Sidebar) */}
        <div className="mt-0.5">
          <ChatRow
            onClick={() => {
              /* 预留:接搜索插件 */
            }}
            icon={<Search className="size-4.5" />}
          >
            搜索
          </ChatRow>
        </div>
      </div>

      {/* 会话列表:ChatRow(hover 高亮,无硬边框) */}
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
        <ChatRow
          onClick={() => setMainView("settings")}
          icon={<Settings className="size-4.5" />}
        >
          设置
        </ChatRow>
      </div>
    </div>
  );
}
