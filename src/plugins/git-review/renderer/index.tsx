// git-review 插件 renderer —— 右面板 Review 页签:工作区改动 + diff 视图。
//
// 子页签:本轮 / 本对话(空态,语义待 turn 级追踪)+ Git 工作区(真数据)。
// 数据:ctx.git(git:read 能力,manifest 已声明):status 列改动,fileDiff 出 unified
// diff 走 react-diff-view;未跟踪文件("?")无 diff,退到 fileContent 纯文本预览。
import { useEffect, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { GitBranch, RefreshCw, FileDiff } from "lucide-react";
import { parseDiff, Diff, Hunk } from "react-diff-view";
import { registerSidePanelComponent, usePluginContext, useUiStore, EmptyState } from "@pi-desktop/react";
import "react-diff-view/style/index.css";

const PLUGIN_ID = "git-review";
registerSidePanelComponent("GitReviewTab", GitReviewTab);

interface ChangedFile {
  path: string;
  status: string;
}

function GitReviewTab(): React.ReactNode {
  return (
    <Tabs.Root defaultValue="workspace" className="flex-1 flex flex-col min-h-0">
      <Tabs.List className="flex shrink-0 gap-1 px-2 pt-2">
        {["本轮", "本对话", "Git 工作区"].map((label, i) => (
          <Tabs.Trigger key={label} value={["turn", "session", "workspace"][i]} style={subTabStyle}>
            {label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content value="turn" className="flex-1 min-h-0 flex flex-col data-[state=inactive]:hidden">
        <EmptyState icon={<FileDiff className="size-8" />} title="暂无改动" description="本轮的文件改动追踪待接入" />
      </Tabs.Content>
      <Tabs.Content value="session" className="flex-1 min-h-0 flex flex-col data-[state=inactive]:hidden">
        <EmptyState icon={<FileDiff className="size-8" />} title="暂无改动" description="本对话累计的文件改动追踪待接入" />
      </Tabs.Content>
      <Tabs.Content value="workspace" className="flex-1 min-h-0 flex flex-col data-[state=inactive]:hidden">
        <WorkspaceView />
      </Tabs.Content>
    </Tabs.Root>
  );
}

function WorkspaceView(): React.ReactNode {
  const ctx = usePluginContext(PLUGIN_ID);
  const { currentCwd, activeSidePanelTab } = useUiStore();
  const [isRepo, setIsRepo] = useState(true);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // keep-alive 下只有本页签可见才刷(git status 要 spawn 进程,不可见不配刷)
  const visible = activeSidePanelTab === "review";

  const refresh = async (): Promise<void> => {
    if (!currentCwd) return;
    const r = await ctx.git.status(currentCwd);
    setIsRepo(r.isRepo);
    setFiles(r.files);
    setSelected((prev) => prev ?? (r.files.length > 0 ? r.files[0].path : null));
  };

  // 刷新时机:页签变可见 / cwd 变 / 手动刷新。会话切换不刷(工作区文件不因切会话而变)
  useEffect(() => {
    if (visible) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd, visible]);

  if (!currentCwd) return <EmptyState icon={<GitBranch className="size-8" />} title="先打开文件夹" />;
  if (!isRepo) return <EmptyState icon={<GitBranch className="size-8" />} title="不是 git 仓库" description={currentCwd} />;
  if (files.length === 0) return <EmptyState icon={<FileDiff className="size-8" />} title="暂无改动" description="工作区干净" />;

  return (
    <div className="flex-1 flex min-h-0">
      {/* 左:改动文件列表 */}
      <div className="w-44 shrink-0 flex flex-col border-r border-[var(--color-border)]">
        <div className="flex items-center justify-between px-2 py-1.5 text-[var(--font-size-sm)] text-[var(--color-muted)] shrink-0">
          <span>{files.length} 个文件</span>
          <button onClick={() => void refresh()} title="刷新" style={iconBtnStyle}>
            <RefreshCw className="size-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          {files.map((f) => (
            <div
              key={f.path}
              onClick={() => setSelected(f.path)}
              title={f.path}
              className="flex items-center gap-1.5 px-2 py-1 cursor-pointer truncate text-[var(--font-size-sm)]"
              style={{
                background: selected === f.path ? "var(--color-surface)" : "transparent",
                color: "var(--color-fg)",
              }}
            >
              <StatusBadge status={f.status} />
              <span className="truncate">{f.path}</span>
            </div>
          ))}
        </div>
      </div>
      {/* 右:diff 视图 */}
      <div className="flex-1 overflow-auto min-w-0 p-2">
        {selected && <DiffView key={selected} cwd={currentCwd} path={selected} status={files.find((f) => f.path === selected)?.status ?? "M"} />}
      </div>
    </div>
  );
}

function DiffView({ cwd, path, status }: { cwd: string; path: string; status: string }): React.ReactNode {
  const ctx = usePluginContext(PLUGIN_ID);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    setDiffText(null);
    setContent(null);
    if (status === "?") {
      void ctx.git.fileContent(cwd, path).then(setContent);
    } else {
      void ctx.git.fileDiff(cwd, path).then(setDiffText);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, path, status]);

  if (status === "?") {
    if (content === null) return <div className="text-[var(--color-muted)] text-sm p-2">加载中…</div>;
    return (
      <div>
        <div className="text-[var(--font-size-sm)] text-[var(--color-muted)] pb-1">新文件(未跟踪)</div>
        <pre className="text-xs font-[var(--font-family-mono)] whitespace-pre-wrap text-[var(--color-fg)]">{content}</pre>
      </div>
    );
  }
  if (diffText === null) return <div className="text-[var(--color-muted)] text-sm p-2">加载中…</div>;
  if (!diffText.trim()) return <div className="text-[var(--color-muted)] text-sm p-2">无 diff(可能已暂存与 HEAD 一致)</div>;

  const parsed = parseDiff(diffText);
  return (
    <div className="text-xs font-[var(--font-family-mono)]">
      {parsed.map((file, i) => (
        <Diff key={i} viewType="unified" diffType={file.type} hunks={file.hunks}>
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }): React.ReactNode {
  const color = status === "?" || status === "A"
    ? "var(--color-accent.success)"
    : status === "D"
      ? "var(--color-accent.error)"
      : "var(--color-accent.warning)";
  const label = status === "?" ? "A" : status;
  return (
    <span
      className="shrink-0 inline-flex items-center justify-center w-4 text-xs font-[var(--font-family-mono)]"
      style={{ color }}
    >
      {label}
    </span>
  );
}

const subTabStyle: React.CSSProperties = {
  padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)",
  fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)",
  cursor: "pointer",
};

const iconBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "22px", height: "22px", border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)", cursor: "pointer",
};
