import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, FileText, AlertTriangle, ExternalLink } from "lucide-react";
import {
  usePluginContext,
  Button,
  type FileActionInvokePayload,
} from "@pi-desktop/react";

export const channels = ["file-preview:fileActionInvoke"] as const;

function getBasename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "icns", "pdf", "zip", "gz", "tar", "dmg", "app", "node", "wasm", "mp4", "mov", "mp3", "wav", "sqlite", "db"
]);

function isBinaryExtension(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTENSIONS.has(ext);
}

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

  const isBinary = isBinaryExtension(path);

  useEffect(() => {
    if (isBinary) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setContent(null);

    void (async () => {
      try {
        if (!ctx.fs) {
          throw new Error("File system access is not available");
        }
        const text = await ctx.fs.readFile(path);
        if (text == null) {
          throw new Error("No content returned");
        }
        setContent(text);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [path, tick, isBinary, ctx.fs]);

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
      {!isBinary && (
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

  if (isBinary || error) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-[var(--color-bg)]">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center max-w-md mx-auto gap-4">
          <div className="p-3 rounded-full bg-[var(--color-surface)] text-[var(--color-muted)]">
            {isBinary ? <FileText className="size-8" /> : <AlertTriangle className="size-8 text-[var(--color-accent-warning)]" />}
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-[length:var(--font-size-base)] font-semibold text-[var(--color-fg)]">
              {basename}
            </h3>
            <p className="text-[length:var(--font-size-sm)] text-[var(--color-muted)]">
              {isBinary ? t("preview.tooLargeOrBinary") : `${t("preview.loadFailed")}: ${error}`}
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

  const lines = content ? content.split(/\r?\n/) : [];

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--color-bg)]">
      {header}
      <div className="flex-1 overflow-auto font-[var(--font-family-mono)] text-[length:var(--font-size-sm)] select-text p-3">
        <table className="border-collapse w-full">
          <tbody>
            {lines.map((line, idx) => (
              <tr key={idx} className="hover:bg-[var(--color-surface)]">
                <td className="text-right pr-4 select-none text-[var(--color-muted)] border-r border-[var(--color-border)] w-12 align-top">
                  {idx + 1}
                </td>
                <td className="pl-4 whitespace-pre text-[var(--color-fg)] align-top">
                  {line}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
