// dsh-manager 插件 renderer ——「DSH 入口」的三个 TAB 组件。
//
// 与 pi-manager 同级:dsh 是另一个内核(DeepSeek harness,Cordis 插件树 + JSON-RPC)。
// TAB 1「DSH 内核版本管理」:复用 client/npm 机制(与 pi 同构,§6.3)。
// TAB 2「DSH 拓展」/ TAB 3「DSH 模型配置」:接 cordis.yml(阶段三/后续)。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import semver from "semver";
import { Button, Select, SettingsSection, type SettingsComponentProps, usePluginContext } from "@pi-desktop/react";

type DshKernelStatus = { currentVersion: string | null; available: boolean; error: string | null };
type DshRegistry = { versions: string[]; latest: string | null };

function InfoRow({ label, value }: { label: string; value: string }): React.ReactNode {
  return (
    <div style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center", fontSize: "var(--font-size-sm)" }}>
      <span style={{ color: "var(--color-muted)", minWidth: "80px" }}>{label}</span>
      <span style={{ color: "var(--color-fg)", fontFamily: "var(--font-family-mono)" }}>{value}</span>
    </div>
  );
}

/** TAB 1 · DSH 内核版本管理(@deepseek-ai/dsh,复用 client/npm 机制)。 */
export function DshKernelPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  const dsh = ctx.dshKernel;
  const { t } = useTranslation();
  const [status, setStatus] = useState<DshKernelStatus | null>(null);
  const [registry, setRegistry] = useState<DshRegistry | null>(null);
  const [regFailed, setRegFailed] = useState(false);
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
    setRegFailed(false);
    try {
      setRegistry(await dsh.listVersions(true));
    } catch {
      setRegFailed(true);
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
    <SettingsSection title={t("dsh.kernelTitle")} description={t("dsh.kernelDesc")}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: "var(--spacing-xl)", alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
          <InfoRow label={t("dsh.kernelInstalled")} value={current ?? (status?.available ? t("dsh.unknown") : t("dsh.notInstalled"))} />
          <div style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center", fontSize: "var(--font-size-sm)" }}>
            <span style={{ color: "var(--color-muted)", minWidth: "80px" }}>{t("dsh.kernelLatest")}</span>
            <span style={{ color: (latest && current && current !== latest) ? "var(--color-accent-warning)" : "var(--color-fg)", fontFamily: "var(--font-family-mono)" }}>
              {regFailed ? t("dsh.fetchFailed") : (latest ?? t("dsh.loading"))}
            </span>
            <Button variant="secondary" onClick={() => void refresh()} style={{ padding: "2px var(--spacing-sm)" }}>
              {t("dsh.kernelCheckUpdate")}
            </Button>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderLeft: "1px solid var(--color-border)", paddingLeft: "var(--spacing-xl)" }}>
          <p style={{ margin: 0, color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
            {isUpgrade && <span style={{ color: "var(--color-accent-success)" }}> {t("dsh.kernelWillUpgrade", { current, target: targetVersion })}</span>}
            {isDowngrade && <span style={{ color: "var(--color-accent-warning)" }}> {t("dsh.kernelWillDowngrade", { current, target: targetVersion })}</span>}
            {isSame && <span style={{ color: "var(--color-muted)" }}> {t("dsh.kernelCurrent")}</span>}
            {!current && targetVersion && <span style={{ color: "var(--color-accent-success)" }}> {t("dsh.kernelWillInstall", { target: targetVersion })}</span>}
          </p>
          <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
            <Select mono value={targetVersion} onChange={setTargetVersion} disabled={installing || !registry} ariaLabel={t("dsh.kernelTitle")}>
              {registry?.versions.slice().reverse().map((v) => (
                <option key={v} value={v}>{v}{v === latest ? ` (${t("dsh.latest")})` : ""}{v === current ? ` (${t("dsh.installed")})` : ""}</option>
              ))}
            </Select>
            <Button variant="primary" onClick={() => void install()} disabled={installing || !targetVersion || isSame}>
              {installing ? t("dsh.installing") : isSame ? t("dsh.kernelCurrent") : isDowngrade ? t("dsh.kernelDowngradeThis") : isUpgrade ? t("dsh.kernelUpgradeThis") : t("dsh.kernelInstallThis")}
            </Button>
          </div>
          {(installing || installOutput.length > 0 || installResult) && (
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
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

/** TAB 2 · DSH 拓展(Cordis 插件树)。 */
export function DshExtensionsPage(_props: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("dsh.extTitle")}>
      <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", margin: 0 }}>
        {t("dsh.extPlaceholder")}
      </p>
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
          <div key={idx} style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
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
              style={{ ...inputStyle, width: "120px", flexShrink: 0 }}
            />
            <Button variant="danger" onClick={() => remove(idx)} style={{ padding: "var(--spacing-xs)" }}>{t("dsh.remove")}</Button>
          </div>
        ))}
        <Button variant="secondary" onClick={add} style={{ alignSelf: "flex-start" }}>{t("dsh.addModel")}</Button>
      </div>
    </SettingsSection>
  );
}
