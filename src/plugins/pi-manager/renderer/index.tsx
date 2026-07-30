// pi-manager 插件 renderer —— Pi 管理(内核版本 + 配置,上下分区)。
//
// 合并 pi-kernel-manager + pi-settings(高内聚:一个插件管 pi 底座所有事)。
// 上区:内核版本管理(原 KernelSettings:版本信息 + 安装/切换版本)
// 下区:pi 配置(原 PiSettingsPage:24 项描述 + 未知字段兜底)
//
// 接受 refreshSignal prop(框架刷新按钮触发 +1,useEffect 依赖它重拉)。
// 经 @pi-desktop/react 受控 API(守薄壳:不直连 shell)。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import semver from "semver";
import { getProperty, setProperty } from "dot-prop";
import {  SettingsSection, type SettingsComponentProps, usePluginContext } from "@pi-desktop/react";
import { FIELD_DESCRIPTORS, FIELD_GROUPS, type FieldDescriptor } from "../field-descriptors";


// ---- 工具(点路径读写走 dot-prop;setPath 用 structuredClone 保不可变,React state 需新引用)----
function getPath(obj: Record<string, unknown>, path: string): unknown {
  return getProperty(obj, path);
}
function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const out = structuredClone(obj);
  setProperty(out, path, value);
  return out;
}
function arrToStr(v: unknown): string {
  return Array.isArray(v) ? v.join(", ") : (v as string) ?? "";
}
function strToArr(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

// ============ PiManagerPage ============
export function PiManagerPage({ refreshSignal, config, onChange }: SettingsComponentProps): React.ReactNode {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)" }}>
      <KernelSection refreshSignal={refreshSignal} />
      <div style={{ borderTop: "2px solid var(--color-border)", margin: "var(--spacing-xl) 0" }} />
      <ConfigSection refreshSignal={refreshSignal} config={config} onChange={onChange} />
    </div>
  );
}

// ============ 上区:内核版本管理(原 KernelSettings)============
interface KernelStatus {
  currentVersion: string | null;
  available: boolean;
  error: string | null;
}

function KernelSection({ refreshSignal }: { refreshSignal: number }): React.ReactNode {
  const ctx = usePluginContext();
  const kernel = ctx.kernel;
  const { t } = useTranslation();
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [registry, setRegistry] = useState<{ versions: string[]; latest: string | null } | null>(null);
  const [regFailed, setRegFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [targetVersion, setTargetVersion] = useState<string>("");
  const [installing, setInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string[]>([]);
  const [installResult, setInstallResult] = useState<{ ok: boolean; error: string | null } | null>(null);
  const installDoneRef = useRef(false);

  useEffect(() => {
    setRegFailed(false);
    void kernel.status().then(setStatus);
    void kernel.listVersions().then((r) => {
      setRegistry(r);
      setTargetVersion((prev) => prev || r.latest || "");
    }).catch(() => setRegFailed(true));
  }, [kernel, refreshSignal]);

  const refresh = async (): Promise<void> => {
    setChecking(true);
    setRegFailed(false);
    try {
      const r = await kernel.listVersions(true);
      setRegistry(r);
    } catch {
      setRegFailed(true);
    } finally {
      setChecking(false);
    }
  };

  const install = async (): Promise<void> => {
    if (!targetVersion) return;
    setInstalling(true);
    setInstallOutput([]);
    setInstallResult(null);
    installDoneRef.current = false;
    const r = await kernel.install(
      targetVersion,
      (line) => setInstallOutput((prev) => [...prev, line]),
      (done) => {
        installDoneRef.current = true;
        setInstalling(false);
        setInstallResult(done);
        if (done.ok) {
          void kernel.status().then(setStatus);
          void kernel.listVersions(true).then(setRegistry).catch(() => setRegFailed(true));
        }
      },
    );
    if (!r.ok && !installDoneRef.current) {
      setInstalling(false);
      setInstallResult(r);
    }
  };

  const current = status?.currentVersion ?? null;
  const latest = registry?.latest ?? null;
  // semver 比较(字符串字典序会错:0.10.0 < "0.9.0");任一侧非法则不判升降
  const cmp = current && targetVersion && semver.valid(current) && semver.valid(targetVersion)
    ? semver.compare(current, targetVersion)
    : null;
  const isDowngrade = cmp !== null && cmp > 0;
  const isUpgrade = cmp !== null && cmp < 0;
  const isSame = cmp !== null && cmp === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      <div>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>{t("kernel.title")}</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          {t("kernel.desc")}
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: "var(--spacing-xl)", alignItems: "start" }}>
        {/* 左列:版本信息 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
          <InfoRow label={t("kernel.installedVersion")} value={current ?? (status?.available ? t("common.unknown") : t("common.notInstalled"))} />
          <div style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center", fontSize: "var(--font-size-sm)" }}>
            <span style={{ color: "var(--color-muted)", minWidth: "80px" }}>{t("kernel.latestVersion")}</span>
            <span style={{ color: (latest && current && current !== latest) ? "var(--color-accent.warning)" : "var(--color-fg)", fontFamily: "var(--font-family-mono)" }}>
              {regFailed ? t("kernel.fetchFailed") : (latest ?? t("common.loading"))}
            </span>
            <button onClick={() => void refresh()} disabled={checking} style={{ ...kernelBtn(false), padding: "2px var(--spacing-sm)", fontSize: "var(--font-size-sm)", whiteSpace: "nowrap" }}>
              {checking ? t("common.checking") : t("kernel.checkUpdate")}
            </button>
          </div>
          <InfoRow
            label={t("kernel.status")}
            value={
              !status?.available
                ? `${t("common.notInstalled")}${status?.error ? `:${status.error}` : ""}`
                : latest && current === latest
                  ? t("kernel.upToDate")
                  : latest && current && current !== latest
                    ? t("kernel.newAvailable")
                    : t("common.unknown")
            }
          />
        </div>

        {/* 右列:安装/切换版本 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderLeft: "1px solid var(--color-border)", paddingLeft: "var(--spacing-xl)" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{t("kernel.installSwitch")}</h3>
            <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
              {isUpgrade && <span style={{ color: "var(--color-accent.success)" }}> {t("kernel.willUpgrade", { current, target: targetVersion })}</span>}
              {isDowngrade && <span style={{ color: "var(--color-accent.warning)" }}> {t("kernel.willDowngrade", { current, target: targetVersion })}</span>}
              {isSame && <span style={{ color: "var(--color-muted)" }}> {t("kernel.currentVersion")}</span>}
              {!current && targetVersion && <span style={{ color: "var(--color-accent.success)" }}> {t("kernel.willInstall", { target: targetVersion })}</span>}
            </p>
          </div>
          <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
            <select
              value={targetVersion}
              onChange={(e) => setTargetVersion(e.target.value)}
              disabled={installing || !registry}
              style={{
                padding: "var(--spacing-xs) var(--spacing-sm)",
                border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
                background: "var(--color-surface)", color: "var(--color-fg)",
                fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
              }}
            >
              {registry?.versions.slice().reverse().map((v) => (
                <option key={v} value={v}>{v}{v === latest ? ` (${t("common.latest")})` : ""}{v === current ? ` (${t("common.installed")})` : ""}</option>
              ))}
            </select>
            <button onClick={() => void install()} disabled={installing || !targetVersion || isSame} style={kernelBtn(true, installing || !targetVersion || isSame)}>
              {installing ? t("common.installing") : isSame ? t("kernel.currentVersion") : isDowngrade ? t("kernel.downgradeThis") : isUpgrade ? t("kernel.upgradeThis") : t("kernel.installThis")}
            </button>
          </div>
          {(installing || installOutput.length > 0 || installResult) && (
            <div>
              <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-xs)" }}>{t("kernel.installOutput")}</div>
              <pre style={{
                background: "var(--color-surface)", border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)", padding: "var(--spacing-sm) var(--spacing-md)",
                fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
                color: "var(--color-fg)", maxHeight: "240px", overflowY: "auto", margin: 0, whiteSpace: "pre-wrap",
              }}>
                {installOutput.join("\n")}
                {installing && "…"}
                {installResult && (
                  <div style={{ marginTop: "var(--spacing-xs)", color: installResult.ok ? "var(--color-accent.success)" : "var(--color-accent.error)" }}>
                    {installResult.ok ? `✓ 安装完成 → ~/.pi-desktop/pi (${targetVersion})` : `✗ ${installResult.error}`}
                  </div>
                )}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============ 下区:pi 配置(框架驱动:config/onChange,不再自己管 save/dirty)============
function ConfigSection({ refreshSignal, config, onChange }: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  const piSettings = ctx.piSettings;
  const { t } = useTranslation();
  const [schemaFields, setSchemaFields] = useState<{ key: string; type: string }[]>([]);

  useEffect(() => {
    void piSettings.schema().then(setSchemaFields);
  }, [piSettings, refreshSignal]);

  // config 由框架从 settings.json 读了传入;settings.json 的 .d.ts schema 仍单独拉(展示用)
  const settings = config;

  if (!settings) return <div style={{ color: "var(--color-muted)" }}>{t("shell.loading")}</div>;

  const update = (key: string, value: unknown): void => {
    onChange(setPath(settings, key, value)); // 调框架 onChange,框架管 dirty
  };

  const knownKeys = new Set(FIELD_DESCRIPTORS.map((f) => f.key));
  const schemaTopKeys = new Set(schemaFields.map((f) => f.key.split(".")[0]));
  const settingsTopKeys = new Set(Object.keys(settings).filter((k) => !k.startsWith("_")));
  const knownTopKeys = new Set(FIELD_DESCRIPTORS.map((f) => f.key.split(".")[0]));
  const unknownTopKeys = new Set([...schemaTopKeys, ...settingsTopKeys].filter((k) => !knownTopKeys.has(k)));
  const unknownKeys = [...unknownTopKeys];
  const schemaTypeByKey = new Map(schemaFields.map((f) => [f.key, f.type]));
  const unknownNested = schemaFields.filter((f) => !knownKeys.has(f.key)).map((f) => f.key);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      <div>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>{t("kernel.configTitle")}</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          {t("kernel.configDesc")}
        </p>
      </div>

      {FIELD_GROUPS.map((group) => (
        <SettingsSection key={group} title={group}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
            {FIELD_DESCRIPTORS.filter((f) => f.group === group).map((f) => (
              <FieldRow key={f.key} desc={f} value={getPath(settings, f.key)} onChange={(v) => update(f.key, v)} />
            ))}
          </div>
        </SettingsSection>
      ))}

      {(unknownKeys.length > 0 || unknownNested.length > 0) && (
        <SettingsSection title={t("settings.otherFields")}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
            {unknownKeys.map((k) => (
              <UnknownRow key={k} keyName={k} value={settings[k]} onChange={(v) => update(k, v)} />
            ))}
            {unknownNested.map((k) => (
              <UnknownRow key={`nested-${k}`} keyName={k} value={getPath(settings, k)} onChange={(v) => update(k, v)} typeHint={schemaTypeByKey.get(k)} />
            ))}
          </div>
        </SettingsSection>
      )}
    </div>
  );
}

// ============ 共享小组件 ============
function InfoRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }): React.ReactNode {
  return (
    <div style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center", fontSize: "var(--font-size-sm)" }}>
      <span style={{ color: "var(--color-muted)", minWidth: "80px" }}>{label}</span>
      <span style={{ color: highlight ? "var(--color-accent.warning)" : "var(--color-fg)", fontFamily: "var(--font-family-mono)" }}>{value}</span>
    </div>
  );
}

function FieldRow({ desc, value, onChange }: { desc: FieldDescriptor; value: unknown; onChange: (v: unknown) => void }): React.ReactNode {
  const { t } = useTranslation();
  const inputStyle: React.CSSProperties = {
    padding: "var(--spacing-xs) var(--spacing-sm)",
    border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
    background: "var(--color-surface)", color: "var(--color-fg)",
    fontFamily: desc.type === "string[]" || desc.type === "number" ? "var(--font-family-mono)" : "var(--font-family-sans)",
    fontSize: "var(--font-size-sm)", width: "100%", boxSizing: "border-box",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
      <label style={{ fontSize: "var(--font-size-sm)", fontWeight: 500 }}>{desc.label}</label>
      <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{desc.description}</span>
      {desc.type === "boolean" ? (
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", cursor: "pointer" }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{value ? t("common.on") : t("common.off")}{desc.default !== undefined ? `(${t("common.default")} ${desc.default ? t("common.on") : t("common.off")})` : ""}</span>
        </label>
      ) : desc.type === "select" ? (
        <select value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
          {desc.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : desc.type === "number" ? (
        <input type="number" value={(value as number) ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} style={inputStyle} placeholder={desc.default !== undefined ? `${t("common.default")} ${desc.default}` : ""} />
      ) : desc.type === "string[]" ? (
        <input type="text" value={arrToStr(value)} onChange={(e) => onChange(strToArr(e.target.value))} style={inputStyle} />
      ) : (
        <input type="text" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || undefined)} style={inputStyle} />
      )}
    </div>
  );
}

function UnknownRow({ keyName, value, onChange, typeHint }: { keyName: string; value: unknown; onChange: (v: unknown) => void; typeHint?: string }): React.ReactNode {
  const { t } = useTranslation();
  const isBool = typeof value === "boolean" || typeHint === "boolean";
  const isNum = typeof value === "number" || typeHint === "number";
  const isArr = Array.isArray(value) || typeHint?.endsWith("[]");
  const typeLabel = typeHint ?? (isArr ? "array" : typeof value);
  const inputStyle: React.CSSProperties = {
    padding: "var(--spacing-xs) var(--spacing-sm)",
    border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
    background: "var(--color-surface)", color: "var(--color-fg)",
    fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
    width: "100%", boxSizing: "border-box",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
      <label style={{ fontSize: "var(--font-size-sm)", fontWeight: 500, fontFamily: "var(--font-family-mono)" }}>{keyName}</label>
      <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("kernel.unknownField", { type: typeLabel })}</span>
      {isBool ? (
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        </label>
      ) : isNum ? (
        <input type="number" value={(value as number) ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} style={inputStyle} />
      ) : isArr ? (
        <input type="text" value={arrToStr(value)} onChange={(e) => onChange(strToArr(e.target.value))} style={inputStyle} />
      ) : (
        <input type="text" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || undefined)} style={inputStyle} />
      )}
    </div>
  );
}

function kernelBtn(primary: boolean, disabled = false): React.CSSProperties {
  return {
    padding: "var(--spacing-xs) var(--spacing-md)",
    border: `1px solid ${primary ? "var(--color-primary)" : "var(--color-border)"}`,
    borderRadius: "var(--radius-sm)",
    background: primary ? "var(--color-primary)" : "transparent",
    color: primary ? "var(--color-primary-fg)" : "var(--color-fg)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)",
    opacity: disabled ? 0.5 : 1,
  };
}
