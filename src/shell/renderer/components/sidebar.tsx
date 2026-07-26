// 左侧栏 —— 会话列表(真实,从文件系统扫)+ 设置按钮 + 打开目录。
//
// 依据 docs/plugins/11(session-manager):会话来自 ~/.pi/agent/sessions/<cwd桶>/。
// 删 mock SESSIONS 数组,改为 pi.sessions.list(cwd) 拿真实会话。
import { useEffect, useState } from "react";
import { Settings, FolderOpen } from "lucide-react";
import { useUiStore, ListItem, usePiApi } from "@pi-desktop/react";

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
    const dir = await pi.dialog.openDirectory();
    if (!dir) return;
    // 停旧 pi → 设新 cwd → 起新 pi → 扫会话
    await pi.rpc.stop();
    setCurrentCwd(dir);
    setCurrentSessionPath(null);
    await pi.rpc.start(dir);
    await refreshSessions(dir);
  };

  // 选中会话 → switch_session → resync
  const selectSession = async (session: SessionInfo): Promise<void> => {
    setCurrentSessionPath(session.path);
    await pi.rpc.send({ type: "switch_session", sessionPath: session.path });
  };

  // 会话显示名:有 name 用 name,否则用创建时间
  const sessionLabel = (s: SessionInfo): string => s.name ?? new Date(s.created).toLocaleString();

  return (
    <div style={{ width: "240px", flexShrink: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--color-border)", background: "var(--color-bg)" }}>
      {/* 顶部:当前目录名 + 打开目录按钮 */}
      <div style={{ padding: "var(--spacing-md) var(--spacing-lg)", fontWeight: 600, borderBottom: "1px solid var(--color-border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {currentCwd ? currentCwd.split("/").pop() : "未打开目录"}
        </span>
        <button
          onClick={() => void openDirectory()}
          title="打开目录"
          style={{ border: "none", background: "transparent", color: "var(--color-muted)", cursor: "pointer", padding: "var(--spacing-xs)", display: "flex", alignItems: "center" }}
        >
          <FolderOpen size={16} />
        </button>
      </div>

      {/* 会话列表 */}
      <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-sm)", display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
        {!currentCwd && (
          <div style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", padding: "var(--spacing-md)", textAlign: "center" }}>
            点击右上角打开一个项目目录
          </div>
        )}
        {currentCwd && loading && (
          <div style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", padding: "var(--spacing-md)" }}>
            加载会话…
          </div>
        )}
        {sessions.map((s) => (
          <ListItem
            key={s.id}
            active={currentSessionPath === s.path}
            onClick={() => void selectSession(s)}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {sessionLabel(s)}
            </span>
          </ListItem>
        ))}
        {currentCwd && !loading && sessions.length === 0 && (
          <div style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", padding: "var(--spacing-md)" }}>
            该目录下暂无会话
          </div>
        )}
      </div>

      {/* 底部:设置按钮 */}
      <div style={{ padding: "var(--spacing-sm)", borderTop: "1px solid var(--color-border)" }}>
        <ListItem onClick={() => setMainView("settings")} style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)" }}>
          <Settings size={16} />
          设置
        </ListItem>
      </div>
    </div>
  );
}
