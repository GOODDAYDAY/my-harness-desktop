// 远程访问设置页(web-service §38)——经 window.kernel.remote.* 控制(§18.6)。
// 纯内容层壳插件:开关/密码/二维码,不碰网关实现。文案经 i18n(contributes.languages)。
// 公网隧道已移除(先只做本机与局域网)。
//
// 布局约定(第 16 项修订):
// - 「远程访问」一个板块收纳全部访问入口:开关(标题行)、本机地址、局域网地址、二维码;
// - 行内「左标签 + 右控件」两端对齐铺满宽度,不堆左侧、少换行;
// - 控件一律用框架 Button(control-geometry 等高);输入框按同一几何契约手写尺寸。
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button, SettingsSection } from "@my-harness-desktop/react";

/** 脱敏后的远程访问状态(服务端不落 hash 出边界)。 */
interface RemoteStatus {
  enabled?: boolean;
  bind?: "loopback" | "lan";
  port?: number;
  lanUrls?: string[];
  lan?: { enabled?: boolean; hasPassword?: boolean; customized?: boolean };
  freshPassword?: string | null;
}

/** 已连接设备行(第 23 项):服务端 ConnectionInfo 的结构化本地声明。 */
interface DeviceRow {
  id: string;
  kind: "local" | "remote";
  authenticated: boolean;
  remoteAddress?: string;
  connectedAt?: number;
}

/** 输入框几何对齐框架 Button:同 padding/边框/行高(见 widgets/control-geometry)。 */
const inputStyle: CSSProperties = {
  padding: "var(--spacing-xs) var(--spacing-md)",
  borderWidth: "var(--border-width-thin)",
  borderStyle: "solid",
  borderColor: "var(--color-border)",
  borderRadius: "var(--radius-sm)",
  fontSize: "var(--font-size-sm)",
  lineHeight: 1.4,
  background: "transparent",
  color: "var(--color-fg)",
  outline: "none",
};

/** 全宽行:左标签 + 右控件,两端对齐——铺满可用宽度,不堆在左侧。 */
const spreadRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--spacing-md)",
  flexWrap: "wrap",
};

const labelStyle: CSSProperties = {
  fontSize: "var(--font-size-sm)",
  color: "var(--color-fg)",
  fontWeight: 500,
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--font-size-sm)",
  color: "var(--color-muted)",
  lineHeight: 1.5,
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-sm)",
};

/** 链接 + 复制:等宽底纹链接点击直达(浏览器新标签 / Electron 转系统浏览器)。 */
function UrlValue({ url }: { url: string }): React.ReactNode {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = () => {
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    }).catch(() => { /* 剪贴板不可用:保持可手动选择复制 */ });
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--spacing-sm)" }}>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={t("remote.openInBrowser")}
        style={{
          ...monoStyle,
          color: "var(--color-accent-success)",
          textDecoration: "none",
          padding: "var(--spacing-xs) var(--spacing-sm)",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-surface)",
          userSelect: "text",
        }}
      >
        {url}
      </a>
      <Button variant="secondary" onClick={copy}>
        {copied ? t("remote.copied") : t("remote.copy")}
      </Button>
    </span>
  );
}

export function RemoteAccessPage(): React.ReactNode {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [freshPassword, setFreshPassword] = useState<string | null>(null);
  const [customPassword, setCustomPassword] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pwdCopied, setPwdCopied] = useState(false);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const pwdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (pwdTimer.current) clearTimeout(pwdTimer.current); }, []);

  const refresh = useCallback(() => {
    void window.kernel.remote.status().then((s) => {
      const st = s as RemoteStatus & { freshPassword?: string | null };
      setStatus(st);
      // 第 20 项:服务端随广播下发可展示密码——任一端开启/刷新,所有端打开都可见,
      // 不再只有操作端看得到(此前「不展示密码」的多端盲区根因)。
      if (st.freshPassword) setFreshPassword(st.freshPassword);
    }).catch(() => {});
    void window.kernel.remote.qr().then((q) => setQr(q)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // 任一客户端改了配置,服务端广播 stateChanged → 本页同步刷新。
    const off = window.kernel.remote.onStateChanged(() => refresh());
    return off;
  }, [refresh]);

  // 设备列表(第 23 项):挂载拉一次 + connectionsChanged 事件驱动刷新(不轮询)。
  const loadDevices = useCallback(() => {
    void window.kernel.remote.connections().then((l) => setDevices((l as DeviceRow[]) ?? [])).catch(() => {});
  }, []);
  useEffect(() => {
    loadDevices();
    const off = window.kernel.remote.onConnectionsChanged?.((l) => setDevices((l as DeviceRow[]) ?? []));
    return () => { off?.(); };
  }, [loadDevices]);

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

  const enabled = !!status?.enabled;
  const port = status?.port;
  const localUrl = port ? `http://127.0.0.1:${port}/` : null;
  const lanUrl = status?.lanUrls?.[0] && port ? `http://${status.lanUrls[0]}:${port}/` : null;

  // 强度预校验与服务端 validatePasswordStrength 同规则(§8.1 修订):先本地提示,服务端兜底。
  const strengthError = (pwd: string): string | null => {
    if (pwd.length < 10) return t("remote.tooShort");
    if (!/\d/.test(pwd)) return t("remote.needDigit");
    if (!/[a-zA-Z]/.test(pwd)) return t("remote.needLetter");
    if (!/[^a-zA-Z0-9]/.test(pwd)) return t("remote.needSymbol");
    return null;
  };

  const toggle = () =>
    run(async () => {
      if (enabled) {
        await window.kernel.remote.stop();
        setFreshPassword(null);
        return;
      }
      // 开启即刷新一次密码:未固定自定义密码时服务端生成新强密码并随响应返回明文展示;
      // 已固定自定义密码则沿用持久化的那份(不覆盖用户设置)。
      const res = (await window.kernel.remote.start()) as { newPassword?: string };
      if (res?.newPassword) setFreshPassword(res.newPassword);
    });

  const refreshPassword = () =>
    run(async () => {
      const pwd = await window.kernel.remote.refreshPassword();
      setFreshPassword(pwd);
    });

  const setPassword = () =>
    run(async () => {
      await window.kernel.remote.setPassword(customPassword);
      setFreshPassword(null);
      setCustomPassword("");
    });

  const copyFresh = () => {
    if (!freshPassword) return;
    void navigator.clipboard?.writeText(freshPassword).then(() => {
      setPwdCopied(true);
      if (pwdTimer.current) clearTimeout(pwdTimer.current);
      pwdTimer.current = setTimeout(() => setPwdCopied(false), 1600);
    }).catch(() => {});
  };

  // 设备管理(第 23/24 项):踢单个 / 踢全部。close 事件回推新清单,列表自动更新。
  const kick = (id: string) => run(async () => { await window.kernel.remote.kick(id); loadDevices(); });
  const kickAll = () => run(async () => { await window.kernel.remote.kickAll(); loadDevices(); });

  return (
    <div style={{ padding: "var(--spacing-lg)", display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      {/* ── 远程访问:开关(标题行)+ 全部访问入口(本机/局域网/二维码) ── */}
      <SettingsSection
        title={t("remote.access")}
        description={t("remote.accessDesc")}
        actions={
          <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--spacing-md)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--spacing-xs)", fontSize: "var(--font-size-sm)", color: enabled ? "var(--color-fg)" : "var(--color-muted)" }}>
              <span
                aria-hidden
                style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: enabled ? "var(--color-accent-success)" : "var(--color-border)",
                }}
              />
              {enabled ? t("remote.enabled") : t("remote.disabled")}
            </span>
            <Button variant={enabled ? "danger" : "primary"} disabled={busy} onClick={toggle}>
              {enabled ? t("remote.stop") : t("remote.start")}
            </Button>
          </span>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
          {localUrl && (
            <div style={spreadRowStyle}>
              <span style={labelStyle}>{t("remote.localAccess")}</span>
              <UrlValue url={localUrl} />
            </div>
          )}
          {enabled && lanUrl && (
            <div style={spreadRowStyle}>
              <span style={labelStyle}>{t("remote.lanAccess")}</span>
              <UrlValue url={lanUrl} />
            </div>
          )}
          {enabled && qr && lanUrl ? (
            <div style={spreadRowStyle}>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)", maxWidth: 420 }}>
                <span style={labelStyle}>{t("remote.qr")}</span>
                <p style={hintStyle}>{t("remote.qrDesc")}</p>
              </div>
              <img
                src={qr}
                alt={t("remote.qr")}
                width={160}
                height={160}
                style={{ borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", flexShrink: 0 }}
              />
            </div>
          ) : (
            <p style={hintStyle}>{t("remote.qrDisabledHint")}</p>
          )}
          <p style={hintStyle}>{t("remote.restartHint")}</p>
          {error && (
            <p style={{ margin: 0, fontSize: "var(--font-size-sm)", color: "var(--color-accent-error)" }}>{error}</p>
          )}
        </div>
      </SettingsSection>

      {/* ── 已连接设备(第 23/24 项):列表 + 踢单个 + 踢全部 ──────── */}
      <SettingsSection title={t("remote.devices")} description={t("remote.devicesDesc")}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
          {devices.length === 0 ? (
            <p style={hintStyle}>{t("remote.noDevices")}</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
              {devices.map((d) => (
                <div key={d.id} style={spreadRowStyle}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--spacing-sm)", flexWrap: "wrap" }}>
                    <span
                      aria-hidden
                      style={{ width: 8, height: 8, borderRadius: "50%", background: d.kind === "local" ? "var(--color-accent-success)" : "var(--color-primary)" }}
                    />
                    <span style={{ ...labelStyle }}>
                      {d.kind === "local" ? t("remote.kindLocal") : t("remote.kindRemote")}
                    </span>
                    <span style={{ ...monoStyle, color: "var(--color-muted)" }}>{d.remoteAddress ?? "—"}</span>
                    {d.connectedAt ? (
                      <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>
                        {new Date(d.connectedAt * 1000).toLocaleTimeString()}
                      </span>
                    ) : null}
                  </span>
                  <Button variant="danger" disabled={busy} onClick={() => void kick(d.id)}>
                    {t("remote.kick")}
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div style={spreadRowStyle}>
            <span style={hintStyle}>{t("remote.kickHint")}</span>
            <Button variant="danger" disabled={busy || devices.length === 0} onClick={() => void kickAll()}>
              {t("remote.kickAll")}
            </Button>
          </div>
        </div>
      </SettingsSection>

      {/* ── 局域网密码:一行收齐(左刷新+状态 / 右新密码+自定义+固定) ── */}
      <SettingsSection title={t("remote.lanPassword")} description={t("remote.lanPasswordDesc")}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
          <div style={spreadRowStyle}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--spacing-sm)", flexWrap: "wrap" }}>
              <Button variant="secondary" disabled={busy} onClick={refreshPassword}>
                {t("remote.refreshPassword")}
              </Button>
              {status?.lan?.customized ? (
                <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-accent-success)" }}>{t("remote.customizedBadge")}</span>
              ) : (
                <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("remote.autoGenerated")}</span>
              )}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--spacing-sm)", flexWrap: "wrap", justifyContent: "flex-end" }}>
              {freshPassword && (
                <>
                  <span style={{ ...monoStyle, fontSize: "var(--font-size-base)", fontWeight: 600, letterSpacing: "0.06em", userSelect: "text", padding: "var(--spacing-xs) var(--spacing-sm)", borderRadius: "var(--radius-sm)", background: "var(--color-surface)" }}>
                    {freshPassword}
                  </span>
                  <Button variant="secondary" onClick={copyFresh}>
                    {pwdCopied ? t("remote.copied") : t("remote.copy")}
                  </Button>
                </>
              )}
              <input
                value={customPassword}
                onChange={(e) => setCustomPassword(e.target.value.slice(0, 64))}
                placeholder={t("remote.customPlaceholder")}
                autoComplete="new-password"
                style={{ ...inputStyle, width: 200 }}
              />
              <Button variant="secondary" disabled={busy || strengthError(customPassword) !== null} onClick={() => void setPassword()}>
                {t("remote.setFixed")}
              </Button>
            </span>
          </div>
          <p style={hintStyle}>{t("remote.passwordPolicy")}</p>
        </div>
      </SettingsSection>
    </div>
  );
}
