// packages/react 内核管理共享 base —— 「内核版本管理」页骨架（kernel-design-spec.md §12.4）。
//
// pi-manager 的 KernelSection + CustomCliSection 与 dsh-manager 的 DshKernelPage +
// DshCustomCliSection 曾是逐行 copy，本组件把「版本信息 + 安装/切换 + 自定义目录」
// 三个区块收敛成一份，pi/dsh 只填 spec（api + i18nPrefix）。
// 基类是机制（内核无关骨架）：不 import 任何内核、不含 `if (kernel === "pi")` 分支，
// 差异经 props 参数化。放 packages/react 而非 core/（core 零 React 依赖）。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import semver from "semver";
import { Button } from "../widgets/button";
import { Select } from "../widgets/select";
import { usePluginContext } from "../plugin-context";
import type { KernelStatusView, KernelVersionApi } from "@my-harness-desktop/contract";

/** 内核安装基础能力(pi/dsh 的 ctx.kernels[KernelId] 都满足此形状)。契约单源在 domain 的
 *  KernelVersionApi,此处 re-export 保持 KernelVersionPage 的 prop 名不变(§1.3)。 */
export type KernelInstallApi = KernelVersionApi;

export interface KernelVersionPageProps {
  api: KernelInstallApi;
  /** i18n key 前缀（如 "kernel" / "dsh"），base 用统一后缀（title/desc/installedVersion/…）。 */
  i18nPrefix: string;
}

export function KernelVersionPage({ api, i18nPrefix }: KernelVersionPageProps): React.ReactNode {
  const { t } = useTranslation();
  const k = (suffix: string, vars?: Record<string, unknown>): string => t(`${i18nPrefix}.${suffix}`, vars);
  const [status, setStatus] = useState<KernelStatusView | null>(null);
  const [registry, setRegistry] = useState<{ versions: string[]; latest: string | null } | null>(null);
  const [regFailed, setRegFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [targetVersion, setTargetVersion] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string[]>([]);
  const [installResult, setInstallResult] = useState<{ ok: boolean; error: string | null } | null>(null);
  const installDoneRef = useRef(false);

  useEffect(() => {
    setRegFailed(false);
    void api.status().then(setStatus);
    void api.listVersions().then((r) => {
      setRegistry(r);
      setTargetVersion((prev) => prev || r.latest || "");
    }).catch(() => setRegFailed(true));
  }, [api]);

  const refresh = async (): Promise<void> => {
    setChecking(true);
    setRegFailed(false);
    try {
      setRegistry(await api.listVersions(true));
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
    const r = await api.install(
      targetVersion,
      (line) => setInstallOutput((prev) => [...prev, line]),
      (done) => {
        installDoneRef.current = true;
        setInstalling(false);
        setInstallResult(done);
        if (done.ok) {
          void api.status().then(setStatus);
          void api.listVersions(true).then(setRegistry).catch(() => setRegFailed(true));
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
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--spacing-sm)" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>{k("title")}</h2>
          <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>{k("desc")}</p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: "var(--spacing-xl)", alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
          <InfoRow label={k("installedVersion")} value={current ?? (status?.available ? t("common.unknown") : t("common.notInstalled"))} />
          <div style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center", fontSize: "var(--font-size-sm)" }}>
            <span style={{ color: "var(--color-muted)", minWidth: "80px" }}>{k("latestVersion")}</span>
            <span style={{ color: (latest && current && current !== latest) ? "var(--color-accent-warning)" : "var(--color-fg)", fontFamily: "var(--font-family-mono)" }}>
              {regFailed ? k("fetchFailed") : (latest ?? t("common.loading"))}
            </span>
            <Button variant="secondary" onClick={() => void refresh()} disabled={checking} style={{ padding: "2px var(--spacing-sm)" }}>
              {checking ? t("common.checking") : k("checkUpdate")}
            </Button>
          </div>
          <InfoRow
            label={k("status")}
            value={
              !status?.available
                ? `${t("common.notInstalled")}${status?.error ? `:${status.error}` : ""}`
                : latest && current === latest
                  ? k("upToDate")
                  : latest && current && current !== latest
                    ? k("newAvailable")
                    : t("common.unknown")
            }
          />
          <InfoRow
            label={k("effectiveSource")}
            highlight={!!status?.error}
            value={
              status?.source === "custom"
                ? status.error
                  ? `${k("customCli.sourceCustom")} · ${status.error}`
                  : `${k("customCli.sourceCustom")} ${status.currentVersion ?? t("common.unknown")}`
                : k("customCli.sourceInstalled")
            }
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderLeft: "1px solid var(--color-border)", paddingLeft: "var(--spacing-xl)" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{k("installSwitch")}</h3>
            <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
              {isUpgrade && <span style={{ color: "var(--color-accent-success)" }}> {k("willUpgrade", { current, target: targetVersion })}</span>}
              {isDowngrade && <span style={{ color: "var(--color-accent-warning)" }}> {k("willDowngrade", { current, target: targetVersion })}</span>}
              {isSame && <span style={{ color: "var(--color-muted)" }}> {k("currentVersion")}</span>}
              {!current && targetVersion && <span style={{ color: "var(--color-accent-success)" }}> {k("willInstall", { target: targetVersion })}</span>}
            </p>
            {status?.source === "custom" && (
              <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>{k("customCli.overrideHint")}</p>
            )}
          </div>
          <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
            <Select mono value={targetVersion} onChange={setTargetVersion} disabled={installing || !registry} ariaLabel={k("installSwitch")}>
              {registry?.versions.slice().reverse().map((v) => (
                <option key={v} value={v}>{v}{v === latest ? ` (${t("common.latest")})` : ""}{v === current ? ` (${t("common.installed")})` : ""}</option>
              ))}
            </Select>
            <Button variant="primary" onClick={() => void install()} disabled={installing || !targetVersion || isSame}>
              {installing ? t("common.installing") : isSame ? k("currentVersion") : isDowngrade ? k("downgradeThis") : isUpgrade ? k("upgradeThis") : k("installThis")}
            </Button>
          </div>
          {(installing || installOutput.length > 0 || installResult) && (
            <div>
              <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)", marginBottom: "var(--spacing-xs)" }}>{k("installOutput")}</div>
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
                    {installResult.ok ? k("installDone", { target: targetVersion }) : k("installFailed", { error: installResult.error })}
                  </div>
                )}
              </pre>
            </div>
          )}
        </div>
      </div>

      <CustomCliSection api={api} i18nPrefix={i18nPrefix} status={status} onStatus={setStatus} />
    </div>
  );
}

function CustomCliSection({ api, i18nPrefix, status, onStatus }: {
  api: KernelInstallApi;
  i18nPrefix: string;
  status: KernelStatusView | null;
  onStatus: (s: KernelStatusView) => void;
}): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const k = (suffix: string, vars?: Record<string, unknown>): string => t(`${i18nPrefix}.customCli.${suffix}`, vars);
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
      const r = await api.setCustomCliDir(dir);
      if (!r.ok) {
        setFeedback({ ok: false, text: r.error ?? k("failed") });
        return;
      }
      if (r.status) onStatus(r.status);
      const version = r.status?.currentVersion ?? t("common.unknown");
      setFeedback({
        ok: true,
        text: !dir
          ? k("cleared")
          : (r.pendingCount ?? 0) > 0
            ? k("appliedWithPending", { version, count: r.pendingCount })
            : k("applied", { version }),
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
        <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{k("title")}</h3>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>{k("desc")}</p>
      </div>
      <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={k("placeholder")}
          style={{
            flex: 1, padding: "var(--spacing-xs) var(--spacing-sm)",
            border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
            background: "var(--color-surface)", color: "var(--color-fg)",
            fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)", boxSizing: "border-box",
          }}
        />
        <Button variant="secondary" onClick={() => void browse()} disabled={busy}>{k("browse")}</Button>
        <Button variant="primary" onClick={() => void apply(input.trim())} disabled={busy || !changed}>{k("apply")}</Button>
        <Button variant="secondary" onClick={() => void apply("")} disabled={busy || !appliedDir}>{k("clear")}</Button>
      </div>
      {feedback && (
        <div style={{ fontSize: "var(--font-size-sm)", color: feedback.ok ? "var(--color-accent-success)" : "var(--color-accent-error)" }}>
          {feedback.text}
        </div>
      )}
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
