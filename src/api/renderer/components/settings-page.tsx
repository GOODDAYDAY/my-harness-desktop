// 设置整页 —— 框架驱动配置管理。
//
// 框架从 manifest 读 configFile + configMerge,自动管:
// - 读 configFile → 传 config prop 给组件
// - 组件调 onChange → 框架设 dirty + 更新 config state
// - 确定改动 → 写回(分层项:diff 写项目级;底座项:config-file:set 整份)
// - 取消改动 → 重读恢复
// - 打开配置按钮 → pi.openFile(生效层的文件)
// - 刷新按钮 → refreshSignal+1
// - 未保存拦截 → 切 tab/返回对话时弹窗
// - 设为全局/移除项目覆盖/来源徽标 → 仅分层项(见下)
//
// 分层判定(内容驱动,路径前缀决定语义,不加 kind 字段):
// - ~/.pi/agent/ 前缀 → 底座文件:白名单通道原样读写,无分层无按钮(底座自留地)
// - ~/.pi-desktop/ 前缀 → 分层项:读两层 key 级合并(项目级只存 diff),
//   零声明(configFile=null)的 framework 项默认 ~/.pi-desktop/config/{pluginId}.json
//   (统一通道约定,docs/design/unified-project-config.md)
// saveMode=manual 的插件(theme-manager):不传 config(null)、不显示浮层/打开按钮/拦截。
import { useCallback, useEffect, useRef, useState, memo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { ArrowLeft, RefreshCw, FileText, Globe, FolderX } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { useUiStore, SIDEBAR_MIN_PX, SIDEBAR_MAX_PX, AREA_FONT_SCALE_MIN, AREA_FONT_SCALE_MAX } from "../ui-store";
import { ChatRow } from "../ui/chat-row";
import { getSettingsComponent, ListItem, PluginIcon, type SettingsComponentProps, type SettingsItem, PluginIdContext, eventBus } from "@pi-desktop/react";

/** 统一通道默认路径:零声明的 framework 项按 pluginId 推路径(~/.pi-desktop/config/{pluginId}.json)。 */
const DESKTOP_PREFIX = "~/.pi-desktop/";
const AGENT_PREFIX = "~/.pi/agent/";

function effectiveConfigFile(item: SettingsItem): string {
  return item.configFile ?? `${DESKTOP_PREFIX}config/${item.pluginId}.json`;
}
/** 底座文件(~/.pi/agent/):白名单通道,不分层。其余(~/.pi-desktop/)走两层合并。 */
function isBaseFile(configFile: string): boolean {
  return configFile.startsWith(AGENT_PREFIX);
}
/** 分层项的 relPath(相对 ~/.pi-desktop/):项目级 = <cwd>/.pi-desktop/<relPath>。 */
function relPathOf(configFile: string): string {
  return configFile.slice(DESKTOP_PREFIX.length);
}

/** 读分层项:两层 key 级合并 + 项目级是否有覆盖(徽标/按钮显隐)。无 cwd 时只读全局。 */
async function readLayered(configFile: string, cwd: string): Promise<{ merged: Record<string, unknown>; hasProject: boolean }> {
  if (!cwd) {
    const g = await window.pi.configFile.get(configFile);
    return { merged: g, hasProject: false };
  }
  const rel = relPathOf(configFile);
  const [merged, projectRaw] = await Promise.all([
    window.pi.configFile.getLayered(cwd, rel),
    window.pi.configFile.getProject(cwd, rel),
  ]);
  return { merged: merged ?? {}, hasProject: !!projectRaw && Object.keys(projectRaw).length > 0 };
}

interface SettingsPaneProps {
  item: SettingsItem;
  active: boolean;
  refreshSignal: number;
  config: Record<string, unknown> | null;
  paneRef: React.RefObject<HTMLDivElement | null>;
  onConfigChange: (id: string, c: Record<string, unknown>) => void;
}

// pane 级 memo:SettingsPage 重渲染时已挂载 pane 不陪跑 reconcile。
// 根因(实测):内容区曾无条件渲染全部插件设置组件,任何父级更新(视图切换/
// 偏好变化)都级联全量重渲染;props 全为稳定引用(item/config 是 state 快照,
// paneRef/onConfigChange 恒定),memo 生效。
const SettingsPane = memo(function SettingsPane({ item, active, refreshSignal, config, paneRef, onConfigChange }: SettingsPaneProps): React.ReactNode {
  const { t } = useTranslation();
  const Comp = getSettingsComponent(item.component);
  if (!Comp) return null;
  return (
    <div ref={active ? paneRef : null} style={{ display: active ? "flex" : "none", flex: 1, flexDirection: "column", overflowY: "auto" }}>
      <div className="flex items-center gap-2 shrink-0 select-none" style={{ padding: "14px var(--sidepanel-header-px)", borderBottom: "1px solid var(--color-border)", fontSize: "16px", fontWeight: 600, color: "var(--color-fg)" }}>
        <PluginIcon name={item.icon} className="size-5 shrink-0" />
        <span className="truncate">{t(`settings.${item.id}`, { defaultValue: item.title })}</span>
      </div>
      <PluginIdContext.Provider value={item.pluginId}>
        <Comp refreshSignal={refreshSignal} config={config} onChange={(c) => onConfigChange(item.id, c)} />
      </PluginIdContext.Provider>
    </div>
  );
});

export function SettingsPage(): React.ReactNode {
  const { t } = useTranslation();
  const setActiveView = useUiStore((s) => s.setActiveView);
  const sidebarStyle = useUiStore((s) => s.sidebarStyle);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const sidebarFontScale = useUiStore((s) => s.sidebarFontScale);
  const fontPreviewDragging = useUiStore((s) => s.fontPreviewDragging);
  const pluginsNonce = useUiStore((s) => s.pluginsNonce);
  const currentCwd = useUiStore((s) => s.currentCwd);
  const [items, setItems] = useState<SettingsItem[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [refreshSignal, setRefreshSignal] = useState(0);
  const leftPanelRef = useRef<ImperativePanelHandle>(null);
  /** 刷新闪烁的作用目标:当前激活的内容面板。 */
  const activePaneRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef<number[]>([]);
  const pgRef = useRef<HTMLDivElement>(null);
  const [handleDragging, setHandleDragging] = useState(false);

  const pgWidth = (): number => pgRef.current?.clientWidth ?? window.innerWidth;

  // 左栏宽度真相源在 ui-store,与会话页共享:订阅 → imperative resize(对侧拖动这边同步)
  useEffect(() => {
    leftPanelRef.current?.resize((sidebarWidth / pgWidth()) * 100);
  }, [sidebarWidth]);
  const onHandleDragging = (dragging: boolean): void => {
    setHandleDragging(dragging);
    if (!dragging && layoutRef.current.length > 0) {
      setSidebarWidth((layoutRef.current[0] / 100) * pgWidth());
    }
  };
  /** per-item config state:框架从 configFile 读了传入组件。id → config。 */
  const [configs, setConfigs] = useState<Map<string, Record<string, unknown> | null>>(new Map());
  /** per-item dirty state:组件调 onChange 后变 true。 */
  const [dirties, setDirties] = useState<Map<string, boolean>>(new Map());
  /** dirties 的 ref 镜像:pluginsNonce 触发的异步重读要读最新 dirty(闭包拿不到)。 */
  const dirtiesRef = useRef<Map<string, boolean>>(new Map());
  useEffect(() => { dirtiesRef.current = dirties; }, [dirties]);
  /** per-item 项目级覆盖存在性(分层项):来源徽标 + "移除项目覆盖"按钮显隐。 */
  const [projectOverrides, setProjectOverrides] = useState<Map<string, boolean>>(new Map());
  const [saving, setSaving] = useState(false);
  /** 未保存拦截:有 dirty 时切 tab/返回 → 弹窗。 */
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  // 刷新闪烁反馈:WAAPI 一次动画(OFF→0.4→ON)自行结束,合成器驱动。
  // 不用 "setTimeout 翻转 flash state + framer-motion rAF 动画"——主线程拥塞时
  // (会话流式渲染等把 renderer 打满)定时器与 rAF 会一起饿死,内容卡在
  // opacity 0.4 的暗态迟迟不回("保存后整体变暗不恢复"的根因)。
  useEffect(() => {
    if (refreshSignal === 0) return;
    activePaneRef.current?.animate(
      [{ opacity: "1" }, { opacity: "0.4", offset: 0.35 }, { opacity: "1" }],
      { duration: 450, easing: "ease-out" },
    );
  }, [refreshSignal]);

  // 评估 P1-E:settings.json 被外部写入(如 skill-toggle 改 skills)时自动刷新,
  // 避免 pi-manager 等 framework 模式页显示旧值(失同步修复)。
  useEffect(() => {
    return eventBus.on("system:settingsChanged", () => setRefreshSignal((n) => n + 1));
  }, []);

  // 启动 + 插件生命周期变化(pluginsNonce)+ 切项目(currentCwd)时读 settings 槽 + 各 configFile。
  // 读每个 saveMode=framework 的项:底座项直读,分层项两层合并读(manual 模式不读、不参与 save)。
  // 重读不得冲掉未保存编辑:dirty 项保留现值;插件被禁用时剪掉残留 state。
  useEffect(() => {
    let cancelled = false;
    void window.pi.settings.list().then(async (list) => {
      const cfgs = new Map<string, Record<string, unknown> | null>();
      const overrides = new Map<string, boolean>();
      for (const item of list) {
        if (item.saveMode !== "framework") { cfgs.set(item.id, null); continue; }
        const file = effectiveConfigFile(item);
        if (isBaseFile(file)) {
          cfgs.set(item.id, await window.pi.configFile.get(file));
          overrides.set(item.id, false);
        } else {
          const { merged, hasProject } = await readLayered(file, currentCwd);
          cfgs.set(item.id, merged);
          overrides.set(item.id, hasProject);
        }
      }
      if (cancelled) return;
      setItems(list);
      setActiveId((prev) => (prev && list.some((i) => i.id === prev) ? prev : (list.length > 0 ? list[0].id : "")));
      setConfigs((prev) => {
        const next = new Map(cfgs);
        for (const [id, dirty] of dirtiesRef.current) {
          if (dirty && next.has(id)) next.set(id, prev.get(id) ?? null);
        }
        return next;
      });
      setProjectOverrides(overrides);
      setDirties((prev) => {
        const ids = new Set(list.map((i) => i.id));
        const next = new Map([...prev].filter(([id]) => ids.has(id)));
        return next.size === prev.size ? prev : next;
      });
    });
    return () => { cancelled = true; };
  }, [pluginsNonce, currentCwd]);

  // 刷新:重读 active 项的 configFile(分层项两层合并)
  const refreshActive = useCallback(async () => {
    if (!activeId) return;
    const item = items.find((i) => i.id === activeId);
    if (!item || item.saveMode !== "framework") return;
    const file = effectiveConfigFile(item);
    if (isBaseFile(file)) {
      const cfg = await window.pi.configFile.get(file);
      setConfigs((prev) => { const n = new Map(prev); n.set(activeId, cfg); return n; });
    } else {
      const { merged, hasProject } = await readLayered(file, currentCwd);
      setConfigs((prev) => { const n = new Map(prev); n.set(activeId, merged); return n; });
      setProjectOverrides((prev) => { const n = new Map(prev); n.set(activeId, hasProject); return n; });
    }
    setDirties((prev) => { const n = new Map(prev); n.set(activeId, false); return n; });
  }, [activeId, items, currentCwd]);

  // refreshSignal 变 → 重读 active configFile(框架管刷新,不靠组件重拉)
  useEffect(() => {
    if (refreshSignal === 0) return;
    void refreshActive();
  }, [refreshSignal, refreshActive]);

  const activeItem = items.find((i) => i.id === activeId);
  // 分层判定:effectiveConfigFile 对零声明 framework 项给统一通道默认路径;底座项(~/.pi/agent/)不分层
  const activeConfigFile = activeItem && activeItem.saveMode === "framework" ? effectiveConfigFile(activeItem) : null;
  const activeIsLayered = !!activeConfigFile && !isBaseFile(activeConfigFile);
  // dirty/save/拦截只对 saveMode=framework 生效;manual 模式(如主题)不参与
  const activeIsFramework = activeItem?.saveMode === "framework";
  const activeDirty = activeIsFramework && !!dirties.get(activeId);
  const activeHasProject = activeIsLayered && !!projectOverrides.get(activeId);

  const handleConfigChange = useCallback((id: string, newConfig: Record<string, unknown>): void => {
    setConfigs((prev) => { const n = new Map(prev); n.set(id, newConfig); return n; });
    setDirties((prev) => { const n = new Map(prev); n.set(id, true); return n; });
  }, []);

  // pane 懒挂载:首次激活才 mount(进设置页只挂 1 个组件,不再一口气挂 11 个),
  // 挂载后不卸载(保住组件本地态 + 切 tab 零重挂载,沿用原"切 tab 不重 mount"契约)。
  // 渲染期派生 state:React 提交前同步重渲染,active pane 同帧出现,无空白帧。
  const [mountedIds, setMountedIds] = useState<ReadonlySet<string>>(new Set());
  if (activeId && !mountedIds.has(activeId)) {
    setMountedIds(new Set(mountedIds).add(activeId));
  }

  const [saveError, setSaveError] = useState<string | null>(null);

  // 保存:底座项整份写白名单通道;分层项有 cwd 时算"生效 config 与全局的顶层 key diff"
  // 写项目级(replace 整份替换项目级文件——项目级只存 diff,全局更新未覆盖 key 自动生效),
  // 无 cwd 时全局层是唯一的家,直接写全局。
  const doSave = async (): Promise<void> => {
    if (!activeItem || !activeConfigFile) return;
    setSaving(true);
    setSaveError(null);
    try {
      const cfg = configs.get(activeId);
      if (cfg) {
        // 超时是治标允底:根治应保证 configFile:set 的 IPC handler 必 settle。
        // 在此之前以 10s 兜底发现 main 挂起,不让保存浮层永久转圈。
        let wroteDiff: Record<string, unknown> | null = null;
        const write = async (): Promise<Record<string, unknown>> => {
          if (!activeIsLayered || !currentCwd) return window.pi.configFile.set(activeConfigFile, cfg, activeItem.configMerge);
          const rel = relPathOf(activeConfigFile);
          const globalDoc = await window.pi.configFile.get(activeConfigFile);
          const diff: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(cfg)) {
            if (JSON.stringify(globalDoc[k]) !== JSON.stringify(v)) diff[k] = v;
          }
          await window.pi.configFile.setProject(currentCwd, rel, diff, "replace");
          wroteDiff = diff;
          return (await window.pi.configFile.getLayered(currentCwd, rel)) ?? {};
        };
        const next = await Promise.race([
          write(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("保存超时:main 进程无响应")), 10000),
          ),
        ]);
        setConfigs((prev) => { const n = new Map(prev); n.set(activeId, next); return n; });
        // hasProject 的判定是"项目级文件有覆盖 key"(= 刚写入的 diff 非空),不是合并结果非空
        if (activeIsLayered) setProjectOverrides((prev) => { const n = new Map(prev); n.set(activeId, wroteDiff !== null && Object.keys(wroteDiff).length > 0); return n; });
        // 保存后通知:configFile 写入成功后广播 system:configFileSaved,消费方(timeline/ui-store)
        // 订阅该事件重读 preference,实现"保存即生效"的 live switch——这是机制,不分插件。
        eventBus.emitSystem("system:configFileSaved", { path: activeConfigFile });
      }
      setDirties((prev) => { const n = new Map(prev); n.set(activeId, false); return n; });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // 设为全局:当前生效配置(含未保存编辑)整份写全局层;项目级文件保留不动(继续覆盖),
  // 想彻底回全局状态用"移除项目覆盖"。写后清 dirty(编辑已落盘)。
  const doSetGlobal = async (): Promise<void> => {
    if (!activeItem || !activeConfigFile || !activeIsLayered) return;
    setSaving(true);
    setSaveError(null);
    try {
      const cfg = configs.get(activeId);
      if (cfg) {
        await window.pi.configFile.set(activeConfigFile, cfg, activeItem.configMerge);
        eventBus.emitSystem("system:configFileSaved", { path: activeConfigFile });
      }
      setDirties((prev) => { const n = new Map(prev); n.set(activeId, false); return n; });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // 移除项目覆盖:删项目级文件,该插件在本项目回退全局默认;然后重读两层合并。
  const doClearProject = async (): Promise<void> => {
    if (!activeItem || !activeConfigFile || !activeIsLayered || !currentCwd) return;
    await window.pi.configFile.clearProject(currentCwd, relPathOf(activeConfigFile));
    setProjectOverrides((prev) => { const n = new Map(prev); n.set(activeId, false); return n; });
    setDirties((prev) => { const n = new Map(prev); n.set(activeId, false); return n; });
    await refreshActive();
    eventBus.emitSystem("system:configFileSaved", { path: activeConfigFile });
  };

  const doReset = async (): Promise<void> => {
    if (!activeItem || !activeConfigFile) return;
    if (activeIsLayered) {
      const { merged, hasProject } = await readLayered(activeConfigFile, currentCwd);
      setConfigs((prev) => { const n = new Map(prev); n.set(activeId, merged); return n; });
      setProjectOverrides((prev) => { const n = new Map(prev); n.set(activeId, hasProject); return n; });
    } else {
      const cfg = await window.pi.configFile.get(activeConfigFile);
      setConfigs((prev) => { const n = new Map(prev); n.set(activeId, cfg); return n; });
    }
    setDirties((prev) => { const n = new Map(prev); n.set(activeId, false); return n; });
  };

  const guardNavigate = (action: () => void): void => {
    if (activeDirty) setPendingAction(() => action);
    else action();
  };

  const guardNavigateRef = useRef(guardNavigate);
  guardNavigateRef.current = guardNavigate;
  useEffect(() => {
    return eventBus.on("system:requestNavigateToChat", () => {
      guardNavigateRef.current(() => setActiveView("chat"));
    });
  }, [setActiveView]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--color-bg)", color: "var(--color-fg)", fontFamily: "var(--font-family-sans)" }}>

      {/* 主体:左列表 + 右配置区(PanelGroup 横向可拖,和 ChatView 同库同模式) */}
      <div ref={pgRef} style={{ flex: 1, minHeight: 0 }}>
      <PanelGroup id="settings-pg" direction="horizontal" onLayout={(sizes) => { layoutRef.current = sizes; }} style={{ height: "100%" }}>
        <Panel
          ref={leftPanelRef}
          defaultSize={(sidebarWidth / window.innerWidth) * 100}
          minSize={(SIDEBAR_MIN_PX / window.innerWidth) * 100}
          maxSize={(SIDEBAR_MAX_PX / window.innerWidth) * 100}
        >
        {/* 左:插件配置项列表(上滚动 + 下固定返回对话,对称会话页底部设置按钮) */}
        <div data-sidebar-style={sidebarStyle} style={{ height: "100%", borderRight: "1px solid var(--color-border)", display: "flex", flexDirection: "column", background: "var(--color-chrome)",
          "--font-size-xs": "calc(var(--font-size-xs-raw) * var(--sidebar-font-scale, 1))",
          "--font-size-sm": "calc(var(--font-size-sm-raw) * var(--sidebar-font-scale, 1))",
          "--font-size-base": "calc(var(--font-size-base-raw) * var(--sidebar-font-scale, 1))",
          "--font-size-lg": "calc(var(--font-size-lg-raw) * var(--sidebar-font-scale, 1))",
          "--sidebar-section-fs": "calc(var(--font-size-sm-raw) * var(--sidebar-font-scale, 1))",
        } as React.CSSProperties}>
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
        {/* 右:配置区。激活过的组件才挂载,active 显示、其余 display:none(切 tab 不重 mount) */}
        <div className="settings-content" style={{ height: "100%", position: "relative", display: "flex", flexDirection: "column" }}>
          {/* 右上角:来源徽标 + 设为全局/移除项目覆盖(分层项) + 打开配置 + 刷新 */}
          {activeId && (
            <div style={{ position: "absolute", top: "var(--spacing-sm)", right: "var(--spacing-lg)", zIndex: 10, display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
              {activeIsLayered && currentCwd && (
                <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", padding: "2px var(--spacing-xs)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", userSelect: "none" }}>
                  {activeHasProject ? t("shell.configSourceProject") : t("shell.configSourceGlobal")}
                </span>
              )}
              {activeIsLayered && currentCwd && (
                <button onClick={() => void doSetGlobal()} disabled={saving} title={t("shell.saveToGlobal")} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--color-muted)", cursor: "pointer" }}>
                  <Globe size={14} />
                </button>
              )}
              {activeIsLayered && currentCwd && activeHasProject && (
                <button onClick={() => void doClearProject()} disabled={saving} title={t("shell.removeProjectOverride")} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--color-muted)", cursor: "pointer" }}>
                  <FolderX size={14} />
                </button>
              )}
              {activeConfigFile && (
                <button
                  onClick={() => void window.pi.openFile(
                    activeIsLayered && currentCwd && activeHasProject
                      ? `${currentCwd}/.pi-desktop/${relPathOf(activeConfigFile)}`
                      : activeConfigFile,
                  )}
                  title={t("shell.openConfig")}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--color-muted)", cursor: "pointer" }}
                >
                  <FileText size={14} />
                </button>
              )}
              <button onClick={() => setRefreshSignal((s) => s + 1)} title={t("shell.refresh")} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--color-muted)", cursor: "pointer" }}>
                <RefreshCw size={14} />
              </button>
            </div>
          )}
          {/* 内容区:只渲染激活过的 pane(mountedIds),active 显示+滚动,非 active 隐藏 */}
          {items.map((item) =>
            mountedIds.has(item.id) ? (
              <SettingsPane
                key={item.id}
                item={item}
                active={activeId === item.id}
                refreshSignal={refreshSignal}
                config={configs.get(item.id) ?? null}
                paneRef={activePaneRef}
                onConfigChange={handleConfigChange}
              />
            ) : null,
          )}
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
                <span style={{ fontSize: "var(--font-size-sm)", color: saveError ? "var(--color-accent-error)" : "var(--color-fg)" }}>{saveError ?? t("shell.unsavedChanges")}</span>
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
