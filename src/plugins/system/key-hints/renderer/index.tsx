// key-hints 插件 renderer 入口。
//
// - Overlay:零可见常驻组件(框架 PluginOverlays 全局挂载,PluginIdContext 已注入)。
//   两种触发:
//     ① keyhints:toggle channel —— keybindings 默认绑 mod+shift+' 等组合键 invoke;
//     ② ` 前缀键(物理 Backquote,中文键盘即 ·):单击 250ms 窗口后进入导览模式,
//        窗口内双击 → 把单个 ` 字符输入当前焦点(想输入 ` 时按两次,类似 tmux 前缀键)。
//   导览模式:全页扫描可点击元素 → 高亮 + 左上角字母徽标(区分大小写、前缀唯一) →
//   按字母前缀过滤、唯一命中即触发点击;触发后保持模式并重扫(打开的菜单项也能继续 hint)。
//   Esc 或点击导览层外退出;滚动防抖重扫(位置重算 + 视口进出)。
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePluginContext } from "@pi-desktop/react";
import { useTranslation } from "react-i18next";
import type { ChannelMeta } from "@pi-desktop/contract";
import { assignHints, isClickable, isDisabled, isVisible } from "../core/hints";
import "./key-hints.css";

export const channels = ["keyhints:toggle"] as const;

// channel 可读描述(快捷键设置页动态列表用;keybindings 默认绑定在设置页可见此描述)。
export const channelMeta: Record<string, ChannelMeta> = {
  "keyhints:toggle": {
    label: "切换按键导览模式",
    description: "进入/退出导览模式:所有可点击元素高亮并显示字母标记,按字母即触发点击。",
  },
};

interface HintTarget {
  el: HTMLElement;
  hint: string;
}

/** 把文本插入当前焦点输入控件(textarea/input/contentEditable)。焦点不在输入处则忽略。 */
function insertText(text: string): void {
  const el = document.activeElement;
  if (!el) return;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.setRangeText(text, start, end, "end");
    return;
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    document.execCommand("insertText", false, text);
  }
}

export function Overlay(): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  const [targets, setTargets] = useState<HintTarget[]>([]);
  const [typed, setTyped] = useState("");
  // ref 镜像:模式 keydown 监听只在 active 变化时挂一次,闭包必须读最新值(根因:
  // 若直接闭包捕获 targets/typed,effect 不重挂就永远读旧值——闭包旧值 bug)。
  const activeRef = useRef(false);
  const targetsRef = useRef<HintTarget[]>([]);
  const typedRef = useRef("");
  // 已加高亮 class 的元素集合:退出/重扫时统一摘除(重扫换目标,旧目标也要摘)。
  const highlightedRef = useRef<Set<HTMLElement>>(new Set());

  const updateTyped = useCallback((v: string): void => {
    typedRef.current = v;
    setTyped(v);
  }, []);

  // 扫描:收集视口内可见可点击元素 → 嵌套去重 → 分配前缀唯一 hint → 高亮 + 建徽标。
  const rescan = useCallback((): void => {
    const all = Array.from(document.querySelectorAll<HTMLElement>("body *"));
    const clickable = new Set<HTMLElement>();
    for (const el of all) {
      if (el.closest(".kh-root")) continue; // 不扫描导览层自身
      if (isClickable(el) && !isDisabled(el) && isVisible(el)) clickable.add(el);
    }
    // 嵌套去重:元素的可点击祖先已在集合 → 它是祖先的子件(图标/文字),点祖先即可。
    const leaves: HTMLElement[] = [];
    for (const el of all) {
      if (!clickable.has(el)) continue;
      let p = el.parentElement;
      let nested = false;
      while (p) {
        if (clickable.has(p)) { nested = true; break; }
        p = p.parentElement;
      }
      if (!nested) leaves.push(el);
    }
    const hints = assignHints(leaves.length);
    const next: HintTarget[] = [];
    for (let i = 0; i < leaves.length; i++) {
      if (hints[i]) next.push({ el: leaves[i], hint: hints[i] });
    }
    for (const el of highlightedRef.current) el.classList.remove("kh-target");
    highlightedRef.current.clear();
    for (const x of next) {
      x.el.classList.add("kh-target");
      highlightedRef.current.add(x.el);
    }
    targetsRef.current = next;
    setTargets(next);
    updateTyped("");
  }, [updateTyped]);

  // 触发切换:keybindings 组合键 → keyhints:toggle。
  useEffect(() => {
    const off = ctx.events.on("keyhints:toggle", () => setActive((a) => !a));
    return off;
  }, [ctx.events]);

  // ` 前缀键:单击(250ms 窗口)进模式;窗口内双击 → 输入一个 ` 字符(想输入 ` 时按两次)。
  useEffect(() => {
    let timer: number | null = null;
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== "Backquote" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (activeRef.current) return; // 导览模式中不参与(退出走 Esc)
      e.preventDefault();
      e.stopPropagation();
      if (timer !== null) {
        // 窗口内第二下:双击 = 输入 ` 字符
        window.clearTimeout(timer);
        timer = null;
        insertText("`");
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        setActive(true);
      }, 250);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  // 激活:进入即扫描;退出清理高亮。
  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    rescan();
    return () => {
      for (const el of highlightedRef.current) el.classList.remove("kh-target");
      highlightedRef.current.clear();
      targetsRef.current = [];
      updateTyped("");
    };
  }, [active, rescan, updateTyped]);

  // 模式内键盘独占:capture + stopImmediatePropagation,字母键不落到页面
  // (焦点若在 composer 输入框,不能一边导览一边打字)。组合键/功能键放行
  // (mod+shift+] 切模型、mod+shift+' 再次切换导览等照常)。
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setActive(false);
        return;
      }
      if (e.key.length !== 1 || !/[a-zA-Z]/.test(e.key)) return; // 组合键/功能键放行
      e.preventDefault();
      e.stopImmediatePropagation();
      const ts = targetsRef.current;
      if (ts.length === 0) return;
      const next = typedRef.current + e.key;
      const matches = ts.filter((x) => x.hint.startsWith(next));
      if (matches.length === 0) { updateTyped(""); return; } // 无匹配:清空重来
      if (matches.length === 1 && matches[0].hint === next) {
        // 唯一完整命中(前缀唯一保证此时必唯一):触发点击,保持模式并重扫
        matches[0].el.click();
        rescan();
        return;
      }
      updateTyped(next); // 前缀匹配中,等待继续输入
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, rescan, updateTyped]);

  // 点击导览层(提示条/徽标)之外任意处 → 退出。
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent): void => {
      if ((e.target as Element | null)?.closest(".kh-root")) return;
      setActive(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [active]);

  // 滚动防抖重扫:徽标位置随滚动重算,新进入视口的元素获得 hint,滚出去的消失。
  useEffect(() => {
    if (!active) return;
    let timer: number | null = null;
    const onScroll = (): void => {
      if (timer !== null) return;
      timer = window.setTimeout(() => { timer = null; rescan(); }, 120);
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
    };
  }, [active, rescan]);

  if (!active) return null;
  return createPortal(
    <div className="kh-root">
      <div className="kh-hintbar">
        <span>{t("keyhints.hintBar")}</span>
        {typed !== "" && <kbd>{typed}</kbd>}
      </div>
      {targets.map((x, i) => {
        const rect = x.el.getBoundingClientRect();
        const dim = typed !== "" && !x.hint.startsWith(typed);
        return (
          <span
            key={i}
            className={`kh-badge${dim ? " kh-badge--dim" : ""}`}
            style={{ left: rect.left, top: rect.top }}
          >
            {x.hint}
          </span>
        );
      })}
    </div>,
    document.body,
  );
}
