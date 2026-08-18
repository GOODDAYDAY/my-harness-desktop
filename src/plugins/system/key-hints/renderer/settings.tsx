// key-hints 设置页 —— ` 前缀键开关 + 触发方式说明。
//
// 配置走 settings 槽框架托管(configFile 统一通道:零声明默认
// ~/.my-harness-desktop/config/key-hints.json),onChange 报告改动、框架管 dirty/save;
// Overlay 订阅 system:configFileSaved 重读,保存即生效。
//
// 触发方式分两路:① ` 前缀键(本页开关);② 组合键(由 keybindings 设置页绑定
// keyhints:toggle,默认 mod+shift+')——两路互不依赖,关掉 ` 键仍有组合键可用。
import { useTranslation } from "react-i18next";
import { SettingsSection, type SettingsComponentProps } from "@my-harness-desktop/react";

export function KeyHintsSettings({ config, onChange }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const backquote = config?.backquote !== false;
  return (
    <div className="flex flex-col gap-4">
      <SettingsSection title={t("keyhints.settings.trigger")} description={t("keyhints.settings.triggerDesc")}>
        <div className="flex items-center justify-between gap-3 py-1">
          <div className="flex flex-col gap-0.5">
            <span className="text-[length:var(--font-size-sm)] text-[var(--color-fg)]">
              {t("keyhints.settings.backquoteLabel")}
            </span>
            <span className="text-[length:var(--font-size-xs)] text-[var(--color-muted)]">
              {t("keyhints.settings.backquoteHint")}
            </span>
          </div>
          <input
            type="checkbox"
            checked={backquote}
            onChange={(e) => onChange({ ...(config ?? {}), backquote: e.target.checked })}
            className="size-4 accent-[var(--color-primary)] cursor-pointer shrink-0"
          />
        </div>
      </SettingsSection>
      <SettingsSection title={t("keyhints.settings.shortcut")} description={t("keyhints.settings.shortcutDesc")}>
        <div className="py-1 text-[length:var(--font-size-sm)] text-[var(--color-fg)]">
          {t("keyhints.settings.shortcutHint")}
        </div>
      </SettingsSection>
    </div>
  );
}
