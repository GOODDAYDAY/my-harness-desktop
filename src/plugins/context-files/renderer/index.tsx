// context-files 插件 renderer —— 右面板 Context 页签:当前目录文件树。
// 文件树是 @pi-desktop/react 共享部件;数据走 fs:project 能力(manifest 已声明)。
import { Files } from "lucide-react";
import { registerSidePanelComponent, useUiStore, FileTree, EmptyState } from "@pi-desktop/react";

const PLUGIN_ID = "context-files";
registerSidePanelComponent("ContextFilesTab", ContextFilesTab);

function ContextFilesTab(): React.ReactNode {
  const currentCwd = useUiStore((s) => s.currentCwd);
  if (!currentCwd) {
    return <EmptyState icon={<Files className="size-8" />} title="先打开文件夹" />;
  }
  return (
    <div className="flex-1 overflow-y-auto py-1 min-h-0">
      <FileTree pluginId={PLUGIN_ID} cwd={currentCwd} />
    </div>
  );
}
