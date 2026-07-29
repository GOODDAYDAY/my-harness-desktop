import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Wrench, Plus, Trash2, Terminal, Globe, FileText, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import {
  registerSettingsComponent,
  registerSidePanelComponent,
  usePluginContext,
  useUiStore,
  usePiApi,
  EmptyState,
  SettingsSection,
  type SettingsComponentProps,
} from "@pi-desktop/react";
import type { SessionToolConfig as ISessionToolConfig } from "@pi-desktop/core";
import {
  BUILTIN_TOOLS,
  PRESET_GROUPS,
  computeDefaultGroupTools,
  computeEnabledToolIds,
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
} {
  const api = usePiApi();
  const [groups, setGroups] = useState<ToolGroup[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!cwd) { setGroups([]); setLoading(false); return; }
    try {
      const data = await api.configFile.get(`${cwd}/.pi-desktop/config/tool-groups.json`);
      if (data && Array.isArray(data.groups)) {
        setGroups(data.groups as ToolGroup[]);
      } else {
        const initial = { groups: PRESET_GROUPS };
        await api.configFile.set(`${cwd}/.pi-desktop/config/tool-groups.json`, initial, "replace");
        setGroups(PRESET_GROUPS);
      }
    } catch {
      setGroups(PRESET_GROUPS);
    }
    setLoading(false);
  }, [cwd, api]);

  const save = useCallback(async (newGroups: ToolGroup[]) => {
    if (!cwd) return;
    setGroups(newGroups);
    await api.configFile.set(`${cwd}/.pi-desktop/config/tool-groups.json`, { groups: newGroups }, "replace");
  }, [cwd, api]);

  useEffect(() => { void load(); }, [load]);

  return { groups, loading, save };
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
  const { groups, loading, save } = useToolGroups(currentCwd);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (refreshSignal > 0) void (async () => { await save(groups); })();
  }, [refreshSignal]);

  if (!currentCwd) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)" }}>
        <EmptyState icon={<Wrench className="size-8" />} title="请先打开项目目录" description="工具组配置存储在项目目录下" />
      </div>
    );
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
    setEditingId(null);
    setCreating(false);
  };

  const sortedGroups = [...groups].sort((a, b) => {
    if (a.builtIn && !b.builtIn) return -1;
    if (!a.builtIn && b.builtIn) return 1;
    return 0;
  });

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--spacing-lg)" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600, color: "var(--color-fg)" }}>工具组</h2>
          <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
            预设工具组合，可在右面板按会话快速启用/禁用。内置组不可删除，可编辑工具列表。
          </p>
        </div>
        {!creating && (
          <button onClick={() => { setCreating(true); setEditingId(null); }} style={btnStyle(true)}>
            <Plus size={14} />
            <span>新建</span>
          </button>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
        {sortedGroups.map((g) => (
          <GroupRow
            key={g.id}
            group={g}
            toolCount={g.id === "__default__" ? defaultGroupTools.length : g.toolIds.length}
            isEditing={editingId === g.id}
            allTools={allTools}
            onEdit={() => setEditingId(editingId === g.id ? null : g.id)}
            onDelete={g.builtIn ? undefined : () => void handleDelete(g.id)}
            onSave={handleSaveGroup}
            onCancel={() => setEditingId(null)}
          />
        ))}

        {creating && (
          <GroupEditRow
            allTools={allTools}
            onSave={handleSaveGroup}
            onCancel={() => setCreating(false)}
          />
        )}
      </div>

      <div style={{ borderTop: "2px solid var(--color-border)", margin: "var(--spacing-xl) 0" }} />

      <div style={{ marginBottom: "var(--spacing-md)" }}>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600, color: "var(--color-fg)" }}>全部工具</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          pi 底座当前可用工具清单，共 {allTools.length} 个。
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
        {allTools.map((tool) => {
          const group = groups.find((g) => g.toolIds.includes(tool.id));
          return (
            <div key={tool.id} style={toolRowStyle}>
              <span className="font-[var(--font-family-mono)] text-[var(--font-size-sm)] text-[var(--color-fg)]">{tool.id}</span>
              <span className="text-[var(--font-size-sm)] text-[var(--color-muted)] flex-1 ml-2 truncate">{tool.description || "—"}</span>
              <span style={toolSrcStyle(tool.source)}>{tool.source}</span>
              <span className="text-[var(--font-size-xs)] text-[var(--color-muted)] ml-3">{group?.name ?? "默认组"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GroupRow({ group, toolCount, isEditing, allTools, onEdit, onDelete, onSave, onCancel }: {
  group: ToolGroup;
  toolCount: number;
  isEditing: boolean;
  allTools: KnownTool[];
  onEdit: () => void;
  onDelete?: () => void;
  onSave: (g: ToolGroup) => void;
  onCancel: () => void;
}): React.ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [editName, setEditName] = useState(group.name);
  const [editDesc, setEditDesc] = useState(group.description ?? "");
  const [editToolIds, setEditToolIds] = useState<Set<string>>(new Set(group.toolIds));

  if (isEditing) {
    const toggle = (id: string): void => {
      setEditToolIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    };
    return (
      <div style={editRowStyle}>
        <div style={{ display: "flex", gap: "var(--spacing-sm)", marginBottom: "var(--spacing-sm)" }}>
          <input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="组名"
            style={inputStyle}
          />
          <input
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            placeholder="描述"
            style={inputStyle}
          />
        </div>
        <div className="grid grid-cols-3 gap-1 mb-2">
          {allTools.map((tool) => (
            <label key={tool.id} onClick={() => toggle(tool.id)} style={toolCheckboxStyle(editToolIds.has(tool.id))}>
              <span style={cbStyle(editToolIds.has(tool.id))}>{editToolIds.has(tool.id) ? "✓" : ""}</span>
              <span className="font-[var(--font-family-mono)] text-xs">{tool.id}</span>
            </label>
          ))}
        </div>
        <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
          <button
            onClick={() => onSave({
              ...group,
              name: editName || "未命名组",
              description: editDesc,
              toolIds: [...editToolIds],
            })}
            style={btnStyle(true)}
          >
            保存
          </button>
          <button onClick={onCancel} style={btnStyle(false)}>取消</button>
        </div>
      </div>
    );
  }

  return (
    <div style={groupRowStyle}>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center bg-transparent border-none cursor-pointer text-[var(--color-muted)]"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <GroupIcon group={group} />
        <span className="text-[var(--font-size-sm)] font-medium text-[var(--color-fg)]">{group.name}</span>
        {group.builtIn && <span style={badgeBuiltInStyle}>系统</span>}
        <span className="text-[var(--font-size-xs)] text-[var(--color-muted)] ml-auto">{toolCount} 个工具</span>
        <button onClick={onEdit} style={iconBtnStyle} title="编辑">
          <span className="text-[var(--font-size-xs)]">编辑</span>
        </button>
        {onDelete && (
          <button onClick={onDelete} style={iconBtnDangerStyle} title="删除">
            <Trash2 className="size-3" />
          </button>
        )}
      </div>
      {expanded && (
        <div className="flex flex-wrap gap-1 mt-2 ml-6">
          {(group.id === "__default__" ? computeDefaultGroupTools(allTools, [group]) : group.toolIds).map((id) => (
            <span key={id} style={chipStyle}>{id}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function GroupEditRow({ allTools, onSave, onCancel }: {
  allTools: KnownTool[];
  onSave: (g: ToolGroup) => void;
  onCancel: () => void;
}): React.ReactNode {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [toolIds, setToolIds] = useState<Set<string>>(new Set());

  const toggle = (id: string): void => {
    setToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div style={editRowStyle}>
      <div style={{ display: "flex", gap: "var(--spacing-sm)", marginBottom: "var(--spacing-sm)" }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="组名（如：安全沙箱）"
          style={inputStyle}
        />
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="描述"
          style={inputStyle}
        />
      </div>
      <div className="grid grid-cols-3 gap-1 mb-2">
        {allTools.map((tool) => (
          <label key={tool.id} onClick={() => toggle(tool.id)} style={toolCheckboxStyle(toolIds.has(tool.id))}>
            <span style={cbStyle(toolIds.has(tool.id))}>{toolIds.has(tool.id) ? "✓" : ""}</span>
            <span className="font-[var(--font-family-mono)] text-xs">{tool.id}</span>
          </label>
        ))}
      </div>
      <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
        <button
          onClick={() => onSave({
            id: `custom-${Date.now()}`,
            name: name || "未命名组",
            description: desc,
            toolIds: [...toolIds],
            builtIn: false,
          })}
          style={btnStyle(true)}
        >
          创建
        </button>
        <button onClick={onCancel} style={btnStyle(false)}>取消</button>
      </div>
    </div>
  );
}

function ToolPanelTab(): React.ReactNode {
  const { currentCwd, currentSessionPath, activeSidePanelTabs } = useUiStore();
  const allTools = useDiscoveredTools();
  const { groups, loading, save: saveGroups } = useToolGroups(currentCwd);
  const { config, save: saveConfig } = useSessionToolConfig(currentSessionPath);
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);

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
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleApply = async (): Promise<void> => {
    await saveConfig({ mode: "custom", enabledGroupIds: [...enabledIds] });
  };

  const handleSwitchAll = async (): Promise<void> => {
    await saveConfig(null);
    setEnabledIds(new Set(groups.map((g) => g.id)));
  };

  const handleSwitchCustom = async (): Promise<void> => {
    if (mode === "all") {
      await saveConfig({ mode: "custom", enabledGroupIds: [...enabledIds] });
    }
  };

  if (!currentCwd) {
    return <EmptyState icon={<Wrench className="size-8" />} title="请先打开项目目录" />;
  }
  if (loading) return null;

  const defaultIds = computeDefaultGroupTools(allTools, groups);
  const enabledToolIds = computeEnabledToolIds(groups, [...enabledIds], allTools);
  const disabledCount = allTools.length - enabledToolIds.length;

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
        <button onClick={handleSwitchAll} style={mode === "all" ? modeActiveStyle : modeStyle}>
          全部工具
        </button>
        <button onClick={handleSwitchCustom} style={mode === "custom" ? modeActiveStyle : modeStyle}>
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
                    <div onClick={() => toggleGroup(g.id)} style={toggleSwitchStyle(isOn)}>
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

function GroupIcon({ group }: { group: ToolGroup }): React.ReactNode {
  if (group.icon === "file-text" || group.id === "files") return <FileText className="size-3.5 text-[var(--color-muted)]" />;
  if (group.icon === "terminal" || group.id === "exec") return <Terminal className="size-3.5 text-[var(--color-muted)]" />;
  if (group.icon === "globe" || group.id === "web") return <Globe className="size-3.5 text-[var(--color-muted)]" />;
  return <Wrench className="size-3.5 text-[var(--color-muted)]" />;
}

const btnStyle = (primary: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: "var(--spacing-xs)",
  padding: "var(--spacing-xs) var(--spacing-md)",
  border: `1px solid ${primary ? "var(--color-primary)" : "var(--color-border)"}`,
  borderRadius: "var(--radius-sm)",
  background: primary ? "var(--color-primary)" : "transparent",
  color: primary ? "var(--color-primary-fg)" : "var(--color-fg)",
  cursor: "pointer",
  fontFamily: "var(--font-family-sans)",
  fontSize: "var(--font-size-sm)",
});

const groupRowStyle: React.CSSProperties = {
  padding: "var(--spacing-sm) var(--spacing-md)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
};

const editRowStyle: React.CSSProperties = {
  padding: "var(--spacing-md)",
  border: "1px dashed var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
};

const toolRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-bg)",
  color: "var(--color-fg)",
  fontSize: "var(--font-size-sm)",
};

const badgeBuiltInStyle: React.CSSProperties = {
  fontSize: "10px",
  padding: "1px 5px",
  borderRadius: "var(--radius-sm)",
  background: "rgba(74,194,107,0.15)",
  color: "var(--color-accent-success)",
  lineHeight: "16px",
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
  height: "22px",
  border: "none",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--color-muted)",
  cursor: "pointer",
  padding: "0 var(--spacing-xs)",
};

const iconBtnDangerStyle: React.CSSProperties = {
  ...iconBtnStyle,
  color: "var(--color-accent-error)",
};

const toolSrcStyle = (source: string): React.CSSProperties => ({
  fontSize: "10px",
  color: source === "builtin" ? "var(--color-accent-success)" : "var(--color-primary)",
  marginLeft: "var(--spacing-sm)",
});

const toolCheckboxStyle = (checked: boolean): React.CSSProperties => ({
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
