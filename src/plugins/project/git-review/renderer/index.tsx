// git-review 插件 renderer —— 右面板 Review 页签:AI 改动审查 + 最小提交出口。
//
// 三个子页签:本轮(最近一个有改动的轮次)/ 本对话(轮次分组)/ Git 工作区(真数据 + commit/push)。
// 轮次追踪:useSessionStore messages 纯推导(user 消息切轮 + toolCallsOf 取 write/edit 的
// args.path,toolCallsOf 是 domain 唯一源);diff 走 ctx.git(git:read);commit/push 走
// ctx.gitWrite(git:write);AI commit message 走 ctx.llm.oneshot(llm:oneshot)。
// 语义边界(如实标注在轮次页脚):diff 是工作区当前状态,会话前已脏文件含会话前改动;
// bash 命令改动的文件追踪不到。
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Tabs from "@radix-ui/react-tabs";
import { GitBranch, RefreshCw, FileDiff, ChevronRight, Sparkles, History } from "lucide-react";
import { parseDiff, Diff, Hunk } from "react-diff-view";
import {
  usePluginContext, useUiStore, useSessionStore, EmptyState, toolCallsOf,
  type NeutralMessage, type GitChangedFile, type GitLogEntry,
} from "@my-harness-desktop/react";
import { messageContentText } from "@my-harness-desktop/contract";
import "react-diff-view/style/index.css";

// ---- 轮次推导:messages → [{ index, label, files }] ----

interface TurnEntry {
  index: number;
  label: string;
  files: string[];
}

function deriveTurns(messages: NeutralMessage[]): TurnEntry[] {
  const turns: TurnEntry[] = [];
  let current: TurnEntry | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      const firstLine = messageContentText(m.content).split("\n")[0]?.trim();
      current = { index: turns.length + 1, label: firstLine || `#${turns.length + 1}`, files: [] };
      turns.push(current);
      continue;
    }
    if (m.role !== "assistant" || !current) continue;
    for (const tc of toolCallsOf(m.content)) {
      if (tc.name !== "write" && tc.name !== "edit") continue;
      const p = (tc.args as { path?: unknown } | undefined)?.path;
      if (typeof p === "string" && p && !current.files.includes(p)) current.files.push(p);
    }
  }
  return turns.filter((t) => t.files.length > 0);
}

// ---- 工作区状态:status 地图(三视图共用),streaming 收尾(true→false)自动重刷 ----

function useWorkspace(cwd: string | null, visible: boolean): {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitChangedFile[];
  refresh: () => Promise<void>;
} {
  const ctx = usePluginContext();
  const { streaming } = useSessionStore();
  const [isRepo, setIsRepo] = useState(true);
  const [branch, setBranch] = useState<string | null>(null);
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [files, setFiles] = useState<GitChangedFile[]>([]);
  const prevStreaming = useRef(false);

  const refresh = async (): Promise<void> => {
    if (!cwd) return;
    const r = await ctx.git!.status(cwd);
    setIsRepo(r.isRepo);
    setBranch(r.branch);
    setAhead(r.ahead);
    setBehind(r.behind);
    setFiles(r.files);
  };

  useEffect(() => {
    if (visible) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, visible]);

  useEffect(() => {
    if (prevStreaming.current && !streaming && visible) void refresh();
    prevStreaming.current = streaming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, visible]);

  return { isRepo, branch, ahead, behind, files, refresh };
}

// ---- 改动文件树:平铺路径列表 → 目录分组(单链子目录压缩成 a/b 一段) ----

interface ChangedFile {
  path: string;
  status: string;
}

interface TreeNode {
  name: string;
  fullPath: string;
  status?: string;
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
  const compress = (nodes: TreeNode[]): TreeNode[] =>
    nodes.map((n) => {
      while (n.children.length === 1 && n.children[0].children.length > 0) {
        const child = n.children[0];
        n = { name: `${n.name}/${child.name}`, fullPath: child.fullPath, children: child.children };
      }
      return { ...n, children: compress(n.children) };
    });
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

// ---- 顶层:三个子页签 ----

export function GitReviewTab({ isActive }: { isActive: boolean }): React.ReactNode {
  const { t } = useTranslation();
  const [subTab, setSubTab] = useState("workspace");
  const tabs = [
    { label: t("system.thisTurn"), value: "turn" },
    { label: t("system.thisConversation"), value: "session" },
    { label: t("system.gitWorkspace"), value: "workspace" },
  ];
  return (
    <Tabs.Root value={subTab} onValueChange={setSubTab} className="flex-1 flex flex-col min-h-0">
      <Tabs.List className="flex shrink-0 gap-1 px-2 pt-2">
        {tabs.map((tab) => (
          <Tabs.Trigger key={tab.value} value={tab.value} style={subTabStyle}>
            {tab.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content value="turn" className="flex-1 min-h-0 flex flex-col data-[state=inactive]:hidden">
        <TurnView isActive={isActive && subTab === "turn"} />
      </Tabs.Content>
      <Tabs.Content value="session" className="flex-1 min-h-0 flex flex-col data-[state=inactive]:hidden">
        <SessionView isActive={isActive && subTab === "session"} />
      </Tabs.Content>
      <Tabs.Content value="workspace" className="flex-1 min-h-0 flex flex-col data-[state=inactive]:hidden">
        <WorkspaceView isActive={isActive && subTab === "workspace"} />
      </Tabs.Content>
    </Tabs.Root>
  );
}

// ---- 本轮:最近一个有文件改动的轮次 ----

function TurnView({ isActive }: { isActive: boolean }): React.ReactNode {
  const { t } = useTranslation();
  const { currentCwd } = useUiStore();
  const { messages } = useSessionStore();
  const turns = useMemo(() => deriveTurns(messages), [messages]);
  const current = turns[turns.length - 1] ?? null;

  if (!currentCwd) return <EmptyState icon={<GitBranch className="size-8" />} title={t("review.openFolderFirst")} />;
  if (!current) return <EmptyState icon={<FileDiff className="size-8" />} title={t("review.noTurnChanges")} />;
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 px-2 py-1 text-xs text-[var(--color-muted)] truncate" title={current.label}>
        #{current.index} {current.label}
      </div>
      <FilesDiffPanel cwd={currentCwd} files={current.files} isActive={isActive} />
      <TurnNote text={t("review.turnDiffNote")} />
    </div>
  );
}

// ---- 本对话:轮次分组(可折叠) ----

function SessionView({ isActive }: { isActive: boolean }): React.ReactNode {
  const { t } = useTranslation();
  const { currentCwd } = useUiStore();
  const { messages } = useSessionStore();
  const turns = useMemo(() => deriveTurns(messages), [messages]);
  const [openTurn, setOpenTurn] = useState<number | null>(null);
  const effectiveOpen = openTurn ?? turns[turns.length - 1]?.index ?? null;
  const openEntry = turns.find((x) => x.index === effectiveOpen) ?? null;

  if (!currentCwd) return <EmptyState icon={<GitBranch className="size-8" />} title={t("review.openFolderFirst")} />;
  if (turns.length === 0) return <EmptyState icon={<FileDiff className="size-8" />} title={t("review.noSessionChanges")} />;
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 overflow-y-auto border-b border-[var(--color-border)]" style={{ maxHeight: "30%" }}>
        {turns.map((turn) => (
          <div key={turn.index}>
            <div
              onClick={() => setOpenTurn(turn.index === effectiveOpen ? null : turn.index)}
              title={turn.label}
              className="flex items-center gap-1 px-2 py-1 cursor-pointer text-[length:var(--font-size-sm)] text-[var(--color-fg)] hover:bg-[var(--color-surface)]"
            >
              <ChevronRight className={`size-3 shrink-0 text-[var(--color-muted)] transition-transform ${turn.index === effectiveOpen ? "rotate-90" : ""}`} />
              <span className="truncate">#{turn.index} {turn.label}</span>
              <span className="ml-auto shrink-0 text-xs text-[var(--color-muted)]">{turn.files.length}</span>
            </div>
          </div>
        ))}
      </div>
      {openEntry && <FilesDiffPanel cwd={currentCwd} files={openEntry.files} isActive={isActive} />}
      <TurnNote text={t("review.turnDiffNote")} />
    </div>
  );
}

function TurnNote({ text }: { text: string }): React.ReactNode {
  return (
    <div className="shrink-0 px-2 py-1 border-t border-[var(--color-border)] text-xs text-[var(--color-muted)]">
      {text}
    </div>
  );
}

// ---- 轮次视图的共用体:左文件列表 + 右 diff ----

function FilesDiffPanel({ cwd, files, isActive }: { cwd: string; files: string[]; isActive: boolean }): React.ReactNode {
  const { streaming } = useSessionStore();
  const [selected, setSelected] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Map<string, string>>(new Map());
  const ctx = usePluginContext();
  const effective = selected && files.includes(selected) ? selected : files[0] ?? null;
  const prevStreaming = useRef(false);

  const refreshStatus = async (): Promise<void> => {
    const r = await ctx.git!.status(cwd);
    setStatusMap(new Map(r.files.map((f) => [f.path, f.index === "?" ? "?" : f.index.trim() || f.worktree.trim() || "M"])));
  };
  useEffect(() => {
    if (isActive) void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, isActive, JSON.stringify(files)]);
  useEffect(() => {
    if (prevStreaming.current && !streaming && isActive) void refreshStatus();
    prevStreaming.current = streaming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, isActive]);

  return (
    <div className="flex-1 flex min-h-0">
      <div className="w-44 shrink-0 flex flex-col border-r border-[var(--color-border)]">
        <div className="flex-1 overflow-y-auto min-h-0">
          {files.map((p) => (
            <div
              key={p}
              onClick={() => setSelected(p)}
              title={p}
              className="flex items-center gap-1.5 py-1 px-2 cursor-pointer truncate text-[length:var(--font-size-sm)] hover:bg-[var(--color-surface)]"
              style={{ background: effective === p ? "var(--color-surface)" : undefined, color: "var(--color-fg)" }}
            >
              <StatusBadge status={statusMap.get(p) ?? "M"} />
              <span className="truncate">{p.split("/").pop()}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        {effective && (
          <div className="shrink-0 px-2 py-1.5 border-b border-[var(--color-border)] text-xs font-[var(--font-family-mono)] text-[var(--color-muted)] truncate" title={effective}>
            {effective}
          </div>
        )}
        <div className="flex-1 overflow-auto p-2">
          {effective && <DiffView key={effective} cwd={cwd} path={effective} status={statusMap.get(effective) ?? "M"} />}
        </div>
      </div>
    </div>
  );
}

// ---- Git 工作区:分支条 + 分组勾选 + commit 区 + 最近提交 ----

function WorkspaceView({ isActive }: { isActive: boolean }): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const { currentCwd } = useUiStore();
  const { streaming } = useSessionStore();
  const { isRepo, branch, ahead, behind, files, refresh } = useWorkspace(currentCwd, isActive);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"commit" | "push" | "generate" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);

  const staged = files.filter((f) => f.index !== " " && f.index !== "?").map((f) => ({ path: f.path, status: f.index.trim() }));
  const unstaged = files.filter((f) => f.worktree !== " " && f.index !== "?").map((f) => ({ path: f.path, status: f.worktree.trim() }));
  const untracked = files.filter((f) => f.index === "?").map((f) => ({ path: f.path, status: "?" }));
  const statusOf = (path: string): string => {
    const f = files.find((x) => x.path === path);
    if (!f) return "M";
    return f.index === "?" ? "?" : f.index.trim() || f.worktree.trim() || "M";
  };

  const refreshLog = async (): Promise<void> => {
    if (!currentCwd) return;
    setLogEntries(await ctx.git!.log(currentCwd, 10));
  };
  useEffect(() => {
    if (isActive && isRepo) void refreshLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd, isActive, isRepo]);

  useEffect(() => {
    if (!selected && files.length > 0) setSelected(files[0].path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.length]);

  const toggleFolder = (fullPath: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  };
  const toggleCheck = (path: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const generateMessage = async (): Promise<void> => {
    if (!currentCwd || checked.size === 0) return;
    setBusy("generate");
    setActionError(null);
    try {
      const DIFF_BUDGET = 48_000;
      const parts: string[] = [];
      let total = 0;
      let truncated = false;
      for (const path of [...checked].sort()) {
        const body = statusOf(path) === "?"
          ? `--- new file: ${path} ---\n${await ctx.git!.fileContent(currentCwd, path)}`
          : `--- ${path} ---\n${await ctx.git!.fileDiff(currentCwd, path)}`;
        if (total + body.length > DIFF_BUDGET) { truncated = true; break; }
        parts.push(body);
        total += body.length;
      }
      const diff = parts.join("\n") + (truncated ? t("review.truncatedNote") : "");
      const prompt = t("review.commitPrompt").replace("{{diff}}", diff);
      const text = await ctx.llm!.oneshot(prompt);
      setMessage(text.split("\n")[0]?.trim().replace(/^["']|["']$/g, "") ?? "");
    } catch (err) {
      setActionError(t("review.generateFailed", { error: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  const doCommit = async (): Promise<void> => {
    if (!currentCwd || checked.size === 0 || !message.trim()) return;
    setBusy("commit");
    setActionError(null);
    const r = await ctx.gitWrite!.commit(currentCwd, message.trim(), [...checked].sort());
    setBusy(null);
    if (!r.ok) {
      setActionError(t("review.commitFailed", { error: r.error ?? "" }));
      return;
    }
    setMessage("");
    setChecked(new Set());
    await refresh();
    await refreshLog();
  };

  const doPush = async (): Promise<void> => {
    if (!currentCwd) return;
    setBusy("push");
    setActionError(null);
    const r = await ctx.gitWrite!.push(currentCwd);
    setBusy(null);
    if (!r.ok) {
      setActionError(t("review.pushFailed", { error: r.error ?? "" }));
      return;
    }
    await refresh();
  };

  if (!currentCwd) return <EmptyState icon={<GitBranch className="size-8" />} title={t("review.openFolderFirst")} />;
  if (!isRepo) return <EmptyState icon={<GitBranch className="size-8" />} title={t("review.notRepo")} description={currentCwd} />;

  const writeDisabled = streaming || busy !== null;
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 分支条:分支名 + ahead/behind + 推送 */}
      <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-[var(--color-border)] text-[length:var(--font-size-sm)]">
        <GitBranch className="size-3.5 shrink-0 text-[var(--color-muted)]" />
        <span className="text-[var(--color-fg)] truncate">{branch ?? "-"}</span>
        {ahead > 0 && <span className="text-xs text-[var(--color-muted)]">↑{ahead}</span>}
        {behind > 0 && <span className="text-xs text-[var(--color-muted)]">↓{behind}</span>}
        <span className="ml-auto flex items-center gap-1">
          <button onClick={() => { void refresh(); void refreshLog(); }} title={t("common.refresh")} style={iconBtnStyle}>
            <RefreshCw className="size-3.5" />
          </button>
          <button
            onClick={() => void doPush()}
            disabled={writeDisabled || ahead === 0}
            title={t("review.push")}
            style={{ ...textBtnStyle, opacity: writeDisabled || ahead === 0 ? 0.5 : 1 }}
          >
            {busy === "push" ? t("review.pushing") : t("review.push")}
          </button>
        </span>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* 左:分组勾选列表 + 最近提交 + commit 区 */}
        <div className="w-52 shrink-0 flex flex-col border-r border-[var(--color-border)] min-h-0">
          {files.length === 0 ? (
            <div className="px-2 py-2 text-[length:var(--font-size-sm)] text-[var(--color-muted)]">{t("review.clean")}</div>
          ) : (
            <div className="flex-1 overflow-y-auto min-h-0">
              <CheckGroup title={t("review.groupStaged")} files={staged} {...{ checked, collapsed, selected, toggleCheck, toggleFolder, onSelect: setSelected }} />
              <CheckGroup title={t("review.groupChanges")} files={unstaged} {...{ checked, collapsed, selected, toggleCheck, toggleFolder, onSelect: setSelected }} />
              <CheckGroup title={t("review.groupUntracked")} files={untracked} {...{ checked, collapsed, selected, toggleCheck, toggleFolder, onSelect: setSelected }} />
            </div>
          )}

          {/* 最近提交(折叠) */}
          <div className="shrink-0 border-t border-[var(--color-border)]">
            <div
              onClick={() => setLogOpen((v) => !v)}
              className="flex items-center gap-1 px-2 py-1 cursor-pointer text-[length:var(--font-size-sm)] text-[var(--color-muted)] hover:bg-[var(--color-surface)]"
            >
              <ChevronRight className={`size-3 shrink-0 transition-transform ${logOpen ? "rotate-90" : ""}`} />
              <History className="size-3.5 shrink-0" />
              <span>{t("review.recentCommits")}</span>
            </div>
            {logOpen && (
              <div className="max-h-36 overflow-y-auto pb-1">
                {logEntries.map((c) => (
                  <div key={c.hash} title={`${c.hash}\n${c.message}`} className="flex items-baseline gap-1.5 px-2 py-0.5 text-xs">
                    <span className="shrink-0 font-[var(--font-family-mono)] text-[var(--color-muted)]">{c.hash.slice(0, 7)}</span>
                    <span className="truncate text-[var(--color-fg)]">{c.message.split("\n")[0]}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* commit 区:勾选即隐式 add */}
          <div className="shrink-0 border-t border-[var(--color-border)] p-2 flex flex-col gap-1.5">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("review.commitPlaceholder")}
              rows={2}
              style={messageInputStyle}
            />
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => void generateMessage()}
                disabled={writeDisabled || checked.size === 0}
                title={t("review.generate")}
                style={{ ...iconTextBtnStyle, opacity: writeDisabled || checked.size === 0 ? 0.5 : 1 }}
              >
                <Sparkles className="size-3.5" />
                {busy === "generate" ? t("review.generating") : t("review.generate")}
              </button>
              <button
                onClick={() => void doCommit()}
                disabled={writeDisabled || checked.size === 0 || !message.trim()}
                style={{ ...textBtnStyle, opacity: writeDisabled || checked.size === 0 || !message.trim() ? 0.5 : 1 }}
              >
                {busy === "commit" ? t("review.committing") : `${t("review.commit")} (${checked.size})`}
              </button>
            </div>
            {actionError && <div className="text-xs text-[var(--color-accent-error)] whitespace-pre-wrap">{actionError}</div>}
          </div>
        </div>

        {/* 右:diff 视图 */}
        <div className="flex-1 flex flex-col min-w-0">
          {selected && (
            <div className="shrink-0 px-2 py-1.5 border-b border-[var(--color-border)] text-xs font-[var(--font-family-mono)] text-[var(--color-muted)] truncate" title={selected}>
              {selected}
            </div>
          )}
          <div className="flex-1 overflow-auto p-2">
            {selected && <DiffView key={selected} cwd={currentCwd} path={selected} status={statusOf(selected)} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- 分组(已暂存/更改/未跟踪):标题 + 文件树(带 checkbox) ----

function CheckGroup({ title, files, checked, collapsed, selected, toggleCheck, toggleFolder, onSelect }: {
  title: string;
  files: ChangedFile[];
  checked: Set<string>;
  collapsed: Set<string>;
  selected: string | null;
  toggleCheck: (path: string) => void;
  toggleFolder: (fullPath: string) => void;
  onSelect: (path: string) => void;
}): React.ReactNode {
  const tree = useMemo(() => buildTree(files), [files]);
  if (files.length === 0) return null;
  return (
    <div>
      <div className="px-2 pt-1.5 pb-0.5 text-xs text-[var(--color-muted)]">{title} ({files.length})</div>
      {tree.map((node) => (
        <CheckTreeRow
          key={node.fullPath}
          node={node}
          depth={0}
          checked={checked}
          collapsed={collapsed}
          selected={selected}
          toggleCheck={toggleCheck}
          toggleFolder={toggleFolder}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function CheckTreeRow({ node, depth, checked, collapsed, selected, toggleCheck, toggleFolder, onSelect }: {
  node: TreeNode;
  depth: number;
  checked: Set<string>;
  collapsed: Set<string>;
  selected: string | null;
  toggleCheck: (path: string) => void;
  toggleFolder: (fullPath: string) => void;
  onSelect: (path: string) => void;
}): React.ReactNode {
  const indent = `calc(var(--spacing-xs) + ${depth} * var(--spacing-md))`;
  const isFolder = node.children.length > 0;

  if (isFolder) {
    const open = !collapsed.has(node.fullPath);
    return (
      <div>
        <div
          onClick={() => toggleFolder(node.fullPath)}
          title={node.fullPath}
          className="flex items-center gap-1 py-1 pr-2 cursor-pointer text-[length:var(--font-size-sm)] text-[var(--color-fg)] hover:bg-[var(--color-surface)]"
          style={{ paddingLeft: indent }}
        >
          <ChevronRight className={`size-3 shrink-0 text-[var(--color-muted)] transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="truncate">{node.name}</span>
          <span className="ml-auto shrink-0 text-xs text-[var(--color-muted)]">{countLeaves(node)}</span>
        </div>
        {open && node.children.map((child) => (
          <CheckTreeRow key={child.fullPath} node={child} depth={depth + 1} checked={checked} collapsed={collapsed} selected={selected} toggleCheck={toggleCheck} toggleFolder={toggleFolder} onSelect={onSelect} />
        ))}
      </div>
    );
  }

  return (
    <div
      onClick={() => onSelect(node.fullPath)}
      title={node.fullPath}
      className="flex items-center gap-1.5 py-1 pr-2 cursor-pointer truncate text-[length:var(--font-size-sm)] hover:bg-[var(--color-surface)]"
      style={{ paddingLeft: indent, background: selected === node.fullPath ? "var(--color-surface)" : undefined, color: "var(--color-fg)" }}
    >
      <input
        type="checkbox"
        checked={checked.has(node.fullPath)}
        onClick={(e) => e.stopPropagation()}
        onChange={() => toggleCheck(node.fullPath)}
        className="shrink-0 accent-[var(--color-primary)]"
      />
      <StatusBadge status={node.status ?? "M"} />
      <span className="truncate">{node.name}</span>
    </div>
  );
}

// ---- diff 视图(未跟踪退纯文本预览) ----

function DiffView({ cwd, path, status }: { cwd: string; path: string; status: string }): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
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
    if (content === null) return <div className="text-[var(--color-muted)] text-sm p-2">{t("review.loading")}</div>;
    return (
      <div>
        <div className="text-[length:var(--font-size-sm)] text-[var(--color-muted)] pb-1">{t("review.newFileUntracked")}</div>
        <pre className="text-xs font-[var(--font-family-mono)] whitespace-pre-wrap text-[var(--color-fg)]">{content}</pre>
      </div>
    );
  }
  if (diffText === null) return <div className="text-[var(--color-muted)] text-sm p-2">{t("review.loading")}</div>;
  if (!diffText.trim()) return <div className="text-[var(--color-muted)] text-sm p-2">{t("review.noDiff")}</div>;

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

const textBtnStyle: React.CSSProperties = {
  padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "none", borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)", color: "var(--color-fg)",
  fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)",
  cursor: "pointer", whiteSpace: "nowrap",
};

const iconTextBtnStyle: React.CSSProperties = {
  ...textBtnStyle,
  display: "flex", alignItems: "center", gap: "var(--spacing-xs)",
};

const messageInputStyle: React.CSSProperties = {
  width: "100%", resize: "none",
  border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-fg)",
  fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)",
  padding: "var(--spacing-xs) var(--spacing-sm)",
};
