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
    <div style={{ width: "240px", flexShrink: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--color-border)", background: "var(--color-bg)" }}>
      {/* 顶部:目录区 */}
      <div style={{ padding: "var(--spacing-sm)", borderBottom: "1px solid var(--color-border)", display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
        {currentCwd ? (
          <>
            {/* 已打开:第一行路径(不可点击),第二行"打开目录"(切换) */}
            <div style={{
              padding: "var(--spacing-sm) var(--spacing-md)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              background: "var(--color-surface)",
              color: "var(--color-muted)",
              fontFamily: "var(--font-family-mono)",
              fontSize: "var(--font-size-sm)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {currentCwd}
            </div>
            <button
              onClick={() => void openDirectory()}
              style={{
                display: "flex", alignItems: "center", gap: "var(--spacing-xs)",
                padding: "var(--spacing-xs) var(--spacing-md)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
                background: "transparent",
                color: "var(--color-muted)",
                cursor: "pointer",
                fontFamily: "var(--font-family-sans)",
                fontSize: "var(--font-size-sm)",
              }}
            >
              <FolderOpen size={12} />
              打开目录
            </button>
          </>
        ) : (
          {/* 未打开:只有一个"打开目录"按钮 */}
          <button
            onClick={() => void openDirectory()}
            style={{
              display: "flex", alignItems: "center", gap: "var(--spacing-sm)",
              padding: "var(--spacing-sm) var(--spacing-md)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
              background: "transparent",
              color: "var(--color-fg)",
              cursor: "pointer",
              fontFamily: "var(--font-family-sans)",
              fontSize: "var(--font-size-sm)",
              textAlign: "left",
              width: "100%",
            }}
          >
            <FolderOpen size={14} />
            打开目录
          </button>
        )}
      </div>

      {/* 会话列表 */}
      <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-sm)", display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
        {!currentCwd && (
          <div style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", padding: "var(--spacing-md)", textAlign: "center" }}>
            点击上方"打开目录"选择项目
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
