// 设置整页 —— 框架驱动配置管理。
//
// 框架从 manifest 读 configFile + configMerge,自动管:
// - 读 configFile → 传 config prop 给组件
// - 组件调 onChange → 框架设 dirty + 更新 config state
// - 确定改动 → 写回(分层项:diff 写项目级;内核项:config-file:set 整份)
// - 取消改动 → 重读恢复
// - 打开配置按钮 → pi.openFile(生效层的文件);生效配置无任何 key 时不显示(无物可开)
// - 刷新按钮 → refreshSignal+1
// - 未保存拦截 → 切 tab/返回对话时弹窗
// - 设为全局/移除项目覆盖/来源徽标 → 仅分层项(见下)
//
// 分层判定(内容驱动,路径前缀决定语义,不加 kind 字段):
// - ~/.pi/agent/ 前缀 → 内核文件:白名单通道原样读写,无分层无按钮(内核自留地)
// - ~/.my-harness-desktop/ 前缀 → 分层项:读两层 key 级合并(项目级只存 diff),
//   零声明(configFile=null)的 framework 项默认 ~/.my-harness-desktop/config/{pluginId}.json
//   (统一通道约定,docs/design/unified-project-config.md)
// saveMode=manual 的插件(theme-manager):不传 config(null)、不显示浮层/打开按钮/拦截。
import { useCallback, useEffect, useRef, useState, memo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
// r97：加载失败的播报走命令式原语（这条链在 useEffect 里，不在渲染路径上，
// 用不了 <Announce> 组件）；文案走 i18next 单例（同 r82 的理由：不把 t 塞进依赖数组）。
import { announceTransient } from "@my-harness-desktop/react";
import { i18next } from "../app/i18n-init";
import { ArrowLeft, RefreshCw, FileText, Globe, FolderX } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { useUiStore, SIDEBAR_MIN_PX, SIDEBAR_MAX_PX, AREA_FONT_SCALE_MIN, AREA_FONT_SCALE_MAX } from "../app/ui-store";
import { ChatRow } from "../ui/chat-row";
import { getSettingsComponent, ListItem, PluginIcon, type SettingsComponentProps, type SettingsItem, PluginIdContext, eventBus } from "@my-harness-desktop/react";
import { configSavedPayload } from "@my-harness-desktop/shared";
import type { KernelModelConfig } from "@my-harness-desktop/shared";

/** 统一通道默认路径:零声明的 framework 项按 pluginId 推路径(~/.my-harness-desktop/config/{pluginId}.json)。 */
const DESKTOP_PREFIX = "~/.my-harness-desktop/";
// ⚠ 这里曾有 `AGENT_PREFIX = "~/.pi/agent/"` 与 `DSH_PREFIX = "~/.dsh/"` 两个常量，
//   用「路径以哪个内核的目录开头」判断某配置项是不是内核自留地。两个问题：
//   ① 壳（`src/web`）里写死了内核身份，加内核要改这里（CLAUDE.md §1.4/§1.5）；
//   ② **对第三个内核就是错的**：`~/.minimal/agent/…` 不在两个前缀里 → 被判成"分层项" →
//      `relPathOf` 用 `slice(DESKTOP_PREFIX.length)` 去切一个不以该前缀开头的路径，
//      得到垃圾 relPath（实测 `~/.minimal/agent/config.json` → 『g.json』），
//      壳于是去读写一个错误的分层路径。当前 minimal 的 TAB 都声明 `configFile: null`
//      所以没踩到，但任何声明了内核原生 configFile 的**第四个内核**会立刻踩中。
//   中性判据：分层只属于壳自己的配置空间 `~/.my-harness-desktop/`；
//   **不在这个空间里的一律扁平**——不点名任何内核，且对未来内核自动成立。

export function effectiveConfigFile(item: SettingsItem): string {
  return item.configFile ?? `${DESKTOP_PREFIX}config/${item.pluginId}.json`;
}
/** 该配置文件是否**在壳的分层空间之外**（= 内核自留地）：不分层、不显示分层按钮。
 *  只有 `~/.my-harness-desktop/` 下的文件走两层（全局 + 项目级）合并；
 *  其余一律扁平读取——判据不含任何内核名，加内核无需改这里。 */
export function isOutsideLayeredSpace(configFile: string): boolean {
  return !configFile.startsWith(DESKTOP_PREFIX);
}
/** 分层项的 relPath(相对 ~/.my-harness-desktop/):项目级 = <cwd>/.my-harness-desktop/<relPath>。 */
export function relPathOf(configFile: string): string {
  return configFile.slice(DESKTOP_PREFIX.length);
}

/** 读分层项:两层 key 级合并 + 项目级是否有覆盖(徽标/按钮显隐)。无 cwd 时只读全局。 */
async function readLayered(configFile: string, cwd: string): Promise<{ merged: Record<string, unknown>; hasProject: boolean }> {
  if (!cwd) {
    const g = await window.kernel.configFile.get(configFile);
    return { merged: g, hasProject: false };
  }
  const rel = relPathOf(configFile);
  const [merged, projectRaw] = await Promise.all([
    window.kernel.configFile.getLayered(cwd, rel),
    window.kernel.configFile.getProject(cwd, rel),
  ]);
  return { merged: merged ?? {}, hasProject: !!projectRaw && Object.keys(projectRaw).length > 0 };
}

interface SettingsPaneProps {
  item: SettingsItem;
  active: boolean;
  refreshSignal: number;
  config: Record<string, unknown> | null;
  /** 本项未保存编辑标记(框架 dirties 透传;插件据此禁用"仅对已落盘配置有意义"的动作)。 */
  dirty: boolean;
  paneRef: React.RefObject<HTMLDivElement | null>;
  onConfigChange: (id: string, c: Record<string, unknown>) => void;
  /** 展示分组(§3.1):TAB 叶子不画自己的 header(入口 header + TAB 条已承担)。默认 true。 */
  showHeader?: boolean;
  /** 该叶子是不是某个设置入口下的 TAB（是 ⇒ 根元素承担 role=tabpanel 语义）。 */
  inTabs?: boolean;
}

// pane 级 memo:SettingsPage 重渲染时已挂载 pane 不陪跑 reconcile。
// 根因(实测):内容区曾无条件渲染全部插件设置组件,任何父级更新(视图切换/
// 偏好变化)都级联全量重渲染;props 全为稳定引用(item/config 是 state 快照,
// paneRef/onConfigChange 恒定),memo 生效。
const SettingsPane = memo(function SettingsPane({ item, active, refreshSignal, config, dirty, paneRef, onConfigChange, showHeader = true, inTabs = false }: SettingsPaneProps): React.ReactNode {
  const { t } = useTranslation();
  const Comp = item.component ? getSettingsComponent(item.component) : undefined;
  if (!Comp) return null;
  return (
    // TAB 型叶子：这个 div 就是该 TAB 的面板，ARIA 关系要与 TAB 条对上
    // （id ← tab 的 aria-controls；aria-labelledby ← tab 的 id）。
    // 非 TAB 型（独立设置项）不是面板，不给 tabpanel 语义。
    // ⚠ 惰性挂载的代价：从未访问过的 TAB，其面板还没 mount，aria-controls 会指向暂不存在的 id。
    //   这是 lazy-mount UI 的常见取舍（点开即建立），比"整条 TAB 无语义"要好；
    //   选中态（aria-selected）与 role=tab 这两个**关键**语义不依赖面板存在，始终有效。
    <div
      ref={active ? paneRef : null}
      // ⚠ 稳定探针锚点（r93，依据本文件 461-463 行自己写的纪律与 skills §10.3：
      //   「探针必须靠稳定锚，不靠文本子串」）。此前这个 pane 根元素**没有任何锚点**
      //   （无 data-*、无 id、无 role —— role/id 只在 inTabs 分支里才有），
      //   于是自动化**无法判断"当前激活的是哪个设置条目"**：
      //   r88/r89 连续两轮想验证 ctx.config.set 的失败兜底，都卡在
      //   "点了条目之后不知道右侧有没有真的切过去"，只能靠 [role=tabpanel] 猜——
      //   而**没有 tabs 的条目根本不渲染 tabpanel**，于是判据永假、误判成"点击无效"。
      //   补 data-settings-pane（哪个条目）+ data-settings-pane-active（是否激活）后，
      //   探针可以直接断言激活态，不必依赖布局或文本。
      data-settings-pane={item.id}
      data-settings-pane-active={active ? "true" : "false"}
      {...(inTabs ? {
        role: "tabpanel",
        id: `settings-tabpanel-${item.id}`,
        "aria-labelledby": `settings-tab-${item.id}`,
      } : {})}
      style={{ display: active ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0 }}>
      {showHeader && (
        <div className="flex items-center gap-2 shrink-0 select-none" style={{ padding: "14px var(--sidepanel-header-px)", borderBottom: "1px solid var(--color-border)", fontSize: "var(--font-size-lg)", fontWeight: 600, color: "var(--color-fg)" }}>
          <PluginIcon name={item.icon} className="size-5 shrink-0" />
          <span className="truncate">{t(`settings.${item.id}`, { defaultValue: item.title })}</span>
        </div>
      )}
      {/* 内容容器契约:壳统一承担滚动/padding/gap/纵向节奏,插件直渲内容、不自建滚动容器。
          标题栏钉在滚动区外(保持收敛前"插件根自滚、标题不动"的语义);
          内容容器 flex 1 0 auto:短内容撑满 scrollport(marginTop:auto 类吸底可用),长内容撑开由 scrollport 滚动。 */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: "1 0 auto", display: "flex", flexDirection: "column", gap: "var(--spacing-lg)", padding: "var(--spacing-xl)" }}>
          <PluginIdContext.Provider value={item.pluginId}>
            <Comp refreshSignal={refreshSignal} config={config} dirty={dirty} onChange={(c) => onConfigChange(item.id, c)} />
          </PluginIdContext.Provider>
        </div>
      </div>
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
  /** 展示分组(§3.1):当前入口内激活的 TAB 下标。入口无 tabs 时恒 0 且不使用。 */
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const leftPanelRef = useRef<ImperativePanelHandle>(null);
  /** 刷新闪烁的作用目标:当前激活的内容面板。 */
  const activePaneRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef<number[]>([]);
  const pgRef = useRef<HTMLDivElement>(null);
  const [handleDragging, setHandleDragging] = useState(false);

  const pgWidth = (): number => pgRef.current?.clientWidth ?? window.innerWidth;

  // 展示分组(§3.1):activeId 是「入口」id,activeItem 是「入口内当前 TAB」(叶子)——
  // config/dirty/save/pane 全部按 activeItem.id 键控,入口本身只是壳、不参与 config。
  const activeEntry = items.find((i) => i.id === activeId);
  const activeItem = activeEntry?.tabs?.[activeTabIndex] ?? activeEntry;
  const activeItemId = activeItem?.id ?? "";
  /** 叶子列表(入口壳展开成 tabs,普通项即自身)。inTabs=true 表示该叶子是某入口的 TAB,
   *  渲染时不画自己的 header(入口 header + TAB 条已承担)。 */
  const leaves = items.flatMap((i) => (i.tabs?.length ? i.tabs.map((t) => ({ item: t, inTabs: true })) : [{ item: i, inTabs: false }]));

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
  // 读每个 saveMode=framework 的项:内核项直读,分层项两层合并读(manual 模式不读、不参与 save)。
  // 重读不得冲掉未保存编辑:dirty 项保留现值;插件被禁用时剪掉残留 state。
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    void window.kernel.settings.list().then(async (list) => {
      const cfgs = new Map<string, Record<string, unknown> | null>();
      const overrides = new Map<string, boolean>();
      // ⚠ **可达性说明（r102 实测，先读这段再去尝试触发它）**：
      //   下面这层逐项 try/catch（r99）与链尾的 .catch（r97）在当前服务端策略下
      //   **实际上触发不了**——加载链上的每一条读取路径都被设计成"失败不抛错、回落空值"：
      //     · `configFile.get` → `readJsonFile`：`catch { return {} }`（config-file.ts，
      //       注释写明"对只读是对的(健壮)"；只有读-改-写的 readJsonFileForDeepMerge 才区分损坏并备份+warn）
      //     · `kernelConfig.pi.get` → `pi-settings-store.get()`：`catch { console.warn(…); return {} }`
      //     · `readLayered` 同样走 readJsonFile
      //   r100/r101/r102 三轮先后用"运行期 chmod"“启动前 chmod 000 blind-review.json”
      //   等手段构造失败，都得到"17 个条目照常、loadError 为空"——不是兜底失效，是**失败没被传出来**。
      //   保留这两层的理由：它们是**防御纵深**，不是死代码——
      //     ① `settings.list()` 本身（链首）仍可能 reject；
      //     ② 内核侧的 `kernelModels[k].readConfig()` 走各内核自己的实现，未来新增内核不保证吞错；
      //     ③ 服务端若哪天把"损坏"改成抛错（那是更好的设计：静默回落默认值会让用户以为配置丢了），
      //        这两层立刻就有用，且行为正确（部分可用 + 指明失败项）。
      //   ⚠ 所以**不要**因为"触发不了"就删掉它们；也不要再花轮次去构造触发（除非先改了服务端错误策略）。
      //
      // ⚠ **逐项兜底**（r99）：此前整条链只有链尾一个 .catch（r97 补的），于是
      //   任一条目读失败 ⇒ 整条链中止 ⇒ 后面所有 setConfigs/setItems 全落空 ⇒
      //   **一个内核没装载就能让整个设置页变空白**。这违背 §7.6 的精神：
      //   部分成功应当显示已成功的部分，并说明哪一项失败了，而不是全部隐藏。
      //   最典型的现实场景：某个内核未装载时 kernelModels[k].readConfig() 抛错——
      //   而其它十几个条目（主题/语言/技能/工具/插件…）与它毫无关系，没理由跟着消失。
      const failed: string[] = [];
      // 展示分组:config 按叶子(入口的 tabs 或入口本身)各管各的,入口壳不参与 config。
      for (const item of list.flatMap((i) => (i.tabs?.length ? i.tabs : [i]))) {
        try {
        if (item.saveMode !== "framework") { cfgs.set(item.id, null); continue; }
        if (item.kernelModels) {
          // 内核模型配置源:壳子只认中性 JSON,读写走 kernelModels[kernel](pi/dsh 各自翻译)。
          cfgs.set(item.id, await window.kernel.kernelModels[item.kernelModels].readConfig() as unknown as Record<string, unknown>);
          overrides.set(item.id, false);
          continue;
        }
        if (item.kernelConfig) {
          // 内核原生配置源:壳子只认中性 JSON,读写走 kernelConfig[kernel](pi/dsh 各自翻译)。
          cfgs.set(item.id, await window.kernel.kernelConfig[item.kernelConfig].get());
          overrides.set(item.id, false);
          continue;
        }
        const file = effectiveConfigFile(item);
        if (isOutsideLayeredSpace(file)) {
          cfgs.set(item.id, await window.kernel.configFile.get(file));
          overrides.set(item.id, false);
        } else {
          const { merged, hasProject } = await readLayered(file, currentCwd);
          cfgs.set(item.id, merged);
          overrides.set(item.id, hasProject);
        }
        } catch (err) {
          // 单项失败：记下来、该项置空态，**不牵连其它条目**（循环继续）
          failed.push(`${item.id}: ${err instanceof Error ? err.message : String(err)}`);
          cfgs.set(item.id, null);
        }
      }
      if (cancelled) return;
      // 部分失败也要**可见**：界面留一行说明（含失败条目 id 与原因），并播报一次。
      // 与"整链失败"共用 loadError 槽位，但文案由 shell.settingsLoadFailed 承载，
      // 用户看到的是"设置加载失败：<哪一项>: <原因>"，据此能判断是不是内核没装载。
      if (failed.length > 0) {
        setLoadError(failed.join("; "));
        announceTransient(i18next.t("shell.settingsLoadFailed", { detail: failed.join("; ") }), "error");
      }
      setItems(list);
      setActiveId((prev) => (prev && list.some((i) => i.id === prev) ? prev : (list.length > 0 ? list[0].id : "")));
      setActiveTabIndex(0);
      setConfigs((prev) => {
        const next = new Map(cfgs);
        for (const [id, dirty] of dirtiesRef.current) {
          if (dirty && next.has(id)) next.set(id, prev.get(id) ?? null);
        }
        return next;
      });
      setProjectOverrides(overrides);
      setDirties((prev) => {
        const ids = new Set(list.flatMap((i) => (i.tabs?.length ? i.tabs.map((t) => t.id) : [i.id])));
        const next = new Map([...prev].filter(([id]) => ids.has(id)));
        return next.size === prev.size ? prev : next;
      });
    }).catch((err: unknown) => {
      // ⚠ 加载失败必须可见（r97）：这条链里有十来个 await（settings.list、
      //   kernelModels/kernelConfig 读取、configFile 分层读取），任何一个抛错都会让
      //   **整条链**中止 —— 不只是那一项没读到，而是所有项的 configs/overrides 都没 set，
      //   页面呈现"全空"。所以这里既要播报（读屏可听）也要在界面上留一条可见提示。
      if (cancelled) return;
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(msg);
      announceTransient(i18next.t("shell.settingsLoadFailed", { detail: msg }), "error");
    });
    return () => { cancelled = true; };
  }, [pluginsNonce, currentCwd]);

  // 刷新:重读 active 项的 configFile(分层项两层合并)。activeItem 是「入口内当前 TAB」(叶子)。
  const refreshActive = useCallback(async () => {
    if (!activeItem || activeItem.saveMode !== "framework") return;
    const id = activeItem.id;
    if (activeItem.kernelModels) {
      const cfg = await window.kernel.kernelModels[activeItem.kernelModels].readConfig() as unknown as Record<string, unknown>;
      setConfigs((prev) => { const n = new Map(prev); n.set(id, cfg); return n; });
      setDirties((prev) => { const n = new Map(prev); n.set(id, false); return n; });
      return;
    }
    if (activeItem.kernelConfig) {
      const cfg = await window.kernel.kernelConfig[activeItem.kernelConfig].get();
      setConfigs((prev) => { const n = new Map(prev); n.set(id, cfg); return n; });
      setDirties((prev) => { const n = new Map(prev); n.set(id, false); return n; });
      return;
    }
    const file = effectiveConfigFile(activeItem);
    if (isOutsideLayeredSpace(file)) {
      const cfg = await window.kernel.configFile.get(file);
      setConfigs((prev) => { const n = new Map(prev); n.set(id, cfg); return n; });
    } else {
      const { merged, hasProject } = await readLayered(file, currentCwd);
      setConfigs((prev) => { const n = new Map(prev); n.set(id, merged); return n; });
      setProjectOverrides((prev) => { const n = new Map(prev); n.set(id, hasProject); return n; });
    }
    setDirties((prev) => { const n = new Map(prev); n.set(id, false); return n; });
  }, [activeItem, currentCwd]);

  // refreshSignal 变 → 重读 active configFile(框架管刷新,不靠组件重拉)
  useEffect(() => {
    if (refreshSignal === 0) return;
    void refreshActive();
  }, [refreshSignal, refreshActive]);

  // 分层判定:effectiveConfigFile 对零声明 framework 项给统一通道默认路径;内核项(~/.pi/agent/、~/.dsh/)不分层
  const activeConfigFile = activeItem && activeItem.saveMode === "framework" ? effectiveConfigFile(activeItem) : null;
  // 「打开配置」按钮目标:framework 项走 effectiveConfigFile(零声明 fallback 统一通道);
  // manual 项用 manifest 声明的 configFile(内核原生文件,只「打开」不「读/写」)。
  // 契约(contributions.ts):configFile 非 null ⇒ 显示打开按钮;saveMode=manual ⇒ 无浮层、仅打开按钮。
  const activeOpenTarget = activeItem
    ? (activeItem.saveMode === "framework" ? effectiveConfigFile(activeItem) : activeItem.configFile)
    : null;
  const activeIsLayered = !!activeOpenTarget && !isOutsideLayeredSpace(activeOpenTarget);
  // dirty/save/拦截只对 saveMode=framework 生效;manual 模式(如主题)不参与
  const activeIsFramework = activeItem?.saveMode === "framework";
  const activeDirty = activeIsFramework && !!dirties.get(activeItemId);
  const activeHasProject = activeIsLayered && !!projectOverrides.get(activeItemId);
  // 生效配置是否含 key:无 key(两层文件都不存在/皆空)时"打开配置"无物可开,按钮不显示。
  // hasProject ⇒ 项目层有 key ⇒ 合并结果非空,故这一条同时覆盖分层与内核项。
  const activeHasConfig = Object.keys(configs.get(activeItemId) ?? {}).length > 0;

  const handleConfigChange = useCallback((id: string, newConfig: Record<string, unknown>): void => {
    setConfigs((prev) => { const n = new Map(prev); n.set(id, newConfig); return n; });
    setDirties((prev) => { const n = new Map(prev); n.set(id, true); return n; });
  }, []);

  // pane 懒挂载:首次激活才 mount(进设置页只挂 1 个组件,不再一口气挂 11 个),
  // 挂载后不卸载(保住组件本地态 + 切 tab 零重挂载,沿用原"切 tab 不重 mount"契约)。
  // 渲染期派生 state:React 提交前同步重渲染,active pane 同帧出现,无空白帧。
  const [mountedIds, setMountedIds] = useState<ReadonlySet<string>>(new Set());
  if (activeItemId && !mountedIds.has(activeItemId)) {
    setMountedIds(new Set(mountedIds).add(activeItemId));
  }

  const [saveError, setSaveError] = useState<string | null>(null);
  /** 配置**加载**失败（r97）。此前加载链是 `void ….then(async …)` 且**没有 .catch**，
   *  于是任一读取抛错（内核未装载时 kernelModels[k].readConfig()、configFile 读失败等）
   *  会让整条链 reject ⇒ unhandled rejection ⇒ 设置页显示**空配置且没有任何提示**：
   *  用户看到的是"默认值/空白"，会以为自己的配置丢了或本来就是这样（§7.6 禁止的静默失败）。
   *  与 saveError 分开：保存失败与加载失败的**可执行下一步不同**
   *  （保存失败=重试保存；加载失败=重载窗口/检查内核是否装载），混用一条会给出错误指引。 */
  const [loadError, setLoadError] = useState<string | null>(null);

  // 保存:内核项整份写白名单通道;分层项有 cwd 时算"生效 config 与全局的顶层 key diff"
  // 写项目级(replace 整份替换项目级文件——项目级只存 diff,全局更新未覆盖 key 自动生效),
  // 无 cwd 时全局层是唯一的家,直接写全局。
  const doSave = async (): Promise<void> => {
    if (!activeItem || !activeConfigFile) return;
    setSaving(true);
    setSaveError(null);
    try {
      const cfg = configs.get(activeItemId);
      if (cfg) {
        // 超时是治标允底:根治应保证 IPC handler 必 settle。
        // 在此之前以 10s 兜底发现 main 挂起,不让保存浮层永久转圈。
        let wroteDiff: Record<string, unknown> | null = null;
        const write = async (): Promise<Record<string, unknown>> => {
          // 内核模型配置源:存走 kernelModels[kernel].saveConfig(pi/dsh 各自翻译落盘)。
          if (activeItem.kernelModels) return window.kernel.kernelModels[activeItem.kernelModels].saveConfig(cfg as unknown as KernelModelConfig) as unknown as Promise<Record<string, unknown>>;
          // 内核原生配置源:存走 kernelConfig[kernel].set(pi/dsh 各自翻译落盘)。
          if (activeItem.kernelConfig) return window.kernel.kernelConfig[activeItem.kernelConfig].set(cfg);
          if (!activeIsLayered || !currentCwd) return window.kernel.configFile.set(activeConfigFile, cfg, activeItem.configMerge);
          const rel = relPathOf(activeConfigFile);
          const globalDoc = await window.kernel.configFile.get(activeConfigFile);
          const diff: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(cfg)) {
            if (JSON.stringify(globalDoc[k]) !== JSON.stringify(v)) diff[k] = v;
          }
          await window.kernel.configFile.setProject(currentCwd, rel, diff, "replace");
          wroteDiff = diff;
          return (await window.kernel.configFile.getLayered(currentCwd, rel)) ?? {};
        };
        const next = await Promise.race([
          write(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("保存超时:main 进程无响应")), 10000),
          ),
        ]);
        setConfigs((prev) => { const n = new Map(prev); n.set(activeItemId, next); return n; });
        // hasProject 的判定是"项目级文件有覆盖 key"(= 刚写入的 diff 非空),不是合并结果非空
        if (activeIsLayered) setProjectOverrides((prev) => { const n = new Map(prev); n.set(activeItemId, wroteDiff !== null && Object.keys(wroteDiff).length > 0); return n; });
        // 保存后通知:configFile 写入成功后广播 system:configFileSaved,消费方(timeline/ui-store)
        // 订阅该事件重读 preference,实现"保存即生效"的 live switch——这是机制,不分插件。
        eventBus.emitSystem("system:configFileSaved", configSavedPayload(activeConfigFile, activeItem));
      }
      setDirties((prev) => { const n = new Map(prev); n.set(activeItemId, false); return n; });
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
      const cfg = configs.get(activeItemId);
      if (cfg) {
        await window.kernel.configFile.set(activeConfigFile, cfg, activeItem.configMerge);
        eventBus.emitSystem("system:configFileSaved", configSavedPayload(activeConfigFile, activeItem));
      }
      setDirties((prev) => { const n = new Map(prev); n.set(activeItemId, false); return n; });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // 移除项目覆盖:删项目级文件,该插件在本项目回退全局默认;然后重读两层合并。
  const doClearProject = async (): Promise<void> => {
    if (!activeItem || !activeConfigFile || !activeIsLayered || !currentCwd) return;
    // ⚠ 与 doSave / doSetGlobal 同款兜底（r103）：这两个兄弟函数都有完整的
    //   setSaving + try/catch(setSaveError) + finally，唯独这个用户动作（「移除项目覆盖」）
    //   是裸 await —— 失败时既不显示原因、也没有 saving 态可解除，用户只看到"点了没反应"。
    //   同族函数的错误处理必须一致，否则最弱的那个就是这条路径的实际行为。
    setSaving(true);
    setSaveError(null);
    try {
      await window.kernel.configFile.clearProject(currentCwd, relPathOf(activeConfigFile));
      setProjectOverrides((prev) => { const n = new Map(prev); n.set(activeItemId, false); return n; });
      setDirties((prev) => { const n = new Map(prev); n.set(activeItemId, false); return n; });
      await refreshActive();
      eventBus.emitSystem("system:configFileSaved", configSavedPayload(activeConfigFile, activeItem));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const doReset = async (): Promise<void> => {
    if (!activeItem || !activeConfigFile) return;
    // ⚠ 必须自己兜住（r103）：本函数被「未保存修改」对话框的**放弃并离开**按钮调用——
    //   `onClick={async () => { await doReset(); setPendingAction(null); a?.(); }}`。
    //   若这里抛错，`setPendingAction(null)` 与后续导航都走不到 ⇒
    //   **对话框永远关不掉、用户被卡在设置页**（与 r80 的 install 卡死同类）。
    //   所以在函数内部兜住：失败时把原因显示到 saveError，让调用方照常关框并导航。
    //   注意失败时**不清 dirty**——重读没成功，用户的编辑还在，标成"已保存"是撒谎。
    try {
    if (activeItem.kernelModels) {
      const cfg = await window.kernel.kernelModels[activeItem.kernelModels].readConfig() as unknown as Record<string, unknown>;
      setConfigs((prev) => { const n = new Map(prev); n.set(activeItemId, cfg); return n; });
    } else if (activeItem.kernelConfig) {
      const cfg = await window.kernel.kernelConfig[activeItem.kernelConfig].get();
      setConfigs((prev) => { const n = new Map(prev); n.set(activeItemId, cfg); return n; });
    } else if (activeIsLayered) {
      const { merged, hasProject } = await readLayered(activeConfigFile, currentCwd);
      setConfigs((prev) => { const n = new Map(prev); n.set(activeItemId, merged); return n; });
      setProjectOverrides((prev) => { const n = new Map(prev); n.set(activeItemId, hasProject); return n; });
    } else {
      const cfg = await window.kernel.configFile.get(activeConfigFile);
      setConfigs((prev) => { const n = new Map(prev); n.set(activeItemId, cfg); return n; });
    }
    setDirties((prev) => { const n = new Map(prev); n.set(activeItemId, false); return n; });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
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
                <ListItem key={item.id} active={activeNow} onClick={() => guardNavigate(() => { setActiveId(item.id); setActiveTabIndex(0); })} style={{ border: "none", background: activeNow ? "var(--sidebar-row-bg-active)" : "transparent", fontSize: "var(--font-size-lg)", padding: "14px 14px" }}>
                  {/* data-settings-id：设置页入口的**稳定探针锚点**。此前导航项只有文案（还经 i18n 查表、
                      缺 key 时回落 defaultValue），e2e 只能按文本猜——「某个插件在不在设置页里」这类断言
                      因此写不可靠（skills §10.3：探针必须靠稳定锚，不靠文本子串）。 */}
                  <div className="flex items-center gap-2" data-settings-id={item.id}>
                    <PluginIcon name={item.icon} className="size-5 shrink-0" />
                    <span>{t(`settings.${item.id}`, { defaultValue: item.title })}</span>
                  </div>
                </ListItem>
              );
            })}
          </div>
          {/* 返回对话:和会话页底部"设置"按钮同款 ChatRow + border-top */}
          <div className="border-t border-[var(--color-border)] shrink-0 px-2 py-2">
            {/* `data-settings-back` 是稳定锚点：e2e 与 DOM 审计据此离开设置页，
                **不按译文文案匹配**（「返回对话」/「Back to chat」/「返回對話」…，
                按文案找等于把测试绑死在某一种语言上，见 skill §17.3）。 */}
            <ChatRow data-settings-back="chat" onClick={() => guardNavigate(() => setActiveView("chat"))} icon={<ArrowLeft className="size-4.5" />}>
              {t("shell.backToChat")}
            </ChatRow>
          </div>
        </div>
        </Panel>
        <PanelResizeHandle
          onDragging={onHandleDragging}
          // role=separator / aria-valuenow / tabIndex 由 react-resizable-panels 提供，
          // 但**可访问名与朝向要自己给**（r39 实测：库渲染出的 separator 是
          // aria-label=null、aria-orientation=null）。缺名的症状是读屏只念"分隔条 19"，
          // 不知道它分隔的是什么；缺朝向则落到 ARIA 默认值 horizontal，
          // 而 col-resize 的手柄是**竖向**分隔条（分隔左右、水平移动）——默认值是错的。
          aria-label={t("shell.resizeSettingsNav")}
          aria-orientation="vertical"
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
              {activeOpenTarget && (activeIsFramework ? activeHasConfig : true) && (
                <button
                  onClick={() => void window.kernel.openFile(
                    activeIsFramework && activeIsLayered && currentCwd && activeHasProject
                      ? `${currentCwd}/.my-harness-desktop/${relPathOf(activeOpenTarget)}`
                      : activeOpenTarget,
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
          {/* 入口 header + TAB 条:仅当当前入口有 tabs(展示分组,§3.1)时渲染。
              入口 header 钉在 TAB 条外;TAB 叶子 pane 不再画自己的 header(showHeader=false)。 */}
          {activeEntry?.tabs?.length ? (
            <>
              <div className="flex items-center gap-2 shrink-0 select-none" style={{ padding: "14px var(--sidepanel-header-px)", borderBottom: "1px solid var(--color-border)", fontSize: "var(--font-size-lg)", fontWeight: 600, color: "var(--color-fg)" }}>
                <PluginIcon name={activeEntry.icon} className="size-5 shrink-0" />
                <span className="truncate">{t(`settings.${activeEntry.id}`, { defaultValue: activeEntry.title })}</span>
              </div>
              {/* ⚠ 这是一条**手写的 TAB 条**（不是 Radix Tabs），所以 ARIA 语义要自己给：
                  容器 role=tablist、每个 TAB role=tab + aria-selected + aria-controls、
                  面板 role=tabpanel + aria-labelledby。此前是一排裸 <button>：读屏只会念成
                  「按钮」，既听不出这是一组互斥的 TAB，也听不出哪个是当前选中的——
                  选中态只用 borderBottom 颜色与 color 表达（视觉态有、可访问态无）。
                  ⚠ 本注释必须用 JSX 注释形态：子元素位置写行注释会直接语法错。 */}
              <div
                role="tablist"
                aria-label={t(`settings.${activeEntry.id}`, { defaultValue: activeEntry.title })}
                className="flex gap-0.5 shrink-0" style={{ padding: "0 var(--spacing-lg)", borderBottom: "1px solid var(--color-border)", background: "var(--color-chrome)" }}>
                {activeEntry.tabs.map((tab, idx) => (
                  <button
                    key={tab.id}
                    // 稳定锚点（§17.3）：TAB 按钮此前只有 key，e2e 只能按译文定位；
                    // 而 r33 改的正是 TAB 级声明（kernelModels/kernelConfig）派生的保存语义，
                    // 必须能确定性地切到「模型」TAB 才验得到那条路径。
                    data-settings-tab={tab.id}
                    data-settings-tab-active={idx === activeTabIndex ? "true" : "false"}
                    role="tab"
                    id={`settings-tab-${tab.id}`}
                    aria-selected={idx === activeTabIndex}
                    aria-controls={`settings-tabpanel-${tab.id}`}
                    tabIndex={idx === activeTabIndex ? 0 : -1}
                    onKeyDown={(e) => {
                      // ARIA APG 的 TAB 键盘约定：左右方向键在同组 TAB 间移动焦点并激活。
                      // 手写 TAB 条不会自动获得这个行为（Radix Tabs 才有），所以自己实现。
                      const n = activeEntry.tabs?.length ?? 0;
                      if (n < 2) return;
                      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                      if (!step) return;
                      e.preventDefault();
                      const next = (activeTabIndex + step + n) % n;
                      guardNavigate(() => setActiveTabIndex(next));
                      requestAnimationFrame(() => {
                        const el = document.getElementById(`settings-tab-${activeEntry.tabs?.[next]?.id ?? ""}`);
                        el?.focus();
                      });
                    }}
                    onClick={() => guardNavigate(() => setActiveTabIndex(idx))}
                    style={{
                      padding: "11px 16px", fontSize: "var(--font-size-sm)", cursor: "pointer",
                      border: "none", background: "transparent", whiteSpace: "nowrap",
                      borderBottom: `2px solid ${idx === activeTabIndex ? "var(--color-primary)" : "transparent"}`,
                      color: idx === activeTabIndex ? "var(--color-fg)" : "var(--color-muted)",
                    }}
                  >
                    {t(`settings.${tab.id}`, { defaultValue: tab.title })}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {/* 内容区:只渲染激活过的叶子 pane(mountedIds 按叶子 id),active 显示+滚动,非 active 隐藏 */}
          {leaves.map(({ item, inTabs }) =>
            mountedIds.has(item.id) ? (
              <SettingsPane
                key={item.id}
                item={item}
                active={activeItemId === item.id}
                showHeader={!inTabs}
                inTabs={inTabs}
                refreshSignal={refreshSignal}
                config={configs.get(item.id) ?? null}
                dirty={dirties.get(item.id) ?? false}
                paneRef={activePaneRef}
                onConfigChange={handleConfigChange}
              />
            ) : null,
          )}
          {items.length > 0 && !(activeItem && activeItem.component && getSettingsComponent(activeItem.component)) && (
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
                {loadError && (
                  <span data-settings-load-error="" style={{ fontSize: "var(--font-size-sm)", color: "var(--color-accent-error)" }}>
                    {t("shell.settingsLoadFailed", { detail: loadError })}
                  </span>
                )}
                <span style={{ fontSize: "var(--font-size-sm)", color: saveError ? "var(--color-accent-error)" : "var(--color-fg)" }}>{saveError ?? t("shell.unsavedChanges")}</span>
                {/* `data-settings-save` 是稳定锚点：e2e 与 DOM 审计据此定位保存/放弃，
                    **不按译文文案匹配**（「确定改动」/「Confirm changes」/「確定改動」…，
                    按文案找等于把测试绑死在某一种语言上，见 skill §17.3）。
                    保存中态用 `data-settings-saving` 标出，比读按钮文案判状态可靠。 */}
                <button data-settings-save="discard" onClick={() => void doReset()} disabled={saving} style={barBtn(false, saving)}>{t("shell.discardChanges")}</button>
                <button data-settings-save="confirm" data-settings-saving={saving ? "true" : "false"} onClick={() => void doSave()} disabled={saving} style={barBtn(true, saving)}>{saving ? t("shell.saving") : t("shell.confirmChanges")}</button>
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
            <div data-settings-unsaved-dialog="" style={{ position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)" }}>
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                style={{ background: "var(--color-surface)", borderRadius: "var(--radius-lg)", border: "1px solid var(--color-border)", padding: "var(--spacing-lg)", boxShadow: "var(--shadow-lg)", display: "flex", flexDirection: "column", gap: "var(--spacing-md)", minWidth: "320px" }}
              >
                {/* ⚠ 稳定探针锚点（r89，依据本文件 461-463 行自己写的纪律与 skills §10.3：
                    「探针必须靠稳定锚，不靠文本子串」）。此前这个"未保存修改"对话框的容器与
                    三个按钮**只有 i18n 文案、没有任何 data-* 锚点**，于是：
                    ① e2e 只能按文本猜（换语言就失效）；
                    ② 更实际的后果——它会**拦下设置页内的导航**（guardNavigate：activeDirty 时
                       把动作存进 pendingAction 而不执行），而自动化脚本点完条目看不到任何变化，
                       会误判成"点击没生效/坐标不对"（r88 就误判成坐标问题，白跑一轮）。
                    有了锚点，脚本可以先判断"是不是被这个对话框拦住了"再决定点哪个按钮。 */}
                <span data-settings-unsaved-title="" style={{ fontSize: "var(--font-size-base)", fontWeight: 600, color: "var(--color-fg)" }}>{t("shell.unsavedChanges")}</span>
                <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("shell.savePrompt")}</span>
                <div style={{ display: "flex", gap: "var(--spacing-sm)", justifyContent: "flex-end" }}>
                  <button data-settings-unsaved="cancel" onClick={() => setPendingAction(null)} style={barBtn(false, false)}>{t("shell.cancel")}</button>
                  <button data-settings-unsaved="discard" onClick={async () => { await doReset(); const a = pendingAction; setPendingAction(null); a?.(); }} style={barBtn(false, false)}>{t("shell.discard")}</button>
                  <button data-settings-unsaved="save" onClick={async () => { await doSave(); const a = pendingAction; setPendingAction(null); a?.(); }} disabled={saving} style={barBtn(true, saving)}>{saving ? t("shell.saving") : t("shell.saveAndContinue")}</button>
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
