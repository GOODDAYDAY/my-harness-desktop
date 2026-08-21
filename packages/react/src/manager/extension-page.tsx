// packages/react 内核管理共享 base —— 「拓展页」骨架（kernel-design-spec.md §12.6）。
//
// pi-manager 的 ExtensionManagerPage（tag 筛选 + 保护锁标 + 待重启重载）与
// dsh-manager 的 DshExtensionsPage（只有 id/name 卡片 + 静态提示）功能面不同。
// 本组件把搜索 + 卡片网格 + 启停 + 安装 + 重启引导收敛成一份，pi/dsh 只填 spec。
// 元数据缺失（version/description/tags）经「字段留空」降级，protected/pendingRestart
// 经 capabilities 显式降级，不据内核身份分支。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../widgets/button";
import { SettingsSection } from "../settings-section";
import { usePluginContext } from "../plugin-context";
import type { KernelPluginsApi, KernelPluginsCapabilities, NeutralExtension } from "@my-harness-desktop/contract";

export interface ExtensionPageProps {
  api: KernelPluginsApi;
  i18nPrefix: string;
  capabilities: KernelPluginsCapabilities;
}

export function ExtensionPage({ api, i18nPrefix, capabilities }: ExtensionPageProps): React.ReactNode {
  const { t } = useTranslation();
  const k = (suffix: string, vars?: Record<string, unknown>): string => t(`${i18nPrefix}.${suffix}`, vars);
  const [extensions, setExtensions] = useState<NeutralExtension[]>([]);
  const [search, setSearch] = useState("");
  const [installSource, setInstallSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string[]>([]);
  const [installResult, setInstallResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const reload = (): void => { void api.list().then(setExtensions); };
  useEffect(reload, [api]);

  const toggle = async (ext: NeutralExtension): Promise<void> => {
    try {
      if (ext.enabled) setExtensions(await api.disable(ext.id));
      else setExtensions(await api.enable(ext.id));
    } catch (err) {
      console.error("[kernel-plugins] 插件开关失败:", err);
    }
  };

  const install = async (): Promise<void> => {
    const pkg = installSource.trim();
    if (!pkg || installing) return;
    setInstalling(true);
    setInstallOutput([]);
    setInstallResult(null);
    const r = await api.install(pkg, (line) => setInstallOutput((prev) => [...prev, line]));
    setInstalling(false);
    setInstallResult({ ok: r.ok, error: r.error });
    if (r.ok) {
      setInstallSource("");
      reload();
    }
  };

  const q = search.trim().toLowerCase();
  const cards = useMemo(
    () => extensions.filter((e) => !q || e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)),
    [extensions, q],
  );

  return (
    <SettingsSection title={k("title")} description={k("desc")}>
      <input
        type="text"
        placeholder={k("search")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={inputStyle()}
      />
      <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center", margin: "var(--spacing-md) 0" }}>
        <input
          type="text"
          placeholder={k("installPlaceholder")}
          value={installSource}
          onChange={(e) => setInstallSource(e.target.value)}
          disabled={installing}
          style={{ ...inputStyle(), flex: 1 }}
        />
        <Button variant="primary" onClick={() => void install()} disabled={installing || !installSource.trim()}>
          {installing ? k("installing") : k("install")}
        </Button>
      </div>
      {(installing || installOutput.length > 0 || installResult) && (
        <pre style={{
          background: "var(--color-surface)", border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)", padding: "var(--spacing-sm) var(--spacing-md)",
          fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
          color: "var(--color-fg)", maxHeight: "160px", overflowY: "auto", margin: "0 0 var(--spacing-md)",
          whiteSpace: "pre-wrap",
        }}>
          {installOutput.join("\n")}
          {installing && "…"}
          {installResult && (
            <span style={{ color: installResult.ok ? "var(--color-accent-success)" : "var(--color-accent-error)" }}>
              {installResult.ok ? k("installDone") : k("installFailed", { error: installResult.error })}
            </span>
          )}
        </pre>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "var(--spacing-sm)" }}>
        {cards.map((ext) => (
          <div key={ext.id} style={{
            display: "flex", flexDirection: "column", gap: "var(--spacing-sm)",
            padding: "var(--spacing-md)", border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)", background: "var(--color-surface)",
            opacity: ext.enabled ? 1 : 0.55, transition: "opacity 0.15s",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
              <span style={{ fontWeight: 600, color: "var(--color-fg)", fontSize: "var(--font-size-sm)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-family-mono)" }}>
                {ext.id}
              </span>
              {ext.protected && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-accent-warning)" }}>&#128274;</span>}
            </div>
            {(ext.version || ext.description) && (
              <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", fontFamily: "var(--font-family-mono)", wordBreak: "break-all" }}>
                {ext.version && <span>v{ext.version} </span>}{ext.description}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "auto" }}>
              {ext.protected ? (
                <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>{k("protected")}</span>
              ) : (
                <ToggleSwitch checked={ext.enabled} onChange={() => void toggle(ext)} />
              )}
            </div>
          </div>
        ))}
      </div>
      {cards.length === 0 && (
        <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", margin: 0 }}>{k("empty")}</p>
      )}
      {capabilities.pendingRestart && <PendingRestartSection i18nPrefix={i18nPrefix} />}
    </SettingsSection>
  );
}

function PendingRestartSection({ i18nPrefix }: { i18nPrefix: string }): React.ReactNode {
  const { t } = useTranslation();
  const k = (suffix: string): string => t(`${i18nPrefix}.${suffix}`);
  const ctx = usePluginContext();
  const [sessions, setSessions] = useState<{ sessionKey: string; state: { status: string } }[]>([]);

  const load = (): void => {
    void ctx.restart.pendingSessions().then((s) => setSessions(s as { sessionKey: string; state: { status: string } }[]));
  };
  useEffect(() => {
    load();
    return ctx.restart.onStateChange(() => load());
  }, [ctx]);

  if (sessions.length === 0) return null;
  return (
    <div style={{ marginTop: "var(--spacing-xl)" }}>
      <SettingsSection title={k("pendingRestart")}>
        {sessions.map((s) => (
          <div key={s.sessionKey} style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
            <span style={{ color: "var(--color-fg)", fontSize: "var(--font-size-sm)" }}>{s.sessionKey.split("/").pop() ?? s.sessionKey}</span>
            <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-xs)" }}>[{s.state.status}]</span>
            {s.state.status === "pending" && (
              <Button variant="secondary" onClick={() => void ctx.restart.restart(s.sessionKey)} style={{ padding: "2px var(--spacing-sm)" }}>{k("reload")}</Button>
            )}
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--spacing-sm)" }}>
          <Button variant="primary" onClick={() => void ctx.restart.restartAllIdle()} style={{ padding: "var(--spacing-xs) var(--spacing-md)" }}>{k("reloadAll")}</Button>
        </div>
      </SettingsSection>
    </div>
  );
}

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

function inputStyle(): React.CSSProperties {
  return {
    width: "100%", padding: "var(--spacing-xs) var(--spacing-sm)",
    border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
    background: "var(--color-surface)", color: "var(--color-fg)",
    fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)",
    boxSizing: "border-box",
  };
}
