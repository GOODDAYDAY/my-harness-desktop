// pi-manager 插件 renderer —— Pi 管理(内核版本 + 配置,上下分区)。
//
// 合并 pi-kernel-manager + pi-settings(高内聚:一个插件管 pi 底座所有事)。
// 上区:内核版本管理(原 KernelSettings:版本信息 + 安装/切换版本)
// 下区:pi 配置(原 PiSettingsPage:24 项描述 + 未知字段兜底)
//
// 接受 refreshSignal prop(框架刷新按钮触发 +1,useEffect 依赖它重拉)。
// 经 @pi-desktop/react 受控 API(守薄壳:不直连 shell)。
import { useEffect, useState } from "react";
import { registerSettingsComponent, usePiApi, type SettingsComponentProps } from "@pi-desktop/react";
import { FIELD_DESCRIPTORS, FIELD_GROUPS, DESCRIPTOR_BY_KEY, type FieldDescriptor } from "../field-descriptors";

registerSettingsComponent("PiManagerPage", PiManagerPage);

// ---- 工具(从两个原组件搬)----
function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);
}
function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const out = { ...obj };
  const keys = path.split(".");
  let cur: Record<string, unknown> = out;
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = { ...(cur[keys[i]] as Record<string, unknown> ?? {}) };
    cur = cur[keys[i]] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
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
    <div style={{ height: "100%", overflowY: "auto", padding: "var(--spacing-xl)" }}>
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

function KernelSection({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const pi = usePiApi();
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [registry, setRegistry] = useState<{ versions: string[]; latest: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [targetVersion, setTargetVersion] = useState<string>("");
  const [installing, setInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string[]>([]);
  const [installResult, setInstallResult] = useState<{ ok: boolean; error: string | null } | null>(null);

  // 启动 + refreshSignal 变 → 拉当前状态 + registry
  useEffect(() => {
    void pi.kernel.status().then(setStatus);
    void pi.kernel.listVersions().then((r) => {
      setRegistry(r);
      setTargetVersion((prev) => prev || r.latest || "");
    });
  }, [pi, refreshSignal]);

  const refresh = async (): Promise<void> => {
    setChecking(true);
    try {
      const r = await pi.kernel.listVersions(true);
      setRegistry(r);
    } finally {
      setChecking(false);
    }
  };

  const install = async (): Promise<void> => {
    if (!targetVersion) return;
    setInstalling(true);
    setInstallOutput([]);
    setInstallResult(null);
    const r = await pi.kernel.install(
      targetVersion,
      (line) => setInstallOutput((prev) => [...prev, line]),
      (done) => {
        setInstalling(false);
        setInstallResult(done);
        if (done.ok) {
          void pi.kernel.status().then(setStatus);
          void pi.kernel.listVersions(true).then(setRegistry);
        }
      },
    );
    if (!r.ok && !installResult) {
      setInstalling(false);
      setInstallResult(r);
    }
  };

  const current = status?.currentVersion ?? null;
  const latest = registry?.latest ?? null;
  const isDowngrade = !!(current && targetVersion && current > targetVersion);
  const isUpgrade = !!(current && targetVersion && current < targetVersion);
  const isSame = !!(current && targetVersion && current === targetVersion);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      <div>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>Pi 内核版本管理</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          只维护 <code style={{ fontFamily: "var(--font-family-mono)" }}>~/.pi-desktop/pi</code> 这一份 pi。选版本安装(装新=更新、装旧=降级),桌面端不碰 PATH 的 pi。
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: "var(--spacing-xl)", alignItems: "start" }}>
        {/* 左列:版本信息 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
          <InfoRow label="已装版本" value={current ?? (status?.available ? "未知" : "未安装")} />
          <div style={{ display: "flex", gap: "var(--spacing-sm)", fontSize: "var(--font-size-sm)" }}>
            <span style={{ color: "var(--color-muted)", minWidth: "80px" }}>最新版本</span>
            <span style={{ color: !!(latest && current && current !== latest) ? "var(--color-accent.warning)" : "var(--color-fg)", fontFamily: "var(--font-family-mono)" }}>
              {latest ?? "加载中…"}
            </span>
            <button onClick={() => void refresh()} disabled={checking} style={{ ...kernelBtn(false), padding: "2px var(--spacing-sm)", fontSize: "var(--font-size-sm)" }}>
              {checking ? "检查中…" : "检查更新"}
            </button>
          </div>
          <InfoRow
            label="状态"
            value={
              !status?.available
                ? `未安装${status?.error ? `:${status.error}` : ""}`
                : latest && current === latest
                  ? "已是最新"
                  : latest && current && current !== latest
                    ? "有新版本可选装"
                    : "未知"
            }
          />
        </div>

        {/* 右列:安装/切换版本 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderLeft: "1px solid var(--color-border)", paddingLeft: "var(--spacing-xl)" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>安装/切换版本</h3>
            <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
              选目标版本 → 安装(覆盖 <code style={{ fontFamily: "var(--font-family-mono)" }}>~/.pi-desktop/pi</code>):
              {isUpgrade && <span style={{ color: "var(--color-accent.success)" }}> 将升级 {current} → {targetVersion}</span>}
              {isDowngrade && <span style={{ color: "var(--color-accent.warning)" }}> 将降级 {current} → {targetVersion}</span>}
              {isSame && <span style={{ color: "var(--color-muted)" }}> 已是当前版本</span>}
              {!current && targetVersion && <span style={{ color: "var(--color-accent.success)" }}> 将安装 {targetVersion}</span>}
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
                <option key={v} value={v}>{v}{v === latest ? " (最新)" : ""}{v === current ? " (已装)" : ""}</option>
              ))}
            </select>
            <button onClick={() => void install()} disabled={installing || !targetVersion || isSame} style={kernelBtn(true, installing || !targetVersion || isSame)}>
              {installing ? "安装中…" : isSame ? "已是当前版本" : isDowngrade ? "降级到该版本" : isUpgrade ? "升级到该版本" : "安装该版本"}
            </button>
          </div>
          {(installing || installOutput.length > 0 || installResult) && (
            <div>
              <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-xs)" }}>安装输出</div>
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
  const pi = usePiApi();
  const [schemaFields, setSchemaFields] = useState<{ key: string; type: string }[]>([]);

  useEffect(() => {
    void pi.piSettings.schema().then(setSchemaFields);
  }, [pi, refreshSignal]);

  // config 由框架从 settings.json 读了传入;settings.json 的 .d.ts schema 仍单独拉(展示用)
  const settings = config;

  if (!settings) return <div style={{ color: "var(--color-muted)" }}>加载中…</div>;

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
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>Pi 配置</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          编辑 pi 底座配置(<code style={{ fontFamily: "var(--font-family-mono)" }}>~/.pi/agent/settings.json</code>)。常用 24 项有说明,其余字段自动展示(底座升级新字段不丢)。
        </p>
      </div>

      {FIELD_GROUPS.map((group) => (
        <div key={group} style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--spacing-md)", background: "var(--color-surface)" }}>
          <h3 style={{ margin: "0 0 var(--spacing-sm)", fontSize: "var(--font-size-base)", fontWeight: 600 }}>{group}</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
            {FIELD_DESCRIPTORS.filter((f) => f.group === group).map((f) => (
              <FieldRow key={f.key} desc={f} value={getPath(settings, f.key)} onChange={(v) => update(f.key, v)} />
            ))}
          </div>
        </div>
      ))}

      {(unknownKeys.length > 0 || unknownNested.length > 0) && (
        <div>
          <h3 style={{ margin: "0 0 var(--spacing-sm)", fontSize: "var(--font-size-base)", fontWeight: 600, color: "var(--color-muted)" }}>
            其他字段(底座 .d.ts 解析 + settings.json 实际,自动展示无预设说明)
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
            {unknownKeys.map((k) => (
              <UnknownRow key={k} keyName={k} value={settings[k]} onChange={(v) => update(k, v)} />
            ))}
            {unknownNested.map((k) => (
              <UnknownRow key={`nested-${k}`} keyName={k} value={getPath(settings, k)} onChange={(v) => update(k, v)} typeHint={schemaTypeByKey.get(k)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============ 共享小组件 ============
function InfoRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }): React.ReactNode {
  return (
    <div style={{ display: "flex", gap: "var(--spacing-md)", fontSize: "var(--font-size-sm)" }}>
      <span style={{ color: "var(--color-muted)", minWidth: "80px" }}>{label}</span>
      <span style={{ color: highlight ? "var(--color-accent.warning)" : "var(--color-fg)", fontFamily: "var(--font-family-mono)" }}>{value}</span>
    </div>
  );
}

function FieldRow({ desc, value, onChange }: { desc: FieldDescriptor; value: unknown; onChange: (v: unknown) => void }): React.ReactNode {
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
          <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{value ? "开" : "关"}{desc.default !== undefined ? `(默认 ${desc.default ? "开" : "关"})` : ""}</span>
        </label>
      ) : desc.type === "select" ? (
        <select value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
          {desc.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : desc.type === "number" ? (
        <input type="number" value={(value as number) ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} style={inputStyle} placeholder={desc.default !== undefined ? `默认 ${desc.default}` : ""} />
      ) : desc.type === "string[]" ? (
        <input type="text" value={arrToStr(value)} onChange={(e) => onChange(strToArr(e.target.value))} style={inputStyle} />
      ) : (
        <input type="text" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || undefined)} style={inputStyle} />
      )}
    </div>
  );
}

function UnknownRow({ keyName, value, onChange, typeHint }: { keyName: string; value: unknown; onChange: (v: unknown) => void; typeHint?: string }): React.ReactNode {
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
      <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>未知字段(类型 {typeLabel})</span>
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
