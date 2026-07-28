import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Wrench, Plus, Trash2, RefreshCw, FileText, Terminal, Globe, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import {
  registerSettingsComponent,
  registerSidePanelComponent,
  usePluginContext,
  useUiStore,
  usePiApi,
  EmptyState,
  type SettingsComponentProps,
} from "@pi-desktop/react";
import type { SessionToolConfig as ISessionToolConfig } from "@pi-desktop/core";
import {
  BUILTIN_TOOLS,
  PRESET_GROUPS,
  getToolGroupsPath,
  computeDefaultGroupTools,
  computeEnabledToolIds,
  buildToolFilterInstruction,
  type KnownTool,
  type ToolGroup,
  type SessionToolConfig,
} from "./types";

const PLUGIN_ID = "tool-manager";

registerSettingsComponent("ToolManagerPage", ToolManagerPage);
registerSidePanelComponent("ToolPanelTab", ToolPanelTab);

function useDiscoveredTools(): KnownTool[] {
  const ctx = usePluginContext(PLUGIN_ID);
  const discoveredRef = useRef(new Map<string, KnownTool>());
  const [, force] = useState(0);

  useEffect(() => {
    const off = ctx.sessions.onEvent((event) => {
      if (event.type === "toolCallStart" && event.toolName) {
        const name = event.toolName as string;
        if (!discoveredRef.current.has(name) && !BUILTIN_TOOLS.some((t) => t.id === name)) {
          discoveredRef.current.set(name, { id: name, name, description: "", source: "builtin" });
          force((n) => n + 1);
        }
      }
    });
    return off;
  }, [ctx]);

  return [...BUILTIN_TOOLS, ...discoveredRef.current.values()];
}

function useToolGroups(cwd: string | null): {
  groups: ToolGroup[];
  loading: boolean;
  save: (groups: ToolGroup[]) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const api = usePiApi();
  const [groups, setGroups] = useState<ToolGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  const load = useCallback(async () => {
    if (!cwd) { setGroups([]); setLoading(false); return; }
    const path = getToolGroupsPath(cwd);
    try {
      const data = await api.configFile.get(path);
      if (data && Array.isArray(data.groups)) {
        setGroups(data.groups as ToolGroup[]);
      } else {
        const initial = { groups: PRESET_GROUPS };
        await api.configFile.set(path, initial, "replace");
        setGroups(PRESET_GROUPS);
      }
    } catch {
      setGroups(PRESET_GROUPS);
    }
    setLoading(false);
  }, [cwd, api]);

  refreshRef.current = load;

  const save = useCallback(async (newGroups: ToolGroup[]) => {
    if (!cwd) return;
    setGroups(newGroups);
    await api.configFile.set(getToolGroupsPath(cwd), { groups: newGroups }, "replace");
  }, [cwd, api]);

  useEffect(() => { void load(); }, [load]);

  return { groups, loading, save, refresh: () => refreshRef.current?.() ?? Promise.resolve() };
}

function useSessionToolConfig(sessionPath: string | null): {
  config: SessionToolConfig | null;
  save: (config: SessionToolConfig | null) => Promise<void>;
} {
  const api = usePiApi();
  const [config, setConfig] = useState<SessionToolConfig | null>(null);

  useEffect(() => {
    if (!sessionPath) { setConfig(null); return; }
    void api.sessions.readToolConfig(sessionPath).then((v) => {
      setConfig(v as SessionToolConfig | null);
    });
  }, [sessionPath, api]);

  const save = useCallback(async (newConfig: SessionToolConfig | null) => {
    if (!sessionPath) return;
    setConfig(newConfig);
    await api.sessions.updateHeader(sessionPath, { toolConfig: newConfig });
  }, [sessionPath, api]);

  return { config, save };
}

function ToolManagerPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const { currentCwd } = useUiStore();
  const allTools = useDiscoveredTools();
  const { groups, loading, save, refresh } = useToolGroups(currentCwd);
  const [view, setView] = useState<"groups" | "all-tools">("groups");
  const [editingGroup, setEditingGroup] = useState<ToolGroup | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (refreshSignal > 0) void refresh();
  }, [refreshSignal, refresh]);

  if (!currentCwd) {
    return <EmptyState icon={<Wrench className="size-8" />} title="请先打开项目目录" description="工具组配置存储在项目目录下" />;
  }
  if (loading) return null;

  const defaultGroupTools = computeDefaultGroupTools(allTools, groups);

  const handleDelete = async (id: string): Promise<void> => {
    await save(groups.filter((g) => g.id !== id));
  };

  const handleSaveGroup = async (group: ToolGroup): Promise<void> => {
    const existing = groups.findIndex((g) => g.id === group.id);
    const next = existing >= 0
      ? groups.map((g) => (g.id === group.id ? group : g))
      : [...groups, group];
    await save(next);
    setEditingGroup(null);
    setCreating(false);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex gap-2 mb-4 shrink-0">
        <button
          onClick={() => setView("groups")}
          style={view === "groups" ? tabActiveStyle : tabStyle}
        >
          工具组 ({groups.length})
        </button>
        <button
          onClick={() => setView("all-tools")}
          style={view === "all-tools" ? tabActiveStyle : tabStyle}
        >
          全部工具 ({allTools.length})
        </button>
      </div>

      {view === "groups" && (
        <div className="flex-1 overflow-y-auto min-h-0">
          {groups.map((g) => (
            <GroupCard
              key={g.id}
              group={g}
              toolCount={g.id === "__default__" ? defaultGroupTools.length : g.toolIds.length}
              onEdit={() => setEditingGroup(g)}
              onDelete={g.builtIn ? undefined : () => void handleDelete(g.id)}
            />
          ))}

          {creating || editingGroup ? (
            <GroupEditForm
              group={editingGroup}
              allTools={allTools}
              onSave={handleSaveGroup}
              onCancel={() => { setCreating(false); setEditingGroup(null); }}
            />
          ) : (
            <button
              onClick={() => setCreating(true)}
              style={createBtnStyle}
            >
              <Plus className="size-4" /> 新建工具组
            </button>
          )}
        </div>
      )}

      {view === "all-tools" && (
        <div className="flex-1 overflow-y-auto min-h-0">
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>工具名</th>
                <th style={thStyle}>描述</th>
                <th style={thStyle}>来源</th>
                <th style={thStyle}>所属组</th>
              </tr>
            </thead>
            <tbody>
              {allTools.map((tool) => {
                const group = groups.find((g) => g.toolIds.includes(tool.id));
                return (
                  <tr key={tool.id}>
                    <td style={tdMonoStyle}>{tool.id}</td>
                    <td style={tdStyle}>{tool.description || "—"}</td>
                    <td style={tdStyle}>
                      <span style={tool.source === "builtin" ? srcBuiltinStyle : srcExtStyle}>
                        {tool.source}
                      </span>
                    </td>
                    <td style={tdStyle}>{group?.name ?? "默认组"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function GroupCard({ group, toolCount, onEdit, onDelete }: {
  group: ToolGroup;
  toolCount: number;
  onEdit: () => void;
  onDelete?: () => void;
}): React.ReactNode {
  const icon = group.icon === "file-text" ? <FileText className="size-4" />
    : group.icon === "terminal" ? <Terminal className="size-4" />
    : group.icon === "globe" ? <Globe className="size-4" />
    : <Wrench className="size-4" />;

  return (
    <div style={groupCardStyle}>
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="font-semibold text-sm">{group.name}</span>
        {group.builtIn && <span style={badgeSystemStyle}>系统</span>}
        <span className="text-xs text-[var(--color-muted)] ml-auto">{toolCount} 个工具</span>
        <button onClick={onEdit} style={iconBtnStyle} title="编辑"><RefreshCw className="size-3" /></button>
        {onDelete && (
          <button onClick={onDelete} style={iconBtnDangerStyle} title="删除"><Trash2 className="size-3" /></button>
        )}
      </div>
      {group.description && <div className="text-xs text-[var(--color-muted)] mb-2">{group.description}</div>}
      <div className="flex flex-wrap gap-1">
        {group.toolIds.map((id) => (
          <span key={id} style={chipStyle}>{id}</span>
        ))}
      </div>
    </div>
  );
}

function GroupEditForm({ group, allTools, onSave, onCancel }: {
  group: ToolGroup | null;
  allTools: KnownTool[];
  onSave: (g: ToolGroup) => void;
  onCancel: () => void;
}): React.ReactNode {
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [toolIds, setToolIds] = useState<Set<string>>(new Set(group?.toolIds ?? []));

  const toggle = (id: string): void => {
    setToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = (): void => {
    const id = group?.id ?? `custom-${Date.now()}`;
    onSave({
      id,
      name: name || "未命名组",
      description,
      toolIds: [...toolIds],
      builtIn: group?.builtIn ?? false,
      icon: group?.icon,
    });
  };

  return (
    <div style={formStyle}>
      <div className="mb-2">
        <label style={labelStyle}>组名</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：安全沙箱（只读）"
          style={inputStyle}
        />
      </div>
      <div className="mb-2">
        <label style={labelStyle}>描述</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="这个组的用途…"
          style={inputStyle}
        />
      </div>
      <div className="mb-2">
        <label style={labelStyle}>包含工具</label>
        <div className="grid grid-cols-3 gap-1">
          {allTools.map((tool) => (
            <label
              key={tool.id}
              onClick={() => toggle(tool.id)}
              style={toolToggleStyle(toolIds.has(tool.id))}
            >
              <span style={cbStyle(toolIds.has(tool.id))}>{toolIds.has(tool.id) ? "✓" : ""}</span>
              <span className="font-[var(--font-family-mono)] text-xs">{tool.id}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex gap-2 mt-3">
        <button onClick={handleSave} style={btnPrimaryStyle}>保存</button>
        <button onClick={onCancel} style={btnGhostStyle}>取消</button>
      </div>
    </div>
  );
}

function ToolPanelTab(): React.ReactNode {
  const ctx = usePluginContext(PLUGIN_ID);
  const { currentCwd, currentSessionPath, activeSidePanelTabs } = useUiStore();
  const allTools = useDiscoveredTools();
  const { groups, loading, save: saveGroups } = useToolGroups(currentCwd);
  const { config, save: saveConfig } = useSessionToolConfig(currentSessionPath);
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const visible = activeSidePanelTabs.includes("tools");

  useEffect(() => {
    if (config?.mode === "custom" && config.enabledGroupIds) {
      setEnabledIds(new Set(config.enabledGroupIds));
    } else {
      setEnabledIds(new Set(groups.map((g) => g.id)));
    }
  }, [config, groups]);

  const mode: "all" | "custom" = config?.mode ?? "all";

  const toggleGroup = (id: string): void => {
    setEnabledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleApply = async (): Promise<void> => {
    if (mode === "all") {
      await saveConfig({ mode: "custom", enabledGroupIds: [...enabledIds] });
    } else {
      await saveConfig({ mode: "custom", enabledGroupIds: [...enabledIds] });
    }
  };

  const handleSwitchAll = async (): Promise<void> => {
    await saveConfig(null);
    setEnabledIds(new Set(groups.map((g) => g.id)));
  };

  if (!currentCwd) {
    return <EmptyState icon={<Wrench className="size-8" />} title="请先打开项目目录" />;
  }
  if (loading) return null;

  const defaultIds = computeDefaultGroupTools(allTools, groups);
  const enabledToolIds = computeEnabledToolIds(groups, [...enabledIds], allTools);
  const totalTools = allTools.length;
  const disabledCount = totalTools - enabledToolIds.length;

  const showAllGroups = [...groups];
  if (!showAllGroups.some((g) => g.id === "__default__")) {
    showAllGroups.push({
      id: "__default__",
      name: "默认组",
      description: "未被其他组收录的工具",
      toolIds: defaultIds,
      builtIn: true,
    });
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 p-3 gap-2 overflow-y-auto">
      <div className="flex items-center gap-2 shrink-0">
        <Wrench className="size-4 text-[var(--color-muted)]" />
        <span className="text-sm text-[var(--color-muted)]">当前会话</span>
        <span className="text-xs font-[var(--font-family-mono)] truncate">{currentSessionPath?.split("/").pop() ?? "—"}</span>
      </div>

      <div className="flex gap-0 rounded-md border border-[var(--color-border)] overflow-hidden shrink-0">
        <button
          onClick={handleSwitchAll}
          style={mode === "all" ? modeActiveStyle : modeStyle}
        >
          全部工具
        </button>
        <button
          onClick={() => {
            if (mode === "all") {
              void saveConfig({ mode: "custom", enabledGroupIds: [...enabledIds] });
            }
          }}
          style={mode === "custom" ? modeActiveStyle : modeStyle}
        >
          自定义
        </button>
      </div>

      {mode === "all" ? (
        <div className="text-xs text-[var(--color-muted)] py-2">所有可用工具均可使用，不做任何限制。</div>
      ) : (
        <>
          <div className="flex items-center gap-1.5 text-xs text-[var(--color-accent-warning)] py-1 shrink-0">
            <AlertTriangle className="size-3" />
            <span>软过滤：LLM 可能不遵守限制</span>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0">
            {showAllGroups.map((g) => {
              const isOn = enabledIds.has(g.id);
              const toolList = g.id === "__default__" ? defaultIds : g.toolIds;
              return (
                <div key={g.id} className="py-2 border-b border-[var(--color-border)] last:border-b-0">
                  <div className="flex items-start gap-2">
                    <div
                      onClick={() => toggleGroup(g.id)}
                      style={toggleSwitchStyle(isOn)}
                    >
                      <div style={toggleKnobStyle(isOn)} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div
                        className="flex items-center gap-1 cursor-pointer"
                        onClick={() => setExpanded(expanded === g.id ? null : g.id)}
                      >
                        {expanded === g.id ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                        <span className={`text-sm font-medium ${isOn ? "" : "text-[var(--color-muted)]"}`}>{g.name}</span>
                        <span className="text-xs text-[var(--color-muted)] ml-auto">{toolList.length}</span>
                      </div>
                      {expanded === g.id && (
                        <div className="flex flex-wrap gap-1 mt-1 ml-4">
                          {toolList.map((id) => (
                            <span key={id} style={chipStyle}>{id}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-3 text-xs shrink-0 py-1">
            <div className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent-success)]" />
              <span className="text-[var(--color-accent-success)]">{enabledToolIds.length} 可用</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent-error)]" />
              <span className="text-[var(--color-accent-error)]">{disabledCount} 禁用</span>
            </div>
          </div>

          <button onClick={() => void handleApply()} style={applyBtnStyle}>
            应用到当前会话
          </button>
          <div className="text-xs text-[var(--color-muted)] text-center">下次发送消息时生效</div>
        </>
      )}
    </div>
  );
}

const tabStyle: React.CSSProperties = {
  padding: "var(--spacing-xs) var(--spacing-md)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--color-muted)",
  fontSize: "var(--font-size-sm)",
  cursor: "pointer",
};
const tabActiveStyle: React.CSSProperties = {
  ...tabStyle,
  background: "var(--color-surface)",
  color: "var(--color-fg)",
  borderColor: "var(--color-border)",
};
const groupCardStyle: React.CSSProperties = {
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  padding: "var(--spacing-md)",
  marginBottom: "var(--spacing-sm)",
  background: "var(--color-surface)",
};
const badgeSystemStyle: React.CSSProperties = {
  fontSize: "10px",
  padding: "2px 6px",
  borderRadius: "var(--radius-sm)",
  background: "rgba(74,194,107,0.15)",
  color: "var(--color-accent-success)",
};
const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: "11px",
  padding: "2px 6px",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-bg)",
  border: "1px solid var(--color-border)",
  fontFamily: "var(--font-family-mono)",
};
const iconBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "22px",
  height: "22px",
  border: "none",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--color-muted)",
  cursor: "pointer",
};
const iconBtnDangerStyle: React.CSSProperties = {
  ...iconBtnStyle,
  color: "var(--color-accent-error)",
};
const createBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--spacing-xs)",
  padding: "var(--spacing-sm) var(--spacing-md)",
  border: "1px dashed var(--color-border)",
  borderRadius: "var(--radius-md)",
  background: "transparent",
  color: "var(--color-muted)",
  fontSize: "var(--font-size-sm)",
  cursor: "pointer",
  width: "100%",
};
const formStyle: React.CSSProperties = {
  border: "1px dashed var(--color-border)",
  borderRadius: "var(--radius-md)",
  padding: "var(--spacing-md)",
  marginTop: "var(--spacing-sm)",
};
const labelStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "var(--color-muted)",
  display: "block",
  marginBottom: "4px",
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-bg)",
  color: "var(--color-fg)",
  fontSize: "13px",
};
const toolToggleStyle = (checked: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: "6px",
  fontSize: "12px",
  padding: "4px 8px",
  borderRadius: "var(--radius-sm)",
  background: checked ? "var(--color-surface)" : "transparent",
  border: "1px solid var(--color-border)",
  cursor: "pointer",
  opacity: checked ? 1 : 0.6,
});
const cbStyle = (checked: boolean): React.CSSProperties => ({
  width: "14px",
  height: "14px",
  borderRadius: "3px",
  border: checked ? "1.5px solid var(--color-accent-success)" : "1.5px solid var(--color-muted)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "10px",
  color: "var(--color-bg)",
  background: checked ? "var(--color-accent-success)" : "transparent",
  fontWeight: "bold" as const,
  flexShrink: 0,
});
const btnPrimaryStyle: React.CSSProperties = {
  padding: "6px 14px",
  border: "none",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-primary)",
  color: "var(--color-primary-fg)",
  fontSize: "12px",
  cursor: "pointer",
};
const btnGhostStyle: React.CSSProperties = {
  padding: "6px 14px",
  border: "none",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--color-muted)",
  fontSize: "12px",
  cursor: "pointer",
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: "11px",
  color: "var(--color-muted)",
  padding: "6px 12px",
  borderBottom: "1px solid var(--color-border)",
  textTransform: "uppercase",
};
const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: "13px",
  borderBottom: "1px solid rgba(255,255,255,0.03)",
};
const tdMonoStyle: React.CSSProperties = {
  ...tdStyle,
  fontFamily: "var(--font-family-mono)",
};
const srcBuiltinStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "var(--color-accent-success)",
};
const srcExtStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "var(--color-primary)",
};
const modeStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px",
  textAlign: "center",
  fontSize: "12px",
  cursor: "pointer",
  background: "var(--color-surface)",
  color: "var(--color-muted)",
  border: "none",
};
const modeActiveStyle: React.CSSProperties = {
  ...modeStyle,
  color: "var(--color-primary)",
  background: "var(--color-bg)",
};
const toggleSwitchStyle = (on: boolean): React.CSSProperties => ({
  width: "32px",
  height: "18px",
  borderRadius: "9px",
  background: on ? "var(--color-accent-success)" : "var(--color-border)",
  position: "relative",
  flexShrink: 0,
  cursor: "pointer",
  transition: "background 0.2s",
});
const toggleKnobStyle = (on: boolean): React.CSSProperties => ({
  position: "absolute",
  width: "14px",
  height: "14px",
  borderRadius: "50%",
  background: "var(--color-fg)",
  top: "2px",
  left: on ? "16px" : "2px",
  transition: "left 0.2s",
});
const applyBtnStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px",
  border: "none",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-primary)",
  color: "var(--color-primary-fg)",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
};
