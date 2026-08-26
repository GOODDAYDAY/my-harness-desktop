// 远程访问设置页(web-service §38)——经 window.kernel.remote.* 控制(§18.6)。
// 纯内容层壳插件:开关/密码/二维码/隧道,不碰网关实现。文案经 i18n(contributes.languages)。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsSection, type SettingsComponentProps } from "@my-harness-desktop/react";

interface RemoteStatus {
  enabled?: boolean;
  bind?: "loopback" | "lan";
  port?: number;
  lan?: { enabled?: boolean; passwordHash?: string | null; customized?: boolean };
  public?: { passwordHash?: string | null; activeTunnel?: string | null };
}

export function RemoteAccessPage(_props: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [freshPassword, setFreshPassword] = useState<string | null>(null);
  const [customPassword, setCustomPassword] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [disclaimer, setDisclaimer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void window.kernel.remote.status().then((s) => setStatus(s as RemoteStatus)).catch(() => {});
    void window.kernel.remote.qr().then((q) => setQr(q)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const off = window.kernel.remote.onStateChanged((state) => {
      const s = state as { tunnel?: { status?: string; url?: string } };
      if (s?.tunnel?.status === "running") setTunnelUrl(s.tunnel.url ?? null);
      if (s?.tunnel?.status === "stopped") setTunnelUrl(null);
      refresh();
    });
    return off;
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = () =>
    run(() => (status?.enabled ? window.kernel.remote.stop() : window.kernel.remote.start()));

  const refreshPassword = () =>
    run(async () => {
      const pwd = (await window.kernel.remote.refreshPassword()) as string;
      setFreshPassword(pwd);
    });

  const setPassword = () =>
    run(() => window.kernel.remote.setPassword(customPassword)).then(() => setFreshPassword(null));

  const toggleTunnel = () =>
    run(() =>
      tunnelUrl
        ? window.kernel.remote.tunnelStop()
        : window.kernel.remote.tunnelStart({ disclaimer }),
    );

  return (
    <div style={{ padding: "var(--spacing-lg)", display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      <SettingsSection title={t("remote.access")} description={t("remote.accessDesc")}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-md)" }}>
          <button disabled={busy} onClick={toggle} style={{ padding: "var(--spacing-sm) var(--spacing-md)" }}>
            {status?.enabled ? t("remote.stop") : t("remote.start")}
          </button>
          <span>{status?.enabled ? t("remote.enabled") : t("remote.disabled")}</span>
        </div>
        {error && <div style={{ color: "var(--color-danger, #f87171)" }}>{error}</div>}
      </SettingsSection>

      <SettingsSection title={t("remote.lanPassword")} description={t("remote.lanPasswordDesc")}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-md)", flexWrap: "wrap" }}>
          <button disabled={busy} onClick={refreshPassword}>{t("remote.refreshPassword")}</button>
          {freshPassword && <span>{t("remote.newPassword")}: {freshPassword}</span>}
          <input
            value={customPassword}
            onChange={(e) => setCustomPassword(e.target.value)}
            placeholder={t("remote.customPlaceholder")}
            maxLength={8}
            style={{ padding: "var(--spacing-sm)", width: 160 }}
          />
          <button disabled={busy || !/^\d{8}$/.test(customPassword)} onClick={setPassword}>{t("remote.setFixed")}</button>
        </div>
      </SettingsSection>

      {qr && (
        <SettingsSection title={t("remote.qr")} description={t("remote.qrDesc")}>
          <img src={qr} alt={t("remote.qr")} width={200} height={200} style={{ borderRadius: "var(--radius-md)" }} />
        </SettingsSection>
      )}

      <SettingsSection title={t("remote.tunnel")} description={t("remote.tunnelDesc")}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-md)", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
            <input type="checkbox" checked={disclaimer} onChange={(e) => setDisclaimer(e.target.checked)} />
            {t("remote.disclaimer")}
          </label>
          <button disabled={busy || (!disclaimer && !tunnelUrl)} onClick={toggleTunnel}>
            {tunnelUrl ? t("remote.tunnelStop") : t("remote.tunnelStart")}
          </button>
          {tunnelUrl && <a href={tunnelUrl} target="_blank" rel="noreferrer">{tunnelUrl}</a>}
        </div>
      </SettingsSection>
    </div>
  );
}
