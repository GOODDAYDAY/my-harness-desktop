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
import { useEffect, useRef, useState } from "react";
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

  // 分组(保序):group 是 i18n key,按 group 归组,无 group 的进「未分组」。
  // ⚠ 兜底值必须是 **i18n key** 而不是写死的中文「其他」：下面渲染时走
  //   `t(group, { defaultValue: group })`，写死中文会让它在任何语言下都显示中文
  //   （§7.1 铁律一）。key 归 system/i18n（共享组件文案的正确主人，见 settings.otherFields）。
  const groups: string[] = [];
  const grouped = new Map<string, KernelConfigField[]>();
  for (const f of fields) {
    const g = f.group ?? UNGROUPED_KEY;
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

      {/* **显式空态**（§1.5：唯一明禁的状态是"静默缺面"）。
          触发条件：内核既没交字段清单（`fields()` 返回 []）、config 里也没有可推断的值。
          实测这一态真的会发生：`kernel/dsh/manager/dsh-kernel-config.ts:44` 的 `fields()` 恒返回 []
          （dsh 的 schema 在它运行时的 cordis schemastery 里，不落文件、桌面读不到——这是有意的
          显式降级，注释写得很清楚），而它的 `get()` 只返回**非模型命名空间**子集，当 settings.yaml
          里只有模型段时就是 `{}`（实测 `kernelConfig.dsh.get()` 返回 `{}`）。
          两者同时为空时，本组件此前渲染出一个**空 div**：设置页只剩"版本管理"，配置区一片空白、
          没有任何解释。用户无法区分"这个内核没有可配置项"与"页面加载失败了"。
          ⚠ 顺带修正一处文档与代码不符：`dsh-kernel-config.ts:8` 声称"壳表单退化成按值推断类型的
          通用 JSON 编辑器"——那句只在 config **非空**时成立（`InferredField` 要有值才能推断类型），
          config 为 `{}` 时它什么都渲染不出来。本空态就是补上那个缺口。 */}
      {groups.length === 0 && unknownTopKeys.length === 0 && (
        <div style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", lineHeight: 1.6 }}>
          {t("settings.noSchemaFields", {
            defaultValue: "This kernel exposes no configurable fields here.",
          })}
        </div>
      )}
    </div>
  );
}

/** 字段没有 group 时的分组标题 i18n key（译文在 system/i18n 的 settings.json）。 */
const UNGROUPED_KEY = "settings.ungrouped";

/** 把下拉框给出的字符串按该选项声明的种类转回真值。
 *  找不到对应选项（例如配置里的值不在枚举内）时原样返回字符串，不猜。 */
function coerceOptionValue(
  raw: string,
  options: KernelConfigField["options"],
): unknown {
  const kind = options?.find((o) => o.value === raw)?.kind ?? "string";
  if (kind === "boolean") return raw === "true";
  if (kind === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;   // 转不动就保留原串，不写 NaN 进配置
  }
  return raw;
}

function FieldRow({ field, value, onChange }: { field: KernelConfigField; value: unknown; onChange: (v: unknown) => void }): React.ReactNode {
  const { t, i18n } = useTranslation();
  const label = t(field.label ?? field.key, { defaultValue: field.key });
  // ⚠ **不能**用 `t(key, { defaultValue: "" })` 表达"没译文就不显示描述"（实测缺陷，勿回退）：
  //   空串是**假值**，i18next 把它当作"未提供默认值"，未命中时返回 **key 本身**
  //   （`nsSeparator: "."` 会把命名空间前缀切掉，见 src/web/app/i18n-init.ts:33-34），
  //   于是界面上直接出现 `fieldDescs.terminal.hyperlinks` 这样的裸 key。
  //   而下一行 `{desc && <span>…}` 那个守卫证明**意图本来就是"没译文不渲染"**——
  //   意图与机制不一致，守卫形同虚设（裸 key 是非空字符串，永远为真）。
  //   改用 `i18n.exists()` 显式判存在，让"没译文"真的得到空串。
  //   实测证据：scripts/demo/dom-audit.e2e.mjs 在设置页抓到 8 处裸 key（5 个字段的标签/描述）。
  //   这类漂移是**常态**而非偶发：字段清单由 `parseSettingsSchema` 从内核自己的
  //   settings-manager.d.ts 动态解析（适配器不硬编码字段，内核升级加字段就自动跟着变），
  //   所以"内核有新字段、壳的 locale 还没跟上"会反复发生——正因如此降级机制必须正确。
  const desc = field.description && i18n.exists(field.description) ? t(field.description) : "";
  return (
    // `data-config-field` = 字段 key（dotted，如 `terminal.hyperlinks`）。**稳定且与语言无关**，
    // e2e 与 DOM 审计据此定位某个字段的控件；按 label 译文定位等于把测试绑死在某一种语言上
    // （skill §17.3）。字段清单由 parseSettingsSchema 从内核 .d.ts 动态解析，所以 key 是
    // 这里唯一稳定的身份——label/description/group 都是可缺译文的 i18n key。
    <div data-config-field={field.key} style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
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
        // ⚠ 值与写回都要过"种类"这一层（勿简化成直接透传字符串）：
        //   HTML `<option value>` 只能是字符串，而内核配置里的值可能是**真布尔/真数字**
        //   （混合字面量联合，如 `boolean | "auto"`）。所以：
        //   · 显示：`String(value)` —— 存的是 `true` 时选中项要能对上 `<option value="true">`；
        //   · 写回：按该选项声明的 `kind` 转回真值 —— 否则内核读到字符串 `"true"`，
        //     在 JS 里它是真值（连 `"false"` 也是真值！），语义直接反了。
        <Select
          value={value == null ? "" : String(value)}
          onChange={(raw) => onChange(coerceOptionValue(raw, field.options))}
          style={{ width: "100%" }}
        >
          {/* 配置里的值**不在枚举内**时补一个合成选项。原生 <select> 无法表示"选项外的值"——
              浏览器会退回显示第一项，于是界面显示 `false` 而磁盘上存的是 `"sixel"`：
              数据没坏（onChange 未触发，不会误写），但**界面在撒谎**，用户看到的与将要保存的
              不一致。补一个 disabled 的合成项让真值可见；用户一旦改选别项就再也回不到它
              （它本来就不是合法值，能显示、不能重选，正是诚实的表达）。 */}
          {value != null && !(field.options ?? []).some((o) => o.value === String(value)) && (
            <option value={String(value)} disabled>
              {/* 文案走 i18n key，不在壳的发布面里写死中文（§1.2 / §7.1 铁律一）。
                  key 归属 system/i18n —— 与 shell.loading / settings.otherFields 同一主人
                  （共享组件的文案不能住在某个内核插件里，见那两个 key 的迁移记录）。 */}
              {t("settings.valueNotInOptions", { defaultValue: "{{value}} (not among the options)", value: String(value) })}
            </option>
          )}
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
  /** **自己刚上报过的值**的序列化形态。
   *  为什么需要它：改成"边改边提交"之后，`onChange` 会让父层的 `value` 变化，
   *  而下面那个 effect 又会把 `value` 序列化回 draft —— 于是用户每敲一个字符，
   *  草稿就被 `JSON.stringify(…, null, 2)` 重排版一次（光标跳到末尾、缩进被改写），
   *  根本没法编辑。判据是"回流的值等于我刚上报的"，等于就**不回写 draft**。 */
  const lastReported = useRef<string | null>(null);
  useEffect(() => {
    const serialized = toDraft(value);
    if (lastReported.current === serialized) return;   // 我自己刚上报的，别打断用户输入
    lastReported.current = serialized;
    setDraft(serialized);
    setError(null);
  }, [value]);

  /** ⚠ **边改边提交**，不是 onBlur 才提交（r21 修；此前是 blur-only）。
   *  旧行为的两个代价，都是实测出来的（`scripts/demo/settings-controls-audit.e2e.mjs` ⑥）：
   *    · 键入合法 JSON 后**保存浮层根本不出现**（`onChange` 没被调用 → 框架不知道有改动），
   *      用户看不到"有未保存改动"，会以为编辑没生效；
   *    · 此时直接关窗/切页，blur 可能不触发 → 编辑**静默丢失且无提示**。
   *  新行为：解析成功就立刻上报（浮层随即出现）；解析失败只在行内显示错误、**不上报**——
   *  半成品 JSON 不该污染配置，也不该把原值清掉（剧本里对此有断言）。 */
  const handleEdit = (next: string): void => {
    setDraft(next);
    if (next.trim() === "") {
      lastReported.current = toDraft(undefined);
      onChange(undefined);
      setError(null);
      return;
    }
    try {
      const parsed = JSON.parse(next) as unknown;
      lastReported.current = toDraft(parsed);
      onChange(parsed);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
      <textarea
        value={draft}
        onChange={(e) => handleEdit(e.target.value)}
        rows={Math.min(10, draft.split("\n").length + 1)}
        style={{ ...inputStyle, fontFamily: "var(--font-family-mono)", resize: "vertical", minHeight: "60px" }}
      />
      {error && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-accent-error)" }}>{error}</span>}
    </div>
  );
}

function StringListInput({ value, onChange }: { value: unknown; onChange: (next: unknown[]) => void }): React.ReactNode {
  const { t } = useTranslation();
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
                {/* aria-label 走 i18n：此前是硬编码英文 "remove"，屏幕阅读器在任何语言下
                    都念英文（§7.1 铁律一：发布面不内嵌文案）。key 归 system/i18n（共享组件
                    文案的正确主人，与 settings.ungrouped / settings.valueNotInOptions 同处）。 */}
                <button type="button" onClick={() => removeAt(idx)} aria-label={t("settings.listRemoveItem")} style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", color: "var(--color-muted)", fontSize: "var(--font-size-sm)", lineHeight: 1 }}>×</button>
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
