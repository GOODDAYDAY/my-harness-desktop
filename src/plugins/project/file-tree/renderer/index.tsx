import { useState } from "react";
import { RefreshCw, FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore, FileTree, EmptyState } from "@my-harness-desktop/react";
import { pathBasename } from "@my-harness-desktop/shared";

export function FileTreeTab(): React.ReactNode {
  const { t } = useTranslation();
  const currentCwd = useUiStore((s) => s.currentCwd);
  const [refreshKey, setRefreshKey] = useState(0);

  if (!currentCwd) {
    return <EmptyState icon={<FolderOpen className="size-8" />} title={t("files.openFolderFirst")} />;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-[var(--color-border)] flex-none">
        <span className="text-[length:var(--font-size-sm)] text-[var(--color-muted)] font-mono truncate" title={currentCwd}>
          {pathBasename(currentCwd)}
        </span>
        <button
          type="button"
          onClick={() => setRefreshKey((k) => k + 1)}
          className="flex items-center gap-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)] hover:text-[var(--color-primary)] transition-colors"
          title={t("common.refresh")}
        >
          <RefreshCw className="size-3.5" />
          {t("common.refresh")}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1 min-h-0">
        <FileTree cwd={currentCwd} refreshKey={refreshKey} />
      </div>
    </div>
  );
}
