// pi-settings 插件 renderer —— pi 底座配置编辑页(方案 D)。
//
// 读 ~/.pi/agent/settings.json(经 pi.piSettings.get),按字段描述表渲染:
// - 描述表里 24 项:label + 说明 + 类型 + 枚举 + 默认(预设说明)
// - settings.json 有但描述表没有的字段:降级"未知字段(类型推断,值)"展示,不丢
// - 底座升级加字段自动以"未知"出现,说明等后续补
//
// 改值经 pi.piSettings.set(patch) 写回(深合并,不整替)。
// ⚠ 偏离文档(标注):写底座配置 ~/.pi/agent/settings.json,文档说壳不替底座管配置,
// 但 settings.json 是底座标准契约,写标准字段不算重复领域知识。用户明确要编辑 pi 所有配置。
//
// 纯 renderer 插件,贡献 settings 槽一项(component=PiSettingsPage),经 @pi-desktop/react。
import { useEffect, useState } from "react";
import { registerSettingsComponent, usePiApi } from "@pi-desktop/react";
import { FIELD_DESCRIPTORS, FIELD_GROUPS, DESCRIPTOR_BY_KEY, type FieldDescriptor } from "../field-descriptors";

registerSettingsComponent("PiSettingsPage", PiSettingsPage);

/** 取嵌套值(obj.a.b → 沿路径取)。 */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

/** 按点路径设嵌套值(返回新对象)。 */
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

/** string[] 字段在 UI 用逗号分隔字符串,双向转换。 */
function arrToStr(v: unknown): string {
  return Array.isArray(v) ? v.join(", ") : (v as string) ?? "";
}
function strToArr(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

export function PiSettingsPage(): React.ReactNode {
  const pi = usePiApi();
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void pi.piSettings.get().then(setSettings);
  }, [pi]);

  if (!settings) return <div style={{ padding: "var(--spacing-xl)", color: "var(--color-muted)" }}>加载中…</div>;

  const update = (key: string, value: unknown): void => {
    setSettings((prev) => (prev ? setPath(prev, key, value) : prev));
    setDirty(true);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const next = await pi.piSettings.set(settings);
      setSettings(next);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  // 找出 settings.json 有但描述表没有的字段(未知字段兜底)
  const knownTopKeys = new Set(FIELD_DESCRIPTORS.map((f) => f.key.split(".")[0]));
  const unknownKeys = Object.keys(settings).filter((k) => !knownTopKeys.has(k) && !k.startsWith("_"));

  return (
    <div style={{ height: "100%", padding: "var(--spacing-xl)", overflowY: "auto", display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      <div>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>Pi 配置</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          编辑 pi 底座配置(<code style={{ fontFamily: "var(--font-family-mono)" }}>~/.pi/agent/settings.json</code>)。常用 24 项有说明,其余字段自动展示(底座升级新字段不丢)。
        </p>
      </div>

      {/* 按 group 分块渲染 24 项 */}
      {FIELD_GROUPS.map((group) => (
        <div key={group}>
          <h3 style={{ margin: "0 0 var(--spacing-sm)", fontSize: "var(--font-size-base)", fontWeight: 600, color: "var(--color-fg)" }}>{group}</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
            {FIELD_DESCRIPTORS.filter((f) => f.group === group).map((f) => (
              <FieldRow key={f.key} desc={f} value={getPath(settings, f.key)} onChange={(v) => update(f.key, v)} />
            ))}
          </div>
        </div>
      ))}

      {/* 未知字段兜底(settings.json 有但描述表没有) */}
      {unknownKeys.length > 0 && (
        <div>
          <h3 style={{ margin: "0 0 var(--spacing-sm)", fontSize: "var(--font-size-base)", fontWeight: 600, color: "var(--color-muted)" }}>
            其他字段(自动展示,无预设说明)
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
            {unknownKeys.map((k) => (
              <UnknownRow key={k} keyName={k} value={settings[k]} onChange={(v) => update(k, v)} />
            ))}
          </div>
        </div>
      )}

      {/* 保存栏 */}
      <div style={{ position: "sticky", bottom: 0, background: "var(--color-bg)", padding: "var(--spacing-sm) 0", borderTop: "1px solid var(--color-border)" }}>
        <button onClick={() => void save()} disabled={!dirty || saving} style={btnStyle(true, !dirty || saving)}>
          {saving ? "保存中…" : dirty ? "保存改动" : "无改动"}
        </button>
      </div>
    </div>
  );
}

function FieldRow({ desc, value, onChange }: { desc: FieldDescriptor; value: unknown; onChange: (v: unknown) => void }): React.ReactNode {
  const inputStyle: React.CSSProperties = {
    padding: "var(--spacing-xs) var(--spacing-sm)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    background: "var(--color-surface)",
    color: "var(--color-fg)",
    fontFamily: desc.type === "string[]" || desc.type === "number" ? "var(--font-family-mono)" : "var(--font-family-sans)",
    fontSize: "var(--font-size-sm)",
    width: "100%",
    boxSizing: "border-box",
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

function UnknownRow({ keyName, value, onChange }: { keyName: string; value: unknown; onChange: (v: unknown) => void }): React.ReactNode {
  const isBool = typeof value === "boolean";
  const isNum = typeof value === "number";
  const isArr = Array.isArray(value);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
      <label style={{ fontSize: "var(--font-size-sm)", fontWeight: 500, fontFamily: "var(--font-family-mono)" }}>{keyName}</label>
      <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>未知字段(类型 {isArr ? "array" : typeof value})</span>
      {isBool ? (
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
          <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
        </label>
      ) : isNum ? (
        <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} style={rowInputStyle()} />
      ) : isArr ? (
        <input type="text" value={arrToStr(value)} onChange={(e) => onChange(strToArr(e.target.value))} style={rowInputStyle()} />
      ) : (
        <input type="text" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || undefined)} style={rowInputStyle()} />
      )}
    </div>
  );
}

function rowInputStyle(): React.CSSProperties {
  return {
    padding: "var(--spacing-xs) var(--spacing-sm)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    background: "var(--color-surface)",
    color: "var(--color-fg)",
    fontFamily: "var(--font-family-mono)",
    fontSize: "var(--font-size-sm)",
    width: "100%",
    boxSizing: "border-box",
  };
}

function btnStyle(primary: boolean, disabled = false): React.CSSProperties {
  return {
    padding: "var(--spacing-xs) var(--spacing-md)",
    border: `1px solid ${primary ? "var(--color-primary)" : "var(--color-border)"}`,
    borderRadius: "var(--radius-sm)",
    background: primary ? "var(--color-primary)" : "transparent",
    color: primary ? "var(--color-primary-fg)" : "var(--color-fg)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "var(--font-family-sans)",
    fontSize: "var(--font-size-sm)",
    opacity: disabled ? 0.5 : 1,
  };
}
