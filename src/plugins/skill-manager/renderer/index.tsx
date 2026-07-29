import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Plus, X, Link2, Search } from "lucide-react";
import {
  registerSettingsComponent,
  usePiApi,
  SettingsSection,
  ListItem,
  EmptyState,
  type SettingsComponentProps,
  type SkillInfo,
} from "@pi-desktop/react";
import { useUiStore } from "@pi-desktop/react";

registerSettingsComponent("SkillManagerPage", SkillManagerPage);

const PAGE_SIZE = 20;

export function SkillManagerPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const pi = usePiApi();
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
        pi.skills.list(cwd),
        pi.skills.getSourcePaths(cwd),
      ]);
      setSkills(list as SkillInfo[]);
      setSourcePaths(paths);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [pi, currentCwd]);

  useEffect(() => { void refresh(); }, [refresh, refreshSignal]);

  useEffect(() => {
    if (!currentCwd) return;
    const unwatch = pi.skills.watch(currentCwd, () => { void refresh(); });
    return unwatch;
  }, [pi, currentCwd]);

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

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const handleToggle = async (skill: SkillInfo) => {
    const newEnabled = !skill.enabled;
    setSkills((prev) => prev.map((s) => s.filePath === skill.filePath ? { ...s, enabled: newEnabled } : s));
    try {
      await pi.skills.toggle({ filePath: skill.filePath, sourcePath: skill.sourcePath, enabled: newEnabled, scope: skill.scope, cwd: currentCwd || "" });
      showToast(t("settings.skillNextSession", { defaultValue: "变更将在下次会话生效" }));
    } catch (e) {
      setSkills((prev) => prev.map((s) => s.filePath === skill.filePath ? { ...s, enabled: !newEnabled } : s));
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleAddPath = async () => {
    if (!newPath.trim()) return;
    setError(null);
    try {
      await pi.skills.addPath({ path: newPath.trim(), scope: newScope, cwd: currentCwd || "" });
      setNewPath("");
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const handleRemovePath = async (path: string, scope: "user" | "project") => {
    setError(null);
    try {
      await pi.skills.removePath({ path, scope, cwd: currentCwd || "" });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (loading && skills.length === 0) {
    return <div style={{ padding: "var(--spacing-xl)", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>Loading...</div>;
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)" }}>
      <SettingsSection title={t("settings.skills", { defaultValue: "Skills" })} description={t("settings.skillAddSourceHint", { defaultValue: "pi 从下方路径扫描 SKILL.md。toggle 写入 settings.json 的 skills[] 模式条目。新增会话时生效。" })}>

        {error && (
          <div style={{ marginBottom: "var(--spacing-sm)", padding: "var(--spacing-xs) var(--spacing-md)", borderRadius: "var(--radius-sm)", background: "rgba(192,122,122,0.15)", border: "1px solid var(--color-accent-error)", color: "var(--color-accent-error)", fontSize: "var(--font-size-sm)" }}>{error}</div>
        )}
        {toast && (
          <div style={{ marginBottom: "var(--spacing-sm)", padding: "var(--spacing-xs) var(--spacing-md)", borderRadius: "var(--radius-sm)", background: "rgba(74,194,107,0.12)", border: "1px solid var(--color-accent-success)", color: "var(--color-accent-success)", fontSize: "var(--font-size-sm)" }}>{toast}</div>
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
              <SkillRow key={skill.filePath} skill={skill} onToggle={() => handleToggle(skill)} />
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
          <select style={selectStyle} value={newScope} onChange={(e) => setNewScope(e.target.value as "user" | "project")}>
            <option value="user">user</option>
            <option value="project">project</option>
          </select>
          <button onClick={() => void handleAddPath()} disabled={!newPath.trim()} style={btnStyle(true, !newPath.trim())}>
            <Plus size={14} />
            <span>{t("settings.skillAdd", { defaultValue: "添加" })}</span>
          </button>
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
    </div>
  );
}

function SkillRow({ skill, onToggle }: { skill: SkillInfo; onToggle: () => void }): React.ReactNode {
  return (
    <ListItem style={{ opacity: skill.enabled ? 1 : 0.45 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
            <span style={{ fontSize: "var(--font-size-sm)", fontWeight: 500, color: "var(--color-fg)" }}>{skill.name}</span>
            {skill.isSymlink && <Link2 size={11} style={{ color: "var(--color-muted)" }} />}
          </div>
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }} title={skill.description}>
            {skill.description}
          </div>
        </div>
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", fontFamily: "var(--font-family-mono)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }} title={skill.sourcePath}>
          {skill.sourcePath}
        </div>
        <Toggle on={skill.enabled} onClick={onToggle} />
      </div>
    </ListItem>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }): React.ReactNode {
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{ width: 28, height: 16, borderRadius: 8, background: on ? "var(--color-accent-success)" : "var(--color-border)", position: "relative", flexShrink: 0, transition: "background 0.15s", cursor: "pointer" }}
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

const selectStyle: React.CSSProperties = {
  padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
  color: "var(--color-fg)",
  fontSize: "var(--font-size-sm)",
  fontFamily: "var(--font-family-sans)",
};

function btnStyle(primary: boolean, disabled = false): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: "var(--spacing-xs)",
    padding: "var(--spacing-xs) var(--spacing-md)",
    border: `1px solid ${primary ? "var(--color-primary)" : "var(--color-border)"}`,
    borderRadius: "var(--radius-sm)",
    background: primary ? "var(--color-primary)" : "transparent",
    color: primary ? "var(--color-primary-fg)" : "var(--color-fg)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)",
    opacity: disabled ? 0.5 : 1,
  };
}

function iconBtn(disabled = false): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 28, height: 28,
    border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
    background: "transparent", color: "var(--color-muted)",
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
  };
}
