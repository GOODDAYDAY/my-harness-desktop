import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Search, FolderOpen, Pin, ChevronDown } from "lucide-react";
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

/** 一个来源路径(扫描根目录)。scope 只用于排序,不渲染成徽标。 */
interface SourcePath {
  key: string;
  scope: "user" | "project";
  count: number;
}

function scopeLabelOf(scope: "user" | "project", t: (key: string, opts?: Record<string, unknown>) => string): string {
  return scope === "user" ? t("settings.skillGlobal", { defaultValue: "全局" }) : t("settings.skillCurrentProject", { defaultValue: "当前项目" });
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
  // 路径筛选:存「被排除」的路径,空集合 = 全部路径全部选中(默认)。
  const [excludedPaths, setExcludedPaths] = useState<Set<string>>(() => new Set());
  // 路径筛选器展开/收起。
  const [pathOpen, setPathOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cwd = currentCwd || "";
      const [list, caps] = await Promise.all([
        ctx.skills.list(cwd),
        ctx.skills.getCapabilities(),
      ]);
      setSkills(list as SkillInfo[]);
      setCapabilities(caps as SkillCapabilities);
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

  // 所有扫描到的来源路径 = 技能 sourceDir 聚合(纯展示 + 过滤,不反推、不写死)。
  const sourcePaths = useMemo<SourcePath[]>(() => {
    const map = new Map<string, { scope: "user" | "project"; count: number }>();
    for (const s of skills) {
      const key = s.sourceDir || `__${s.scope}__`;
      const existing = map.get(key);
      if (existing) existing.count += 1;
      else map.set(key, { scope: s.scope, count: 1 });
    }
    return [...map.entries()]
      .map(([key, v]) => ({ key, scope: v.scope, count: v.count }))
      .sort((a, b) => (a.scope === b.scope ? a.key.localeCompare(b.key) : a.scope === "user" ? -1 : 1));
  }, [skills]);

  // 已排除项若不再存在(项目切换/目录消失),清掉失效 key,不静默保留。
  useEffect(() => {
    setExcludedPaths((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(sourcePaths.map((p) => p.key));
      const next = new Set([...prev].filter((k) => valid.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [sourcePaths]);

  // 第一层:路径过滤(排除集合为空 = 全部路径)。
  const pathFiltered = useMemo<SkillInfo[]>(() => {
    if (excludedPaths.size === 0) return skills;
    return skills.filter((s) => !excludedPaths.has(s.sourceDir || `__${s.scope}__`));
  }, [skills, excludedPaths]);

  const enabledCount = pathFiltered.filter((s) => s.enabled).length;

  // 第二层:启用/禁用筛选 + 搜索(name/description/路径)。
  const visibleSkills = useMemo<SkillInfo[]>(() => {
    let list = pathFiltered;
    if (filter === "enabled") list = list.filter((s) => s.enabled);
    else if (filter === "disabled") list = list.filter((s) => !s.enabled);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.sourceDir?.toLowerCase().includes(q) ?? false) ||
        (s.filePath?.toLowerCase().includes(q) ?? false)
      );
    }
    return [...list].sort((a, b) => {
      const sa = a.scope === "user" ? 0 : 1;
      const sb = b.scope === "user" ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const da = (a.sourceDir ?? "").localeCompare(b.sourceDir ?? "");
      if (da !== 0) return da;
      return a.name.localeCompare(b.name);
    });
  }, [pathFiltered, filter, search]);

  const toggleExclude = (key: string) => {
    setExcludedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllPaths = () => setExcludedPaths(new Set());

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

  if (loading && skills.length === 0) {
    return <div style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>Loading...</div>;
  }

  return (
    <div>
      <SettingsSection title={t("settings.skills", { defaultValue: "Skills" })} description={t("settings.skillHint", { defaultValue: "按来源路径筛选技能（默认全选，取消勾选即排除该路径）。路径由内核扫描回报、只读，技能开关按内核能力渲染，变更下次会话生效。" })}>

        {error && (
          <div style={{ marginBottom: "var(--spacing-sm)", padding: "var(--spacing-xs) var(--spacing-md)", borderRadius: "var(--radius-sm)", background: "rgba(192,122,122,0.15)", border: "1px solid var(--color-accent-error)", color: "var(--color-accent-error)", fontSize: "var(--font-size-sm)" }}>{error}</div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", marginBottom: "var(--spacing-md)", flexWrap: "wrap" }}>
          {(["all", "enabled", "disabled"] as const).map((f) => (
            <FilterButton key={f} active={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? t("settings.skillAll", { defaultValue: "全部" }) : f === "enabled" ? t("settings.skillEnabled", { defaultValue: "启用" }) : t("settings.skillDisabled", { defaultValue: "禁用" })}
              {" "}{f === "all" ? pathFiltered.length : f === "enabled" ? enabledCount : pathFiltered.length - enabledCount}
            </FilterButton>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ position: "relative" }}>
            <Search size={13} style={{ position: "absolute", left: "var(--spacing-sm)", top: "50%", transform: "translateY(-50%)", color: "var(--color-muted)", pointerEvents: "none" }} />
            <input
              style={{ ...inputStyle, paddingLeft: "var(--spacing-lg)", width: 220 }}
              placeholder={t("settings.skillSearch", { defaultValue: "搜索 name / description / 路径..." })}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <PathFilter
          paths={sourcePaths}
          excluded={excludedPaths}
          open={pathOpen}
          onToggleOpen={() => setPathOpen((o) => !o)}
          onToggleExclude={toggleExclude}
          onSelectAll={selectAllPaths}
          t={t}
        />

        {visibleSkills.length === 0 ? (
          <EmptyState title={search || excludedPaths.size > 0 || filter !== "all" ? t("settings.skillNoResults", { defaultValue: "没有匹配的 skill" }) : t("settings.skillEmpty", { defaultValue: "暂无 skills" })} />
        ) : (
          <SkillList
            skills={visibleSkills}
            capabilities={capabilities}
            onSetEnabled={handleSetEnabled}
            onSetModelInvocable={handleSetModelInvocable}
            onOpenFolder={(s) => void ctx.openFile(s.filePath ? s.filePath.slice(0, s.filePath.lastIndexOf("/")) : "")}
            t={t}
          />
        )}
      </SettingsSection>
      {toast && <Toast message={toast} onClose={() => setToast(null)} variant="success" />}
    </div>
  );
}

function PathFilter({ paths, excluded, open, onToggleOpen, onToggleExclude, onSelectAll, t }: {
  paths: SourcePath[];
  excluded: Set<string>;
  open: boolean;
  onToggleOpen: () => void;
  onToggleExclude: (key: string) => void;
  onSelectAll: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}): React.ReactNode {
  const allChecked = excluded.size === 0;
  const checkedCount = paths.length - excluded.size;
  const headerValue = allChecked
    ? t("settings.skillAllPaths", { defaultValue: "全部路径" })
    : t("settings.skillPathsSelected", { count: checkedCount, defaultValue: "已选 {{count}} 个路径" });

  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", marginBottom: "var(--spacing-md)", overflow: "hidden" }}>
      <div onClick={onToggleOpen} style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", padding: "var(--spacing-xs) var(--spacing-md)", cursor: "pointer" }}>
        <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", flexShrink: 0 }}>{t("settings.skillSourcePaths", { defaultValue: "来源路径" })}</span>
        <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-xs)", color: "var(--color-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{headerValue}</span>
        {!allChecked && (
          <button
            onClick={(e) => { e.stopPropagation(); onSelectAll(); }}
            style={{ border: "none", background: "transparent", color: "var(--color-primary)", cursor: "pointer", fontSize: "var(--font-size-xs)", padding: 0, flexShrink: 0 }}
          >
            {t("settings.skillSelectAllPaths", { defaultValue: "全选" })}
          </button>
        )}
        <ChevronDown size={14} style={{ color: "var(--color-muted)", flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </div>
      {open && (
        <div style={{ borderTop: "1px solid var(--color-border)", background: "var(--color-bg)", display: "flex", flexDirection: "column" }}>
          {paths.map((p) => (
            <label key={p.key} style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", padding: "var(--spacing-xs) var(--spacing-md)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={!excluded.has(p.key)}
                onChange={() => onToggleExclude(p.key)}
                style={{ accentColor: "var(--color-primary)", flexShrink: 0 }}
              />
              <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-xs)", color: "var(--color-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.key}>{p.key}</span>
              <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", flexShrink: 0 }}>{p.count}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function SkillList({ skills, capabilities, onSetEnabled, onSetModelInvocable, onOpenFolder, t }: {
  skills: SkillInfo[];
  capabilities: SkillCapabilities;
  onSetEnabled: (s: SkillInfo) => void;
  onSetModelInvocable: (s: SkillInfo) => void;
  onOpenFolder: (s: SkillInfo) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}): React.ReactNode {
  const page = usePagination(skills, PAGE_SIZE);
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
        {page.pageItems.map((skill) => (
          <SkillRow key={skill.filePath ?? skill.name} skill={skill} capabilities={capabilities} onSetEnabled={() => onSetEnabled(skill)} onSetModelInvocable={() => onSetModelInvocable(skill)} onOpenFolder={() => onOpenFolder(skill)} t={t} />
        ))}
      </div>
      {page.totalPages > 1 && <Pagination currentPage={page.currentPage} totalPages={page.totalPages} onPageChange={page.setCurrentPage} />}
    </>
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
            <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", padding: "1px 6px" }}>{scopeLabelOf(skill.scope, t)}</span>
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
