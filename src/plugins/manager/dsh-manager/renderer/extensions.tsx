// dsh-manager 插件 renderer ——「DSH 入口 · DSH 拓展」TAB。
// Cordis 插件树（npm 包 @deepseek-ai/dsh-*，声明在 cordis.yml）。禁用=移出 cordis.yml、启用=还原；
// 安装 = npm install 进 dsh 内核目录 + 写 cordis.yml 项（由 dshPlugins.install 在 main 侧完成）。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, SettingsSection, type SettingsComponentProps, usePluginContext } from "@my-harness-desktop/react";

export function DshExtensionsPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<{ id: string; name: string }[]>([]);
  const [disabled, setDisabled] = useState<{ id: string; name: string }[]>([]);
  const [available, setAvailable] = useState<{ name: string }[]>([]);
  const [search, setSearch] = useState("");
  const [installSource, setInstallSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string[]>([]);
  const [installResult, setInstallResult] = useState<{ ok: boolean; error?: string } | null>(null);

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

  const install = async (): Promise<void> => {
    const pkg = installSource.trim();
    if (!pkg || installing) return;
    setInstalling(true);
    setInstallOutput([]);
    setInstallResult(null);
    const r = await ctx.dshPlugins.install(pkg, (line) => setInstallOutput((prev) => [...prev, line]));
    setInstalling(false);
    setInstallResult({ ok: r.ok, error: r.error });
    if (r.ok) {
      setInstallSource("");
      reload();
    }
  };

  const q = search.trim().toLowerCase();
  const matches = (p: { id?: string; name: string }): boolean =>
    !q || p.name.toLowerCase().includes(q) || (p.id ?? "").toLowerCase().includes(q);
  const cards = [
    ...enabled.map((p) => ({ ...p, on: true })),
    ...disabled.map((p) => ({ ...p, on: false })),
  ].filter((p) => matches(p));
  const filteredAvailable = available.filter((p) => matches(p));
  const enabledNames = new Set(enabled.map((p) => p.name));
  const disabledNames = new Set(disabled.map((p) => p.name));

  return (
    <SettingsSection title={t("dsh.extTitle")} description={t("dsh.extDesc")}>
      <input
        type="text"
        placeholder={t("dsh.extSearch")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{
          width: "100%", padding: "var(--spacing-xs) var(--spacing-sm)",
          border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
          background: "var(--color-surface)", color: "var(--color-fg)",
          fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)",
          boxSizing: "border-box", marginBottom: "var(--spacing-md)",
        }}
      />
      <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center", marginBottom: "var(--spacing-md)" }}>
        <input
          type="text"
          placeholder={t("dsh.extInstallPlaceholder")}
          value={installSource}
          onChange={(e) => setInstallSource(e.target.value)}
          disabled={installing}
          style={{
            flex: 1, padding: "var(--spacing-xs) var(--spacing-sm)",
            border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
            background: "var(--color-surface)", color: "var(--color-fg)",
            fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)", boxSizing: "border-box",
          }}
        />
        <Button variant="primary" onClick={() => void install()} disabled={installing || !installSource.trim()}>
          {installing ? t("dsh.installing") : t("dsh.extInstall")}
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
              {installResult.ok ? t("dsh.extInstallDone") : t("dsh.extInstallFailed", { error: installResult.error })}
            </span>
          )}
        </pre>
      )}
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

      {filteredAvailable.length > 0 && (
        <>
          <div style={{ margin: "var(--spacing-md) 0 var(--spacing-xs)", fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>
            {t("dsh.availableTitle", { count: filteredAvailable.length })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
            {filteredAvailable.map((p) => {
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
      <p style={{ margin: "var(--spacing-md) 0 0", fontSize: "var(--font-size-xs)", color: "var(--color-accent-warning)" }}>
        {t("dsh.extRestartHint")}
      </p>
    </SettingsSection>
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
