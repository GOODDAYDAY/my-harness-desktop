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
import { usePluginContext, useUiStore } from "@my-harness-desktop/react";
import { useTranslation } from "react-i18next";
import type { ChannelMeta } from "@my-harness-desktop/contract";
import { assignDigits, assignHints, isClickable, isDisabled, isVisible } from "../core/hints";
import "./key-hints.css";

export { KeyHintsSettings } from "./settings";

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

/** 键盘滚动的目标容器:视口中心最近的可滚动祖先(设置页多层滚动区域时滚"当前看的那个");
 *  没有可滚动祖先回退文档根。 */
function findScrollContainer(): HTMLElement {
  const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  let node = el instanceof HTMLElement ? el : null;
  while (node && node !== document.body) {
    if (node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.body;
}

/** 焦点在可编辑元素(textarea/input/contentEditable)时移出焦点——"退出输入态"动作。 */
function blurActiveEditable(): void {
  const ae = document.activeElement;
  if (!ae) return;
  if (ae instanceof HTMLTextAreaElement || ae instanceof HTMLInputElement || (ae instanceof HTMLElement && ae.isContentEditable)) {
    ae.blur();
  }
}

/** 键盘滚动按键 → 动作(导览模式下 PageUp/Down、方向键、Home/End、Space 滚可滚动容器)。 */
const scrollKeyAct: Record<string, "up" | "down" | "top" | "bottom"> = {
  PageUp: "up",
  PageDown: "down",
  ArrowUp: "up",
  ArrowDown: "down",
  Home: "top",
  End: "bottom",
  " ": "down",
};

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

  // 视图切换(聊天 ↔ 设置)时退出导览:切走后旧徽标悬在新视图上无意义,且触发后本就该消失。
  const activeView = useUiStore((s) => s.activeView);
  useEffect(() => {
    setActive(false);
  }, [activeView]);

  const updateTyped = useCallback((v: string): void => {
    typedRef.current = v;
    setTyped(v);
  }, []);

  // 配置:` 前缀键开关(默认开)。设置页保存后重读(system:configFileSaved),保存即生效。
  const [backquoteEnabled, setBackquoteEnabled] = useState(true);
  const backquoteEnabledRef = useRef(true);
  backquoteEnabledRef.current = backquoteEnabled;
  useEffect(() => {
    let alive = true;
    const reload = async (): Promise<void> => {
      try {
        const v = await ctx.config.get<unknown>("backquote");
        if (!alive) return;
        setBackquoteEnabled(v !== false);
      } catch {
        // 读失败保持现状
      }
    };
    void reload();
    const off = ctx.events.on("system:configFileSaved", () => { void reload(); });
    return () => {
      alive = false;
      off();
    };
  }, [ctx]);

  // 扫描:收集视口内可见可点击元素 → 嵌套去重 → 数字优先区(侧栏)分数字、其余分字母
  // → 高亮 + 建徽标。前缀唯一:数字(1-0)与字母(a-z A-Z)首字符不相交,构造保证。
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
    // 数字优先区:侧栏容器([data-sidebar-style],框架 sidebar 根标记)内元素拿数字 1-0
    // —— 会话/项目列表是"索引心智",数字比字母直觉(1=第一个会话)。超出数字容量的
    // 侧栏元素与其余元素按文档序并入字母池。
    const sideEls = leaves.filter((el) => el.closest("[data-sidebar-style]"));
    const digits = assignDigits(sideEls.length);
    let digitIdx = 0;
    const letterPool: HTMLElement[] = [];
    const next: HintTarget[] = [];
    for (const el of leaves) {
      if (el.closest("[data-sidebar-style]")) {
        const d = digits[digitIdx++];
        if (d) next.push({ el, hint: d });
        else letterPool.push(el);
      } else {
        letterPool.push(el);
      }
    }
    const hints = assignHints(letterPool.length);
    letterPool.forEach((el, i) => {
      if (hints[i]) next.push({ el, hint: hints[i] });
    });
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

  // 输入态 Esc 退出:焦点在可编辑元素时按 Esc 移出焦点,回到页面键盘态(可 ` 进导览)。
  // 用 window bubble(非 capture)——React 组件的自身 Esc 语义(关搜索/关菜单/关 rewind)
  // 在合成事件里先执行;组件 stopPropagation 则事件到不了这里(组件全权处理),不冲突。
  // IME 组合中按 Esc 是取消候选(输入法),不是退出输入态,isComposing 放行。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.isComposing) return;
      blurActiveEditable();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 触发切换:keybindings 组合键 → keyhints:toggle。
  useEffect(() => {
    const off = ctx.events.on("keyhints:toggle", () => setActive((a) => !a));
    return off;
  }, [ctx.events]);

  // ` 前缀键:输入态(焦点在可编辑元素)完全放行——` 就是普通字符,单击即输入,永不进导览;
  // 非输入态按 ` 立即进入导览(无双击判定,零延迟)。设置页可关闭此键(backquote=false),
  // 关闭后 ` 完全恢复为普通字符,只留组合键触发。想输入 ` 去输入框,单击即可。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== "Backquote" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!backquoteEnabledRef.current) return; // 配置关闭 ` 前缀键
      const ae = document.activeElement;
      if (
        ae &&
        (ae instanceof HTMLTextAreaElement || ae instanceof HTMLInputElement ||
          (ae instanceof HTMLElement && ae.isContentEditable))
      ) {
        return; // 输入态:放行,正常输入(与导览无关)
      }
      if (activeRef.current) return; // 导览模式中不参与(退出走 Esc)
      e.preventDefault();
      e.stopPropagation();
      setActive(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // 激活:进入即扫描;退出清理高亮。
  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    rescan();
    // cleanup 用 effect 快照:ref.current 在 cleanup 运行时可能已指向别的集合,
    // 把本次 rescan 填充的集合拷到局部变量再清理(react-hooks/exhaustive-deps)。
    const highlighted = highlightedRef.current;
    return () => {
      for (const el of highlighted) el.classList.remove("kh-target");
      highlighted.clear();
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
        blurActiveEditable(); // 导览退出时若焦点在输入框一并退出输入态(一次 Esc 全退)
        return;
      }
      // 键盘滚动:导览模式下方向键/PageUp/PageDown/Home/End/Space 滚动视口内可滚动容器
      // (滚轮原生可用且 120ms 防抖重扫会重算徽标;这里补键盘路径,手不离键盘滚长页)。
      const scrollAct = scrollKeyAct[e.key];
      if (scrollAct) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const sc = findScrollContainer();
        if (scrollAct === "top") sc.scrollTo({ top: 0, behavior: "smooth" });
        else if (scrollAct === "bottom") sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
        else sc.scrollBy({ top: scrollAct === "down" ? sc.clientHeight * 0.8 : -sc.clientHeight * 0.3, behavior: "smooth" });
        return;
      }
      if (e.key.length !== 1 || !/[a-zA-Z0-9]/.test(e.key)) return; // 组合键/功能键放行
      e.preventDefault();
      e.stopImmediatePropagation();
      const ts = targetsRef.current;
      if (ts.length === 0) return;
      const next = typedRef.current + e.key;
      const matches = ts.filter((x) => x.hint.startsWith(next));
      if (matches.length === 0) { updateTyped(""); return; } // 无匹配:清空重来
      if (matches.length === 1 && matches[0].hint === next) {
        const el = matches[0].el;
        // 触发后直接退出导览(点一下即消失):聚焦目标聚焦输入框、动作目标点击。
        // 不保持模式——视图切换/菜单打开后徽标不更新是保持模式的坑,且重进导览很便宜(` 或组合键)。
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || (el instanceof HTMLElement && el.isContentEditable)) {
          el.focus();
        } else {
          el.click();
        }
        setActive(false);
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
