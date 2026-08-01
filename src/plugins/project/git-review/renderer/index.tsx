// git-review 插件 renderer —— 右面板 Review 页签:工作区改动 + diff 视图。
//
// 子页签:本轮 / 本对话(空态,语义待 turn 级追踪)+ Git 工作区(真数据)。
// 数据:ctx.git(git:read 能力,manifest 已声明):status 列改动,fileDiff 出 unified
// diff 走 react-diff-view;未跟踪文件("?")无 diff,退到 fileContent 纯文本预览。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Tabs from "@radix-ui/react-tabs";
import { GitBranch, RefreshCw, FileDiff, ChevronRight } from "lucide-react";
import { parseDiff, Diff, Hunk } from "react-diff-view";
import {  usePluginContext, useUiStore, EmptyState } from "@pi-desktop/react";
import "react-diff-view/style/index.css";


interface ChangedFile {
  path: string;
  status: string;
}

// ---- 改动文件树:平铺路径列表 → 目录分组(单链子目录压缩成 a/b 一段) ----

interface TreeNode {
  name: string;      // 本段显示名(压缩后可能是 "i18n/locales")
  fullPath: string;  // 累计完整路径(叶子=文件路径,用于选择/diff)
  status?: string;   // 仅叶子节点有
  children: TreeNode[];
}

function buildTree(files: ChangedFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const f of files) {
    const parts = f.path.split("/");
    let level = root;
    for (let i = 0; i < parts.length; i++) {
      const fullPath = parts.slice(0, i + 1).join("/");
      const isLeaf = i === parts.length - 1;
      let node = level.find((n) => n.name === parts[i] && n.children.length >= 0 && (isLeaf ? n.children.length === 0 : true));
      if (!node) {
        node = { name: parts[i], fullPath, status: isLeaf ? f.status : undefined, children: [] };
        level.push(node);
      }
      if (isLeaf) node.status = f.status;
      level = node.children;
    }
  }
  // 单链子目录压缩:i18n > locales > de(只有 1 个子目录) 压成 "i18n/locales" 一段,减层级
  const compress = (nodes: TreeNode[]): TreeNode[] =>
    nodes.map((n) => {
      while (n.children.length === 1 && n.children[0].children.length > 0) {
        const child = n.children[0];
        n = { name: `${n.name}/${child.name}`, fullPath: child.fullPath, children: child.children };
      }
      return { ...n, children: compress(n.children) };
    });
  // 目录在前、按名字母序
  const sortNodes = (nodes: TreeNode[]): TreeNode[] =>
    [...nodes].sort((a, b) => {
      const aDir = a.children.length > 0 ? 0 : 1;
      const bDir = b.children.length > 0 ? 0 : 1;
      return aDir - bDir || a.name.localeCompare(b.name);
    }).map((n) => ({ ...n, children: sortNodes(n.children) }));
  return sortNodes(compress(root));
}

function countLeaves(node: TreeNode): number {
  if (node.children.length === 0) return 1;
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

export function GitReviewTab({ isActive }: { isActive: boolean }): React.ReactNode {
  const { t } = useTranslation();
  const tabs = [
    { label: t("system.thisTurn"), value: "turn" },
    { label: t("system.thisConversation"), value: "session" },
    { label: t("system.gitWorkspace"), value: "workspace" },
  ];
  return (
    <Tabs.Root defaultValue="workspace" className="flex-1 flex flex-col min-h-0">
      <Tabs.List className="flex shrink-0 gap-1 px-2 pt-2">
        {tabs.map((tab) => (
          <Tabs.Trigger key={tab.value} value={tab.value} style={subTabStyle}>
            {tab.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content value="turn" className="flex-1 min-h-0 flex flex-col data-[state=inactive]:hidden">
        <EmptyState icon={<FileDiff className="size-8" />} title={t("review.noChanges")} description={t("review.turnTrackPending")} />
      </Tabs.Content>
      <Tabs.Content value="session" className="flex-1 min-h-0 flex flex-col data-[state=inactive]:hidden">
        <EmptyState icon={<FileDiff className="size-8" />} title={t("review.noChanges")} description={t("review.sessionTrackPending")} />
      </Tabs.Content>
      <Tabs.Content value="workspace" className="flex-1 min-h-0 flex flex-col data-[state=inactive]:hidden">
        <WorkspaceView isActive={isActive} />
      </Tabs.Content>
    </Tabs.Root>
  );
}

function WorkspaceView({ isActive }: { isActive: boolean }): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const { currentCwd } = useUiStore();
  const [isRepo, setIsRepo] = useState(true);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(files), [files]);
  const visible = isActive;

  const toggleFolder = (fullPath: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  };

  const refresh = async (): Promise<void> => {
    if (!currentCwd) return;
    const r = await ctx.git!.status(currentCwd);
    setIsRepo(r.isRepo);
    setFiles(r.files);
    setSelected((prev) => prev ?? (r.files.length > 0 ? r.files[0].path : null));
  };

  // 刷新时机:页签变可见 / cwd 变 / 手动刷新。会话切换不刷(工作区文件不因切会话而变)
  useEffect(() => {
    if (visible) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd, visible]);

  if (!currentCwd) return <EmptyState icon={<GitBranch className="size-8" />} title={t("review.openFolderFirst")} />;
  if (!isRepo) return <EmptyState icon={<GitBranch className="size-8" />} title={t("review.notRepo")} description={currentCwd} />;
  if (files.length === 0) return <EmptyState icon={<FileDiff className="size-8" />} title={t("review.noChanges")} description={t("review.clean")} />;

  return (
    <div className="flex-1 flex min-h-0">
      {/* 左:改动文件列表 */}
      <div className="w-44 shrink-0 flex flex-col border-r border-[var(--color-border)]">
        <div className="flex items-center justify-between px-2 py-1.5 text-[var(--font-size-sm)] text-[var(--color-muted)] shrink-0">
          <span>{files.length} 个文件</span>
          <button onClick={() => void refresh()} title={t("common.refresh")} style={iconBtnStyle}>
            <RefreshCw className="size-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          {tree.map((node) => (
            <TreeRow
              key={node.fullPath}
              node={node}
              depth={0}
              selected={selected}
              collapsed={collapsed}
              onSelect={setSelected}
              onToggle={toggleFolder}
            />
          ))}
        </div>
      </div>
      {/* 右:diff 视图(顶栏显示当前文件路径,不然根本不知道在看哪个) */}
      <div className="flex-1 flex flex-col min-w-0">
        {selected && (
          <div className="shrink-0 px-2 py-1.5 border-b border-[var(--color-border)] text-xs font-[var(--font-family-mono)] text-[var(--color-muted)] truncate" title={selected}>
            {selected}
          </div>
        )}
        <div className="flex-1 overflow-auto p-2">
          {selected && <DiffView key={selected} cwd={currentCwd} path={selected} status={files.find((f) => f.path === selected)?.status ?? "M"} />}
        </div>
      </div>
    </div>
  );
}

function TreeRow({ node, depth, selected, collapsed, onSelect, onToggle }: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  collapsed: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (fullPath: string) => void;
}): React.ReactNode {
  const indent = `calc(var(--spacing-xs) + ${depth} * var(--spacing-md))`;
  const isFolder = node.children.length > 0;

  if (isFolder) {
    const open = !collapsed.has(node.fullPath);
    return (
      <div>
        <div
          onClick={() => onToggle(node.fullPath)}
          title={node.fullPath}
          className="flex items-center gap-1 py-1 pr-2 cursor-pointer text-[var(--font-size-sm)] text-[var(--color-fg)] hover:bg-[var(--color-surface)]"
          style={{ paddingLeft: indent }}
        >
          <ChevronRight className={`size-3 shrink-0 text-[var(--color-muted)] transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="truncate">{node.name}</span>
          <span className="ml-auto shrink-0 text-xs text-[var(--color-muted)]">{countLeaves(node)}</span>
        </div>
        {open && node.children.map((child) => (
          <TreeRow key={child.fullPath} node={child} depth={depth + 1} selected={selected} collapsed={collapsed} onSelect={onSelect} onToggle={onToggle} />
        ))}
      </div>
    );
  }

  return (
    <div
      onClick={() => onSelect(node.fullPath)}
      title={node.fullPath}
      className="flex items-center gap-1.5 py-1 pr-2 cursor-pointer truncate text-[var(--font-size-sm)] hover:bg-[var(--color-surface)]"
      style={{
        paddingLeft: indent,
        background: selected === node.fullPath ? "var(--color-surface)" : undefined,
        color: "var(--color-fg)",
      }}
    >
      <StatusBadge status={node.status ?? "M"} />
      <span className="truncate">{node.name}</span>
    </div>
  );
}

function DiffView({ cwd, path, status }: { cwd: string; path: string; status: string }): React.ReactNode {
  const ctx = usePluginContext();
  const [diffText, setDiffText] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    setDiffText(null);
    setContent(null);
    if (status === "?") {
      void ctx.git!.fileContent(cwd, path).then(setContent);
    } else {
      void ctx.git!.fileDiff(cwd, path).then(setDiffText);
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
  // token key color.accent.* 注入为 --color-accent-*(点号在 CSS 自定义属性名中非法)。
  const color = status === "?" || status === "A"
    ? "var(--color-accent-success)"
    : status === "D"
      ? "var(--color-accent-error)"
      : "var(--color-accent-warning)";
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
