import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Plus, X, Link2, Search, FolderOpen, Zap } from "lucide-react";
import {
  SettingsSection,
  ListItem,
  EmptyState,
  Toast,
  Button,
  Select,
  type SettingsComponentProps,
  type SkillInfo,
  usePluginContext,
} from "@pi-desktop/react";
import { useUiStore } from "@pi-desktop/react";


const PAGE_SIZE = 20;

export function SkillManagerPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const currentCwd = useUiStore((s) => s.currentCwd);

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newPath, setNewPath] = useState("");
  const [newScope, setNewScope] = useState<"user" | "project">("user");
  const [sourcePaths, setSourcePaths] = useState<{ user: string[]; project: string[] }>({ user: [], project: [] });

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cwd = currentCwd || "";
      const [list, paths] = await Promise.all([
        ctx.skills.list(cwd),
        ctx.skills.getSourcePaths(cwd),
      ]);
      setSkills(list as SkillInfo[]);
      setSourcePaths(paths);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [ctx, currentCwd]);

  useEffect(() => { void refresh(); }, [refresh, refreshSignal]);

  useEffect(() => {
    if (!currentCwd) return;
    const unwatch = ctx.skills.watch(currentCwd, () => { void refresh(); });
    return unwatch;
  }, [ctx, currentCwd, refresh]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevPageRef = useRef(page);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (page > prevPageRef.current) el.scrollTop = 0;
    else if (page < prevPageRef.current) el.scrollTop = el.scrollHeight;
    prevPageRef.current = page;
  }, [page]);

  const filtered = useMemo(() => {
    let result = skills;
    if (filter === "enabled") result = result.filter((s) => s.enabled);
    else if (filter === "disabled") result = result.filter((s) => !s.enabled);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((s) =>
        s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
      );
    }
    return result;
  }, [skills, filter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageItems = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const enabledCount = skills.filter((s) => s.enabled).length;
  const disabledCount = skills.length - enabledCount;

  const handleToggle = async (skill: SkillInfo) => {
    const newEnabled = !skill.enabled;
    setSkills((prev) => prev.map((s) => s.filePath === skill.filePath ? { ...s, enabled: newEnabled } : s));
    try {
      await ctx.skills.toggle({ filePath: skill.filePath, sourcePath: skill.sourcePath, enabled: newEnabled, scope: skill.scope, cwd: currentCwd || "" });
      setToast(t("settings.skillNextSession", { defaultValue: "变更将在下次会话生效" }));
    } catch (e) {
      setSkills((prev) => prev.map((s) => s.filePath === skill.filePath ? { ...s, enabled: !newEnabled } : s));
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleToggleForce = async (skill: SkillInfo) => {
    const newForce = !skill.disableModelInvocation;
    setSkills((prev) => prev.map((s) => s.filePath === skill.filePath ? { ...s, disableModelInvocation: !newForce } : s));
    try {
      await ctx.skills.toggleForce({ filePath: skill.filePath, force: newForce });
      setToast(t("settings.skillNextSession", { defaultValue: "变更将在下次会话生效" }));
    } catch (e) {
      setSkills((prev) => prev.map((s) => s.filePath === skill.filePath ? { ...s, disableModelInvocation: newForce } : s));
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleAddPath = async () => {
    if (!newPath.trim()) return;
    setError(null);
    try {
      await ctx.skills.addPath({ path: newPath.trim(), scope: newScope, cwd: currentCwd || "" });
      setNewPath("");
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const handleRemovePath = async (path: string, scope: "user" | "project") => {
    setError(null);
    try {
      await ctx.skills.removePath({ path, scope, cwd: currentCwd || "" });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (loading && skills.length === 0) {
    return <div style={{ padding: "var(--spacing-xl)", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>Loading...</div>;
  }

  return (
    <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)" }}>
      <SettingsSection title={t("settings.skills", { defaultValue: "Skills" })} description={t("settings.skillAddSourceHint", { defaultValue: "pi 从下方路径扫描 SKILL.md。toggle 写入 settings.json 的 skills[] 模式条目。新增会话时生效。" })}>

        {error && (
          <div style={{ marginBottom: "var(--spacing-sm)", padding: "var(--spacing-xs) var(--spacing-md)", borderRadius: "var(--radius-sm)", background: "rgba(192,122,122,0.15)", border: "1px solid var(--color-accent-error)", color: "var(--color-accent-error)", fontSize: "var(--font-size-sm)" }}>{error}</div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", marginBottom: "var(--spacing-md)", flexWrap: "wrap" }}>
          {(["all", "enabled", "disabled"] as const).map((f) => (
            <FilterButton key={f} active={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? t("settings.skillAll", { defaultValue: "全部" }) : f === "enabled" ? t("settings.skillEnabled", { defaultValue: "启用" }) : t("settings.skillDisabled", { defaultValue: "禁用" })}
              {" "}{f === "all" ? skills.length : f === "enabled" ? enabledCount : disabledCount}
            </FilterButton>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ position: "relative" }}>
            <Search size={13} style={{ position: "absolute", left: "var(--spacing-sm)", top: "50%", transform: "translateY(-50%)", color: "var(--color-muted)", pointerEvents: "none" }} />
            <input
              style={{ ...inputStyle, paddingLeft: "var(--spacing-lg)", width: 220 }}
              placeholder={t("settings.skillSearch", { defaultValue: "搜索..." })}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            />
          </div>
        </div>

        {currentCwd && (
          <div style={{ marginBottom: "var(--spacing-md)", padding: "var(--spacing-xs) var(--spacing-md)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", display: "flex", alignItems: "center", gap: "var(--spacing-sm)", fontSize: "var(--font-size-sm)" }}>
            <span style={{ color: "var(--color-muted)" }}>{t("settings.skillCurrentProject", { defaultValue: "当前项目" })}</span>
            <span style={{ fontFamily: "var(--font-family-mono)", color: "var(--color-primary)" }}>{currentCwd}</span>
          </div>
        )}

        {pageItems.length === 0 ? (
          <EmptyState title={search ? t("settings.skillNoResults", { defaultValue: "没有匹配的 skill" }) : t("settings.skillEmpty", { defaultValue: "暂无 skills" })} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
            {pageItems.map((skill) => (
              <SkillRow key={skill.filePath} skill={skill} onToggle={() => handleToggle(skill)} onToggleForce={() => handleToggleForce(skill)} onOpenFolder={() => void ctx.openFile(skill.baseDir)} />
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "var(--spacing-sm)", marginTop: "var(--spacing-lg)" }}>
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={currentPage === 0} style={iconBtn(currentPage === 0)}>
              <ChevronLeft size={14} />
            </button>
            {Array.from({ length: totalPages }, (_, i) => (
              <button key={i} onClick={() => setPage(i)} style={{ ...iconBtn(i !== currentPage), border: `1px solid ${i === currentPage ? "var(--color-primary)" : "var(--color-border)"}`, background: i === currentPage ? "var(--color-primary)" : "transparent", color: i === currentPage ? "var(--color-primary-fg)" : "var(--color-muted)" }}>
                {i + 1}
              </button>
            ))}
            <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={currentPage >= totalPages - 1} style={iconBtn(currentPage >= totalPages - 1)}>
              <ChevronRight size={14} />
            </button>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t("settings.skillAddSource", { defaultValue: "添加路径来源" })} description={t("settings.skillAddSourceHint", { defaultValue: "user 级写入 ~/.pi/agent/settings.json，project 级写入 {cwd}/.pi/settings.json" })}>
        <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <input
            style={{ ...inputStyle, flex: 1, fontFamily: "var(--font-family-mono)" }}
            placeholder="/Users/user/.claude/skills"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleAddPath(); }}
          />
          <Select value={newScope} onChange={(v) => setNewScope(v as "user" | "project")} ariaLabel="scope">
            <option value="user">user</option>
            <option value="project">project</option>
          </Select>
          <Button variant="primary" onClick={() => void handleAddPath()} disabled={!newPath.trim()}>
            <Plus size={14} />
            <span>{t("settings.skillAdd", { defaultValue: "添加" })}</span>
          </Button>
        </div>

        {(sourcePaths.user.length > 0 || sourcePaths.project.length > 0) && (
          <div style={{ marginTop: "var(--spacing-md)", display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
            {sourcePaths.user.length > 0 && (
              <PathList label="user" paths={sourcePaths.user} onRemove={(p) => handleRemovePath(p, "user")} />
            )}
            {sourcePaths.project.length > 0 && (
              <PathList label="project" paths={sourcePaths.project} onRemove={(p) => handleRemovePath(p, "project")} />
            )}
          </div>
        )}
      </SettingsSection>
      {toast && <Toast message={toast} onClose={() => setToast(null)} variant="success" />}
    </div>
  );
}

function SkillRow({ skill, onToggle, onToggleForce, onOpenFolder }: { skill: SkillInfo; onToggle: () => void; onToggleForce: () => void; onOpenFolder: () => void }): React.ReactNode {
  const [expanded, setExpanded] = useState(false);
  return (
    <ListItem style={{ opacity: skill.enabled ? 1 : 0.45 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)" }}>
        <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => setExpanded((e) => !e)}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
            <span style={{ fontSize: "var(--font-size-sm)", fontWeight: 500, color: "var(--color-fg)" }}>{skill.name}</span>
            {skill.isSymlink && <Link2 size={11} style={{ color: "var(--color-muted)" }} />}
          </div>
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", opacity: 0.6, fontFamily: "var(--font-family-mono)", wordBreak: "break-all", marginTop: "var(--spacing-xxs)" }}>
            {skill.baseDir}
          </div>
          <div style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-muted)",
            overflow: "hidden",
            maxHeight: expanded ? 200 : 20,
            transition: "max-height 0.3s ease",
            whiteSpace: expanded ? "normal" : "nowrap",
            textOverflow: expanded ? undefined : "ellipsis",
          }}>
            {skill.description}
          </div>
        </div>
        <Toggle on={skill.enabled} onClick={onToggle} />
        <Toggle on={!skill.disableModelInvocation} onClick={onToggleForce} activeColor="var(--color-primary)" title="强制进入上下文" />
        <button onClick={(e) => { e.stopPropagation(); onOpenFolder(); }} title="打开文件夹" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--color-muted)", cursor: "pointer", flexShrink: 0 }}>
          <FolderOpen size={14} />
        </button>
      </div>
    </ListItem>
  );
}

function Toggle({ on, onClick, activeColor = "var(--color-accent-success)", title }: { on: boolean; onClick: () => void; activeColor?: string; title?: string }): React.ReactNode {
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      style={{ width: 28, height: 16, borderRadius: 8, background: on ? activeColor : "var(--color-border)", position: "relative", flexShrink: 0, transition: "background 0.15s", cursor: "pointer" }}
    >
      <div style={{ width: 12, height: 12, borderRadius: "50%", background: "var(--color-fg)", position: "absolute", top: 2, left: on ? 14 : 2, transition: "left 0.15s" }} />
    </div>
  );
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.ReactNode {
  return (
    <button onClick={onClick} style={{
      padding: "var(--spacing-xs) var(--spacing-md)",
      borderRadius: "var(--radius-sm)",
      border: `1px solid ${active ? "var(--color-primary)" : "var(--color-border)"}`,
      background: active ? "var(--color-primary)" : "transparent",
      color: active ? "var(--color-primary-fg)" : "var(--color-muted)",
      cursor: "pointer", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-family-sans)",
    }}>
      {children}
    </button>
  );
}

function PathList({ label, paths, onRemove }: { label: string; paths: string[]; onRemove: (p: string) => void }): React.ReactNode {
  return (
    <div>
      <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", marginBottom: "var(--spacing-xs)" }}>{label}</div>
      {paths.map((p) => (
        <div key={p} style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", padding: "var(--spacing-xs) 0" }}>
          <span style={{ flex: 1, fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)", color: "var(--color-fg)" }}>{p}</span>
          <button onClick={() => onRemove(p)} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--color-accent-error)", cursor: "pointer" }}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-bg)",
  color: "var(--color-fg)",
  fontSize: "var(--font-size-sm)",
  fontFamily: "var(--font-family-sans)",
  outline: "none",
};

function iconBtn(disabled = false): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 28, height: 28,
    border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
    background: "transparent", color: "var(--color-muted)",
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
  };
}
