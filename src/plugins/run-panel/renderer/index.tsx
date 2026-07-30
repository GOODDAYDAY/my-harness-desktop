// run-panel 插件 renderer —— 右面板 Run 页签(空态占位:运行任务追踪待接入)。
import { useTranslation } from "react-i18next";
import { Activity } from "lucide-react";
import {  EmptyState } from "@pi-desktop/react";


export function RunPanelTab({ isActive }: { isActive: boolean }): React.ReactNode {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={<Activity className="size-8" />}
      title={t("system.noRunningTask")}
      description={t("system.noRunningTaskDesc")}
    />
  );
}
