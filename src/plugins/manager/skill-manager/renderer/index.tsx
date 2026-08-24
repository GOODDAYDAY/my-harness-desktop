import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Search, FolderOpen, Pin } from "lucide-react";
import {
  SettingsSection,
  ListItem,
  EmptyState,
  Toast,
  type SettingsComponentProps,
  type SkillInfo,
  type SkillCapabilities,
  usePluginContext,
  Pagination,
  usePagination,
} from "@my-harness-desktop/react";
import { useUiStore } from "@my-harness-desktop/react";

// 结构化块:skill parser(auxParsers 代码级声明,plugins-host 加载时自动注册)+ 渲染器
// (manifest blockRenderers auxBlock/skill 按名自动匹配,必须在入口 re-export)。
export { auxParsers, SkillAuxBlock } from "./skill-aux";

const PAGE_SIZE = 20;

interface SkillGroup {
  key: string;
  sourceDir?: string;
  scope: "user" | "project";
  skills: SkillInfo[];
}

export function SkillManagerPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const currentCwd = useUiStore((s) => s.currentCwd);

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [capabilities, setCapabilities] = useState<SkillCapabilities>({ toggleEnabled: false, toggleModelInvocable: false });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bundled, setBundled] = useState<{ path: string; enabled: boolean } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cwd = currentCwd || "";
      const [list, caps, bundledInfo] = await Promise.all([
        ctx.skills.list(cwd),
        ctx.skills.getCapabilities(),
        ctx.skills.getBundled(),
      ]);
      setSkills(list as SkillInfo[]);
      setCapabilities(caps as SkillCapabilities);
      setBundled(bundledInfo);
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

  const groups = useMemo<SkillGroup[]>(() => {
    const map = new Map<string, SkillGroup>();
    for (const s of skills) {
      // 分组键:优先扫描根目录;旧播报数据无 sourceDir 时退化为 scope 分组。
      const key = s.sourceDir || `__${s.scope}__`;
      let g = map.get(key);
      if (!g) { g = { key, sourceDir: s.sourceDir, scope: s.scope, skills: [] }; map.set(key, g); }
      g.skills.push(s);
    }
    const out: SkillGroup[] = [];
    for (const g of map.values()) {
      let list = g.skills;
      if (filter === "enabled") list = list.filter((s) => s.enabled);
      else if (filter === "disabled") list = list.filter((s) => !s.enabled);
      if (search.trim()) {
        const q = search.toLowerCase();
        list = list.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
      }
      if (list.length === 0) continue;
      out.push({ ...g, skills: list });
    }
    out.sort((a, b) => (a.scope !== b.scope ? (a.scope === "user" ? -1 : 1) : (a.sourceDir ?? "").localeCompare(b.sourceDir ?? "")));
    return out;
  }, [skills, filter, search]);

  const enabledCount = skills.filter((s) => s.enabled).length;

  const mutate = (filePath: string | undefined, patch: Partial<SkillInfo>) => {
    setSkills((prev) => prev.map((s) => (s.filePath === filePath ? { ...s, ...patch } : s)));
  };

  const handleSetEnabled = async (skill: SkillInfo) => {
    const next = !skill.enabled;
    mutate(skill.filePath, { enabled: next });
    try {
      await ctx.skills.setEnabled(skill, next);
      setToast(t("settings.skillNextSession", { defaultValue: "变更将在下次会话生效" }));
    } catch (e) {
      mutate(skill.filePath, { enabled: !next });
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSetModelInvocable = async (skill: SkillInfo) => {
    const next = !skill.modelInvocable;
    mutate(skill.filePath, { modelInvocable: next });
    try {
      await ctx.skills.setModelInvocable(skill, next);
      setToast(t("settings.skillNextSession", { defaultValue: "变更将在下次会话生效" }));
    } catch (e) {
      mutate(skill.filePath, { modelInvocable: !next });
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleToggleBundled = async () => {
    if (!bundled) return;
    const next = !bundled.enabled;
    setBundled({ ...bundled, enabled: next });
    try {
      await ctx.skills.setBundledEnabled(next);
      setToast(t("settings.skillNextSession", { defaultValue: "变更将在下次会话生效" }));
      await refresh();
    } catch (e) {
      setBundled({ ...bundled, enabled: !next });
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading && skills.length === 0) {
    return <div style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>Loading...</div>;
  }

  return (
    <div>
      <SettingsSection title={t("settings.skills", { defaultValue: "Skills" })} description={t("settings.skillGroupHint", { defaultValue: "按扫描的文件夹分组。路径来源由内核扫描回报、只读；技能开关按内核能力渲染。变更下次会话生效。" })}>

        {error && (
          <div style={{ marginBottom: "var(--spacing-sm)", padding: "var(--spacing-xs) var(--spacing-md)", borderRadius: "var(--radius-sm)", background: "rgba(192,122,122,0.15)", border: "1px solid var(--color-accent-error)", color: "var(--color-accent-error)", fontSize: "var(--font-size-sm)" }}>{error}</div>
        )}

        {bundled && (
          <div style={{ marginBottom: "var(--spacing-md)", padding: "var(--spacing-xs) var(--spacing-md)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", display: "flex", alignItems: "center", gap: "var(--spacing-sm)", fontSize: "var(--font-size-sm)" }}>
            <span style={{ color: "var(--color-fg)", fontWeight: 500, flexShrink: 0 }}>{t("settings.skillBundled", { defaultValue: "内置 Skills" })}</span>
            <span style={{ flex: 1, fontFamily: "var(--font-family-mono)", color: "var(--color-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bundled.path}</span>
            <Toggle on={bundled.enabled} onClick={() => void handleToggleBundled()} title={t("settings.skillBundledHint", { defaultValue: "my-harness-desktop 自带 skills 的总开关(下次会话生效)" })} />
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", marginBottom: "var(--spacing-md)", flexWrap: "wrap" }}>
          {(["all", "enabled", "disabled"] as const).map((f) => (
            <FilterButton key={f} active={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? t("settings.skillAll", { defaultValue: "全部" }) : f === "enabled" ? t("settings.skillEnabled", { defaultValue: "启用" }) : t("settings.skillDisabled", { defaultValue: "禁用" })}
              {" "}{f === "all" ? skills.length : f === "enabled" ? enabledCount : skills.length - enabledCount}
            </FilterButton>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ position: "relative" }}>
            <Search size={13} style={{ position: "absolute", left: "var(--spacing-sm)", top: "50%", transform: "translateY(-50%)", color: "var(--color-muted)", pointerEvents: "none" }} />
            <input
              style={{ ...inputStyle, paddingLeft: "var(--spacing-lg)", width: 220 }}
              placeholder={t("settings.skillSearch", { defaultValue: "搜索..." })}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {groups.length === 0 ? (
          <EmptyState title={search ? t("settings.skillNoResults", { defaultValue: "没有匹配的 skill" }) : t("settings.skillEmpty", { defaultValue: "暂无 skills" })} />
        ) : (
          groups.map((g) => (
            <GroupSection
              key={g.key}
              sourceDir={g.sourceDir}
              scope={g.scope}
              skills={g.skills}
              capabilities={capabilities}
              search={search}
              onSetEnabled={handleSetEnabled}
              onSetModelInvocable={handleSetModelInvocable}
              onOpenFolder={(s) => void ctx.openFile(s.filePath ? s.filePath.slice(0, s.filePath.lastIndexOf("/")) : "")}
              t={t}
            />
          ))
        )}
      </SettingsSection>
      {toast && <Toast message={toast} onClose={() => setToast(null)} variant="success" />}
    </div>
  );
}

function GroupSection({ sourceDir, scope, skills, capabilities, search, onSetEnabled, onSetModelInvocable, onOpenFolder, t }: {
  sourceDir?: string;
  scope: "user" | "project";
  skills: SkillInfo[];
  capabilities: SkillCapabilities;
  search: string;
  onSetEnabled: (s: SkillInfo) => void;
  onSetModelInvocable: (s: SkillInfo) => void;
  onOpenFolder: (s: SkillInfo) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}): React.ReactNode {
  const page = usePagination(skills, PAGE_SIZE);
  const scopeLabel = scope === "user" ? t("settings.skillGlobal", { defaultValue: "全局" }) : t("settings.skillCurrentProject", { defaultValue: "当前项目" });
  // 无 sourceDir(旧播报数据)时退化为 scope 标题;有则显示扫描根目录 + scope 徽标。
  const title = sourceDir ?? scopeLabel;
  return (
    <div style={{ marginBottom: "var(--spacing-lg)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--spacing-sm)", marginBottom: "var(--spacing-sm)", flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--font-size-sm)", fontWeight: 600, color: "var(--color-fg)", fontFamily: sourceDir ? "var(--font-family-mono)" : undefined, wordBreak: sourceDir ? "break-all" : undefined }}>{title}</span>
        {sourceDir && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", padding: "1px 6px", flexShrink: 0 }}>{scopeLabel}</span>}
        <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>{skills.length}</span>
      </div>
      {page.pageItems.length === 0 ? (
        <EmptyState title={search ? t("settings.skillNoResults", { defaultValue: "没有匹配的 skill" }) : t("settings.skillEmpty", { defaultValue: "暂无 skills" })} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
          {page.pageItems.map((skill) => (
            <SkillRow key={skill.filePath} skill={skill} capabilities={capabilities} onSetEnabled={() => onSetEnabled(skill)} onSetModelInvocable={() => onSetModelInvocable(skill)} onOpenFolder={() => onOpenFolder(skill)} t={t} />
          ))}
        </div>
      )}
      {page.totalPages > 1 && <Pagination currentPage={page.currentPage} totalPages={page.totalPages} onPageChange={page.setCurrentPage} />}
    </div>
  );
}

function SkillRow({ skill, capabilities, onSetEnabled, onSetModelInvocable, onOpenFolder, t }: {
  skill: SkillInfo;
  capabilities: SkillCapabilities;
  onSetEnabled: () => void;
  onSetModelInvocable: () => void;
  onOpenFolder: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}): React.ReactNode {
  const [expanded, setExpanded] = useState(false);
  return (
    <ListItem style={{ opacity: skill.enabled ? 1 : 0.45 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)" }}>
        <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => setExpanded((e) => !e)}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", flexWrap: "wrap" }}>
            <span style={{ fontSize: "var(--font-size-sm)", fontWeight: 500, color: "var(--color-fg)" }}>{skill.name}</span>
            {skill.source && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", padding: "1px 6px" }}>{skill.source}</span>}
          </div>
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", opacity: 0.6, fontFamily: "var(--font-family-mono)", wordBreak: "break-all", marginTop: "var(--spacing-xxs)" }}>
            {skill.filePath}
          </div>
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", overflow: "hidden", maxHeight: expanded ? 200 : 20, transition: "max-height 0.3s ease", whiteSpace: expanded ? "normal" : "nowrap", textOverflow: expanded ? undefined : "ellipsis" }}>
            {skill.description}
          </div>
        </div>
        {capabilities.toggleEnabled && <Toggle on={skill.enabled} onClick={onSetEnabled} title={t("settings.skillToggleEnable", { defaultValue: "启用 / 禁用(下次会话生效)" })} />}
        {capabilities.toggleModelInvocable && <PinBox pinned={skill.modelInvocable} onClick={onSetModelInvocable} title={t("settings.skillToggleForce", { defaultValue: "固定到上下文:模型可自动调用" })} />}
        <button onClick={(e) => { e.stopPropagation(); onOpenFolder(); }} title={t("settings.skillOpenFolder", { defaultValue: "打开所在文件夹" })} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--color-muted)", cursor: "pointer", flexShrink: 0 }}>
          <FolderOpen size={14} />
        </button>
      </div>
    </ListItem>
  );
}

function PinBox({ pinned, onClick, title }: { pinned: boolean; onClick: () => void; title?: string }): React.ReactNode {
  return (
    <div onClick={(e) => { e.stopPropagation(); onClick(); }} title={title} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, flexShrink: 0, cursor: "pointer", border: `1px solid ${pinned ? "var(--color-primary)" : "var(--color-border)"}`, borderRadius: "var(--radius-sm)", background: pinned ? "var(--color-primary)" : "transparent", color: pinned ? "var(--color-primary-fg)" : "var(--color-muted)", opacity: pinned ? 1 : 0.45, transition: "background 0.15s, color 0.15s, opacity 0.15s" }}>
      <Pin size={14} />
    </div>
  );
}

function Toggle({ on, onClick, title }: { on: boolean; onClick: () => void; title?: string }): React.ReactNode {
  return (
    <div onClick={(e) => { e.stopPropagation(); onClick(); }} title={title} style={{ width: 28, height: 16, borderRadius: 8, background: on ? "var(--color-accent-success)" : "var(--color-muted)", position: "relative", flexShrink: 0, transition: "background 0.15s", cursor: "pointer" }}>
      <div style={{ width: 12, height: 12, borderRadius: "50%", background: "var(--color-bg)", position: "absolute", top: 2, left: on ? 14 : 2, transition: "left 0.15s" }} />
    </div>
  );
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.ReactNode {
  return (
    <button onClick={onClick} style={{ padding: "var(--spacing-xs) var(--spacing-md)", borderRadius: "var(--radius-sm)", border: `1px solid ${active ? "var(--color-primary)" : "var(--color-border)"}`, background: active ? "var(--color-primary)" : "transparent", color: active ? "var(--color-primary-fg)" : "var(--color-muted)", cursor: "pointer", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-family-sans)" }}>
      {children}
    </button>
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
