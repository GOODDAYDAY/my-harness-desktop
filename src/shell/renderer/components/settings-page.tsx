// 设置整页 —— 读 settings 槽所有贡献项,左列表 + 右配置区。
//
// 框架级:
// - 切 tab 不重载:所有 settings 组件都渲染,非 active 用 display:none 隐藏(不卸载)
// - 右上角刷新按钮:点 → refreshSignal+1 → 组件 useEffect 重拉 + 整页闪烁动画
// - 保存浮层(框架级):每个组件有 saveBar 句柄,插件 register save/reset + setDirty;
//   框架读 active 插件 dirty 渲染统一浮层(createPortal body + fixed 真悬浮),
//   确定改动调 save、取消改动调 reset。
//
// 依据 DESIGN.md §3.3(settings 槽)。
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useUiStore } from "../ui-store";
import { getSettingsComponent, type SaveBarApi, type SettingsComponentProps } from "@pi-desktop/react";

interface SettingsItem {
  id: string;
  title: string;
  component: string;
  pluginId: string;
}

/** 框架为每个组件创建的 saveBar 状态。 */
interface SaveBarState {
  dirty: boolean;
  saving: boolean;
  save: (() => Promise<void>) | null;
  reset: (() => Promise<void>) | null;
}

export function SettingsPage(): React.ReactNode {
  const setMainView = useUiStore((s) => s.setMainView);
  const [items, setItems] = useState<SettingsItem[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [flash, setFlash] = useState(false);
  /** per-component saveBar 状态:id → SaveBarState。框架渲染浮层读 active 的 dirty。 */
  const [saveBars, setSaveBars] = useState<Map<string, SaveBarState>>(new Map());
  /** 未保存拦截:有 dirty 改动时切 tab/返回对话 → 弹窗"保存/丢弃/取消",
   *  pendingAction 存用户想执行的动作(确认后执行)。null=无拦截。 */
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  // refreshSignal 变(点刷新)→ 整页闪烁动画
  useEffect(() => {
    if (refreshSignal === 0) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 280);
    return () => clearTimeout(t);
  }, [refreshSignal]);

  // 启动读 settings 槽贡献项(只 mount 拉一次)
  useEffect(() => {
    void window.pi.settings.list().then((list) => {
      setItems(list);
      setActiveId((prev) => prev || (list.length > 0 ? list[0].id : ""));
    });
  }, []);

  /** 为某组件创建 saveBar 句柄(传给组件)。组件 register/setDirty 经此更新框架状态。 */
  const makeSaveBar = useCallback((itemId: string): SaveBarApi => {
    const update = (patch: Partial<SaveBarState>): void => {
      setSaveBars((prev) => {
        const next = new Map(prev);
        const cur = next.get(itemId) ?? { dirty: false, saving: false, save: null, reset: null };
        next.set(itemId, { ...cur, ...patch });
        return next;
      });
    };
    return {
      register: ({ save, reset }) => update({ save, reset }),
      setDirty: (dirty) => update({ dirty }),
    };
  }, []);

  const activeSaveBar = activeId ? saveBars.get(activeId) : undefined;
  const activeDirty = !!activeSaveBar?.dirty;
  const activeSaving = !!activeSaveBar?.saving;

  /** 拦截导航:有未保存改动时弹窗,用户选保存/丢弃/取消。无改动直接执行。 */
  const guardNavigate = (action: () => void): void => {
    if (activeDirty) {
      setPendingAction(() => action);
    } else {
      action();
    }
  };

  const doSave = async (): Promise<void> => {
    if (!activeSaveBar?.save) return;
    setSaveBars((prev) => { const n = new Map(prev); n.set(activeId, { ...n.get(activeId)!, saving: true }); return n; });
    try {
      await activeSaveBar.save();
      setSaveBars((prev) => { const n = new Map(prev); n.set(activeId, { ...n.get(activeId)!, dirty: false, saving: false }); return n; });
    } catch (e) {
      console.error("[settings] save failed", e);
      setSaveBars((prev) => { const n = new Map(prev); n.set(activeId, { ...n.get(activeId)!, saving: false }); return n; });
    }
  };

  const doReset = async (): Promise<void> => {
    if (!activeSaveBar?.reset) return;
    try {
      await activeSaveBar.reset();
      setSaveBars((prev) => { const n = new Map(prev); n.set(activeId, { ...n.get(activeId)!, dirty: false }); return n; });
    } catch (e) {
      console.error("[settings] reset failed", e);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--color-bg)", color: "var(--color-fg)", fontFamily: "var(--font-family-sans)" }}>
      {/* 顶部:返回栏 */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", padding: "var(--spacing-sm) var(--spacing-lg)", borderBottom: "1px solid var(--color-border)", flexShrink: 0 }}>
        <button onClick={() => guardNavigate(() => setMainView("chat"))} style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", border: "none", background: "transparent", color: "var(--color-muted)", cursor: "pointer", fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)", padding: "var(--spacing-xs) var(--spacing-sm)", borderRadius: "var(--radius-sm)" }}>
          <ArrowLeft size={16} />
          返回对话
        </button>
        <div style={{ marginLeft: "auto", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>设置</div>
      </div>

      {/* 主体:左列表 + 右配置区 */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* 左:插件配置项列表 */}
        <div style={{ width: "240px", flexShrink: 0, borderRight: "1px solid var(--color-border)", padding: "var(--spacing-sm) 0", overflowY: "auto" }}>
          {items.map((item) => {
            const activeNow = activeId === item.id;
            return (
              <button key={item.id} onClick={() => guardNavigate(() => setActiveId(item.id))} style={{ display: "block", width: "100%", padding: "var(--spacing-sm) var(--spacing-lg)", border: "none", borderLeft: activeNow ? "2px solid var(--color-primary)" : "2px solid transparent", background: activeNow ? "var(--color-surface)" : "transparent", color: activeNow ? "var(--color-fg)" : "var(--color-muted)", cursor: "pointer", fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)", textAlign: "left" }}>
                {item.title}
              </button>
            );
          })}
        </div>

        {/* 右:配置区。所有组件都渲染,active 显示、其余 display:none(切 tab 不重 mount) */}
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {/* 右上角刷新按钮 */}
          {activeId && (
            <button onClick={() => setRefreshSignal((s) => s + 1)} title="刷新" style={{ position: "absolute", top: "var(--spacing-sm)", right: "var(--spacing-md)", zIndex: 10, display: "flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--color-muted)", cursor: "pointer" }}>
              <RefreshCw size={14} />
            </button>
          )}
          {items.map((item) => {
            const Comp = getSettingsComponent(item.component);
            if (!Comp) return null;
            const active = activeId === item.id;
            const saveBar = makeSaveBar(item.id);
            return (
              <motion.div key={item.id} style={{ display: active ? "block" : "none", height: "100%" }} animate={{ opacity: active && flash ? 0.4 : 1 }} transition={{ duration: 0.25, ease: "easeOut" }}>
                <Comp refreshSignal={refreshSignal} saveBar={saveBar} />
              </motion.div>
            );
          })}
          {items.length > 0 && !items.some((i) => i.id === activeId && getSettingsComponent(i.component)) && (
            <div style={{ padding: "var(--spacing-xl)", color: "var(--color-muted)" }}>暂无配置</div>
          )}
        </div>
      </div>

      {/* 框架级保存浮层:dirty 时弹出(createPortal body + fixed 真悬浮)。
          active 插件的 saveBar.dirty 控制;确定改动调 save、取消改动调 reset。 */}
      {createPortal(
        <AnimatePresence>
          {activeDirty && (
            <div style={{ position: "fixed", top: "var(--spacing-md)", left: "50%", transform: "translateX(-50%)", zIndex: 9999 }}>
              <motion.div
                initial={{ y: -60, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -60, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", background: "var(--color-surface)", borderRadius: "var(--radius-md)", border: "1px solid var(--color-primary)", padding: "var(--spacing-sm) var(--spacing-lg)", boxShadow: "var(--shadow-md)", whiteSpace: "nowrap" }}
              >
                <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-fg)" }}>有未保存的改动</span>
                <button onClick={() => void doReset()} disabled={activeSaving} style={barBtn(false, activeSaving)}>取消改动</button>
                <button onClick={() => void doSave()} disabled={activeSaving} style={barBtn(true, activeSaving)}>{activeSaving ? "保存中…" : "确定改动"}</button>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body,
      )}

      {/* 框架级未保存拦截弹窗:切 tab/返回对话时有 dirty → 弹窗"保存/丢弃/取消" */}
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
                <span style={{ fontSize: "var(--font-size-base)", fontWeight: 600, color: "var(--color-fg)" }}>有未保存的改动</span>
                <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>切换前是否保存当前改动?</span>
                <div style={{ display: "flex", gap: "var(--spacing-sm)", justifyContent: "flex-end" }}>
                  <button onClick={() => setPendingAction(null)} style={barBtn(false, false)}>取消</button>
                  <button onClick={async () => { await doReset(); const a = pendingAction; setPendingAction(null); a?.(); }} style={barBtn(false, false)}>丢弃改动</button>
                  <button onClick={async () => { await doSave(); const a = pendingAction; setPendingAction(null); a?.(); }} disabled={activeSaving} style={barBtn(true, activeSaving)}>{activeSaving ? "保存中…" : "保存并继续"}</button>
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
