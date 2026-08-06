// 通用设置页 —— 通用渲染器宿主。
//
// 本页不再持有任何业务字段的渲染逻辑:字段组由 settingsGroups 槽贡献(各插件在自己
// 的 plugin.json 里纯 JSON 声明,含本插件自己的「界面」组——内置与第三方同契约,
// 无特权差异),本渲染器按声明通用渲染。值统一落 general.json,save/dirty/分层/广播
// 走既有框架管线,本页零感知。
//
// 唯一硬编码例外:调试组的 debugMode——默认值随 import.meta.env.DEV 动态,
// 静态 JSON 声明表达不了,保留 bespoke 块(显式标注演进)。
// 顶栏 bespoke:应用信息条 + 重启按钮——信息来自 ctx.appInfo,动作走 app:restart
// 通道(整 App 重启,退出链路同手动退出),非配置字段,不进 settingsGroups。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Power } from "lucide-react";
import { Select, SettingsSection, useSettingsGroups, type SettingsComponentProps, type SettingsFieldDecl, usePluginContext, type AppInfo } from "@pi-desktop/react";


function SectionGroup({ title, children }: { title: string; children: React.ReactNode }): React.ReactNode {
  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--spacing-md)" }}>
      <div style={{ fontSize: "var(--font-size-base)", fontWeight: 600, marginBottom: "var(--spacing-md)" }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--spacing-md)", alignContent: "start" }}>{children}</div>
    </div>
  );
}


const checkboxStyle: React.CSSProperties = {
  width: "16px", height: "16px", cursor: "pointer", accentColor: "var(--color-primary)",
};


/** 单个声明字段 → 控件。value 是 general.json 当前值(可能 undefined/手改过的脏值)。 */
function FieldControl({ field, value, onChange }: {
  field: SettingsFieldDecl;
  value: unknown;
  onChange: (v: unknown) => void;
}): React.ReactNode {
  const { t } = useTranslation();

  if (field.type === "boolean") {
    const on = (value ?? field.default ?? false) === true;
    return (
      <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} style={checkboxStyle} />
        <span style={{ fontSize: "var(--font-size-sm)" }}>{on ? t("common.on") : t("common.off")}</span>
      </label>
    );
  }

  if (field.type === "int") {
    const presets = (field.options ?? []).filter((o): o is number => typeof o === "number");
    const parsed = Number(value ?? field.default ?? presets[0] ?? 0);
    const current = Number.isFinite(parsed) ? parsed : (presets[0] ?? 0);
    // 手改 JSON 写出非档值时并入选项——value 不在 option 里 select 显示空白
    const opts = presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
    return (
      <Select value={String(current)} onChange={(v) => onChange(Number(v))} style={{ width: "100%" }} ariaLabel={t(field.titleKey)}>
        {opts.map((n) => <option key={n} value={n}>{n}</option>)}
      </Select>
    );
  }

  // enum
  const declared = (field.options ?? []).filter((o): o is { value: string; labelKey?: string } => typeof o === "object" && o !== null);
  const current = String(value ?? field.default ?? declared[0]?.value ?? "");
  // 同上:手改写出的法外值并入,防空白
  const opts = declared.some((o) => o.value === current) ? declared : [...declared, { value: current }];
  return (
    <Select value={current} onChange={(v) => onChange(v)} style={{ width: "100%" }} ariaLabel={t(field.titleKey)}>
      {opts.map((o) => <option key={o.value} value={o.value}>{o.labelKey ? t(o.labelKey) : o.value}</option>)}
    </Select>
  );
}


export function GeneralConfigPage({ config, onChange }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  useEffect(() => { void ctx.appInfo.get().then(setAppInfo); }, [ctx]);
  const [restartArmed, setRestartArmed] = useState(false);
  useEffect(() => {
    if (!restartArmed) return;
    const timer = setTimeout(() => setRestartArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [restartArmed]);
  const onRestart = useCallback(() => {
    if (restartArmed) void ctx.appInfo.restart();
    else setRestartArmed(true);
  }, [restartArmed, ctx]);
  const groups = useSettingsGroups();
  // bespoke 例外(见文件头):默认值动态,声明式表达不了
  const isDev = import.meta.env.DEV;
  const debugMode = (config?.["debugMode"] ?? isDev) === true;

  const update = (key: string, value: unknown): void => {
    onChange({ ...config, [key]: value });
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)", display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      {appInfo && (
        <div style={{
          display: "flex", alignItems: "center", gap: "var(--spacing-md)",
          padding: "var(--spacing-sm) var(--spacing-md)",
          borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)",
          background: "var(--color-surface)", fontSize: "var(--font-size-sm)", color: "var(--color-muted)",
        }}>
          <span style={{ fontWeight: 600, color: "var(--color-fg)" }}>{appInfo.name}</span>
          <span>v{appInfo.version}</span>
          <span style={{ opacity: 0.4 }}>|</span>
          <span>Electron {appInfo.electron}</span>
          <span>Node {appInfo.node}</span>
          <span>Chrome {appInfo.chrome}</span>
          <span style={{ opacity: 0.4 }}>|</span>
          <span>{appInfo.platform}{appInfo.isPackaged ? "" : " (dev)"}</span>
          <button
            onClick={onRestart}
            title={restartArmed ? t("settings.restartConfirm") : t("settings.restartApp")}
            style={{
              marginLeft: "auto",
              display: "flex", alignItems: "center", gap: "var(--spacing-xs)",
              padding: "2px var(--spacing-sm)",
              border: `1px solid ${restartArmed ? "var(--color-error)" : "var(--color-border)"}`,
              borderRadius: "var(--radius-sm)", background: "transparent",
              color: restartArmed ? "var(--color-error)" : "var(--color-muted)",
              cursor: "pointer", fontSize: "var(--font-size-sm)",
            }}
          >
            <Power size={12} />
            {restartArmed ? t("settings.restartConfirm") : t("settings.restartApp")}
          </button>
        </div>
      )}
      {groups.map((g) => (
        <SectionGroup key={`${g.pluginId}:${g.id}`} title={t(g.titleKey)}>
          {g.fields.map((f) => (
            <SettingsSection key={f.key} title={t(f.titleKey)} description={f.descKey ? t(f.descKey) : undefined}>
              <FieldControl field={f} value={config?.[f.key]} onChange={(v) => update(f.key, v)} />
            </SettingsSection>
          ))}
        </SectionGroup>
      ))}
      <SectionGroup title={t("settings.groupDebug")}>
      <SettingsSection title={t("settings.debugMode")} description={t("settings.debugModeDesc")}>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
          <input type="checkbox" checked={debugMode} onChange={(e) => update("debugMode", e.target.checked)} style={checkboxStyle} />
          <span style={{ fontSize: "var(--font-size-sm)" }}>{debugMode ? t("common.on") : t("common.off")}</span>
        </label>
      </SettingsSection>
      </SectionGroup>
    </div>
  );
}
