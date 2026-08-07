import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { Wrench, Plus, Trash2, ChevronDown, ChevronRight, AlertTriangle, Clock, Eye, Pencil, Radio, Bot } from "lucide-react";
import {
  usePluginContext,
  useUiStore,
  EmptyState,
  Button,
  type SettingsComponentProps,
} from "@pi-desktop/react";
import {
  BUILTIN_TOOLS,
  PRESET_GROUPS,
  computeDefaultEnabledGroupIds,
  computeEnabledToolIds,
  mergeKnownTools,
  reconcilePresetGroups,
  type KnownTool,
  type ToolGroup,
  type SessionToolConfig,
} from "../core/types";



function useDiscoveredTools(): KnownTool[] {
  const ctx = usePluginContext();
  const { currentCwd, currentSessionPath } = useUiStore();
  const discoveredRef = useRef(new Map<string, KnownTool>());
  const [announced, setAnnounced] = useState<KnownTool[]>([]);
  const [, force] = useState(0);

  // 权威来源:tool-gate 播报文件(§4.4.4)——挂载/cwd 变化/会话切换三个读点,不挂文件监听。
  // 播报缺席(文件未写/该 cwd 无桶)时 knownTools 返回 null,announced 留空走兜底。
  useEffect(() => {
    if (!currentCwd) { setAnnounced([]); return; }
    let cancelled = false;
    void ctx.kernel.knownTools(currentCwd).then((list) => {
      if (cancelled || !list) return;
      setAnnounced(list.map((t) => ({
        id: t.name,
        name: t.name,
        description: t.description,
        source: t.source,
        extensionId: t.extensionPath,
      })));
    });
    return () => { cancelled = true; };
  }, [ctx, currentCwd, currentSessionPath]);

  // 增量兜底:toolCallStart 直播事件收集(tool-gate 未装/文件未写时的补全,§4.3 降级纪律不删)。
  useEffect(() => {
    const off = ctx.sessions.onEvent((event) => {
      if (event.type === "toolCallStart" && event.toolName) {
        const name = event.toolName as string;
        if (!discoveredRef.current.has(name) && !BUILTIN_TOOLS.some((t) => t.id === name)) {
          discoveredRef.current.set(name, { id: name, name, description: "", source: "extension" });
          force((n) => n + 1);
        }
      }
    });
    return off;
  }, [ctx]);

  return mergeKnownTools(BUILTIN_TOOLS, announced, [...discoveredRef.current.values()]);
}

function useToolGroups(cwd: string | null): {
  groups: ToolGroup[];
  loading: boolean;
  reload: () => Promise<void>;
  save: (groups: ToolGroup[]) => Promise<void>;
} {
  const ctx = usePluginContext();
  const [groups, setGroups] = useState<ToolGroup[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!cwd) { setGroups([]); setLoading(false); return; }
    try {
      // 统一通道:读合并视图(项目级无 groups 时全局兜底);两层都无 → 写预设到项目级。
      // 内置组随代码换新(reconcile):旧预设 files/exec 整体被当前 PRESET_GROUPS 替换,自定义组保留。
      const stored = await ctx.config.get<ToolGroup[]>("groups");
      if (Array.isArray(stored)) {
        setGroups(reconcilePresetGroups(stored));
      } else {
        await ctx.config.set("groups", PRESET_GROUPS);
        setGroups(PRESET_GROUPS);
      }
    } catch {
      setGroups(PRESET_GROUPS);
    }
    setLoading(false);
  }, [cwd, ctx]);

  const save = useCallback(async (newGroups: ToolGroup[]) => {
    if (!cwd) return;
    setGroups(newGroups);
    await ctx.config.set("groups", newGroups);
  }, [cwd, ctx]);

  useEffect(() => { void load(); }, [load]);

  return { groups, loading, reload: load, save };
}

function useSessionToolConfig(sessionPath: string | null): SessionToolConfig | null {
  const ctx = usePluginContext();
  const [config, setConfig] = useState<SessionToolConfig | null>(null);

  useEffect(() => {
    if (!sessionPath) { setConfig(null); return; }
    void ctx.sessions.readToolConfig(sessionPath).then((v) => {
      setConfig(v as SessionToolConfig | null);
    });
  }, [sessionPath, ctx]);

  return config;
}

export function ToolManagerPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const { currentCwd } = useUiStore();
  const allTools = useDiscoveredTools();
  const { groups, loading, reload, save } = useToolGroups(currentCwd);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    // 刷新信号的语义是重读磁盘(框架刷新按钮 / settings:changed 广播)。
    // 绝不能反向 save:写 tool-groups.json 会再触发 settings:changed 广播,
    // 设置页 bump refreshSignal → 本 effect 又 save → 自激死循环
    // (曾致 settingsChanged 每秒数百次、renderer CPU 打满、设置页 flash 卡暗态)。
    if (refreshSignal > 0) void reload();
  }, [reload, refreshSignal]);

  if (!currentCwd) {
    return <EmptyState icon={<Wrench className="size-8" />} title={t("toolManager.openProjectFirst")} description={t("toolManager.openProjectFirstDesc")} />;
  }
  if (loading) return null;

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
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600, color: "var(--color-fg)" }}>{t("toolManager.tools")}</h2>
          <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
            {t("toolManager.toolsDesc")}
          </p>
        </div>
        {!creating && (
          <Button variant="primary" onClick={() => { setCreating(true); setEditingId(null); }}>
            <Plus size={14} />
            <span>{t("toolManager.create")}</span>
          </Button>
        )}
      </div>

      <div style={twoColGridStyle}>
        {sortedGroups.map((g) => (
          <GroupRow
            key={g.id}
            group={g}
            toolCount={g.toolIds.length}
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

      <div style={{ borderTop: "2px solid var(--color-border)" }} />

      <div>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600, color: "var(--color-fg)" }}>{t("toolManager.allTools")}</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          {t("toolManager.allToolsDesc", { count: allTools.length })}
        </p>
      </div>

      <div style={twoColGridStyle}>
        {allTools.map((tool) => {
          // 一个工具可属多个组,全量展示;无显式组的工具无组标签(它不受组开关控制,恒可用)
          const toolGroups = groups.filter((g) => g.toolIds.includes(tool.id));
          return (
            <ToolRow
              key={tool.id}
              tool={tool}
              toolGroups={toolGroups}
            />
          );
        })}
      </div>
    </>
  );
}

function ToolRow({ tool, toolGroups }: {
  tool: KnownTool;
  toolGroups: ToolGroup[];
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ ...toolRowStyle, cursor: "pointer" }} onClick={() => setOpen(!open)}>
      <div className="flex items-center gap-1.5">
        <span className="text-[var(--color-muted)] flex items-center">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
        <span className="font-[var(--font-family-mono)] text-[length:var(--font-size-sm)] font-medium text-[var(--color-fg)] truncate">{tool.id}</span>
        <span style={{ ...toolSrcStyle(tool.source), marginLeft: "auto" }}>{tool.source}</span>
      </div>
      <div className="flex flex-wrap gap-1 mt-1.5" style={{ paddingLeft: "18px" }}>
        {toolGroups.map((g) => <span key={g.id} style={groupTagStyle}>{g.name}</span>)}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <div
              className="mt-1.5 text-[length:var(--font-size-xs)] text-[var(--color-muted)]"
              style={{ paddingLeft: "18px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
            >
              {tool.description || "—"}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ToolCheckGrid({ allTools, checked, onToggle }: {
  allTools: KnownTool[];
  checked: Set<string>;
  onToggle: (id: string) => void;
}): React.ReactNode {
  return (
    <div className="grid gap-1 mb-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}>
      {allTools.map((tool) => (
        <label key={tool.id} onClick={() => onToggle(tool.id)} style={toolCheckboxStyle(checked.has(tool.id))}>
          <span style={cbStyle(checked.has(tool.id))}>{checked.has(tool.id) ? "✓" : ""}</span>
          <span className="font-[var(--font-family-mono)] text-[length:var(--font-size-sm)]">{tool.id}</span>
        </label>
      ))}
    </div>
  );
}

function GroupRow({ group, toolCount, isEditing, allTools, onEdit, onDelete, onSave, onCancel }: {
  group: ToolGroup;
  toolCount: number;
  isEditing: boolean;
  allTools: KnownTool[];
  onEdit?: () => void;
  onDelete?: () => void;
  onSave: (g: ToolGroup) => void;
  onCancel: () => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [editName, setEditName] = useState(group.name);
  const [editDesc, setEditDesc] = useState(group.description ?? "");
  const [editToolIds, setEditToolIds] = useState<Set<string>>(new Set(group.toolIds));
  const [editDefaultEnabled, setEditDefaultEnabled] = useState(group.defaultEnabled);

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
            placeholder={t("toolManager.groupNamePlaceholder")}
            style={inputStyle}
          />
          <input
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            placeholder={t("toolManager.groupDescPlaceholder")}
            style={inputStyle}
          />
        </div>
        <ToolCheckGrid allTools={allTools} checked={editToolIds} onToggle={toggle} />
        <label className="flex items-center gap-1.5 mb-2 cursor-pointer text-[length:var(--font-size-sm)] text-[var(--color-fg)]">
          <input type="checkbox" checked={editDefaultEnabled} onChange={(e) => setEditDefaultEnabled(e.target.checked)} />
          {t("toolManager.defaultEnabledLabel")}
        </label>
        <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
          <Button
            variant="primary"
            onClick={() => onSave({
              ...group,
              name: editName || t("toolManager.unnamedGroup"),
              description: editDesc,
              toolIds: [...editToolIds],
              defaultEnabled: editDefaultEnabled,
            })}
          >
            {t("toolManager.save")}
          </Button>
          <Button variant="secondary" onClick={onCancel}>{t("toolManager.cancel")}</Button>
        </div>
      </div>
    );
  }

  return (
    <div style={groupRowStyle}>
      <div className="flex items-center gap-2 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <span className="flex items-center text-[var(--color-muted)]">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
        <GroupIcon group={group} />
        <span className="text-[length:var(--font-size-sm)] font-medium text-[var(--color-fg)]">{group.name}</span>
        {group.builtIn && <span style={badgeBuiltInStyle}>{t("toolManager.system")}</span>}
        <span style={defaultBadgeStyle(group.defaultEnabled)}>
          {group.defaultEnabled ? t("toolManager.defaultOn") : t("toolManager.defaultOff")}
        </span>
        <span className="text-[length:var(--font-size-xs)] text-[var(--color-muted)] ml-auto">{t("toolManager.toolCount", { count: toolCount })}</span>
        {onEdit && (
          <button onClick={(e) => { e.stopPropagation(); onEdit(); }} style={iconBtnStyle} title={t("toolManager.edit")}>
            <span className="text-[length:var(--font-size-xs)]">{t("toolManager.edit")}</span>
          </button>
        )}
        {onDelete && (
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }} style={iconBtnDangerStyle} title={t("toolManager.delete")}>
            <Trash2 className="size-3" />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <div className="flex flex-wrap gap-1 mt-2 ml-6">
              {group.toolIds.map((id) => (
                <span key={id} style={chipStyle}>{id}</span>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function GroupEditRow({ allTools, onSave, onCancel }: {
  allTools: KnownTool[];
  onSave: (g: ToolGroup) => void;
  onCancel: () => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [toolIds, setToolIds] = useState<Set<string>>(new Set());
  const [defaultEnabled, setDefaultEnabled] = useState(true);

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
          placeholder={t("toolManager.groupNameHint")}
          style={inputStyle}
        />
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={t("toolManager.groupDescPlaceholder")}
          style={inputStyle}
        />
      </div>
      <ToolCheckGrid allTools={allTools} checked={toolIds} onToggle={toggle} />
      <label className="flex items-center gap-1.5 mb-2 cursor-pointer text-[length:var(--font-size-sm)] text-[var(--color-fg)]">
        <input type="checkbox" checked={defaultEnabled} onChange={(e) => setDefaultEnabled(e.target.checked)} />
        {t("toolManager.defaultEnabledLabel")}
      </label>
      <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
        <Button
          variant="primary"
          onClick={() => onSave({
            id: `custom-${Date.now()}`,
            name: name || t("toolManager.unnamedGroup"),
            description: desc,
            toolIds: [...toolIds],
            builtIn: false,
            defaultEnabled,
          })}
        >
          {t("toolManager.createBtn")}
        </Button>
        <Button variant="secondary" onClick={onCancel}>{t("toolManager.cancel")}</Button>
      </div>
    </div>
  );
}

export function ToolPanelTab(): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const { currentCwd, currentSessionPath, sessionTitle, pendingToolConfig, setPendingToolConfig } = useUiStore();
  const allTools = useDiscoveredTools();
  const { groups, loading } = useToolGroups(currentCwd);
  const headerConfig = useSessionToolConfig(currentSessionPath);
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  // tool-gate 底座扩展不可用时过滤只走 timeline 软注入——显示降级提示而非静默。
  const [gateAvailable, setGateAvailable] = useState(true);
  // allTools 每渲染都是新引用(mergeKnownTools 不重算缓存),进 effect deps 会死循环——
  // effect 里展开 enabledToolIds 时经 ref 读最新值,deps 只挂稳定引用。
  const allToolsRef = useRef(allTools);
  allToolsRef.current = allTools;

  useEffect(() => {
    void ctx.kernel.toolgateAvailable().then(setGateAvailable);
  }, [ctx]);

  // 偏好/落盘两态(composerApplyTiming 同语义):开关只写 pending(内存偏好),
  // timeline send() 才 flush 到头行。flushed 的 pending 仍作显示值——它等于最新落盘值,避免跳变。
  const pending = currentSessionPath && pendingToolConfig?.sessionPath === currentSessionPath ? pendingToolConfig : null;

  const pushPending = useCallback((enabledGroupIds: string[]): void => {
    if (!currentSessionPath) return;
    // enabledToolIds 随偏好展开落好(flush 直写头行,tool-gate 只认该字段,不回退组展开)
    setPendingToolConfig({
      sessionPath: currentSessionPath,
      config: { enabledGroupIds, enabledToolIds: computeEnabledToolIds(groups, enabledGroupIds, allTools) },
      flushed: false,
    });
  }, [currentSessionPath, groups, allTools, setPendingToolConfig]);

  // 生效开关 = pending > session 头 > 组默认(defaultEnabled)。无 mode 概念:
  // 头行无配置 = 按组默认;enabledGroupIds 显式空数组 = 全关,不回落(全关即零工具的显式语义)。
  // 头行组 id 全部已退役(旧预设 files/exec 遗存)= 配置失效:回落组默认并挂起,下次发送自愈落盘。
  useEffect(() => {
    if (loading) return;
    const cfg = pending ? pending.config : headerConfig;
    const defaults = computeDefaultEnabledGroupIds(groups);
    const ids = cfg?.enabledGroupIds;
    if (!ids) {
      setEnabledIds(new Set(defaults));
      return;
    }
    if (ids.length === 0) {
      setEnabledIds(new Set());
      return;
    }
    const known = new Set(groups.map((g) => g.id));
    if (ids.some((id) => known.has(id))) {
      setEnabledIds(new Set(ids));
      return;
    }
    setEnabledIds(new Set(defaults));
    if (currentSessionPath) {
      setPendingToolConfig({
        sessionPath: currentSessionPath,
        config: { enabledGroupIds: defaults, enabledToolIds: computeEnabledToolIds(groups, defaults, allToolsRef.current) },
        flushed: false,
      });
    }
  }, [pending, headerConfig, groups, loading, currentSessionPath, setPendingToolConfig]);

  const toggleGroup = (id: string): void => {
    const next = new Set(enabledIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setEnabledIds(next);
    pushPending([...next]);
  };

  if (!currentCwd) {
    return <EmptyState icon={<Wrench className="size-8" />} title={t("toolManager.openProjectFirst")} />;
  }
  if (loading) return null;

  const enabledToolIds = computeEnabledToolIds(groups, [...enabledIds], allTools);
  const disabledCount = allTools.length - enabledToolIds.length;
  // 有过滤动作(非全量)且 tool-gate 缺席时才需要降级警告;硬过滤在场时无"LLM 不遵守"问题。
  const restrictive = enabledToolIds.length < allTools.length;

  return (
    <div className="flex-1 flex flex-col min-h-0 p-3 gap-2 overflow-y-auto">
      <div className="flex items-center gap-2 shrink-0">
        <Wrench className="size-4 text-[var(--color-muted)]" />
        <span className="text-sm text-[var(--color-muted)]">{t("toolManager.currentSession")}</span>
        <span className={`text-xs truncate ${sessionTitle ? "" : "font-[var(--font-family-mono)]"}`}>{sessionTitle ?? currentSessionPath?.split("/").pop() ?? "—"}</span>
      </div>

      {pending && !pending.flushed && (
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-primary)] py-1 shrink-0">
          <Clock className="size-3" />
          <span>{t("toolManager.pendingHint")}</span>
        </div>
      )}

      {!gateAvailable && restrictive && (
        <>
          <div className="flex items-center gap-1.5 text-xs text-[var(--color-accent-warning)] py-1 shrink-0">
            <AlertTriangle className="size-3" />
            <span>{t("toolManager.gateUnavailable")}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-[var(--color-accent-warning)] py-1 shrink-0">
            <AlertTriangle className="size-3" />
            <span>{t("toolManager.softFilterWarn")}</span>
          </div>
        </>
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {groups.map((g) => {
          const isOn = enabledIds.has(g.id);
          const toolList = g.toolIds;
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
                    <span style={defaultBadgeStyle(g.defaultEnabled)}>
                      {g.defaultEnabled ? t("toolManager.defaultOn") : t("toolManager.defaultOff")}
                    </span>
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
          <span className="text-[var(--color-accent-success)]">{t("toolManager.available", { count: enabledToolIds.length })}</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent-error)]" />
          <span className="text-[var(--color-accent-error)]">{t("toolManager.disabled", { count: disabledCount })}</span>
        </div>
      </div>
    </div>
  );
}

function GroupIcon({ group }: { group: ToolGroup }): React.ReactNode {
  if (group.icon === "eye") return <Eye className="size-3.5 text-[var(--color-muted)]" />;
  if (group.icon === "pencil") return <Pencil className="size-3.5 text-[var(--color-muted)]" />;
  if (group.icon === "radio") return <Radio className="size-3.5 text-[var(--color-muted)]" />;
  if (group.icon === "bot") return <Bot className="size-3.5 text-[var(--color-muted)]" />;
  return <Wrench className="size-3.5 text-[var(--color-muted)]" />;
}


const twoColGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "var(--spacing-xs)",
  alignItems: "start",
};

const groupRowStyle: React.CSSProperties = {
  padding: "var(--spacing-sm) var(--spacing-md)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
};

const editRowStyle: React.CSSProperties = {
  gridColumn: "1 / -1",
  padding: "var(--spacing-md)",
  border: "1px dashed var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
};

const toolRowStyle: React.CSSProperties = {
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
  fontSize: "var(--font-size-xs)",
  padding: "1px 5px",
  borderRadius: "var(--radius-sm)",
  background: "rgba(74,194,107,0.15)",
  color: "var(--color-accent-success)",
  lineHeight: "16px",
};

const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: "var(--font-size-xs)",
  padding: "2px 6px",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-bg)",
  border: "1px solid var(--color-border)",
  fontFamily: "var(--font-family-mono)",
};

const groupTagStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: "var(--font-size-xs)",
  padding: "2px 6px",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-bg)",
  border: "1px solid var(--color-border)",
  color: "var(--color-muted)",
  whiteSpace: "nowrap",
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
  fontSize: "var(--font-size-xs)",
  color: source === "builtin" ? "var(--color-accent-success)" : "var(--color-primary)",
  marginLeft: "var(--spacing-sm)",
});

const toolCheckboxStyle = (checked: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: "6px",
  fontSize: "var(--font-size-sm)",
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
  fontSize: "var(--font-size-xs)",
  color: "var(--color-bg)",
  background: checked ? "var(--color-accent-success)" : "transparent",
  fontWeight: "bold" as const,
  flexShrink: 0,
});

const defaultBadgeStyle = (on: boolean): React.CSSProperties => ({
  fontSize: "var(--font-size-xs)",
  padding: "0 4px",
  borderRadius: "var(--radius-sm)",
  background: on ? "rgba(74,194,107,0.12)" : "var(--color-bg)",
  border: "1px solid var(--color-border)",
  color: on ? "var(--color-accent-success)" : "var(--color-muted)",
  whiteSpace: "nowrap",
  transform: "scale(0.92)",
});

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

