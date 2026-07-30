// 设置整页 —— 框架驱动配置管理。
//
// 框架从 manifest 读 configFile + configMerge,自动管:
// - 读 configFile → 传 config prop 给组件
// - 组件调 onChange → 框架设 dirty + 更新 config state
// - 确定改动 → config-file:set 写回 configFile
// - 取消改动 → 重读 configFile 恢复
// - 打开配置按钮 → pi.openFile(configFile)
// - 刷新按钮 → refreshSignal+1
// - 未保存拦截 → 切 tab/返回对话时弹窗
// 无 configFile 的插件(theme-manager):不传 config(null)、不显示浮层/打开按钮/拦截。
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { ArrowLeft, RefreshCw, FileText } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { useUiStore } from "../ui-store";
import { ChatRow } from "../ui/chat-row";
import { getSettingsComponent, ListItem, PluginIcon, type SettingsComponentProps, type SettingsItem, PluginIdContext, eventBus } from "@pi-desktop/react";

const SIDEBAR_MIN_PX = 180;
const SIDEBAR_MAX_PX = 500;
const SIDEBAR_DEFAULT_PX = 260;

export function SettingsPage(): React.ReactNode {
  const { t } = useTranslation();
  const setActiveView = useUiStore((s) => s.setActiveView);
  const sidebarStyle = useUiStore((s) => s.sidebarStyle);
  useUiStore((s) => s.pluginsNonce);
  const [items, setItems] = useState<SettingsItem[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [flash, setFlash] = useState(false);
  const leftPanelRef = useRef<ImperativePanelHandle>(null);
  const layoutRef = useRef<number[]>([]);
  const pgRef = useRef<HTMLDivElement>(null);
  const [handleDragging, setHandleDragging] = useState(false);

  const pgWidth = (): number => pgRef.current?.clientWidth ?? window.innerWidth;

  useEffect(() => {
    void window.pi.prefs.get<number>("sidebarWidth").then((w) => {
      if (w && w >= SIDEBAR_MIN_PX && w <= SIDEBAR_MAX_PX) {
        requestAnimationFrame(() => {
          leftPanelRef.current?.resize((w / pgWidth()) * 100);
        });
      }
    });
  }, []);
  const onHandleDragging = (dragging: boolean): void => {
    setHandleDragging(dragging);
    if (!dragging && layoutRef.current.length > 0) {
      const px = Math.round((layoutRef.current[0] / 100) * pgWidth());
      void window.pi.prefs.set("sidebarWidth", Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, px)));
    }
  };
  /** per-item config state:框架从 configFile 读了传入组件。id → config。 */
  const [configs, setConfigs] = useState<Map<string, Record<string, unknown> | null>>(new Map());
  /** per-item dirty state:组件调 onChange 后变 true。 */
  const [dirties, setDirties] = useState<Map<string, boolean>>(new Map());
  const [saving, setSaving] = useState(false);
  /** 未保存拦截:有 dirty 时切 tab/返回 → 弹窗。 */
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  useEffect(() => {
    if (refreshSignal === 0) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 280);
    return () => clearTimeout(t);
  }, [refreshSignal]);

  // 评估 P1-E:settings.json 被外部写入(如 skill-toggle 改 skills)时自动刷新,
  // 避免 pi-manager 等 framework 模式页显示旧值(失同步修复)。
  useEffect(() => {
    return eventBus.on("system:settingsChanged", () => setRefreshSignal((n) => n + 1));
  }, []);

  // 启动读 settings 槽 + 各 configFile
  useEffect(() => {
    void window.pi.settings.list().then(async (list) => {
      setItems(list);
      setActiveId((prev) => prev || (list.length > 0 ? list[0].id : ""));
      // 读每个 saveMode=framework 的项的 configFile(manual 模式不读、不参与 save)
      const cfgs = new Map<string, Record<string, unknown> | null>();
      for (const item of list) {
        if (item.configFile && item.saveMode === "framework") {
          const cfg = await window.pi.configFile.get(item.configFile);
          cfgs.set(item.id, cfg);
        } else {
          cfgs.set(item.id, null);
        }
      }
      setConfigs(cfgs);
    });
  }, []);

  // 刷新:重读 active 项的 configFile
  const refreshActive = useCallback(async () => {
    if (!activeId) return;
    const item = items.find((i) => i.id === activeId);
    if (!item?.configFile) return;
    const cfg = await window.pi.configFile.get(item.configFile);
    setConfigs((prev) => { const n = new Map(prev); n.set(activeId, cfg); return n; });
    setDirties((prev) => { const n = new Map(prev); n.set(activeId, false); return n; });
  }, [activeId, items]);

  // refreshSignal 变 → 重读 active configFile(框架管刷新,不靠组件重拉)
  useEffect(() => {
    if (refreshSignal === 0) return;
    void refreshActive();
  }, [refreshSignal, refreshActive]);

  const activeItem = items.find((i) => i.id === activeId);
  const activeConfigFile = activeItem?.configFile ?? null;
  // dirty/save/拦截只对 saveMode=framework 生效;manual 模式(如主题)不参与
  const activeIsFramework = activeItem?.saveMode === "framework";
  const activeDirty = activeIsFramework && !!dirties.get(activeId);

  const handleConfigChange = (id: string, newConfig: Record<string, unknown>): void => {
    setConfigs((prev) => { const n = new Map(prev); n.set(id, newConfig); return n; });
    setDirties((prev) => { const n = new Map(prev); n.set(id, true); return n; });
  };

  const doSave = async (): Promise<void> => {
    if (!activeItem?.configFile) return;
    setSaving(true);
    try {
      const cfg = configs.get(activeId);
      if (cfg) {
        const next = await window.pi.configFile.set(activeItem.configFile, cfg, activeItem.configMerge);
        setConfigs((prev) => { const n = new Map(prev); n.set(activeId, next); return n; });
      }
      setDirties((prev) => { const n = new Map(prev); n.set(activeId, false); return n; });
    } finally {
      setSaving(false);
    }
  };

  const doReset = async (): Promise<void> => {
    if (!activeItem?.configFile) return;
    const cfg = await window.pi.configFile.get(activeItem.configFile);
    setConfigs((prev) => { const n = new Map(prev); n.set(activeId, cfg); return n; });
    setDirties((prev) => { const n = new Map(prev); n.set(activeId, false); return n; });
  };

  const guardNavigate = (action: () => void): void => {
    if (activeDirty) setPendingAction(() => action);
    else action();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--color-bg)", color: "var(--color-fg)", fontFamily: "var(--font-family-sans)" }}>

      {/* 主体:左列表 + 右配置区(PanelGroup 横向可拖,和 ChatView 同库同模式) */}
      <div ref={pgRef} style={{ flex: 1, minHeight: 0 }}>
      <PanelGroup id="settings-pg" direction="horizontal" onLayout={(sizes) => { layoutRef.current = sizes; }} style={{ height: "100%" }}>
        <Panel
          ref={leftPanelRef}
          defaultSize={(SIDEBAR_DEFAULT_PX / window.innerWidth) * 100}
          minSize={(SIDEBAR_MIN_PX / window.innerWidth) * 100}
          maxSize={(SIDEBAR_MAX_PX / window.innerWidth) * 100}
        >
        {/* 左:插件配置项列表(上滚动 + 下固定返回对话,对称会话页底部设置按钮) */}
        <div data-sidebar-style={sidebarStyle} style={{ height: "100%", borderRight: "1px solid var(--color-border)", display: "flex", flexDirection: "column", background: "var(--color-chrome)" }}>
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 10px 8px", display: "flex", flexDirection: "column", gap: "var(--sidebar-row-gap)" }}>
            {items.map((item) => {
              const activeNow = activeId === item.id;
              return (
                <ListItem key={item.id} active={activeNow} onClick={() => guardNavigate(() => setActiveId(item.id))} style={{ border: "none", background: activeNow ? "var(--sidebar-row-bg-active)" : "transparent", fontSize: "16px", padding: "14px 14px" }}>
                  <div className="flex items-center gap-2">
                    <PluginIcon name={item.icon} className="size-5 shrink-0" />
                    <span>{t(`settings.${item.id}`, { defaultValue: item.title })}</span>
                  </div>
                </ListItem>
              );
            })}
          </div>
          {/* 返回对话:和会话页底部"设置"按钮同款 ChatRow + border-top */}
          <div className="border-t border-[var(--color-border)] shrink-0 px-2 py-2">
            <ChatRow onClick={() => guardNavigate(() => setActiveView("chat"))} icon={<ArrowLeft className="size-4.5" />}>
              {t("shell.backToChat")}
            </ChatRow>
          </div>
        </div>
        </Panel>
        <PanelResizeHandle
          onDragging={onHandleDragging}
          style={{
            width: "4px",
            cursor: "col-resize",
            background: handleDragging ? "var(--color-primary)" : "transparent",
            transition: "background 0.15s",
          }}
        />
        <Panel>
        {/* 右:配置区。所有组件都渲染,active 显示、其余 display:none(切 tab 不重 mount) */}
        <div className="settings-content" style={{ height: "100%", position: "relative", display: "flex", flexDirection: "column" }}>
          {/* 右上角:打开配置 + 刷新 按钮 */}
          {activeId && (
            <div style={{ position: "absolute", top: "var(--spacing-sm)", right: "var(--spacing-lg)", zIndex: 10, display: "flex", gap: "var(--spacing-xs)" }}>
              {activeConfigFile && (
                <button onClick={() => void window.pi.openFile(activeConfigFile)} title={t("shell.openConfig")} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--color-muted)", cursor: "pointer" }}>
                  <FileText size={14} />
                </button>
              )}
              <button onClick={() => setRefreshSignal((s) => s + 1)} title={t("shell.refresh")} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--color-muted)", cursor: "pointer" }}>
                <RefreshCw size={14} />
              </button>
            </div>
          )}
          {/* 内容区:每个组件独占一列,active 显示+滚动,非 active 隐藏 */}
          {items.map((item) => {
            const Comp = getSettingsComponent(item.component);
            if (!Comp) return null;
            const active = activeId === item.id;
            const cfg = configs.get(item.id) ?? null;
            return (
              <motion.div key={item.id} style={{ display: active ? "flex" : "none", flex: 1, flexDirection: "column", overflowY: "auto" }} animate={{ opacity: active && flash ? 0.4 : 1 }} transition={{ duration: 0.25, ease: "easeOut" }}>
                <div className="flex items-center gap-2 shrink-0 select-none" style={{ padding: "14px var(--sidepanel-header-px)", borderBottom: "1px solid var(--color-border)", fontSize: "16px", fontWeight: 600, color: "var(--color-fg)" }}>
                  <PluginIcon name={item.icon} className="size-5 shrink-0" />
                  <span className="truncate">{t(`settings.${item.id}`, { defaultValue: item.title })}</span>
                </div>
                <PluginIdContext.Provider value={item.pluginId}>
                  <Comp refreshSignal={refreshSignal} config={cfg} onChange={(c) => handleConfigChange(item.id, c)} />
                </PluginIdContext.Provider>
              </motion.div>
            );
          })}
          {items.length > 0 && !items.some((i) => i.id === activeId && getSettingsComponent(i.component)) && (
            <div style={{ padding: "var(--spacing-xl)", color: "var(--color-muted)" }}>{t("shell.noConfig")}</div>
          )}
        </div>
        </Panel>
      </PanelGroup>
      </div>
      {createPortal(
        <AnimatePresence>
          {activeDirty && activeConfigFile && (
            <div style={{ position: "fixed", top: "var(--spacing-md)", left: "50%", transform: "translateX(-50%)", zIndex: 9999 }}>
              <motion.div
                initial={{ y: -60, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -60, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", background: "var(--color-surface)", borderRadius: "var(--radius-md)", border: "1px solid var(--color-primary)", padding: "var(--spacing-sm) var(--spacing-lg)", boxShadow: "var(--shadow-md)", whiteSpace: "nowrap" }}
              >
                <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-fg)" }}>{t("shell.unsavedChanges")}</span>
                <button onClick={() => void doReset()} disabled={saving} style={barBtn(false, saving)}>{t("shell.discardChanges")}</button>
                <button onClick={() => void doSave()} disabled={saving} style={barBtn(true, saving)}>{saving ? t("shell.saving") : t("shell.confirmChanges")}</button>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body,
      )}

      {/* 框架级未保存拦截弹窗 */}
      {createPortal(
        <AnimatePresence>
          {pendingAction && (
            <div style={{ position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)" }}>
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                style={{ background: "var(--color-surface)", borderRadius: "var(--radius-lg)", border: "1px solid var(--color-border)", padding: "var(--spacing-lg)", boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", gap: "var(--spacing-md)", minWidth: "320px" }}
              >
                <span style={{ fontSize: "var(--font-size-base)", fontWeight: 600, color: "var(--color-fg)" }}>{t("shell.unsavedChanges")}</span>
                <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("shell.savePrompt")}</span>
                <div style={{ display: "flex", gap: "var(--spacing-sm)", justifyContent: "flex-end" }}>
                  <button onClick={() => setPendingAction(null)} style={barBtn(false, false)}>{t("shell.cancel")}</button>
                  <button onClick={async () => { await doReset(); const a = pendingAction; setPendingAction(null); a?.(); }} style={barBtn(false, false)}>{t("shell.discard")}</button>
                  <button onClick={async () => { await doSave(); const a = pendingAction; setPendingAction(null); a?.(); }} disabled={saving} style={barBtn(true, saving)}>{saving ? t("shell.saving") : t("shell.saveAndContinue")}</button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

function barBtn(primary: boolean, disabled: boolean): React.CSSProperties {
  return {
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
