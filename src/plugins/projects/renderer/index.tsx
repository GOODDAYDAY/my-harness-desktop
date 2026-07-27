// projects 插件 renderer —— 左栏"项目"分组:打开文件夹 + 最近工作目录。
//
// 最近目录存自己的插件 config("recentCwds",插件配置能力的示范),
// 切目录 = sessions.start(dir)(停旧起新由 SessionStore 管)+ 清会话上下文 + nonce。
import { useEffect, useState } from "react";
import { Plus, FolderOpen, Folder, X } from "lucide-react";
import { registerSidebarComponent, usePluginContext, useUiStore, Section } from "@pi-desktop/react";

const PLUGIN_ID = "projects";
registerSidebarComponent("ProjectsSection", ProjectsSection);

function ProjectsSection(): React.ReactNode {
  const ctx = usePluginContext(PLUGIN_ID);
  const {
    currentCwd, setCurrentCwd, setCurrentSessionPath, setSessionTitle, bumpSession,
  } = useUiStore();
  const [cwds, setCwds] = useState<string[]>([]);

  useEffect(() => {
    void ctx.config.get<string[]>("recentCwds").then((v) => setCwds(v ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = (next: string[]): void => {
    setCwds(next);
    void ctx.config.set("recentCwds", next);
  };

  const switchCwd = async (dir: string): Promise<void> => {
    try {
      setCurrentCwd(dir);
      setCurrentSessionPath(null);
      setSessionTitle(null);
      await ctx.sessions.start(dir);
      persist([dir, ...cwds.filter((c) => c !== dir)].slice(0, 10));
      bumpSession();
    } catch (err) {
      console.error("[projects] 切换目录失败:", err);
    }
  };

  const openDirectory = async (): Promise<void> => {
    const dir = await ctx.dialog.openDirectory();
    if (dir) await switchCwd(dir);
  };

  return (
    <Section
      title="项目"
      actions={
        <button onClick={() => void openDirectory()} title="添加项目" style={iconBtnStyle}>
          <Plus className="size-4" />
        </button>
      }
    >
      <button onClick={() => void openDirectory()} style={openBtnStyle}>
        <FolderOpen className="size-4" />
        打开文件夹
      </button>
      {cwds.map((dir) => (
        <ProjectRow
          key={dir}
          dir={dir}
          active={currentCwd === dir}
          onClick={() => void switchCwd(dir)}
          onRemove={() => persist(cwds.filter((c) => c !== dir))}
        />
      ))}
    </Section>
  );
}

function ProjectRow({ dir, active, onClick, onRemove }: { dir: string; active: boolean; onClick: () => void; onRemove: () => void }): React.ReactNode {
  const [hovered, setHovered] = useState(false);
  const name = dir.split("/").filter(Boolean).pop() ?? dir;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={dir}
      className="flex items-center gap-2 px-2.5 py-1.5 mx-0.5 rounded-[var(--radius-md)] cursor-pointer select-none"
      style={{
        background: active || hovered ? "var(--color-surface)" : "transparent",
        color: active ? "var(--color-fg)" : "var(--color-muted)",
      }}
    >
      <Folder className="size-4 shrink-0" />
      <span className="flex-1 min-w-0 truncate text-[var(--font-size-sm)]">{name}</span>
      {hovered && (
        <span
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="shrink-0 opacity-60 hover:opacity-100"
          title="从列表移除"
        >
          <X className="size-3.5" />
        </span>
      )}
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "22px", height: "22px", border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)", cursor: "pointer",
};

const openBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "var(--spacing-xs)",
  margin: "0 2px var(--spacing-xs)", padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)",
  background: "var(--color-surface)", color: "var(--color-fg)",
  fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)",
  cursor: "pointer",
};
