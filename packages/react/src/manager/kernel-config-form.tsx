// packages/react 内核管理共享 base —— 「内核原生配置」通用表单(kernel 配置 TAB 用)。
//
// 字段名 + 类型从内核来(api.fields(),pi 解析 .d.ts / dsh 为空),label/description/group/
// 选项文案是壳的 i18n key,由本组件 t() 解析。本组件把**通用数据型**映射成控件:
//   boolean→开关 / number→数字 / string→文本 / string[]→列表 / enum→下拉 / object→可编辑 JSON。
// 不含内核身份分支;字段清单空(如 dsh)时,按值递归推断类型:嵌套对象展平成叶子控件
// (命名空间→子字段),只有真正无法结构化的叶子(空对象/对象数组)才落到可编辑 JSON。
//
// 数据/保存走框架:config 由 SettingsPage 注入(manifest kernelConfig 的 kernelConfig[kernel].get()),
// 改动经 onChange 上报、框架顶部保存浮层落盘(kernelConfig[kernel].set())。本组件不自己 set。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "../settings-section";
import { Select } from "../widgets/select";
import type { KernelConfigApi, KernelConfigField } from "@my-harness-desktop/shared";

export interface KernelConfigFormProps {
  api: KernelConfigApi;
  /** 框架注入的全量配置(中性 JSON)。 */
  config: Record<string, unknown> | null;
  /** 改动上报(框架置 dirty + 顶部保存浮层)。 */
  onChange: (config: Record<string, unknown>) => void;
  /** 刷新信号(框架刷新按钮),重拉字段清单。 */
  refreshSignal?: number;
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

const inputStyle: React.CSSProperties = {
  padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)", color: "var(--color-fg)",
  fontSize: "var(--font-size-sm)", width: "100%", boxSizing: "border-box",
};

export function KernelConfigForm({ api, config, onChange, refreshSignal = 0 }: KernelConfigFormProps): React.ReactNode {
  const { t } = useTranslation();
  const [fields, setFields] = useState<KernelConfigField[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api.fields().then((f) => { if (!cancelled) setFields(f); });
    return () => { cancelled = true; };
  }, [api, refreshSignal]);

  if (!config) return <div style={{ color: "var(--color-muted)" }}>{t("shell.loading", { defaultValue: "Loading…" })}</div>;

  const update = (key: string, value: unknown): void => onChange(setPath(config, key, value));

  // 分组(保序):group 是 i18n key,按 group 归组,无 group 的进「其他」。
  const groups: string[] = [];
  const grouped = new Map<string, KernelConfigField[]>();
  for (const f of fields) {
    const g = f.group ?? "其他";
    if (!grouped.has(g)) { grouped.set(g, []); groups.push(g); }
    grouped.get(g)!.push(f);
  }

  // config 里字段清单未覆盖的顶层键 → 兜底渲染(按值递归推断类型:对象下钻到叶子,标量/数组映射控件)。
  const unknownTopKeys = Object.keys(config).filter((k) => !k.startsWith("_") && !fields.some((f) => f.key === k || f.key.startsWith(`${k}.`)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
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
              <InferredField key={k} name={k} path={k} value={config[k]} onSet={update} />
            ))}
          </div>
        </SettingsSection>
      )}
    </div>
  );
}

function FieldRow({ field, value, onChange }: { field: KernelConfigField; value: unknown; onChange: (v: unknown) => void }): React.ReactNode {
  const { t } = useTranslation();
  const label = t(field.label ?? field.key, { defaultValue: field.key });
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
          </span>
        </label>
      ) : field.type === "enum" ? (
        <Select value={(value as string) ?? ""} onChange={onChange} style={{ width: "100%" }}>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{t(o.label ?? o.value, { defaultValue: o.value })}</option>
          ))}
        </Select>
      ) : field.type === "number" ? (
        <input type="number" value={(value as number) ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} style={inputStyle} />
      ) : field.type === "string[]" ? (
        <StringListInput value={value} onChange={onChange} />
      ) : field.type === "object" ? (
        <JsonInput value={value} onChange={onChange} />
      ) : (
        <input type="text" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || undefined)} style={inputStyle} />
      )}
    </div>
  );
}

// 可编辑 JSON 编辑器:object 型字段 + 未知兜底字段用。失焦时 JSON.parse 合法才提交,非法回显错误。
function JsonInput({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }): React.ReactNode {
  // JSON.stringify(undefined) 返回 undefined(非字符串)——未设值字段会让 draft 为 undefined,
  // 渲染期 draft.split 直接炸设置页;空草稿表示「未设值」,提交空串回写 undefined 保持语义。
  const toDraft = (v: unknown): string => JSON.stringify(v, null, 2) ?? "";
  const [draft, setDraft] = useState(() => toDraft(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(toDraft(value)); setError(null); }, [value]);
  const commit = (): void => {
    if (draft.trim() === "") {
      onChange(undefined);
      setError(null);
      return;
    }
    try {
      onChange(JSON.parse(draft));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        rows={Math.min(10, draft.split("\n").length + 1)}
        style={{ ...inputStyle, fontFamily: "var(--font-family-mono)", resize: "vertical", minHeight: "60px" }}
      />
      {error && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-accent-error)" }}>{error}</span>}
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

// 字段清单未覆盖的键:按值递归推断类型。纯对象 → 下钻到叶子(命名空间→子字段);
// 标量 / 字符串数组 → 对应控件;空对象 / 对象数组(无法结构化)→ 可编辑 JSON。
// 这是 dsh 无 schema 时的通用兜底:settings.yaml 的「命名空间 → 嵌套对象」形状被展平成
// 叶子表单,而不是每个命名空间糊成一个 JSON textarea(根因修复:原 UnknownRow 只做单层
// 推断,`typeof value === "object"` 一律甩 JSON,和 dsh 的对象套对象形状打架)。
function InferredField({ name, path, value, onSet }: {
  name: string;
  /** 完整 dotted 路径(顶层键 = 自身;叶子 = 如 ui-onboarding.welcomeNoticeVersion)。 */
  path: string;
  value: unknown;
  onSet: (path: string, value: unknown) => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const isBool = typeof value === "boolean";
  const isNum = typeof value === "number";
  const isStrArr = Array.isArray(value) && value.every((v) => typeof v === "string");
  const isPlainObj = value !== null && typeof value === "object" && !Array.isArray(value);
  const childEntries = isPlainObj ? Object.entries(value as Record<string, unknown>) : [];
  // 无法结构化的叶子:空对象(无子可下钻)、对象数组(每项结构各异,列表编辑器不通用)。
  const isComplexLeaf = (isPlainObj && childEntries.length === 0) || (Array.isArray(value) && !isStrArr);

  const labelStyle: React.CSSProperties = {
    fontSize: "var(--font-size-sm)", fontWeight: 500, fontFamily: "var(--font-family-mono)",
  };

  if (isPlainObj && childEntries.length > 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
        <span style={{ ...labelStyle, fontWeight: 600 }}>{name}</span>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)", paddingLeft: "var(--spacing-md)", borderLeft: "1px solid var(--color-border)" }}>
          {childEntries.map(([k, v]) => (
            <InferredField key={k} name={k} path={`${path}.${k}`} value={v} onSet={onSet} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
      <label style={labelStyle}>{name}</label>
      {isComplexLeaf ? (
        <JsonInput value={value} onChange={(v) => onSet(path, v)} />
      ) : isBool ? (
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", cursor: "pointer" }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onSet(path, e.target.checked)} />
          <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
            {value ? t("common.on", { defaultValue: "on" }) : t("common.off", { defaultValue: "off" })}
          </span>
        </label>
      ) : isNum ? (
        <input type="number" value={(value as number) ?? ""} onChange={(e) => onSet(path, e.target.value === "" ? undefined : Number(e.target.value))} style={inputStyle} />
      ) : isStrArr ? (
        <StringListInput value={value} onChange={(v) => onSet(path, v)} />
      ) : (
        <input type="text" value={(value as string) ?? ""} onChange={(e) => onSet(path, e.target.value || undefined)} style={inputStyle} />
      )}
    </div>
  );
}
