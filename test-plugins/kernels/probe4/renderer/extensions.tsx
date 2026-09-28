// probe4 内核插件 renderer ——「Probe4 入口 · Probe4 拓展」TAB。
// 泛化到共享 KernelExtensionsPage（内核无关，docs/core/extension-management.md §0），这里只绑 kernel="probe4"
// 并传**内核专属**的安装来源占位符（通用文案归语言插件 ext.*，内核专属的经 prop 进）。
import { useTranslation } from "react-i18next";
import type { SettingsComponentProps } from "@my-harness-desktop/react";
import { KernelExtensionsPage } from "@my-harness-desktop/react";

export function Probe4ExtensionsPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  return <KernelExtensionsPage kernel="probe4" title={t("probe4.extTitle")} sourcePlaceholder={t("probe4.extSourcePlaceholder")} refreshSignal={refreshSignal} />;
}
