// dsh-manager 插件 renderer ——「DSH 入口」的三个 TAB 组件。
//
// 与 pi-manager 同级:dsh 是另一个内核(DeepSeek harness,Cordis 插件树 + JSON-RPC)。
// 本期(阶段二)三 TAB 是骨架,内容在阶段三(模型合流/配置)+ 阶段四(跨内核切换)接真。
// 三个 TAB 经 manifest 的 contributes.settings[].tabs 声明,框架按 component 名匹配本入口 exports。
import { useTranslation } from "react-i18next";
import { SettingsSection, type SettingsComponentProps } from "@pi-desktop/react";

/** TAB 1 · DSH 内核版本 + 配置。 */
export function DshKernelPage(_props: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("dsh.kernelTitle")}>
      <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", margin: 0 }}>
        {t("dsh.kernelPlaceholder")}
      </p>
    </SettingsSection>
  );
}

/** TAB 2 · DSH 拓展(Cordis 插件树)。 */
export function DshExtensionsPage(_props: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("dsh.extTitle")}>
      <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", margin: 0 }}>
        {t("dsh.extPlaceholder")}
      </p>
    </SettingsSection>
  );
}

/** TAB 3 · DSH 模型配置(cordis.yml 的 llm-deepseek)。 */
export function DshModelsPage(_props: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("dsh.modelsTitle")}>
      <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", margin: 0 }}>
        {t("dsh.modelsPlaceholder")}
      </p>
    </SettingsSection>
  );
}
