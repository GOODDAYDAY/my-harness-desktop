import { useState } from "react";
import { RefreshCw, FolderOpen } from "lucide-react";
import { useUiStore, FileTree, EmptyState } from "@pi-desktop/react";

export function FileTreeTab({ isActive: _isActive }: { isActive: boolean }): React.ReactNode {
  const currentCwd = useUiStore((s) => s.currentCwd);
  const [refreshKey, setRefreshKey] = useState(0);

  if (!currentCwd) {
    return <EmptyState icon={<FolderOpen className="size-8" />} title="先打开文件夹" />;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-[var(--color-border)] flex-none">
        <span className="text-[var(--font-size-sm)] text-[var(--color-muted)] font-mono truncate" title={currentCwd}>
          {currentCwd.split("/").pop() ?? currentCwd}
        </span>
        <button
          type="button"
          onClick={() => setRefreshKey((k) => k + 1)}
          className="flex items-center gap-1 text-[var(--font-size-sm)] text-[var(--color-muted)] hover:text-[var(--color-primary)] transition-colors"
          title="刷新"
        >
          <RefreshCw className="size-3.5" />
          刷新
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1 min-h-0">
        <FileTree cwd={currentCwd} refreshKey={refreshKey} />
      </div>
    </div>
  );
}
