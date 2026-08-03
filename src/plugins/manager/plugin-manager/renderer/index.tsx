import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Power, PowerOff, Trash2, RotateCw, Download, Shield, ChevronLeft, ChevronRight, GripVertical } from "lucide-react";
import {
  DndContext, closestCenter, type DragEndEvent,
  PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable, verticalListSortingStrategy, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, RECOMMENDED_PLUGIN_TAGS, type PluginListItem, type PluginTier, usePluginContext } from "@pi-desktop/react";


const PAGE_SIZE = 10;

/** tag 筛选态:tag -> "inc"(只看) | "exc"(排除);不存在的 key = 不过滤。 */
type TagFilter = Record<string, "inc" | "exc">;

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

function filterPluginsByTags(plugins: PluginListItem[], filter: TagFilter): PluginListItem[] {
  const inc = Object.keys(filter).filter((t) => filter[t] === "inc");
  const exc = Object.keys(filter).filter((t) => filter[t] === "exc");
  if (!inc.length && !exc.length) return plugins;
  return plugins.filter((p) => {
    if (inc.length && !p.tags.some((t) => inc.includes(t))) return false;
    if (p.tags.some((t) => exc.includes(t))) return false;
    return true;
  });
}

function orderTags(present: Set<string>): string[] {
  const recommended = RECOMMENDED_PLUGIN_TAGS.filter((t) => present.has(t));
  const extras = [...present].filter((t) => !(RECOMMENDED_PLUGIN_TAGS as readonly string[]).includes(t)).sort();
  return [...recommended, ...extras];
}

function tierColor(tier: PluginTier): string {
  if (tier === "official") return "var(--color-primary)";
  if (tier === "verified") return "var(--color-accent-success)";
  return "var(--color-muted)";
}

export function PluginManagerPage(): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [plugins, setPlugins] = useState<PluginListItem[]>([]);
  const [customOrder, setCustomOrder] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<TagFilter>({});
  const [currentPage, setCurrentPage] = useState(1);
  const [installOpen, setInstallOpen] = useState(false);
  const [installUrl, setInstallUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const refresh = useCallback(async () => {
    setPlugins(await ctx.plugins.list());
    const order = await ctx.config.get<string[]>("customOrder");
    if (order) setCustomOrder(order);
    const filter = await ctx.config.get<TagFilter>("tagFilter");
    if (filter) setTagFilter(filter);
  }, [ctx]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevPageRef = useRef(currentPage);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (currentPage > prevPageRef.current) el.scrollTop = 0;
    else if (currentPage < prevPageRef.current) el.scrollTop = el.scrollHeight;
    prevPageRef.current = currentPage;
  }, [currentPage]);

  const showFeedback = (r: { ok: boolean; error: string | null; errorArgs?: string[] }) => {
    // error 是 token key(如 plugin.error.notLoaded)则 t() 翻译;非 token(如 npm 退出码)
    // 经 i18next parseMissingKeyHandler 原样返回。errorArgs 用于插值(如依赖列表)。
    if (r.ok) { setFeedback({ ok: true, msg: t("pluginManager.operationSuccess") }); return; }
    const msg = r.error
      ? t(r.error, r.errorArgs ? { deps: r.errorArgs.join(", ") } : undefined)
      : t("pluginManager.operationFailed");
    setFeedback({ ok: false, msg });
  };

  const handleEnable = async (id: string) => { showFeedback(await ctx.plugins.enable(id)); void refresh(); };
  const handleDisable = async (id: string) => { showFeedback(await ctx.plugins.disable(id)); void refresh(); };
  const handleUninstall = async (id: string) => { showFeedback(await ctx.plugins.uninstall(id)); void refresh(); };
  const handleReload = async (id: string) => { showFeedback(await ctx.plugins.reload(id)); void refresh(); };

  const handleInstall = async () => {
    if (!installUrl.trim()) return;
    setInstalling(true);
    const source = installUrl.startsWith("http")
      ? { type: "url" as const, location: installUrl }
      : { type: "local" as const, location: installUrl };
    showFeedback(await ctx.plugins.install(source));
    setInstalling(false);
    setInstallOpen(false);
    setInstallUrl("");
    void refresh();
  };

  const handleSelectFile = async () => {
    const path = await ctx.dialog.openDirectory();
    if (path) setInstallUrl(path);
  };

  const sortedPlugins = useMemo(() => sortPlugins(plugins, customOrder), [plugins, customOrder]);
  const filteredPlugins = useMemo(() => filterPluginsByTags(sortedPlugins, tagFilter), [sortedPlugins, tagFilter]);
  const allTags = useMemo(() => orderTags(new Set(plugins.flatMap((p) => p.tags))), [plugins]);
  const totalPages = Math.ceil(filteredPlugins.length / PAGE_SIZE);

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(Math.max(1, totalPages));
  }, [currentPage, totalPages]);

  const pageItems = useMemo(
    () => filteredPlugins.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filteredPlugins, currentPage],
  );

  const cycleTag = (tag: string) => {
    const next = { ...tagFilter };
    if (next[tag] === "inc") next[tag] = "exc";
    else if (next[tag] === "exc") delete next[tag];
    else next[tag] = "inc";
    setTagFilter(next);
    void ctx.config.set("tagFilter", next, { scope: "global" });
  };

  const resetTagFilter = () => {
    setTagFilter({});
    void ctx.config.set("tagFilter", {}, { scope: "global" });
  };

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
    void ctx.config.set("customOrder", newOrder, { scope: "global" });
  }, [sortedPlugins, ctx]);

  // Radix v1 要求 Tooltip.Root 位于 Provider 之下,一个 Provider 覆盖全部按钮,
  // 相邻按钮 hover 间享有加热区交接(跳过延迟直接浮出)。
  return (
    <Tooltip.Provider>
    <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--spacing-lg)" }}>
        <h2 style={{ fontSize: "var(--font-size-lg)", fontWeight: 600, color: "var(--color-fg)" }}>
          {t("settings.plugins", { defaultValue: "Desktop 插件" })}
        </h2>
        <Button variant="primary" onClick={() => setInstallOpen(!installOpen)}>
          <Download size={14} />
          <span>{t("pluginManager.install")}</span>
        </Button>
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
          <Button variant="secondary" onClick={handleSelectFile}>{t("pluginManager.selectFile")}</Button>
          <Button variant="primary" onClick={handleInstall} disabled={installing || !installUrl.trim()}>
            {installing ? t("pluginManager.installing") : t("pluginManager.installBtn")}
          </Button>
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

      {allTags.length > 0 && (
        <div style={{ marginBottom: "var(--spacing-md)" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-xs)", alignItems: "center" }}>
            {allTags.map((tag) => {
              const st = tagFilter[tag];
              const count = plugins.filter((p) => p.tags.includes(tag)).length;
              return (
                <button
                  key={tag}
                  onClick={() => cycleTag(tag)}
                  style={{
                    cursor: "pointer",
                    padding: "2px 10px",
                    fontSize: "var(--font-size-xs)",
                    borderRadius: "var(--radius-md)",
                    border: `1px ${st ? "solid" : "dashed"} ${st === "inc" ? "var(--color-primary)" : st === "exc" ? "var(--color-accent-error)" : "var(--color-border)"}`,
                    background: st === "inc" ? "var(--color-primary)" : "transparent",
                    color: st === "inc" ? "var(--color-primary-fg)" : st === "exc" ? "var(--color-accent-error)" : "var(--color-muted)",
                    textDecoration: st === "exc" ? "line-through" : "none",
                  }}
                >
                  {t(`pluginManager.tag.${tag}`, { defaultValue: tag })} {count}
                </button>
              );
            })}
            {Object.keys(tagFilter).length > 0 && (
              <button
                onClick={resetTagFilter}
                style={{ cursor: "pointer", border: "none", background: "transparent", color: "var(--color-primary)", fontSize: "var(--font-size-xs)", textDecoration: "underline", padding: "2px 4px" }}
              >
                {t("pluginManager.filterReset")}
              </button>
            )}
          </div>
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", marginTop: "var(--spacing-xs)" }}>
            {t("pluginManager.filterHint")}
          </div>
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
            {t("pluginManager.total", { count: filteredPlugins.length })}
          </span>
        </div>
      )}
    </div>
    </Tooltip.Provider>
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
          {p.tags.length > 0 && ` · ${p.tags.map((tag) => t(`pluginManager.tag.${tag}`, { defaultValue: tag })).join(" · ")}`}
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

function iconBtn(disabled = false): React.CSSProperties {
  return {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: "28px", height: "28px",
    border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
    background: "transparent", color: "var(--color-muted)",
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
  };
}

/** 悬停 1s 延迟浮出的解释气泡。手写 setTimeout 版已收敛到 Radix(§3.5):
 *  portal/边界翻转/加热区交接全由成熟包代劳。
 *  Trigger 套 span:disabled button 不派发 pointer 事件,套 span 后 protected 的
 *  protectedTooltip 也能浮出(原手写版 `!disabled &&` 把该文案写成死代码)。 */
function TooltipButton({ tooltip, onClick, disabled, children }: {
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <Tooltip.Root delayDuration={1000}>
      <Tooltip.Trigger asChild>
        <span style={{ display: "inline-flex" }}>
          <button onClick={onClick} disabled={disabled} style={iconBtn(disabled)}>
            {children}
          </button>
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="top" sideOffset={4} style={tipStyle}>
          {tooltip}
          <Tooltip.Arrow style={{ fill: "var(--color-border)" }} width={10} height={5} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const tipStyle: React.CSSProperties = {
  padding: "2px 8px",
  background: "var(--color-chrome)",
  color: "var(--color-fg)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  fontSize: "var(--font-size-xs)",
  whiteSpace: "nowrap",
  boxShadow: "var(--shadow-sm)",
  zIndex: 99999,
};
