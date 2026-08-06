import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, FileText, AlertTriangle, ExternalLink, Code, Eye } from "lucide-react";
import {
  usePluginContext,
  Button,
  MarkdownBody,
  MermaidDiagram,
  PumlDiagram,
  type FileActionInvokePayload,
} from "@pi-desktop/react";

export const channels = ["file-preview:fileActionInvoke"] as const;

function getBasename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function getExtension(path: string): string {
  const name = getBasename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", avif: "image/avif", ico: "image/x-icon", svg: "image/svg+xml",
};

const BINARY_EXTENSIONS = new Set([
  "zip", "gz", "tar", "rar", "7z", "xz", "bz2", "dmg", "iso",
  "app", "node", "wasm", "exe", "dll", "so", "dylib", "bin", "dat",
  "sqlite", "db", "mp4", "mov", "webm", "mkv", "avi",
  "mp3", "wav", "flac", "ogg", "m4a", "aac", "icns", "ttf", "otf", "woff", "woff2",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);
const MERMAID_EXTENSIONS = new Set(["mmd", "mermaid"]);
const PUML_EXTENSIONS = new Set(["puml", "plantuml", "iuml"]);

type Route = "image" | "pdf" | "text" | "binary" | "markdown" | "diagram" | "puml";

function routeOf(path: string): Route {
  const ext = getExtension(path);
  if (ext in IMAGE_MIME) return "image";
  if (ext === "pdf") return "pdf";
  if (BINARY_EXTENSIONS.has(ext)) return "binary";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (MERMAID_EXTENSIONS.has(ext)) return "diagram";
  if (PUML_EXTENSIONS.has(ext)) return "puml";
  return "text";
}

/** 带"渲染/源码"双态的富文本路由 */
const isRichRoute = (route: Route): boolean => route === "markdown" || route === "diagram" || route === "puml";

export function PreviewOpener(): ReactNode {
  const ctx = usePluginContext();

  useEffect(() => {
    const off = ctx.events.on("file-preview:fileActionInvoke", (payload) => {
      const p = payload as FileActionInvokePayload | null;
      if (!p || p.isDir) return;

      const basename = getBasename(p.path);
      ctx.layout.openView({
        viewId: `file:${p.path}`,
        component: "FilePreviewView",
        title: basename,
        icon: "file-text",
        props: { path: p.path },
      });
    });
    return off;
  }, [ctx.events, ctx.layout]);

  return null;
}

export function FilePreviewView({ path }: { path: string }): ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [viewMode, setViewMode] = useState<"rendered" | "source">("rendered");

  const route = routeOf(path);
  // 富文本路由的"看源码"切换:回落到行号文本视图
  const effectiveRoute = isRichRoute(route) && viewMode === "source" ? "text" : route;

  useEffect(() => {
    if (route === "binary") {
      setLoading(false);
      return;
    }

    let alive = true;
    let blobUrl: string | null = null;
    setLoading(true);
    setError(null);
    setContent(null);

    void (async () => {
      try {
        if (!ctx.fs) {
          throw new Error("File system access is not available");
        }
        if (route === "text" || isRichRoute(route)) {
          const text = await ctx.fs.readFile(path);
          if (text == null) throw new Error("No content returned");
          if (alive) setContent(text);
          return;
        }
        const b64 = await ctx.fs.readFileBase64(path);
        if (route === "image") {
          if (alive) setContent(`data:${IMAGE_MIME[getExtension(path)]};base64,${b64}`);
          return;
        }
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        if (alive) {
          setContent(blobUrl);
        } else {
          URL.revokeObjectURL(blobUrl);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [path, tick, route, ctx.fs]);

  const handleRefresh = () => {
    setTick((t) => t + 1);
  };

  const handleOpenSystem = () => {
    void ctx.openFile(path);
  };

  const basename = getBasename(path);

  const header = (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-[var(--color-border)] flex-none">
      <span className="text-[length:var(--font-size-sm)] text-[var(--color-muted)] font-mono truncate" title={path}>
        {path}
      </span>
      <div className="flex items-center gap-2 flex-none">
        {isRichRoute(route) && (
          <button
            type="button"
            onClick={() => setViewMode((v) => (v === "rendered" ? "source" : "rendered"))}
            className="flex items-center gap-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)] hover:text-[var(--color-primary)] transition-colors bg-transparent border-none cursor-pointer"
          >
            {viewMode === "rendered" ? <Code className="size-3.5" /> : <Eye className="size-3.5" />}
            {viewMode === "rendered" ? t("preview.viewSource") : t("preview.viewRendered")}
          </button>
        )}
        {route !== "binary" && (
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading}
            className="flex items-center gap-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)] hover:text-[var(--color-primary)] transition-colors bg-transparent border-none cursor-pointer disabled:opacity-50"
            title={t("preview.refresh")}
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("preview.refresh")}
          </button>
        )}
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[var(--color-bg)]">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center text-[var(--color-muted)] text-[length:var(--font-size-sm)]">
          <RefreshCw className="size-6 animate-spin mb-2" />
          {t("preview.loading")}
        </div>
      </div>
    );
  }

  if (route === "binary" || error) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[var(--color-bg)]">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center max-w-md mx-auto gap-4">
          <div className="p-3 rounded-full bg-[var(--color-surface)] text-[var(--color-muted)]">
            {route === "binary" ? <FileText className="size-8" /> : <AlertTriangle className="size-8 text-[var(--color-accent-warning)]" />}
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-[length:var(--font-size-base)] font-semibold text-[var(--color-fg)]">
              {basename}
            </h3>
            <p className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">
              {route === "binary" ? t("preview.tooLargeOrBinary") : `${t("preview.loadFailed")}: ${error}`}
            </p>
          </div>
          <Button variant="primary" onClick={handleOpenSystem}>
            <ExternalLink className="size-3.5" />
            {t("preview.openWithSystemApp")}
          </Button>
        </div>
      </div>
    );
  }

  if (route === "image" && content) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[var(--color-bg)]">
        {header}
        <div className="flex-1 overflow-auto flex items-center justify-center p-4 min-h-0">
          <img src={content} alt={basename} className="max-w-full max-h-full object-contain" />
        </div>
      </div>
    );
  }

  if (route === "pdf" && content) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[var(--color-bg)]">
        {header}
        <embed src={content} type="application/pdf" className="flex-1 w-full min-h-0" />
      </div>
    );
  }

  if (effectiveRoute === "markdown" && content) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[var(--color-bg)]">
        {header}
        <div className="flex-1 overflow-auto min-h-0 px-6 py-4">
          <div className="max-w-[760px] mx-auto">
            <MarkdownBody text={content} />
          </div>
        </div>
      </div>
    );
  }

  if ((effectiveRoute === "diagram" || effectiveRoute === "puml") && content) {
    const sourceFallback = (
      <pre className="font-[var(--font-family-mono)] text-[length:var(--font-size-sm)] text-[var(--color-fg)] whitespace-pre p-3">
        {content}
      </pre>
    );
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[var(--color-bg)]">
        {header}
        <div className="flex-1 overflow-auto min-h-0 p-4">
          {effectiveRoute === "diagram"
            ? <MermaidDiagram code={content} fallback={sourceFallback} />
            : <PumlDiagram code={content} fallback={sourceFallback} />}
        </div>
      </div>
    );
  }

  const lines = content ? content.split(/\r?\n/) : [];
  const gutterCh = String(Math.max(lines.length, 1)).length;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--color-bg)]">
      {header}
      <div className="flex-1 overflow-auto font-[var(--font-family-mono)] text-[length:var(--font-size-sm)] select-text p-3">
        {lines.map((line, idx) => (
          <div
            key={idx}
            className="flex hover:bg-[var(--color-surface)]"
            style={{ contentVisibility: "auto", containIntrinsicSize: "auto 1.5em" }}
          >
            <span
              className="text-right pr-3 select-none text-[var(--color-muted)] border-r border-[var(--color-border)] flex-none"
              style={{ minWidth: `${gutterCh + 1}ch` }}
            >
              {idx + 1}
            </span>
            <span className="pl-3 whitespace-pre text-[var(--color-fg)]">{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
