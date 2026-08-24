// pi-manager 插件 renderer ——「PI 入口」的 TAB 组件入口。
//
// 三个 TAB 的组件都在本插件(合并 pi-kernel-manager + pi-settings + extension-manager + pi-model-manager):
//   PiManagerPage     —— TAB 1「Pi」(内核版本 + 配置),本文件内联
//   ExtensionManagerPage —— TAB 2「PI 拓展」,./extensions.tsx
//   ModelManagerPage  —— TAB 3「模型配置」,./models.tsx
// 经 manifest 的 contributes.settings[].tabs 声明,框架按 component 名自动匹配本入口的 exports。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getProperty, setProperty } from "dot-prop";
import { Button, Select, SettingsSection, KernelVersionPage, type SettingsComponentProps, usePluginContext } from "@my-harness-desktop/react";
import { FIELD_DESCRIPTORS, FIELD_GROUPS, type FieldDescriptor } from "../core/field-descriptors";

// TAB 2 / TAB 3 的组件从各自文件迁入,在此 re-export 供框架按 component 名匹配(§7.4)。
// channels 也要 re-export:框架从入口 module 读 module.channels 注册事件总线,
// 模型默认变更频道在 models.tsx 里声明,不 re-export 则「未被任何插件注册」。
export { ExtensionManagerPage } from "./extensions";
export { ModelManagerPage, channels } from "./models";


// ---- 工具(点路径读写走 dot-prop;setPath 用 structuredClone 保不可变,React state 需新引用)----
function getPath(obj: Record<string, unknown>, path: string): unknown {
  return getProperty(obj, path);
}
function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const out = structuredClone(obj);
  setProperty(out, path, value);
  return out;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ============ PiManagerPage ============
// TAB 1「Pi」：内核版本管理走共享 base（kernel-design-spec.md §12.4），配置表单留在本插件（pi 专属 settings.json schema）。
export function PiManagerPage({ refreshSignal, config, onChange }: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  return (
    <>
      <KernelVersionPage api={ctx.kernels.pi} i18nPrefix="kernel" />
      <div style={{ borderTop: "2px solid var(--color-border)" }} />
      <ConfigSection refreshSignal={refreshSignal} config={config} onChange={onChange} />
    </>
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
  const knownKvFixedTopKeys = new Set(FIELD_DESCRIPTORS.filter((f) => f.type === "kv-fixed").map((f) => f.key));
  const unknownTopKeys = new Set([...schemaTopKeys, ...settingsTopKeys].filter((k) => !knownTopKeys.has(k)));
  const unknownKeys = [...unknownTopKeys];
  const schemaTypeByKey = new Map(schemaFields.map((f) => [f.key, f.type]));
  const unknownNested = schemaFields
    .filter((f) => !knownKeys.has(f.key))
    .map((f) => f.key)
    .filter((k) => {
      const top = k.split(".")[0];
      return !unknownTopKeys.has(top) && !knownKvFixedTopKeys.has(top);
    });

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
              <UnknownRow key={k} keyName={k} value={settings[k]} onChange={(v) => update(k, v)} typeHint={schemaTypeByKey.get(k)} />
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

// object 元素只读展示+仅允许删除(防 packages 这类异构数组被 toString 成 "[object Object]")。
function StringListInput({ value, onChange, addPlaceholder, objectTagLabel }: {
  value: unknown;
  onChange: (next: unknown[]) => void;
  addPlaceholder?: string;
  objectTagLabel: string;
}): React.ReactNode {
  const items: unknown[] = Array.isArray(value) ? value : [];
  const [draft, setDraft] = useState("");
  const add = (): void => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onChange([...items, trimmed]);
    setDraft("");
  };
  const removeAt = (idx: number): void => {
    onChange(items.filter((_, i) => i !== idx));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
      {items.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-xs)" }}>
          {items.map((item, idx) => {
            const isObj = typeof item === "object" && item !== null;
            const text = isObj
              ? ((item as Record<string, unknown>).source as string) ?? JSON.stringify(item)
              : String(item);
            return (
              <span
                key={idx}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "var(--spacing-xs)",
                  padding: "2px var(--spacing-xs) 2px var(--spacing-sm)",
                  background: "var(--color-surface)", border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-sm)",
                  fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
                  color: "var(--color-fg)",
                }}
              >
                <span>{text}</span>
                {isObj && (
                  <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-xs)" }}>{objectTagLabel}</span>
                )}
                <button
                  type="button"
                  onClick={() => removeAt(idx)}
                  aria-label="remove"
                  style={{
                    background: "none", border: "none", cursor: "pointer", padding: "0 2px",
                    color: "var(--color-muted)", fontSize: "var(--font-size-sm)", lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        placeholder={addPlaceholder}
        style={{
          padding: "var(--spacing-xs) var(--spacing-sm)",
          border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
          background: "var(--color-surface)", color: "var(--color-fg)",
          fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
          width: "100%", boxSizing: "border-box",
        }}
      />
    </div>
  );
}

// 留空=删该 key;全空上抛 undefined,整项不写回 settings.json(对齐底座 optional 语义)。
function KvFixedInput({ value, kvKeys, onChange, emptyHint }: {
  value: unknown;
  kvKeys: string[];
  onChange: (next: Record<string, unknown> | undefined) => void;
  emptyHint: string;
}): React.ReactNode {
  const obj: Record<string, unknown> = isPlainObject(value) ? value : {};
  const setKey = (k: string, v: number | undefined): void => {
    const next = { ...obj };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(Object.keys(next).length > 0 ? next : undefined);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
      {kvKeys.map((k) => (
        <div key={k} style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center" }}>
          <span style={{ minWidth: "80px", fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>
            {k}
          </span>
          <input
            type="number"
            value={(obj[k] as number) ?? ""}
            onChange={(e) => setKey(k, e.target.value === "" ? undefined : Number(e.target.value))}
            placeholder={emptyHint}
            style={{
              flex: 1, padding: "var(--spacing-xs) var(--spacing-sm)",
              border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
              background: "var(--color-surface)", color: "var(--color-fg)",
              fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
              boxSizing: "border-box",
            }}
          />
        </div>
      ))}
    </div>
  );
}

// 对象/异构数组只读预览。替代旧 string input 分支——那分支把对象当字符串渲染并静默覆盖。
function ReadonlyJsonPreview({ value, hint }: { value: unknown; hint: string }): React.ReactNode {
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
      <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>{hint}</span>
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
        <Select value={(value as string) ?? ""} onChange={onChange} style={{ width: "100%" }}>
          {desc.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      ) : desc.type === "number" ? (
        <input type="number" value={(value as number) ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} style={inputStyle} placeholder={desc.default !== undefined ? `${t("common.default")} ${desc.default}` : ""} />
      ) : desc.type === "string[]" ? (
        <StringListInput
          value={value}
          onChange={onChange}
          addPlaceholder={t("settings.listInput.placeholder")}
          objectTagLabel={t("settings.listInput.objectTag")}
        />
      ) : desc.type === "kv-fixed" ? (
        <KvFixedInput
          value={value}
          kvKeys={desc.kvKeys ?? []}
          onChange={onChange}
          emptyHint={t("settings.kvInput.empty")}
        />
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
  const isStrArr = (Array.isArray(value) && value.every((v) => typeof v === "string"))
    || (value === undefined && typeHint === "string[]");
  const isComplex = isPlainObject(value)
    || (Array.isArray(value) && value.some((v) => typeof v === "object" && v !== null))
    || (value === undefined && !!typeHint && !["boolean", "number", "string", "string[]"].includes(typeHint));
  const typeLabel = typeHint ?? (Array.isArray(value) ? "array" : typeof value);
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
      {isComplex ? (
        <ReadonlyJsonPreview value={value} hint={t("settings.readonlyObject.hint")} />
      ) : isBool ? (
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        </label>
      ) : isNum ? (
        <input type="number" value={(value as number) ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} style={inputStyle} />
      ) : isStrArr ? (
        <StringListInput
          value={value}
          onChange={onChange}
          addPlaceholder={t("settings.listInput.placeholder")}
          objectTagLabel={t("settings.listInput.objectTag")}
        />
      ) : (
        <input type="text" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || undefined)} style={inputStyle} />
      )}
    </div>
  );
}

