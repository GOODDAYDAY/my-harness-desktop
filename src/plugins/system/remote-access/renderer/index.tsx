// 远程访问设置页(web-service §38)——经 window.kernel.remote.* 控制(§18.6)。
// 纯内容层壳插件:开关/密码/二维码/隧道,不碰网关实现。
// 文案:i18n 待补(演进),先落简体中文直文——内容层插件,文案归属本插件,不污染壳。
import { useCallback, useEffect, useState } from "react";
import { SettingsSection, type SettingsComponentProps } from "@my-harness-desktop/react";

interface RemoteStatus {
  enabled?: boolean;
  bind?: "loopback" | "lan";
  port?: number;
  lan?: { enabled?: boolean; passwordHash?: string | null; customized?: boolean };
  public?: { passwordHash?: string | null; activeTunnel?: string | null };
}

export function RemoteAccessPage(_props: SettingsComponentProps): React.ReactNode {
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
      <SettingsSection title="远程访问" description="开启后同一局域网的设备可经浏览器访问本机。">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-md)" }}>
          <button disabled={busy} onClick={toggle} style={{ padding: "var(--spacing-sm) var(--spacing-md)" }}>
            {status?.enabled ? "关闭远程访问" : "开启局域网访问"}
          </button>
          <span>{status?.enabled ? "已开启" : "未开启"}</span>
        </div>
        {error && <div style={{ color: "var(--color-danger, #f87171)" }}>{error}</div>}
      </SettingsSection>

      <SettingsSection title="局域网密码" description="8 位数字密码,用于局域网设备登录。">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-md)", flexWrap: "wrap" }}>
          <button disabled={busy} onClick={refreshPassword}>刷新密码</button>
          {freshPassword && <span>新密码: {freshPassword}</span>}
          <input
            value={customPassword}
            onChange={(e) => setCustomPassword(e.target.value)}
            placeholder="自定义 8 位数字"
            maxLength={8}
            style={{ padding: "var(--spacing-sm)", width: 160 }}
          />
          <button disabled={busy || !/^\d{8}$/.test(customPassword)} onClick={setPassword}>设为固定</button>
        </div>
      </SettingsSection>

      {qr && (
        <SettingsSection title="二维码" description="手机扫描后经局域网地址访问。">
          <img src={qr} alt="局域网二维码" width={200} height={200} style={{ borderRadius: "var(--radius-md)" }} />
        </SettingsSection>
      )}

      <SettingsSection title="公网隧道" description="经 cloudflared 生成临时公网地址(需先勾选免责声明)。">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-md)", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", cursor: "pointer" }}>
            <input type="checkbox" checked={disclaimer} onChange={(e) => setDisclaimer(e.target.checked)} />
            我理解公网地址公开可访问,不用于传输敏感数据
          </label>
          <button disabled={busy || (!disclaimer && !tunnelUrl)} onClick={toggleTunnel}>
            {tunnelUrl ? "关闭隧道" : "开启隧道"}
          </button>
          {tunnelUrl && <a href={tunnelUrl} target="_blank" rel="noreferrer">{tunnelUrl}</a>}
        </div>
      </SettingsSection>
    </div>
  );
}
