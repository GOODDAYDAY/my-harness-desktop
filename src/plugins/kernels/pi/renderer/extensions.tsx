// pi 内核插件 renderer ——「PI 入口 · PI 拓展」TAB。
// 泛化到共享 KernelExtensionsPage(内核无关,docs/core/extension-management.md §0),这里只绑 kernel="pi"
// 并传**内核专属**的安装来源占位符(通用文案归语言插件 ext.*,内核专属的经 prop 进)。
import { useTranslation } from "react-i18next";
import type { SettingsComponentProps } from "@my-harness-desktop/react";
import { KernelExtensionsPage } from "@my-harness-desktop/react";

export function ExtensionManagerPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  return <KernelExtensionsPage kernel="pi" title={t("settings.extensions")} sourcePlaceholder={t("kernel.extSourcePlaceholder")} refreshSignal={refreshSignal} />;
}
