// dsh-manager 插件 renderer ——「DSH 入口」的三个 TAB 组件。
//
// 与 pi-manager 同级:dsh 是另一个内核(DeepSeek harness,Cordis 插件树 + JSON-RPC)。
// TAB 1「DSH 内核版本管理」1:1 复刻 pi-manager 的 KernelSection(版本信息 + 安装切换 + 自定义目录)。
// TAB 2「DSH 拓展」/ TAB 3「DSH 模型配置」:接 cordis.yml。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import semver from "semver";
import { Button, Select, SettingsSection, type SettingsComponentProps, usePluginContext } from "@pi-desktop/react";
import type { KernelStatusView } from "@pi-desktop/contract";

type DshRegistry = { versions: string[]; latest: string | null };

function InfoRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }): React.ReactNode {
  return (
    <div style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center", fontSize: "var(--font-size-sm)" }}>
      <span style={{ color: "var(--color-muted)", minWidth: "80px" }}>{label}</span>
      <span style={{ color: highlight ? "var(--color-accent-warning)" : "var(--color-fg)", fontFamily: "var(--font-family-mono)" }}>{value}</span>
    </div>
  );
}

/** TAB 1 · DSH 内核版本管理(@deepseek-ai/dsh,1:1 复刻 pi KernelSection)。 */
export function DshKernelPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  const dsh = ctx.dshKernel;
  const { t } = useTranslation();
  const [status, setStatus] = useState<KernelStatusView | null>(null);
  const [registry, setRegistry] = useState<DshRegistry | null>(null);
  const [regFailed, setRegFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [targetVersion, setTargetVersion] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string[]>([]);
  const [installResult, setInstallResult] = useState<{ ok: boolean; error: string | null } | null>(null);
  const installDoneRef = useRef(false);

  useEffect(() => {
    setRegFailed(false);
    void dsh.status().then(setStatus);
    void dsh.listVersions().then((r) => {
      setRegistry(r);
      setTargetVersion((prev) => prev || r.latest || "");
    }).catch(() => setRegFailed(true));
  }, [dsh, refreshSignal]);

  const refresh = async (): Promise<void> => {
    setChecking(true);
    setRegFailed(false);
    try {
      setRegistry(await dsh.listVersions(true));
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
    const r = await dsh.install(
      targetVersion,
      (line) => setInstallOutput((prev) => [...prev, line]),
      (done) => {
        installDoneRef.current = true;
        setInstalling(false);
        setInstallResult(done);
        if (done.ok) {
          void dsh.status().then(setStatus);
          void dsh.listVersions(true).then(setRegistry).catch(() => setRegFailed(true));
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
  const cmp = current && targetVersion && semver.valid(current) && semver.valid(targetVersion)
    ? semver.compare(current, targetVersion)
    : null;
  const isDowngrade = cmp !== null && cmp > 0;
  const isUpgrade = cmp !== null && cmp < 0;
  const isSame = cmp !== null && cmp === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      <div>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>{t("dsh.kernelTitle")}</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          {t("dsh.kernelDesc")}
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: "var(--spacing-xl)", alignItems: "start" }}>
        {/* 左列:版本信息 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
          <InfoRow label={t("dsh.kernelInstalled")} value={current ?? (status?.available ? t("common.unknown") : t("common.notInstalled"))} />
          <div style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center", fontSize: "var(--font-size-sm)" }}>
            <span style={{ color: "var(--color-muted)", minWidth: "80px" }}>{t("dsh.kernelLatest")}</span>
            <span style={{ color: (latest && current && current !== latest) ? "var(--color-accent-warning)" : "var(--color-fg)", fontFamily: "var(--font-family-mono)" }}>
              {regFailed ? t("dsh.fetchFailed") : (latest ?? t("common.loading"))}
            </span>
            <Button variant="secondary" onClick={() => void refresh()} disabled={checking} style={{ padding: "2px var(--spacing-sm)" }}>
              {checking ? t("common.checking") : t("dsh.kernelCheckUpdate")}
            </Button>
          </div>
          <InfoRow
            label={t("dsh.kernelStatus")}
            value={
              !status?.available
                ? `${t("common.notInstalled")}${status?.error ? `:${status.error}` : ""}`
                : latest && current === latest
                  ? t("dsh.kernelUpToDate")
                  : latest && current && current !== latest
                    ? t("dsh.kernelNewAvailable")
                    : t("common.unknown")
            }
          />
          <InfoRow
            label={t("dsh.kernelEffectiveSource")}
            highlight={!!status?.error}
            value={
              status?.source === "custom"
                ? status.error
                  ? `${t("dsh.customCli.sourceCustom")} · ${status.error}`
                  : `${t("dsh.customCli.sourceCustom")} ${status.currentVersion ?? t("common.unknown")}`
                : t("dsh.customCli.sourceInstalled")
            }
          />
        </div>

        {/* 右列:安装/切换版本 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderLeft: "1px solid var(--color-border)", paddingLeft: "var(--spacing-xl)" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{t("dsh.kernelInstallSwitch")}</h3>
            <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
              {isUpgrade && <span style={{ color: "var(--color-accent-success)" }}> {t("dsh.kernelWillUpgrade", { current, target: targetVersion })}</span>}
              {isDowngrade && <span style={{ color: "var(--color-accent-warning)" }}> {t("dsh.kernelWillDowngrade", { current, target: targetVersion })}</span>}
              {isSame && <span style={{ color: "var(--color-muted)" }}> {t("dsh.kernelCurrent")}</span>}
              {!current && targetVersion && <span style={{ color: "var(--color-accent-success)" }}> {t("dsh.kernelWillInstall", { target: targetVersion })}</span>}
            </p>
            {status?.source === "custom" && (
              <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
                {t("dsh.customCli.overrideHint")}
              </p>
            )}
          </div>
          <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
            <Select mono value={targetVersion} onChange={setTargetVersion} disabled={installing || !registry} ariaLabel={t("dsh.kernelInstallSwitch")}>
              {registry?.versions.slice().reverse().map((v) => (
                <option key={v} value={v}>{v}{v === latest ? ` (${t("common.latest")})` : ""}{v === current ? ` (${t("common.installed")})` : ""}</option>
              ))}
            </Select>
            <Button variant="primary" onClick={() => void install()} disabled={installing || !targetVersion || isSame}>
              {installing ? t("common.installing") : isSame ? t("dsh.kernelCurrent") : isDowngrade ? t("dsh.kernelDowngradeThis") : isUpgrade ? t("dsh.kernelUpgradeThis") : t("dsh.kernelInstallThis")}
            </Button>
          </div>
          {(installing || installOutput.length > 0 || installResult) && (
            <div>
              <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-xs)" }}>{t("dsh.kernelInstallOutput")}</div>
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
                    {installResult.ok ? t("dsh.kernelInstallDone", { target: targetVersion }) : t("dsh.kernelInstallFailed", { error: installResult.error })}
                  </div>
                )}
              </pre>
            </div>
          )}
        </div>
      </div>

      <DshCustomCliSection status={status} onStatus={setStatus} />
    </div>
  );
}

/** 自定义 dsh 目录区块(1:1 复刻 pi CustomCliSection)。 */
function DshCustomCliSection({ status, onStatus }: { status: KernelStatusView | null; onStatus: (s: KernelStatusView) => void }): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const appliedDir = status?.customCliDir ?? "";
  useEffect(() => { setInput(appliedDir); }, [appliedDir]);

  const changed = input.trim() !== appliedDir;

  const apply = async (dir: string): Promise<void> => {
    setBusy(true);
    setFeedback(null);
    try {
      const r = await ctx.dshKernel.setCustomCliDir(dir);
      if (!r.ok) {
        setFeedback({ ok: false, text: r.error ?? t("dsh.customCli.failed") });
        return;
      }
      if (r.status) onStatus(r.status);
      const version = r.status?.currentVersion ?? t("common.unknown");
      setFeedback({ ok: true, text: !dir ? t("dsh.customCli.cleared") : t("dsh.customCli.applied", { version }) });
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
        <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{t("dsh.customCli.title")}</h3>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          {t("dsh.customCli.desc")}
        </p>
      </div>
      <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("dsh.customCli.placeholder")}
          style={{
            flex: 1, padding: "var(--spacing-xs) var(--spacing-sm)",
            border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
            background: "var(--color-surface)", color: "var(--color-fg)",
            fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)", boxSizing: "border-box",
          }}
        />
        <Button variant="secondary" onClick={() => void browse()} disabled={busy}>{t("dsh.customCli.browse")}</Button>
        <Button variant="primary" onClick={() => void apply(input.trim())} disabled={busy || !changed}>{t("dsh.customCli.apply")}</Button>
        <Button variant="secondary" onClick={() => void apply("")} disabled={busy || !appliedDir}>{t("dsh.customCli.clear")}</Button>
      </div>
      {feedback && (
        <div style={{ fontSize: "var(--font-size-sm)", color: feedback.ok ? "var(--color-accent-success)" : "var(--color-accent-error)" }}>
          {feedback.text}
        </div>
      )}
    </div>
  );
}

/** 开关(1:1 复刻 extension-manager 的 ToggleSwitch)。 */
function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }): React.ReactNode {
  return (
    <div onClick={(e) => { e.stopPropagation(); onChange(); }} style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", cursor: "pointer", userSelect: "none" }}>
      <span style={{ fontSize: "var(--font-size-xs)", color: checked ? "var(--color-fg)" : "var(--color-muted)", fontWeight: 500 }}>
        {checked ? "ON" : "OFF"}
      </span>
      <div style={{ width: "36px", height: "20px", borderRadius: "10px", background: checked ? "var(--color-primary)" : "var(--color-border)", position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
        <div style={{ position: "absolute", top: "2px", left: checked ? "18px" : "2px", width: "16px", height: "16px", borderRadius: "50%", background: "var(--color-primary-fg)", transition: "left 0.2s" }} />
      </div>
    </div>
  );
}

/** TAB 2 · DSH 拓展(Cordis 插件树,卡片 + 开关,1:1 复刻 extension-manager 的卡片布局)。 */
export function DshExtensionsPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<{ id: string; name: string }[]>([]);
  const [disabled, setDisabled] = useState<{ id: string; name: string }[]>([]);
  const [available, setAvailable] = useState<{ name: string }[]>([]);

  const reload = (): void => {
    void ctx.dshPlugins.list().then(setEnabled);
    void ctx.dshPlugins.listDisabled().then(setDisabled);
    void ctx.dshPlugins.listAvailable().then(setAvailable);
  };
  useEffect(reload, [ctx, refreshSignal]);

  const toggle = async (id: string, cur: boolean): Promise<void> => {
    try {
      if (cur) setEnabled(await ctx.dshPlugins.disable(id));
      else setEnabled(await ctx.dshPlugins.enable(id));
      setDisabled(await ctx.dshPlugins.listDisabled());
    } catch (err) {
      console.error("[dsh] 插件开关失败:", err);
    }
  };

  const cards = [
    ...enabled.map((p) => ({ ...p, on: true })),
    ...disabled.map((p) => ({ ...p, on: false })),
  ];
  const enabledNames = new Set(enabled.map((p) => p.name));
  const disabledNames = new Set(disabled.map((p) => p.name));

  return (
    <SettingsSection title={t("dsh.extTitle")} description={t("dsh.extDesc")}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "var(--spacing-sm)" }}>
        {cards.map((p) => (
          <div key={p.id} style={{
            display: "flex", flexDirection: "column", gap: "var(--spacing-sm)",
            padding: "var(--spacing-md)", border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)", background: "var(--color-surface)",
            opacity: p.on ? 1 : 0.55, transition: "opacity 0.15s",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
              <span style={{ fontWeight: 600, color: "var(--color-fg)", fontSize: "var(--font-size-sm)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-family-mono)" }}>
                {p.id}
              </span>
            </div>
            <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", fontFamily: "var(--font-family-mono)", wordBreak: "break-all" }}>
              {p.name}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "auto" }}>
              <ToggleSwitch checked={p.on} onChange={() => void toggle(p.id, p.on)} />
            </div>
          </div>
        ))}
      </div>
      {cards.length === 0 && (
        <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", margin: 0 }}>{t("dsh.extEmpty")}</p>
      )}

      {/* 可用插件清单:node_modules 里装好的 @deepseek-ai/dsh-* 包(分析结果,读只展示不启停) */}
      {available.length > 0 && (
        <>
          <div style={{ margin: "var(--spacing-md) 0 var(--spacing-xs)", fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>
            {t("dsh.availableTitle", { count: available.length })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
            {available.map((p) => {
              const status = enabledNames.has(p.name) ? t("dsh.statusEnabled") : disabledNames.has(p.name) ? t("dsh.statusDisabled") : t("dsh.statusUnconfigured");
              const color = enabledNames.has(p.name) ? "var(--color-accent-success)" : disabledNames.has(p.name) ? "var(--color-accent-warning)" : "var(--color-muted)";
              return (
                <div key={p.name} style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center", fontSize: "var(--font-size-sm)" }}>
                  <span style={{ fontFamily: "var(--font-family-mono)", color: "var(--color-fg)", flex: 1, minWidth: 0, wordBreak: "break-all" }}>{p.name}</span>
                  <span style={{ fontSize: "var(--font-size-xs)", color, flexShrink: 0 }}>{status}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </SettingsSection>
  );
}

/** TAB 3 · DSH 模型配置(cordis.yml 的 llm-deepseek.models,编辑 id + contextWindow)。 */
export function DshModelsPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [models, setModels] = useState<{ id: string; contextWindow?: number }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void ctx.dshModels.get().then((ms) => {
      setModels(ms.map((m) => ({ id: m.id, contextWindow: m.contextWindow })));
      setLoaded(true);
    });
  }, [ctx, refreshSignal]);

  const update = (idx: number, patch: Partial<{ id: string; contextWindow?: number }>): void =>
    setModels((prev) => prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
  const add = (): void =>
    setModels((prev) => [...prev, { id: `model-${crypto.randomUUID().slice(0, 8)}`, contextWindow: 128000 }]);
  const remove = (idx: number): void => setModels((prev) => prev.filter((_, i) => i !== idx));

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const saved = await ctx.dshModels.set(models);
      setModels(saved.map((m) => ({ id: m.id, contextWindow: m.contextWindow })));
      setSaveMsg({ ok: true, text: t("dsh.modelsSaved") });
    } catch (err) {
      setSaveMsg({ ok: false, text: t("dsh.modelsSaveFailed", { error: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    padding: "var(--spacing-xs) var(--spacing-sm)", border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)", background: "var(--color-surface)", color: "var(--color-fg)",
    fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)", boxSizing: "border-box",
  };

  return (
    <SettingsSection
      title={t("dsh.modelsTitle")}
      description={t("dsh.modelsDesc")}
      actions={<Button variant="primary" onClick={() => void save()} disabled={saving || !loaded}>{saving ? t("dsh.saving") : t("dsh.save")}</Button>}
    >
      {saveMsg && (
        <p style={{ margin: "0 0 var(--spacing-sm)", fontSize: "var(--font-size-sm)", color: saveMsg.ok ? "var(--color-accent-success)" : "var(--color-accent-error)" }}>
          {saveMsg.text}
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
        {models.map((m, idx) => (
          <div key={idx} style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--spacing-sm) var(--spacing-md)", display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
            <input
              value={m.id}
              onChange={(e) => update(idx, { id: e.target.value })}
              placeholder={t("dsh.modelId")}
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
            />
            <input
              type="number"
              value={m.contextWindow ?? ""}
              onChange={(e) => update(idx, { contextWindow: e.target.value === "" ? undefined : Number(e.target.value) })}
              placeholder={t("dsh.contextWindow")}
              style={{ ...inputStyle, width: "110px", flexShrink: 0 }}
            />
            <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-family-mono)", whiteSpace: "nowrap" }}>
              ≈ {Math.round((m.contextWindow ?? 0) / 1024)}K
            </span>
            <Button variant="danger" onClick={() => remove(idx)} style={{ padding: "var(--spacing-xs)", flexShrink: 0 }}>{t("dsh.remove")}</Button>
          </div>
        ))}
        <Button variant="secondary" onClick={add} style={{ alignSelf: "flex-start" }}>{t("dsh.addModel")}</Button>
      </div>
    </SettingsSection>
  );
}
