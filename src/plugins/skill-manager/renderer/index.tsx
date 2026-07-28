import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  registerSettingsComponent,
  usePiApi,
  SettingsSection,
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

  useEffect(() => {
    void refresh();
  }, [refresh, refreshSignal]);

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

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleToggle = async (skill: SkillInfo) => {
    const newEnabled = !skill.enabled;
    setSkills((prev) => prev.map((s) =>
      s.filePath === skill.filePath ? { ...s, enabled: newEnabled } : s,
    ));
    try {
      await pi.skills.toggle({
        filePath: skill.filePath,
        sourcePath: skill.sourcePath,
        enabled: newEnabled,
        scope: skill.scope,
        cwd: currentCwd || "",
      });
      showToast(t("skill-manager.nextSession", { defaultValue: "变更将在下次会话生效" }));
    } catch (e) {
      setSkills((prev) => prev.map((s) =>
        s.filePath === skill.filePath ? { ...s, enabled: !newEnabled } : s,
      ));
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRemovePath = async (path: string, scope: "user" | "project") => {
    setError(null);
    try {
      await pi.skills.removePath({ path, scope, cwd: currentCwd || "" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading && skills.length === 0) {
    return <div style={{ color: "var(--color-muted)", padding: "24px" }}>Loading...</div>;
  }

  return (
    <SettingsSection title={t("skill-manager.title", { defaultValue: "Skills" })} description="">
      {error && (
        <div style={{ color: "var(--color.accent.error)", fontSize: 12, marginBottom: 8, padding: "8px 12px", border: "1px solid var(--color.accent.error)", borderRadius: 8 }}>
          {error}
        </div>
      )}

      {toast && (
        <div style={{ color: "var(--color.accent.success)", fontSize: 11, marginBottom: 8, padding: "6px 12px", border: "1px solid var(--color.accent.success)", borderRadius: 8, opacity: 0.8 }}>
          {toast}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
          {t("skill-manager.all", { defaultValue: "全部" })} {skills.length}
        </FilterButton>
        <FilterButton active={filter === "enabled"} onClick={() => setFilter("enabled")}>
          {t("skill-manager.enabled", { defaultValue: "启用" })} {enabledCount}
        </FilterButton>
        <FilterButton active={filter === "disabled"} onClick={() => setFilter("disabled")}>
          {t("skill-manager.disabled", { defaultValue: "禁用" })} {disabledCount}
        </FilterButton>
        <div style={{ flex: 1 }} />
        <input
          style={searchStyle}
          placeholder={t("skill-manager.search", { defaultValue: "搜索 name 或 description..." })}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
        />
      </div>

      {currentCwd && (
        <div style={bannerStyle}>
          <span style={{ color: "var(--color-muted)" }}>{t("skill-manager.currentProject", { defaultValue: "当前项目" })}</span>
          <span style={{ fontFamily: "var(--font-family-mono)", fontSize: 12, color: "var(--color.primary)" }}>{currentCwd}</span>
        </div>
      )}

      {pageItems.length === 0 ? (
        <div style={{ textAlign: "center", padding: "24px", color: "var(--color-muted)", fontSize: 12 }}>
          {search ? t("skill-manager.noResults", { defaultValue: "没有匹配的 skill" }) : t("skill-manager.empty", { defaultValue: "暂无 skills" })}
        </div>
      ) : (
        <>
          <div style={tableHeaderStyle}>
            <div style={{ width: 28 }} />
            <div style={{ flex: 2, fontSize: 11, color: "var(--color-muted)" }}>Name</div>
            <div style={{ flex: 2, fontSize: 11, color: "var(--color-muted)" }}>来源</div>
            <div style={{ flex: 3, fontSize: 11, color: "var(--color-muted)" }}>Description</div>
          </div>
          {pageItems.map((skill) => (
            <SkillRow key={skill.filePath} skill={skill} onToggle={() => handleToggle(skill)} />
          ))}
        </>
      )}

      {totalPages > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px 0", fontSize: 12, color: "var(--color-muted)" }}>
          <span>{currentPage * PAGE_SIZE + 1}-{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} / {filtered.length}</span>
          <div style={{ display: "flex", gap: 4 }}>
            <PageBtn disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>‹</PageBtn>
            {Array.from({ length: totalPages }, (_, i) => (
              <PageBtn key={i} active={i === currentPage} onClick={() => setPage(i)}>{i + 1}</PageBtn>
            ))}
            <PageBtn disabled={currentPage >= totalPages - 1} onClick={() => setPage(currentPage + 1)}>›</PageBtn>
          </div>
        </div>
      )}

      <div style={{ marginTop: 24, borderTop: "1px solid var(--color.border)", paddingTop: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{t("skill-manager.addSource", { defaultValue: "添加 Skill 路径来源" })}</div>
        <div style={{ fontSize: 12, color: "var(--color-muted)", marginBottom: 8 }}>
          {t("skill-manager.addSourceHint", { defaultValue: "user 级写入 ~/.pi/agent/settings.json，project 级写入 {cwd}/.pi/settings.json" })}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            style={{ ...searchStyle, flex: 1, fontFamily: "var(--font-family-mono)" }}
            placeholder="/Users/user/.claude/skills"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleAddPath(); }}
          />
          <select
            style={{ padding: "4px 8px", background: "var(--color.bg)", border: "1px solid var(--color.border)", borderRadius: 6, color: "var(--color.fg)", fontSize: 12 }}
            value={newScope}
            onChange={(e) => setNewScope(e.target.value as "user" | "project")}
          >
            <option value="user">user</option>
            <option value="project">project</option>
          </select>
          <button style={primaryBtnStyle} onClick={() => void handleAddPath()}>
            {t("skill-manager.add", { defaultValue: "添加" })}
          </button>
        </div>

        <div style={{ marginTop: 12 }}>
          <PathList label="user" paths={sourcePaths.user} onRemove={(p) => handleRemovePath(p, "user")} />
          <PathList label="project" paths={sourcePaths.project} onRemove={(p) => handleRemovePath(p, "project")} />
        </div>
      </div>
    </SettingsSection>
  );
}

function SkillRow({ skill, onToggle }: { skill: SkillInfo; onToggle: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 12px",
        borderRadius: 6,
        cursor: "pointer",
        opacity: skill.enabled ? 1 : 0.4,
      }}
      onClick={onToggle}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color.surface)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      <Toggle on={skill.enabled} />
      <div style={{ flex: 2, fontWeight: 500, fontSize: 13 }}>
        {skill.name}
        {skill.isSymlink && <span style={{ fontSize: 10, color: "var(--color.primary)", marginLeft: 4 }}>symlink</span>}
      </div>
      <div style={{ flex: 2, fontSize: 11, color: "var(--color-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {skill.sourcePath}
      </div>
      <div style={{ flex: 3, fontSize: 11, color: "var(--color.muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {skill.description}
      </div>
    </div>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <div
      style={{
        width: 28, height: 16, borderRadius: 8, background: on ? "var(--color.accent.success)" : "var(--color.border)",
        position: "relative", flexShrink: 0, transition: "background 0.15s", cursor: "pointer",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{
        width: 12, height: 12, borderRadius: "50%", background: "var(--color.fg)",
        position: "absolute", top: 2, left: on ? 14 : 2, transition: "left 0.15s",
      }} />
    </div>
  );
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      style={{
        padding: "4px 10px", borderRadius: 6, border: `1px solid ${active ? "var(--color.border)" : "var(--color.border)"}`,
        background: active ? "var(--color.surface)" : "transparent", color: active ? "var(--color.fg)" : "var(--color.muted)",
        cursor: "pointer", fontSize: 12,
      }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PageBtn({ active, disabled, onClick, children }: { active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      disabled={disabled}
      style={{
        width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center",
        border: `1px solid ${active ? "var(--color.border)" : "var(--color.border)"}`,
        borderRadius: 6, cursor: disabled ? "default" : "pointer",
        background: active ? "var(--color.surface)" : "transparent",
        color: disabled ? "var(--color.muted)" : active ? "var(--color.fg)" : "var(--color.muted)",
        fontSize: 12, opacity: disabled ? 0.3 : 1,
      }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PathList({ label, paths, onRemove }: { label: string; paths: string[]; onRemove: (p: string) => void }) {
  if (paths.length === 0) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: "var(--color.muted)", marginBottom: 4 }}>{label}</div>
      {paths.map((p) => (
        <div key={p} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
          <span style={{ flex: 1, fontFamily: "var(--font-family-mono)", fontSize: 12, color: "var(--color.fg)" }}>{p}</span>
          <button
            style={{ color: "var(--color.accent.error)", background: "transparent", border: "none", cursor: "pointer", fontSize: 12, padding: "2px 6px" }}
            onClick={() => onRemove(p)}
          >×</button>
        </div>
      ))}
    </div>
  );
}

const searchStyle: React.CSSProperties = {
  width: 200, padding: "4px 10px",
  background: "var(--color.bg)", border: "1px solid var(--color.border)", borderRadius: 6,
  color: "var(--color.fg)", fontSize: 12,
};

const primaryBtnStyle: React.CSSProperties = {
  padding: "4px 10px", borderRadius: 6,
  border: "1px solid var(--color.border)", background: "var(--color.surface)",
  color: "var(--color.fg)", cursor: "pointer", fontSize: 12,
};

const tableHeaderStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, padding: "6px 12px",
  borderBottom: "1px solid var(--color.border)", marginBottom: 2,
};

const bannerStyle: React.CSSProperties = {
  background: "var(--color.surface)", border: "1px solid var(--color.border)",
  borderRadius: 10, padding: "8px 14px", marginBottom: 12,
  display: "flex", alignItems: "center", gap: 8, fontSize: 12,
};
