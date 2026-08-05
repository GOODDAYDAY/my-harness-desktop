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
import { Button, Select, SettingsSection, type SettingsComponentProps, usePluginContext } from "@pi-desktop/react";
import type { KernelStatusView } from "@pi-desktop/contract";
import { FIELD_DESCRIPTORS, FIELD_GROUPS, type FieldDescriptor } from "../core/field-descriptors";


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
// KernelStatus 契约单源在 domain/context(经 contract 发布),本地别名沿用旧名
type KernelStatus = KernelStatusView;

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
            <span style={{ color: (latest && current && current !== latest) ? "var(--color-accent-warning)" : "var(--color-fg)", fontFamily: "var(--font-family-mono)" }}>
              {regFailed ? t("kernel.fetchFailed") : (latest ?? t("common.loading"))}
            </span>
            <Button variant="secondary" onClick={() => void refresh()} disabled={checking} style={{ padding: "2px var(--spacing-sm)" }}>
              {checking ? t("common.checking") : t("kernel.checkUpdate")}
            </Button>
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
          {/* 生效来源(docs/design/custom-cli-path.md §3.2):"装了什么"与"在跑什么"分行呈现;
              自定义失效时 error 透到此行(highlight 警示) */}
          <InfoRow
            label={t("kernel.effectiveSource")}
            highlight={!!status?.error}
            value={
              status?.source === "custom"
                ? status.error
                  ? `${t("kernel.customCli.sourceCustom")} · ${status.error}`
                  : `${t("kernel.customCli.sourceCustom")} ${status.currentVersion ?? t("common.unknown")}`
                : t("kernel.customCli.sourceInstalled")
            }
          />
        </div>

        {/* 右列:安装/切换版本 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderLeft: "1px solid var(--color-border)", paddingLeft: "var(--spacing-xl)" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{t("kernel.installSwitch")}</h3>
            <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
              {isUpgrade && <span style={{ color: "var(--color-accent-success)" }}> {t("kernel.willUpgrade", { current, target: targetVersion })}</span>}
              {isDowngrade && <span style={{ color: "var(--color-accent-warning)" }}> {t("kernel.willDowngrade", { current, target: targetVersion })}</span>}
              {isSame && <span style={{ color: "var(--color-muted)" }}> {t("kernel.currentVersion")}</span>}
              {!current && targetVersion && <span style={{ color: "var(--color-accent-success)" }}> {t("kernel.willInstall", { target: targetVersion })}</span>}
            </p>
            {/* 覆盖提示:自定义生效时装版本仍写数据根,防"装了没反应"的困惑(§3.2) */}
            {status?.source === "custom" && (
              <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
                {t("kernel.customCli.overrideHint")}
              </p>
            )}
          </div>
          <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
            <Select
              mono
              value={targetVersion}
              onChange={setTargetVersion}
              disabled={installing || !registry}
              ariaLabel={t("kernel.installSwitch")}
            >
              {registry?.versions.slice().reverse().map((v) => (
                <option key={v} value={v}>{v}{v === latest ? ` (${t("common.latest")})` : ""}{v === current ? ` (${t("common.installed")})` : ""}</option>
              ))}
            </Select>
            <Button variant="primary" onClick={() => void install()} disabled={installing || !targetVersion || isSame}>
              {installing ? t("common.installing") : isSame ? t("kernel.currentVersion") : isDowngrade ? t("kernel.downgradeThis") : isUpgrade ? t("kernel.upgradeThis") : t("kernel.installThis")}
            </Button>
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
                  <div style={{ marginTop: "var(--spacing-xs)", color: installResult.ok ? "var(--color-accent-success)" : "var(--color-accent-error)" }}>
                    {installResult.ok ? t("kernel.installDone", { target: targetVersion }) : t("kernel.installFailed", { error: installResult.error })}
                  </div>
                )}
              </pre>
            </div>
          )}
        </div>
      </div>

      <CustomCliSection status={status} onStatus={setStatus} />
    </div>
  );
}

// ============ 自定义底座区块(docs/design/custom-cli-path.md §3.2)============
// 立即操作型(同 KernelSection 风格,不进 configFile dirty/save):点应用一次 IPC 原子完成
// 校验+写入+标 pending;前端无 fs 能力不预检,失败原因由 main 返回。
function CustomCliSection({ status, onStatus }: { status: KernelStatus | null; onStatus: (s: KernelStatus) => void }): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  // status 刷新(打开页/点刷新/应用成功)时同步输入框为生效值
  const appliedDir = status?.customCliDir ?? "";
  useEffect(() => {
    setInput(appliedDir);
  }, [appliedDir]);

  const changed = input.trim() !== appliedDir;

  const apply = async (dir: string): Promise<void> => {
    setBusy(true);
    setFeedback(null);
    try {
      const r = await ctx.kernel.setCustomCliDir(dir);
      if (!r.ok) {
        setFeedback({ ok: false, text: r.error ?? t("kernel.customCli.failed") });
        return;
      }
      if (r.status) onStatus(r.status);
      const version = r.status?.currentVersion ?? t("common.unknown");
      setFeedback({
        ok: true,
        text: !dir
          ? t("kernel.customCli.cleared")
          : r.pendingCount > 0
            ? t("kernel.customCli.appliedWithPending", { version, count: r.pendingCount })
            : t("kernel.customCli.applied", { version }),
      });
    } finally {
      setBusy(false);
    }
  };

  const browse = async (): Promise<void> => {
    const dir = await ctx.dialog.openDirectory();
    if (dir) setInput(dir);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderTop: "1px solid var(--color-border)", paddingTop: "var(--spacing-lg)" }}>
      <div>
        <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{t("kernel.customCli.title")}</h3>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          {t("kernel.customCli.desc")}
        </p>
      </div>
      <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("kernel.customCli.placeholder")}
          style={{
            flex: 1, padding: "var(--spacing-xs) var(--spacing-sm)",
            border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
            background: "var(--color-surface)", color: "var(--color-fg)",
            fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)", boxSizing: "border-box",
          }}
        />
        <Button variant="secondary" onClick={() => void browse()} disabled={busy}>{t("kernel.customCli.browse")}</Button>
        <Button variant="primary" onClick={() => void apply(input.trim())} disabled={busy || !changed}>{t("kernel.customCli.apply")}</Button>
        <Button variant="secondary" onClick={() => void apply("")} disabled={busy || !appliedDir}>{t("kernel.customCli.clear")}</Button>
      </div>
      {feedback && (
        <div style={{ fontSize: "var(--font-size-sm)", color: feedback.ok ? "var(--color-accent-success)" : "var(--color-accent-error)" }}>
          {feedback.text}
        </div>
      )}
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

function InfoRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }): React.ReactNode {
  return (
    <div style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center", fontSize: "var(--font-size-sm)" }}>
      <span style={{ color: "var(--color-muted)", minWidth: "80px" }}>{label}</span>
      <span style={{ color: highlight ? "var(--color-accent-warning)" : "var(--color-fg)", fontFamily: "var(--font-family-mono)" }}>{value}</span>
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

