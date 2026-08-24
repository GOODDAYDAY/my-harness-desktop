// packages/react 内核管理共享 base —— 「内核原生配置」schema 驱动表单(kernel 配置 TAB 用)。
//
// 与 KernelVersionPage / ModelConfigPage 同构:内核交「字段 schema」(KernelConfigField[]),
// 本组件把它渲成 typed 控件(boolean→开关 / select→下拉 / string[]→列表 / kv→定键数字 /
// json→只读 JSON)。config 数据走框架(config/onChange 受控),字段元数据走 api.schema()。
// 不含任何内核身份分支——pi/dsh 各自经适配器翻译字段,本组件只认中性 KernelConfigField。
//
// 数据/保存走框架:config 由 SettingsPage 注入(经 manifest kernelConfig 声明的 kernelConfig[kernel]
// .get()),改动经 onChange 上报、框架顶部保存浮层落盘(kernelConfig[kernel].set())。本组件不自己 set。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "../settings-section";
import { Select } from "../widgets/select";
import type { KernelConfigApi, KernelConfigField } from "@my-harness-desktop/contract";

export interface KernelConfigFormProps {
  api: KernelConfigApi;
  /** 框架注入的全量配置(中性 JSON)。 */
  config: Record<string, unknown> | null;
  /** 改动上报(框架置 dirty + 顶部保存浮层)。 */
  onChange: (config: Record<string, unknown>) => void;
  /** 刷新信号(框架刷新按钮),重拉 schema。 */
  refreshSignal?: number;
  /** i18n key 前缀(如 "kernel" / "dsh"):头部标题/说明/兜底分组都从它派生,内核无关。 */
  i18nPrefix: string;
}

// ---- 点路径读写(flat key 如 compaction.enabled)----
function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]), obj);
}
function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const out = structuredClone(obj);
  const keys = path.split(".");
  let cur = out;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const nxt = cur[k];
    if (typeof nxt !== "object" || nxt === null || Array.isArray(nxt)) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  if (value === undefined) delete cur[keys[keys.length - 1]];
  else cur[keys[keys.length - 1]] = value;
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const inputStyle: React.CSSProperties = {
  padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)", color: "var(--color-fg)",
  fontSize: "var(--font-size-sm)", width: "100%", boxSizing: "border-box",
};

export function KernelConfigForm({ api, config, onChange, refreshSignal = 0, i18nPrefix }: KernelConfigFormProps): React.ReactNode {
  const { t } = useTranslation();
  const [fields, setFields] = useState<KernelConfigField[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api.schema().then((f) => { if (!cancelled) setFields(f); });
    return () => { cancelled = true; };
  }, [api, refreshSignal]);

  if (!config) return <div style={{ color: "var(--color-muted)" }}>{t("shell.loading", { defaultValue: "Loading…" })}</div>;

  const update = (key: string, value: unknown): void => onChange(setPath(config, key, value));

  // 分组(保序):group 是 i18n key,按 group 归组,无 group 的进「其他」。
  const groups: string[] = [];
  const grouped = new Map<string, KernelConfigField[]>();
  for (const f of fields) {
    const g = f.group ?? `${i18nPrefix}.groups.other`;
    if (!grouped.has(g)) { grouped.set(g, []); groups.push(g); }
    grouped.get(g)!.push(f);
  }

  // config 里 schema 未覆盖的顶层/嵌套键 → 兜底渲染(底座升级加字段不丢)。
  const unknownTopKeys = Object.keys(config).filter((k) => !k.startsWith("_") && !fields.some((f) => f.key === k || f.key.startsWith(`${k}.`)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      <div>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>{t(`${i18nPrefix}.configTitle`, { defaultValue: "Config" })}</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          {t(`${i18nPrefix}.configDesc`, { defaultValue: "Edit the kernel native config as JSON." })}
        </p>
      </div>

      {groups.map((group) => (
        <SettingsSection key={group} title={t(group, { defaultValue: group })}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
            {(grouped.get(group) ?? []).map((f) => (
              <FieldRow key={f.key} field={f} value={getPath(config, f.key)} onChange={(v) => update(f.key, v)} />
            ))}
          </div>
        </SettingsSection>
      ))}

      {unknownTopKeys.length > 0 && (
        <SettingsSection title={t("settings.otherFields", { defaultValue: "Other" })}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
            {unknownTopKeys.map((k) => (
              <UnknownRow key={k} keyName={k} value={config[k]} onChange={(v) => update(k, v)} />
            ))}
          </div>
        </SettingsSection>
      )}
    </div>
  );
}

function FieldRow({ field, value, onChange }: { field: KernelConfigField; value: unknown; onChange: (v: unknown) => void }): React.ReactNode {
  const { t } = useTranslation();
  const label = field.label ? t(field.label, { defaultValue: field.key }) : field.key;
  const desc = field.description ? t(field.description, { defaultValue: "" }) : "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
      <label style={{ fontSize: "var(--font-size-sm)", fontWeight: 500 }}>{label}</label>
      {desc && <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{desc}</span>}
      {field.type === "boolean" ? (
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", cursor: "pointer" }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
            {value ? t("common.on", { defaultValue: "on" }) : t("common.off", { defaultValue: "off" })}
            {field.default !== undefined ? ` (${t("common.default", { defaultValue: "default" })} ${field.default ? t("common.on", { defaultValue: "on" }) : t("common.off", { defaultValue: "off" })})` : ""}
          </span>
        </label>
      ) : field.type === "select" ? (
        <Select value={(value as string) ?? ""} onChange={onChange} style={{ width: "100%" }}>
          {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      ) : field.type === "number" ? (
        <input type="number" value={(value as number) ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} style={inputStyle} placeholder={field.default !== undefined ? `${t("common.default", { defaultValue: "default" })} ${field.default}` : ""} />
      ) : field.type === "string[]" ? (
        <StringListInput value={value} onChange={onChange} />
      ) : field.type === "kv" ? (
        <KvFixedInput value={value} kvKeys={field.kvKeys ?? []} onChange={onChange} />
      ) : field.type === "json" ? (
        <ReadonlyJsonPreview value={value} />
      ) : (
        <input type="text" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || undefined)} style={inputStyle} />
      )}
    </div>
  );
}

// object/异构数组只读预览(替代旧 string input 分支——那分支把对象当字符串渲染并静默覆盖)。
function ReadonlyJsonPreview({ value }: { value: unknown }): React.ReactNode {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
      <pre style={{
        background: "var(--color-surface)", border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-sm)", padding: "var(--spacing-sm) var(--spacing-md)",
        fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
        color: "var(--color-fg)", margin: 0, maxHeight: "160px", overflowY: "auto",
        whiteSpace: "pre-wrap", wordBreak: "break-all",
      }}>
        {value === undefined ? "(undefined)" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function StringListInput({ value, onChange }: { value: unknown; onChange: (next: unknown[]) => void }): React.ReactNode {
  const items: unknown[] = Array.isArray(value) ? value : [];
  const [draft, setDraft] = useState("");
  const add = (): void => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onChange([...items, trimmed]);
    setDraft("");
  };
  const removeAt = (idx: number): void => onChange(items.filter((_, i) => i !== idx));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
      {items.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-xs)" }}>
          {items.map((item, idx) => {
            const isObj = typeof item === "object" && item !== null;
            const text = isObj ? ((item as Record<string, unknown>).source as string) ?? JSON.stringify(item) : String(item);
            return (
              <span key={idx} style={{ display: "inline-flex", alignItems: "center", gap: "var(--spacing-xs)", padding: "2px var(--spacing-xs) 2px var(--spacing-sm)", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)", color: "var(--color-fg)" }}>
                <span>{text}</span>
                <button type="button" onClick={() => removeAt(idx)} aria-label="remove" style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", color: "var(--color-muted)", fontSize: "var(--font-size-sm)", lineHeight: 1 }}>×</button>
              </span>
            );
          })}
        </div>
      )}
      <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} style={inputStyle} />
    </div>
  );
}

function KvFixedInput({ value, kvKeys, onChange }: { value: unknown; kvKeys: string[]; onChange: (next: Record<string, unknown> | undefined) => void }): React.ReactNode {
  const obj: Record<string, unknown> = isPlainObject(value) ? value : {};
  const setKey = (k: string, v: number | undefined): void => {
    const next = { ...obj };
    if (v === undefined) delete next[k]; else next[k] = v;
    onChange(Object.keys(next).length > 0 ? next : undefined);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
      {kvKeys.map((k) => (
        <div key={k} style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center" }}>
          <span style={{ minWidth: "80px", fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{k}</span>
          <input type="number" value={(obj[k] as number) ?? ""} onChange={(e) => setKey(k, e.target.value === "" ? undefined : Number(e.target.value))} style={{ ...inputStyle, flex: 1, fontFamily: "var(--font-family-mono)" }} />
        </div>
      ))}
    </div>
  );
}

// schema 未覆盖的顶层键:按值形状推断控件(boolean/number/string[]/object)。object 只读。
function UnknownRow({ keyName, value, onChange }: { keyName: string; value: unknown; onChange: (v: unknown) => void }): React.ReactNode {
  const isBool = typeof value === "boolean";
  const isNum = typeof value === "number";
  const isStrArr = Array.isArray(value) && value.every((v) => typeof v === "string");
  const isComplex = isPlainObject(value) || (Array.isArray(value) && value.some((v) => typeof v === "object" && v !== null));
  const typeLabel = Array.isArray(value) ? "array" : typeof value;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
      <label style={{ fontSize: "var(--font-size-sm)", fontWeight: 500, fontFamily: "var(--font-family-mono)" }}>{keyName}</label>
      {isComplex ? (
        <ReadonlyJsonPreview value={value} />
      ) : isBool ? (
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        </label>
      ) : isNum ? (
        <input type="number" value={(value as number) ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} style={inputStyle} />
      ) : isStrArr ? (
        <StringListInput value={value} onChange={onChange} />
      ) : (
        <input type="text" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || undefined)} style={inputStyle} />
      )}
      <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>{typeLabel}</span>
    </div>
  );
}
