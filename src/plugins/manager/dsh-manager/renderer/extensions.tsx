// dsh-manager 插件 renderer ——「DSH 入口 · DSH 拓展」TAB。
// 泛化到共享 KernelExtensionsPage(内核无关,docs/core/extension-management.md §0),这里只绑 kernel="dsh"。
// 与 PI 拓展同组件同功能态:一根 enabled 轴 + 元信息 + 受保护 + 重启协调,不再有「可用插件」第三列表。
import { useTranslation } from "react-i18next";
import type { SettingsComponentProps } from "@my-harness-desktop/react";
import { KernelExtensionsPage } from "@my-harness-desktop/react";

export function DshExtensionsPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  return <KernelExtensionsPage kernel="dsh" title={t("dsh.extTitle")} refreshSignal={refreshSignal} />;
}
