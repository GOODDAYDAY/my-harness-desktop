// debug-bar 插件 renderer —— 标题栏 Debug 工具,仅在 general-config 的 debugMode
// 开启(或 dev 环境)时渲染。两个按钮:
//   1. 复制菜单:把整个页面/主视图/右面板/左栏的 DOM 复制到剪贴板(可选去 inline style)。
//   2. 元素审查:全屏 overlay 给每个可见元素画框并标注序号,点击某元素即复制其
//      outerHTML——方便"跟 AI 说 #N 这个元素有问题"。Esc / 点空白处退出。
import { useCallback, useEffect, useRef, useState } from "react";
import { Bug, Check, Crosshair } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePluginContext, GENERAL_CONFIG_PATH } from "@pi-desktop/react";

type AreaKey = "page" | "mainView" | "rightPanel" | "leftPanel";
const AREA_KEYS: AreaKey[] = ["page", "mainView", "rightPanel", "leftPanel"];

/** 复制结果反馈:kind 区分成功/失败/区域不存在,key 定位到具体菜单项(修复全局 boolean 串扰)。 */
type Feedback = { kind: "copied" | "failed" | "empty"; key: AreaKey | null };

interface BoxInfo {
  n: number;
  top: number;
  left: number;
  width: number;
  height: number;
}

/** 自我保护属性:标注时跳过 debug-bar 自身(按钮、菜单、overlay)。 */
const SELF_ATTR = "data-debug-bar-root";
/** 元素数量上限:会话长了 DOM 可能上千节点,全画框会卡死渲染,截断并在提示条注明。 */
const MAX_INSPECT_ELEMENTS = 500;
/** 小于此尺寸的元素不可点,标注无意义。 */
const MIN_BOX_PX = 4;

function simplifyDom(el: Element): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[style]").forEach((n) => n.removeAttribute("style"));
  clone.removeAttribute("style");
  return clone.outerHTML;
}

// 注意:耦合 shell 的 DOM 结构(#chat-pg 的直接子节点顺序 = 左栏/主视图/右面板,
// 分割条按 inline style 含 col-resize 过滤)。shell 布局改版时这里会失效,
// 调用方已对 null 给出"区域不存在"反馈,不再静默吞掉。
function getAreaEl(key: AreaKey): Element | null {
  if (key === "page") return document.getElementById("root");
  const pg = document.getElementById("chat-pg");
  if (!pg) return null;
  const panels = Array.from(pg.children).filter(
    (c) => !c.getAttribute("style")?.includes("col-resize"),
  );
  if (key === "leftPanel") return panels[0] ?? null;
  if (key === "mainView") return panels[1] ?? null;
  if (key === "rightPanel") return panels[2] ?? null;
  return null;
}

export function DebugBar(): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [debugMode, setDebugMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [simplified, setSimplified] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [boxes, setBoxes] = useState<BoxInfo[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [inspectNote, setInspectNote] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const elsRef = useRef<Map<number, Element>>(new Map());
  const timersRef = useRef<number[]>([]);

  // 定时器统一登记,卸载时全部清理(修复 setState-after-unmount 泄漏)。
  const later = (fn: () => void, ms: number): void => {
    timersRef.current.push(window.setTimeout(fn, ms));
  };
  useEffect(() => {
    const timers = timersRef.current;
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, []);

  const readDebugMode = useCallback((): void => {
    void ctx.configFile
      .get(GENERAL_CONFIG_PATH)
      .then((c) => setDebugMode(c["debugMode"] === true || import.meta.env.DEV))
      .catch(() => setDebugMode(import.meta.env.DEV));
  }, [ctx]);

  useEffect(() => readDebugMode(), [readDebugMode]);

  useEffect(() => {
    const off = ctx.events.on("system:settingsChanged", readDebugMode);
    return off;
  }, [ctx, readDebugMode]);

  // 点击菜单外部 / Esc 关闭复制菜单
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen]);

  // 审查模式生命周期:进入时采集,滚动/缩放时 rAF 节流重算,Esc 退出。
  useEffect(() => {
    if (!inspecting) return;
    // 枚举可见元素并分配序号。位置用 viewport 坐标,滚动/缩放后需重算。
    const collectElements = (): { boxes: BoxInfo[]; truncated: boolean } => {
      const rootEl = document.getElementById("root");
      const result: BoxInfo[] = [];
      const map = elsRef.current;
      map.clear();
      if (!rootEl) return { boxes: result, truncated: false };
      let truncated = false;
      for (const el of Array.from(rootEl.querySelectorAll("*"))) {
        if (el.closest(`[${SELF_ATTR}]`)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < MIN_BOX_PX || r.height < MIN_BOX_PX) continue;
        if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) continue;
        map.set(result.length + 1, el);
        result.push({ n: result.length + 1, top: r.top, left: r.left, width: r.width, height: r.height });
        if (result.length >= MAX_INSPECT_ELEMENTS) { truncated = true; break; }
      }
      return { boxes: result, truncated };
    };
    const recollect = (): void => {
      const r = collectElements();
      setBoxes(r.boxes);
      setTruncated(r.truncated);
    };
    recollect();
    let raf = 0;
    const schedule = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recollect);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setInspecting(false);
    };
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("keydown", onKey);
      setBoxes([]);
      setInspectNote(null);
    };
  }, [inspecting]);

  if (!debugMode) return null;

  const flash = (kind: Feedback["kind"], key: AreaKey | null, ms: number): void => {
    setFeedback({ kind, key });
    later(() => {
      setFeedback(null);
      setMenuOpen(false);
    }, ms);
  };

  const copyArea = (key: AreaKey): void => {
    const el = getAreaEl(key);
    if (!el) {
      flash("empty", key, 2000);
      return;
    }
    const text = simplified ? simplifyDom(el) : el.outerHTML;
    navigator.clipboard
      .writeText(text)
      .then(() => flash("copied", key, 1000))
      .catch(() => flash("failed", key, 2000));
  };

  const exitInspect = (): void => setInspecting(false);

  // 命中测试:取包含点击点的元素中面积最小者 = 最内层的可标注元素。
  // 点不到任何元素(如落在 debug-bar 自身按钮上,已排除标注)时退出审查模式。
  const onOverlayClick = (e: React.MouseEvent): void => {
    const x = e.clientX;
    const y = e.clientY;
    let best: BoxInfo | null = null;
    let bestArea = Infinity;
    for (const b of boxes) {
      if (x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height) {
        const area = b.width * b.height;
        if (area < bestArea) {
          bestArea = area;
          best = b;
        }
      }
    }
    if (!best) {
      exitInspect();
      return;
    }
    const el = elsRef.current.get(best.n);
    if (!el) {
      exitInspect();
      return;
    }
    const n = best.n;
    const text = simplified ? simplifyDom(el) : el.outerHTML;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setInspectNote(t("debug.copiedElement", { n }));
        later(exitInspect, 900);
      })
      .catch(() => {
        setInspectNote(t("debug.copyFailed"));
        later(exitInspect, 1500);
      });
  };

  const btnStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    border: "none",
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    color: "var(--color-muted)",
    cursor: "pointer",
    // @ts-expect-error Electron 私有 CSS 属性
    WebkitAppRegion: "no-drag",
  };

  const menuItemStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 10px",
    cursor: "pointer",
    fontSize: "var(--font-size-sm)",
    color: "var(--color-fg)",
    borderRadius: "var(--radius-sm)",
  };

  return (
    <div ref={rootRef} {...{ [SELF_ATTR]: "" }} className="relative flex">
      <button
        style={{
          ...btnStyle,
          color: inspecting ? "var(--color-primary)" : "var(--color-muted)",
        }}
        title={t("debug.inspectTitle")}
        onClick={() => {
          setMenuOpen(false);
          setInspecting((v) => !v);
        }}
      >
        <Crosshair className="size-4" />
      </button>

      <button
        style={btnStyle}
        title={t("debug.copyDomTitle")}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <Bug className="size-4" />
      </button>

      {menuOpen && (
        <div
          className="absolute top-full right-0 mt-1 z-50 min-w-[180px] py-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg"
        >
          {AREA_KEYS.map((key) => {
            const fb = feedback?.key === key ? feedback.kind : null;
            return (
              <div
                key={key}
                style={menuItemStyle}
                onClick={() => copyArea(key)}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = "var(--color-bg-hover, var(--color-surface))";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = "transparent";
                }}
              >
                {fb === "copied" ? (
                  <Check className="size-3 text-[var(--color-primary)]" />
                ) : (
                  <span className="size-3" />
                )}
                <span>
                  {fb === "copied"
                    ? t("debug.copied")
                    : fb === "failed"
                      ? t("debug.copyFailed")
                      : fb === "empty"
                        ? t("debug.areaNotFound")
                        : `${t("common.copy")}${t(`debug.area.${key}`)}`}
                </span>
              </div>
            );
          })}

          <div className="my-1 border-t border-[var(--color-border)]" />

          <div
            style={menuItemStyle}
            onClick={() => setSimplified((v) => !v)}
          >
            {simplified ? (
              <Check className="size-3 text-[var(--color-primary)]" />
            ) : (
              <span className="size-3" />
            )}
            <span>{t("debug.simplify")}</span>
          </div>
        </div>
      )}

      {inspecting && (
        <div
          className="fixed inset-0"
          style={{ zIndex: 9999, cursor: "crosshair" }}
          onClick={onOverlayClick}
        >
          <div
            className="absolute top-12 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)] shadow-lg"
            style={{ fontSize: "var(--font-size-sm)", pointerEvents: "none" }}
          >
            {inspectNote ??
              (truncated
                ? t("debug.inspectTruncated", { count: boxes.length })
                : t("debug.inspectHint", { count: boxes.length }))}
          </div>
          {boxes.map((b) => (
            <div
              key={b.n}
              style={{
                position: "fixed",
                top: b.top,
                left: b.left,
                width: b.width,
                height: b.height,
                border: "1px solid var(--color-primary)",
                pointerEvents: "none",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  background: "var(--color-primary)",
                  color: "var(--color-bg)",
                  fontSize: "10px",
                  lineHeight: 1,
                  padding: "2px 3px",
                }}
              >
                {b.n}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
