// run-panel 插件 renderer —— 右面板 Run 页签(空态占位:运行任务追踪待接入)。
import { Activity } from "lucide-react";
import { registerSidePanelComponent, EmptyState } from "@pi-desktop/react";

registerSidePanelComponent("RunPanelTab", RunPanelTab);

function RunPanelTab(): React.ReactNode {
  return (
    <EmptyState
      icon={<Activity className="size-8" />}
      title="暂无运行任务"
      description="命令运行/终端输出追踪待接入"
    />
  );
}
