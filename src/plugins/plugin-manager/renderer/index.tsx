import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Power, PowerOff, Trash2, RotateCw, Download, Shield } from "lucide-react";
import { registerSettingsComponent, usePiApi, type PluginListItem } from "@pi-desktop/react";

registerSettingsComponent("PluginManagerPage", PluginManagerPage);

function PluginManagerPage(): React.ReactNode {
  const { t } = useTranslation();
  const api = usePiApi();
  const [plugins, setPlugins] = useState<PluginListItem[]>([]);
  const [installOpen, setInstallOpen] = useState(false);
  const [installUrl, setInstallUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const refresh = useCallback(async () => {
    setPlugins(await api.plugins.list());
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const showFeedback = (r: { ok: boolean; error: string | null }) => {
    setFeedback(r.ok ? { ok: true, msg: "操作成功" } : { ok: false, msg: r.error ?? "操作失败" });
  };

  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(t);
  }, [feedback]);

  const handleEnable = async (id: string) => { showFeedback(await api.plugins.enable(id)); void refresh(); };
  const handleDisable = async (id: string) => { showFeedback(await api.plugins.disable(id)); void refresh(); };
  const handleUninstall = async (id: string) => { showFeedback(await api.plugins.uninstall(id)); void refresh(); };
  const handleReload = async (id: string) => { showFeedback(await api.plugins.reload(id)); void refresh(); };

  const handleInstall = async () => {
    if (!installUrl.trim()) return;
    setInstalling(true);
    const source = installUrl.startsWith("http")
      ? { type: "url" as const, location: installUrl }
      : { type: "local" as const, location: installUrl };
    showFeedback(await api.plugins.install(source));
    setInstalling(false);
    setInstallOpen(false);
    setInstallUrl("");
    void refresh();
  };

  const handleSelectFile = async () => {
    const path = await api.dialog.openDirectory();
    if (path) {
      setInstallUrl(path);
    }
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--spacing-lg)" }}>
        <h2 style={{ fontSize: "var(--font-size-lg)", fontWeight: 600, color: "var(--color-fg)" }}>{t("settings.plugins", { defaultValue: "插件" })}</h2>
        <button
          onClick={() => setInstallOpen(!installOpen)}
          style={btnStyle(true)}
        >
          <Download size={14} />
          <span>安装插件</span>
        </button>
      </div>

      {installOpen && (
        <div style={{ marginBottom: "var(--spacing-md)", padding: "var(--spacing-md)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", background: "var(--color-surface)", display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <input
            type="text"
            value={installUrl}
            onChange={(e) => setInstallUrl(e.target.value)}
            placeholder="输入 URL 或选择本地文件"
            style={{ flex: 1, padding: "var(--spacing-xs) var(--spacing-sm)", background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", color: "var(--color-fg)", fontSize: "var(--font-size-sm)" }}
          />
          <button onClick={handleSelectFile} style={btnStyle(false)}>选择文件</button>
          <button onClick={handleInstall} disabled={installing || !installUrl.trim()} style={btnStyle(true)}>
            {installing ? "安装中..." : "安装"}
          </button>
        </div>
      )}

      {feedback && (
        <div style={{
          marginBottom: "var(--spacing-md)",
          padding: "var(--spacing-sm) var(--spacing-md)",
          borderRadius: "var(--radius-sm)",
          background: feedback.ok ? "rgba(123,168,139,0.15)" : "rgba(192,122,122,0.15)",
          border: `1px solid ${feedback.ok ? "var(--color-accent-success)" : "var(--color-accent-error)"}`,
          color: feedback.ok ? "var(--color-accent-success)" : "var(--color-accent-error)",
          fontSize: "var(--font-size-sm)",
        }}>
          {feedback.msg}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
        {plugins.map((p) => (
          <div
            key={p.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--spacing-sm)",
              padding: "var(--spacing-sm) var(--spacing-md)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
                <span style={{ fontSize: "var(--font-size-sm)", fontWeight: 500, color: "var(--color-fg)" }}>{p.displayName}</span>
                <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>{p.version}</span>
                {p.protected && <Shield size={11} style={{ color: "var(--color-muted)" }} />}
              </div>
              <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>
                {p.id} · {p.source} · {p.state}
              </div>
            </div>
            <div style={{ display: "flex", gap: "var(--spacing-xs)" }}>
              {p.state === "inactive" && (
                <button onClick={() => handleEnable(p.id)} title="启用" style={iconBtn()}>
                  <Power size={14} />
                </button>
              )}
              {p.state === "active" && (
                <button onClick={() => handleDisable(p.id)} title="禁用" style={iconBtn()}>
                  <PowerOff size={14} />
                </button>
              )}
              {(p.state === "active" || p.state === "error") && (
                <button onClick={() => handleReload(p.id)} title="重载" style={iconBtn()}>
                  <RotateCw size={14} />
                </button>
              )}
              <button
                onClick={() => handleUninstall(p.id)}
                disabled={p.protected}
                title={p.protected ? "受保护，不可卸载" : "卸载"}
                style={iconBtn(p.protected)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function btnStyle(primary: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing-xs)",
    padding: "var(--spacing-xs) var(--spacing-md)",
    border: `1px solid ${primary ? "var(--color-primary)" : "var(--color-border)"}`,
    borderRadius: "var(--radius-sm)",
    background: primary ? "var(--color-primary)" : "transparent",
    color: primary ? "var(--color-primary-fg)" : "var(--color-fg)",
    cursor: "pointer",
    fontSize: "var(--font-size-sm)",
    fontFamily: "var(--font-family-sans)",
  };
}

function iconBtn(disabled = false): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    color: "var(--color-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
  };
}
