import { useEffect, useRef, useState } from "react";
import { Bug, Check } from "lucide-react";
import { usePluginContext } from "@pi-desktop/react";

const GENERAL_CONFIG_PATH = "~/.pi-desktop/config/general.json";

type AreaKey = "page" | "mainView" | "rightPanel" | "leftPanel";

const AREA_LABELS: Record<AreaKey, string> = {
  page: "整个页面",
  mainView: "中区主视图",
  rightPanel: "右面板",
  leftPanel: "左栏",
};

function simplifyDom(el: Element): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[style]").forEach((n) => n.removeAttribute("style"));
  clone.removeAttribute("style");
  return clone.outerHTML;
}

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

export function DebugBarButton(): React.ReactNode {
  const ctx = usePluginContext();
  const [debugMode, setDebugMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [simplified, setSimplified] = useState(false);
  const [copiedKey, setCopiedKey] = useState<AreaKey | null>(null);
  const [copyError, setCopyError] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const readDebugMode = (): void => {
    void ctx.configFile
      .get(GENERAL_CONFIG_PATH)
      .then((c) => setDebugMode(c["debugMode"] === true || import.meta.env.DEV))
      .catch(() => setDebugMode(import.meta.env.DEV));
  };

  useEffect(readDebugMode, [ctx]);

  useEffect(() => {
    const off = ctx.events.on("system:settingsChanged", readDebugMode);
    return off;
  }, [ctx]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
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

  if (!debugMode) return null;

  const copyArea = (key: AreaKey): void => {
    const el = getAreaEl(key);
    if (!el) return;
    const text = simplified ? simplifyDom(el) : el.outerHTML;
    setCopyError(false);
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedKey(key);
        setTimeout(() => {
          setCopiedKey(null);
          setMenuOpen(false);
        }, 1000);
      })
      .catch(() => {
        setCopyError(true);
        setTimeout(() => {
          setCopyError(false);
          setMenuOpen(false);
        }, 2000);
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
    <div ref={menuRef} className="relative">
      <button
        style={btnStyle}
        title="Debug: 复制 DOM 到剪贴板"
        onClick={() => setMenuOpen((v) => !v)}
      >
        <Bug className="size-4" />
      </button>

      {menuOpen && (
        <div
          className="absolute top-full right-0 mt-1 z-50 min-w-[180px] py-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg"
        >
          {(Object.keys(AREA_LABELS) as AreaKey[]).map((key) => (
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
              {copiedKey === key ? (
                <Check className="size-3 text-[var(--color-primary)]" />
              ) : (
                <span className="size-3" />
              )}
              <span>{copiedKey === key ? "已复制到剪贴板" : copyError ? "复制失败" : `复制${AREA_LABELS[key]}`}</span>
            </div>
          ))}

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
            <span>简化 DOM（去除 inline style）</span>
          </div>
        </div>
      )}
    </div>
  );
}
