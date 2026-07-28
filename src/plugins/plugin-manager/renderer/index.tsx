import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Power, PowerOff, Trash2, RotateCw, Download, Shield, ChevronLeft, ChevronRight, GripVertical } from "lucide-react";
import {
  DndContext, closestCenter, type DragEndEvent,
  PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable, verticalListSortingStrategy, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { registerSettingsComponent, usePiApi, type PluginListItem, type PluginTier } from "@pi-desktop/react";

registerSettingsComponent("PluginManagerPage", PluginManagerPage);

const PAGE_SIZE = 10;

const TIER_ORDER: Record<PluginTier, number> = { official: 0, verified: 1, community: 2 };
const SOURCE_ORDER = { builtin: 0, installed: 1, user: 2, project: 3 } as const;

function defaultCompare(a: PluginListItem, b: PluginListItem): number {
  if (a.tier !== b.tier) return TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
  if (a.source !== b.source) return SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
  return a.displayName.localeCompare(b.displayName);
}

function sortPlugins(plugins: PluginListItem[], customOrder: string[]): PluginListItem[] {
  const orderMap = new Map(customOrder.map((id, i) => [id, i]));
  return [...plugins].sort((a, b) => {
    const aOrder = orderMap.get(a.id);
    const bOrder = orderMap.get(b.id);
    if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
    if (aOrder !== undefined) return -1;
    if (bOrder !== undefined) return 1;
    return defaultCompare(a, b);
  });
}

function tierColor(tier: PluginTier): string {
  if (tier === "official") return "var(--color-primary)";
  if (tier === "verified") return "var(--color-accent-success)";
  return "var(--color-muted)";
}

function PluginManagerPage(): React.ReactNode {
  const { t } = useTranslation();
  const api = usePiApi();
  const [plugins, setPlugins] = useState<PluginListItem[]>([]);
  const [customOrder, setCustomOrder] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [installOpen, setInstallOpen] = useState(false);
  const [installUrl, setInstallUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const refresh = useCallback(async () => {
    setPlugins(await api.plugins.list());
    const order = await api.config.get<string[]>("plugin-manager", "customOrder");
    if (order) setCustomOrder(order);
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const showFeedback = (r: { ok: boolean; error: string | null }) => {
    setFeedback(r.ok ? { ok: true, msg: t("pluginManager.operationSuccess") } : { ok: false, msg: r.error ?? t("pluginManager.operationFailed") });
  };

  const handleEnable = async (id: string) => { showFeedback(await api.plugins.enable(id)); void refresh(); };
  const handleDisable = async (id: string) => { showFeedback(await api.plugins.disable(id)); void refresh(); };
  const handleUninstall = async (id: string) => { showFeedback(await api.plugins.uninstall(id)); void refresh(); };
  const handleReload = async (id: string) => { showFeedback(await api.plugins.reload(id)); void refresh(); };

  const handleInstall = async () => {
    if (!installUrl.trim()) return;
    setInstalling(true);
    const source = installUrl.startsWith("http")
      ? { type: "url" as const, location: installUrl }
      : { type: "local" as const, location: installUrl };
    showFeedback(await api.plugins.install(source));
    setInstalling(false);
    setInstallOpen(false);
    setInstallUrl("");
    void refresh();
  };

  const handleSelectFile = async () => {
    const path = await api.dialog.openDirectory();
    if (path) setInstallUrl(path);
  };

  const sortedPlugins = useMemo(() => sortPlugins(plugins, customOrder), [plugins, customOrder]);
  const totalPages = Math.ceil(sortedPlugins.length / PAGE_SIZE);

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(Math.max(1, totalPages));
  }, [currentPage, totalPages]);

  const pageItems = useMemo(
    () => sortedPlugins.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [sortedPlugins, currentPage],
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sortedPlugins.findIndex((p) => p.id === active.id);
    const newIndex = sortedPlugins.findIndex((p) => p.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(sortedPlugins, oldIndex, newIndex);
    const newOrder = reordered.map((p) => p.id);
    setCustomOrder(newOrder);
    void api.config.set("plugin-manager", "customOrder", newOrder);
  }, [sortedPlugins, api]);

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--spacing-lg)" }}>
        <h2 style={{ fontSize: "var(--font-size-lg)", fontWeight: 600, color: "var(--color-fg)" }}>
          {t("settings.plugins", { defaultValue: "插件" })}
        </h2>
        <button onClick={() => setInstallOpen(!installOpen)} style={btnStyle(true)}>
          <Download size={14} />
          <span>{t("pluginManager.install")}</span>
        </button>
      </div>

      {installOpen && (
        <div style={{ marginBottom: "var(--spacing-md)", padding: "var(--spacing-md)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", background: "var(--color-surface)", display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <input
            type="text"
            value={installUrl}
            onChange={(e) => setInstallUrl(e.target.value)}
            placeholder={t("pluginManager.installPlaceholder")}
            style={{ flex: 1, padding: "var(--spacing-xs) var(--spacing-sm)", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", color: "var(--color-fg)", fontSize: "var(--font-size-sm)" }}
          />
          <button onClick={handleSelectFile} style={btnStyle(false)}>{t("pluginManager.selectFile")}</button>
          <button onClick={handleInstall} disabled={installing || !installUrl.trim()} style={btnStyle(true)}>
            {installing ? t("pluginManager.installing") : t("pluginManager.installBtn")}
          </button>
        </div>
      )}

      {feedback && (
        <div style={{
          marginBottom: "var(--spacing-md)",
          padding: "var(--spacing-sm) var(--spacing-md)",
          borderRadius: "var(--radius-sm)",
          background: feedback.ok ? "rgba(123,168,139,0.15)" : "rgba(192,122,122,0.15)",
          border: `1px solid ${feedback.ok ? "var(--color-accent-success)" : "var(--color-accent-error)"}`,
          color: feedback.ok ? "var(--color-accent-success)" : "var(--color-accent-error)",
          fontSize: "var(--font-size-sm)",
        }}>
          {feedback.msg}
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={pageItems.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
            {pageItems.map((p) => (
              <PluginRow key={p.id} plugin={p} t={t} onEnable={handleEnable} onDisable={handleDisable} onUninstall={handleUninstall} onReload={handleReload} />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {totalPages > 1 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "var(--spacing-sm)", marginTop: "var(--spacing-lg)" }}>
          <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1} style={iconBtn(currentPage === 1)}>
            <ChevronLeft size={14} />
          </button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
            <button
              key={page}
              onClick={() => setCurrentPage(page)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: "28px", height: "28px",
                border: `1px solid ${page === currentPage ? "var(--color-primary)" : "var(--color-border)"}`,
                borderRadius: "var(--radius-sm)",
                background: page === currentPage ? "var(--color-primary)" : "transparent",
                color: page === currentPage ? "var(--color-primary-fg)" : "var(--color-muted)",
                cursor: "pointer", fontSize: "var(--font-size-sm)",
              }}
            >
              {page}
            </button>
          ))}
          <button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} style={iconBtn(currentPage === totalPages)}>
            <ChevronRight size={14} />
          </button>
          <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", marginLeft: "var(--spacing-sm)" }}>
            {t("pluginManager.total", { count: sortedPlugins.length })}
          </span>
        </div>
      )}
    </div>
  );
}

function PluginRow({ plugin: p, t, onEnable, onDisable, onUninstall, onReload }: {
  plugin: PluginListItem;
  t: (key: string, opts?: Record<string, unknown>) => string;
  onEnable: (id: string) => void;
  onDisable: (id: string) => void;
  onUninstall: (id: string) => void;
  onReload: (id: string) => void;
}): React.ReactNode {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: p.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing-sm)",
    padding: "var(--spacing-sm) var(--spacing-md)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    background: "var(--color-surface)",
  };

  const displayName = t(`plugin.${p.id}.displayName`, { defaultValue: p.displayName || p.id });
  const description = t(`plugin.${p.id}.description`, { defaultValue: p.description || "" });
  const stateLabel = t(`pluginManager.state${p.state.charAt(0).toUpperCase()}${p.state.slice(1)}`);
  const tierLabel = t(`pluginManager.tier${p.tier.charAt(0).toUpperCase()}${p.tier.slice(1)}`);

  return (
    <div ref={setNodeRef} style={style}>
      <span {...attributes} {...listeners} style={{ cursor: "grab", color: "var(--color-muted)", flexShrink: 0 }}>
        <GripVertical size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
          <span style={{ fontSize: "var(--font-size-sm)", fontWeight: 500, color: "var(--color-fg)" }}>{displayName}</span>
          <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>{p.version}</span>
          <span style={{ fontSize: "var(--font-size-xs)", color: tierColor(p.tier), border: `1px solid ${tierColor(p.tier)}`, borderRadius: "var(--radius-sm)", padding: "0 4px", lineHeight: "16px" }}>{tierLabel}</span>
          {p.protected && <Shield size={11} style={{ color: "var(--color-muted)" }} />}
        </div>
        {description && (
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }} title={description}>
            {description}
          </div>
        )}
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>
          {p.id} · {p.source} · {stateLabel}
        </div>
      </div>
      <div style={{ display: "flex", gap: "var(--spacing-xs)", flexShrink: 0 }}>
        {p.state === "inactive" && (
          <TooltipButton tooltip={t("pluginManager.enable")} onClick={() => onEnable(p.id)}>
            <Power size={14} />
          </TooltipButton>
        )}
        {p.state === "active" && (
          <TooltipButton tooltip={t("pluginManager.disable")} onClick={() => onDisable(p.id)}>
            <PowerOff size={14} />
          </TooltipButton>
        )}
        {(p.state === "active" || p.state === "error") && (
          <TooltipButton tooltip={t("pluginManager.reload")} onClick={() => onReload(p.id)}>
            <RotateCw size={14} />
          </TooltipButton>
        )}
        <TooltipButton
          tooltip={p.protected ? t("pluginManager.protectedTooltip") : t("pluginManager.uninstall")}
          onClick={() => onUninstall(p.id)}
          disabled={p.protected}
        >
          <Trash2 size={14} />
        </TooltipButton>
      </div>
    </div>
  );
}

function btnStyle(primary: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", gap: "var(--spacing-xs)",
    padding: "var(--spacing-xs) var(--spacing-md)",
    border: `1px solid ${primary ? "var(--color-primary)" : "var(--color-border)"}`,
    borderRadius: "var(--radius-sm)",
    background: primary ? "var(--color-primary)" : "transparent",
    color: primary ? "var(--color-primary-fg)" : "var(--color-fg)",
    cursor: "pointer", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-family-sans)",
  };
}

function iconBtn(disabled = false): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: "28px", height: "28px",
    border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
    background: "transparent", color: "var(--color-muted)",
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
  };
}

function TooltipButton({ tooltip, onClick, disabled, children }: {
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): React.ReactNode {
  const [showTip, setShowTip] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleEnter = (): void => {
    timer.current = setTimeout(() => setShowTip(true), 1000);
  };
  const handleLeave = (): void => {
    clearTimeout(timer.current);
    setShowTip(false);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div style={{ position: "relative", display: "inline-flex" }} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <button onClick={onClick} disabled={disabled} style={iconBtn(disabled)}>
        {children}
      </button>
      {showTip && !disabled && (
        <div style={{
          position: "absolute", bottom: "100%", left: "50%", transform: "translateX(-50%)",
          marginBottom: "4px", padding: "2px 8px",
          background: "var(--color-chrome)", color: "var(--color-fg)",
          border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
          fontSize: "var(--font-size-xs)", whiteSpace: "nowrap",
          pointerEvents: "none", zIndex: 100,
          boxShadow: "var(--shadow-sm)",
        }}>
          {tooltip}
        </div>
      )}
    </div>
  );
}
