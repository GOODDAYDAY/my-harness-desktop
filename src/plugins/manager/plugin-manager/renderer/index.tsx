import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Power, PowerOff, Trash2, RotateCw, Download, Shield, GripVertical } from "lucide-react";
import {
  DndContext, closestCenter, type DragEndEvent,
  PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import {
  SortableContext, useSortable, verticalListSortingStrategy, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Announce, announceTransient, Button, RECOMMENDED_PLUGIN_TAGS, type PluginListItem, type PluginTier, usePluginContext, useSessionStore, Pagination, usePagination , pickDirectory } from "@my-harness-desktop/react";


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
  /** UI 态落盘（r183，同 projects 的 persist）：三处此前都是 `void ctx.config.set(...)` 发射后不管。 */
  const persist = (key: string, value: unknown): void => {
    void ctx.config.set(key, value, { scope: "global" }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn("[plugin-manager] UI 态落盘失败:", key, err);
      announceTransient(t("pluginManager.stateSaveFailed", { key, detail }), "error");
    });
  };

  const ctx = usePluginContext();
  const [plugins, setPlugins] = useState<PluginListItem[]>([]);
  const [customOrder, setCustomOrder] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<TagFilter>({});
  const [installOpen, setInstallOpen] = useState(false);
  const [installUrl, setInstallUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  /** 当前会话的内核是否**承接**追加系统 prompt（r50）。
   *
   *  走的是 timeline 同一条通路（`useSessionStore` 的 `capabilities`，由 store 在会话就绪时
   *  经 `getCapabilities()` 填充），而不是自己新开一次 API 调用——`SessionsApi` 上并没有
   *  `getCapabilities`（那是 `window.kernel.sessions` 的形状），插件侧的既定入口是 store。
   *
   *  三态而不是布尔：`null` = 还不知道（没有会话 / 能力面尚未就绪）。此时**不下结论**——
   *  信息不足时断言"不生效"会误伤真正支持的内核，宁可不说。 */
  const caps = useSessionStore((s) => s.capabilities);
  const systemPromptInert = caps.kernel != null ? caps.faces?.systemPrompt !== true : null;

  const refresh = useCallback(async () => {
    // ⚠ 三段各自兜底（r83）：此前是裸 await 串起来，任一段抛错就会**静默**中止后面的段——
    //   `ctx.plugins.list()` 失败 ⇒ 列表停在旧数据、用户以为操作没生效，且一点提示都没有
    //   （服务端 handler 抛错时 gateway→transport 会 reject，见 ws-transport.ts:102）。
    //   分开兜底还保证：列表读失败不影响排序/筛选的恢复，反之亦然。
    try {
      setPlugins(await ctx.plugins.list());
    } catch (err) {
      showFeedback({ ok: false, error: (err as Error)?.message || "pluginManager.operationFailed" });
    }
    try {
      const order = await ctx.config.get<string[]>("customOrder");
      if (order) setCustomOrder(order);
      const filter = await ctx.config.get<TagFilter>("tagFilter");
      if (filter) setTagFilter(filter);
    } catch {
      // 偏好读取失败：用默认序/默认筛选即可，不打扰用户（不是"用户以为成功了"的那类静默）
    }
  }, [ctx]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const showFeedback = (r: { ok: boolean; error: string | null; errorArgs?: string[] }) => {
    // error 是 token key(如 plugin.error.notLoaded)则 t() 翻译;非 token(如 npm 退出码)
    // 经 i18next parseMissingKeyHandler 原样返回。errorArgs 用于插值(如依赖列表)。
    if (r.ok) { setFeedback({ ok: true, msg: t("pluginManager.operationSuccess") }); return; }
    const msg = r.error
      ? t(r.error, r.errorArgs ? { deps: r.errorArgs.join(", ") } : undefined)
      : t("pluginManager.operationFailed");
    setFeedback({ ok: false, msg });
  };

  /** 跑一个插件操作，把**两种失败形态**都收敛到 showFeedback（r80）。
   *
   *  ① 服务端返回 `{ ok:false, error }` —— 既有的 token-key 协议（error 是 i18n 键，
   *     如 `plugin.error.notLoaded`；非键的字符串由 i18next 原样返回）；
   *  ② 服务端 handler **抛错** —— gateway 把它转成 `{ok:false, error:{code:"HANDLER_ERROR", message}}`
   *     （routing/gateway.ts:61-66），transport 据此 **reject**（ws-transport.ts:102），
   *     于是 `await` 会 throw，形态①的那条路径根本走不到。
   *
   *  此前 5 个 handler（enable/disable/uninstall/reload/install）都直接
   *  `showFeedback(await ctx.plugins.X(…))` 且**没有 try/catch**，所以形态②的后果是：
   *  **一点提示都没有**，且 install 那条还会让 `setInstalling(false)` 走不到 ⇒
   *  按钮永久停在 installing 态、对话框不关、输入不清（用户只能刷新页面）。
   *  而 `ctx.plugins.install` 的返回类型标称 `Promise<{ok,error}>`，对抛错路径是**假的**。
   *  §7.6：不许静默、不许假装成功。 */
  const runOp = async (
    op: () => Promise<{ ok: boolean; error: string | null; errorArgs?: string[] }>,
  ): Promise<boolean> => {
    try {
      const r = await op();
      showFeedback(r);
      return r.ok;
    } catch (err) {
      // 抛错形态：把 message 当文案交给 showFeedback（它内部会先试着按 i18n 键翻译，
      // 不是键就原样显示）——用户至少要看到"为什么失败"。
      showFeedback({ ok: false, error: (err as Error)?.message || "pluginManager.operationFailed" });
      return false;
    }
  };

  const handleEnable = async (id: string) => { await runOp(() => ctx.plugins.enable(id)); void refresh(); };
  const handleDisable = async (id: string) => { await runOp(() => ctx.plugins.disable(id)); void refresh(); };
  const handleUninstall = async (id: string) => { await runOp(() => ctx.plugins.uninstall(id)); void refresh(); };
  const handleReload = async (id: string) => { await runOp(() => ctx.plugins.reload(id)); void refresh(); };

  const handleInstall = async () => {
    if (!installUrl.trim()) return;
    setInstalling(true);
    const source = installUrl.startsWith("http")
      ? { type: "url" as const, location: installUrl }
      : { type: "local" as const, location: installUrl };
    // ⚠ 用 try/finally 保证**无论成功失败都解除 installing 态**（r80 的卡死根因）。
    //   成功才关对话框并清空输入；失败时保留它们，方便用户改完 URL 直接重试。
    let ok = false;
    try {
      ok = await runOp(() => ctx.plugins.install(source));
    } finally {
      setInstalling(false);
      if (ok) { setInstallOpen(false); setInstallUrl(""); }
    }
    void refresh();
  };

  const handleSelectFile = async () => {
    const path = await pickDirectory(ctx);   // r137：统一原语
    if (path) setInstallUrl(path);
  };

  const sortedPlugins = useMemo(() => sortPlugins(plugins, customOrder), [plugins, customOrder]);
  const filteredPlugins = useMemo(() => filterPluginsByTags(sortedPlugins, tagFilter), [sortedPlugins, tagFilter]);
  const { currentPage, setCurrentPage, totalPages, pageItems, scrollRef } = usePagination(filteredPlugins, PAGE_SIZE);
  const allTags = useMemo(() => orderTags(new Set(plugins.flatMap((p) => p.tags))), [plugins]);

  const cycleTag = (tag: string) => {
    const next = { ...tagFilter };
    if (next[tag] === "inc") next[tag] = "exc";
    else if (next[tag] === "exc") delete next[tag];
    else next[tag] = "inc";
    setTagFilter(next);
    persist("tagFilter", next);
  };

  const resetTagFilter = () => {
    setTagFilter({});
    persist("tagFilter", {});
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
    persist("customOrder", newOrder);
  }, [sortedPlugins, ctx]);

  // Tooltip.Provider 由内核根组件统一提供(index.tsx),此处只保留 Root 局部配置;
  // 相邻按钮 hover 间仍享有加热区交接。
  return (
    <div ref={scrollRef}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--spacing-lg)" }}>
        <h2 style={{ fontSize: "var(--font-size-lg)", fontWeight: 600, color: "var(--color-fg)" }}>
          {t("settings.plugins", { defaultValue: "插件" })}
        </h2>
        {/* ⚠ 稳定探针锚点（r96，§10.3：探针必须靠稳定锚，不靠文本子串）。
            安装表单有**两个文本高度相似的按钮**：这个折叠开关（pluginManager.install）
            与表单内的提交钮（pluginManager.installBtn）。r95 的 e2e 因此反复点错——
            点开关等于把刚展开的表单又关上，看起来像"提交没反应"。
            补 data-plugin-install 一族锚点后，脚本不必再按文本猜。 */}
        <Button variant="primary" data-plugin-install="toggle" aria-expanded={installOpen} onClick={() => setInstallOpen(!installOpen)}>
          <Download size={14} />
          <span>{t("pluginManager.install")}</span>
        </Button>
      </div>

      {installOpen && (
        <div style={{ marginBottom: "var(--spacing-md)", padding: "var(--spacing-md)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", background: "var(--color-surface)", display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <input
            data-plugin-install="source"
            type="text"
            value={installUrl}
            onChange={(e) => setInstallUrl(e.target.value)}
            placeholder={t("pluginManager.installPlaceholder")}
            style={{ flex: 1, padding: "var(--spacing-xs) var(--spacing-sm)", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", color: "var(--color-fg)", fontSize: "var(--font-size-sm)" }}
          />
          <Button variant="secondary" data-plugin-install="browse" onClick={handleSelectFile}>{t("pluginManager.selectFile")}</Button>
          <Button variant="primary" data-plugin-install="submit" data-installing={installing ? "true" : "false"} onClick={handleInstall} disabled={installing || !installUrl.trim()}>
            {installing ? t("pluginManager.installing") : t("pluginManager.installBtn")}
          </Button>
        </div>
      )}

      {/* 瞬时反馈必须进 live region（r59）：安装/启用/卸载的结果几秒后消失，
          读屏用户若听不到就等于操作"没有任何反应"。ok=false 用 alert（可打断）。 */}
      {feedback && <Announce message={feedback.msg} variant={feedback.ok ? "info" : "error"} />}
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
              <PluginRow key={p.id} plugin={p} t={t} systemPromptInert={systemPromptInert} onEnable={handleEnable} onDisable={handleDisable} onUninstall={handleUninstall} onReload={handleReload} />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <Pagination
        prevLabel={t("shell.pagePrev")}
        nextLabel={t("shell.pageNext")}
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={setCurrentPage}
        trailing={
          <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", marginLeft: "var(--spacing-sm)" }}>
            {t("pluginManager.total", { count: filteredPlugins.length })}
          </span>
        }
      />
    </div>
  );
}

function PluginRow({ plugin: p, t, systemPromptInert, onEnable, onDisable, onUninstall, onReload }: {
  /** 见 PluginManagerPage 里的同名 state：null = 未知（不显示提示）。 */
  systemPromptInert: boolean | null;
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
      {/* ⚠ 拖拽手柄是纯图标：dnd-kit 的 attributes 给了 role="button" 与 tabIndex，
          但**可访问名要自己给**（里面只有一个 svg）。r38 普查发现它是全应用 3 种
          无名可交互元素里出现次数最多的（×10，每行一个）。 */}
      <span
        {...attributes}
        {...listeners}
        aria-label={t("shell.dragToReorder")}
        data-plugin-drag-handle=""
        style={{ cursor: "grab", color: "var(--color-muted)", flexShrink: 0 }}
      >
        <GripVertical size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
          <span style={{ fontSize: "var(--font-size-sm)", fontWeight: 500, color: "var(--color-fg)" }}>{displayName}</span>
          <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>{p.version}</span>
          <span style={{ fontSize: "var(--font-size-xs)", color: tierColor(p.tier), border: `1px solid ${tierColor(p.tier)}`, borderRadius: "var(--radius-sm)", padding: "0 4px", lineHeight: "16px" }}>{tierLabel}</span>
          {p.protected && <Shield size={11} style={{ color: "var(--color-muted)" }} />}
        </div>
        {/* 显式降级（§7.6 / §1.5 第三条出路，r50）：这个插件贡献了 systemPrompts 槽，
            而当前会话的内核**不承接**追加系统 prompt ⇒ 它的注入实际不生效。
            此前这件事在界面上完全看不出来：插件照常显示"已启用"、描述照常承诺注入，
            用户没有任何线索知道贡献被静默忽略了（§1.5 唯一禁止的「静默缺面」）。
            ⚠ 只在 `systemPromptInert === true` 时显示；null（未知）不显示。 */}
        {systemPromptInert === true && (p.contributes?.systemPrompts?.length ?? 0) > 0 && (
          <div
            data-plugin-systemprompt-inert=""
            title={t("pluginManager.systemPromptInert")}
            style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}
          >
            <span>{t("pluginManager.systemPromptInert")}</span>
          </div>
        )}
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
          <button onClick={onClick} disabled={disabled} style={iconBtn(disabled)} aria-label={tooltip}>
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
