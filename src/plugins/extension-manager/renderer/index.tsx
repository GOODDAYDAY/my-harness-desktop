import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {

  SettingsSection,
  Button,
  type SettingsComponentProps,
  usePluginContext,
} from "@pi-desktop/react";
import type { ExtensionInfo } from "@pi-desktop/core";


export function ExtensionManagerPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)" }}>
      <ListSection refreshSignal={refreshSignal} />
      <div style={{ borderTop: "2px solid var(--color-border)", margin: "var(--spacing-xl) 0" }} />
      <InstallSection />
      <PendingRestartSection />
    </div>
  );
}

function ListSection({ refreshSignal }: { refreshSignal: number }): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [search, setSearch] = useState("");

  const loadExtensions = useCallback(() => {
    ctx.extension.list().then((list) => setExtensions(list as ExtensionInfo[]));
  }, [ctx]);

  useEffect(() => {
    loadExtensions();
  }, [loadExtensions, refreshSignal]);

  const handleToggle = async (ext: ExtensionInfo): Promise<void> => {
    if (ext.enabled) await ctx.extension.disable(ext.source);
    else await ctx.extension.enable(ext.source);
    loadExtensions();
  };

  const filtered = extensions
    .filter((ext) => {
      const q = search.toLowerCase();
      return ext.name.toLowerCase().includes(q) || ext.description?.toLowerCase().includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (extensions.length === 0) {
    return (
      <SettingsSection title={t("settings.extensions")}>
        <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", margin: 0 }}>
          {t("ext.empty")}
        </p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t("settings.extensions")}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
        <input
          type="text"
          placeholder={t("ext.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: "var(--spacing-xs) var(--spacing-sm)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-surface)",
            color: "var(--color-fg)",
            fontFamily: "var(--font-family-sans)",
            fontSize: "var(--font-size-sm)",
          }}
        />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: "var(--spacing-sm)",
          }}
        >
          {filtered.map((ext) => (
            <ExtensionCard
              key={ext.source}
              ext={ext}
              canToggle={!ext.disallowOff}
              onToggle={() => void handleToggle(ext)}
            />
          ))}
        </div>

        {filtered.length === 0 && (
          <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", textAlign: "center", padding: "var(--spacing-lg) 0" }}>
            {t("ext.noMatch")}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

function ExtensionCard({
  ext,
  canToggle,
  onToggle,
}: {
  ext: ExtensionInfo;
  canToggle: boolean;
  onToggle: () => void;
}): React.ReactNode {
  const { t } = useTranslation();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-sm)",
        padding: "var(--spacing-md)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-surface)",
        opacity: ext.enabled ? 1 : 0.55,
        transition: "border-color 0.15s, opacity 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
        <span style={{ fontWeight: 600, color: "var(--color-fg)", fontSize: "var(--font-size-sm)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {ext.name}
        </span>
        {ext.disallowOff && (
          <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-accent-warning)" }}>
            &#128274;
          </span>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
        {ext.version && (
          <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", fontFamily: "var(--font-family-mono)" }}>
            v{ext.version}
          </span>
        )}
        <span style={{
          fontSize: "var(--font-size-xs)",
          color: "var(--color-muted)",
          border: "1px solid var(--color-border)",
          padding: "0 var(--spacing-xs)",
          borderRadius: "var(--radius-sm)",
          fontFamily: "var(--font-family-mono)",
        }}>
          {ext.sourceType}
        </span>
      </div>

      {ext.description && (
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", lineHeight: 1.4, minHeight: "1.4em" }}>
          {ext.description}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginTop: "auto" }}>
        {canToggle ? (
          <ToggleSwitch checked={ext.enabled} onChange={onToggle} />
        ) : (
          <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>
            {t("ext.protected")}
          </span>
        )}
      </div>
    </div>
  );
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }): React.ReactNode {
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--spacing-xs)",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <span style={{ fontSize: "var(--font-size-xs)", color: checked ? "var(--color-fg)" : "var(--color-muted)", fontWeight: 500 }}>
        {checked ? "ON" : "OFF"}
      </span>
      <div
        style={{
          width: "36px",
          height: "20px",
          borderRadius: "10px",
          background: checked ? "var(--color-primary)" : "var(--color-border)",
          position: "relative",
          transition: "background 0.2s",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "2px",
            left: checked ? "18px" : "2px",
            width: "16px",
            height: "16px",
            borderRadius: "50%",
            background: "var(--color-primary-fg)",
            transition: "left 0.2s",
          }}
        />
      </div>
    </div>
  );
}

function InstallSection(): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [installSource, setInstallSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState("");

  const handleInstall = async (): Promise<void> => {
    if (!installSource.trim() || installing) return;
    setInstalling(true);
    setInstallProgress("");
    const result = await ctx.extension.install(installSource.trim(), (line) => {
      setInstallProgress((prev) => prev + line);
    });
    setInstalling(false);
    if (result.ok) {
      setInstallSource("");
      setInstallProgress("");
    } else {
      setInstallProgress(result.error ?? t("ext.installFailed"));
    }
  };

  return (
    <SettingsSection title={t("ext.install")}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
        <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", minWidth: "60px" }}>
            {t("ext.source")}
          </span>
          <input
            type="text"
            placeholder={t("ext.sourcePlaceholder")}
            value={installSource}
            onChange={(e) => setInstallSource(e.target.value)}
            disabled={installing}
            style={{
              flex: 1,
              padding: "var(--spacing-xs) var(--spacing-sm)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface)",
              color: "var(--color-fg)",
              fontFamily: "var(--font-family-mono)",
              fontSize: "var(--font-size-sm)",
            }}
          />
          <Button
            variant="primary"
            onClick={() => void handleInstall()}
            disabled={installing || !installSource.trim()}
          >
            {installing ? t("ext.installing") : t("ext.install")}
          </Button>
        </div>
        {installProgress && (
          <pre style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            padding: "var(--spacing-sm) var(--spacing-md)",
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-xs)",
            color: "var(--color-muted)",
            maxHeight: "200px",
            overflowY: "auto",
            margin: 0,
            whiteSpace: "pre-wrap",
          }}>
            {installProgress}
          </pre>
        )}
      </div>
    </SettingsSection>
  );
}

function PendingRestartSection(): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [sessions, setSessions] = useState<{ sessionKey: string; state: { status: string } }[]>([]);

  const loadPending = useCallback(() => {
    ctx.restart.pendingSessions().then((s) => {
      setSessions(s as { sessionKey: string; state: { status: string } }[]);
    });
  }, [ctx]);

  useEffect(() => {
    loadPending();
    const unsub = ctx.restart.onStateChange(() => loadPending());
    return unsub;
  }, [loadPending, ctx]);

  const handleRestart = async (sessionKey: string): Promise<void> => {
    await ctx.restart.restart(sessionKey);
    loadPending();
  };

  const handleRestartAll = async (): Promise<void> => {
    await ctx.restart.restartAllIdle();
    loadPending();
  };

  if (sessions.length === 0) return null;

  return (
    <div style={{ marginTop: "var(--spacing-xl)" }}>
      <SettingsSection title={t("ext.pendingRestart")}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
          {sessions.map((s) => (
            <div key={s.sessionKey} style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
              <span style={{ color: "var(--color-fg)", fontSize: "var(--font-size-sm)" }}>
                {s.sessionKey.split("/").pop() ?? s.sessionKey}
              </span>
              <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-xs)" }}>
                [{s.state.status}]
              </span>
              {s.state.status === "pending" && (
                <button
                  onClick={() => void handleRestart(s.sessionKey)}
                  style={{
                    padding: "2px var(--spacing-sm)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius-sm)",
                    background: "transparent",
                    color: "var(--color-fg)",
                    fontSize: "var(--font-size-xs)",
                    cursor: "pointer",
                    fontFamily: "var(--font-family-sans)",
                  }}
                >
                  {t("ext.reload")}
                </button>
              )}
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--spacing-sm)" }}>
            <button
              onClick={() => void handleRestartAll()}
              style={{
                padding: "var(--spacing-xs) var(--spacing-md)",
                border: "1px solid var(--color-primary)",
                borderRadius: "var(--radius-sm)",
                background: "var(--color-primary)",
                color: "var(--color-primary-fg)",
                fontSize: "var(--font-size-sm)",
                cursor: "pointer",
                fontFamily: "var(--font-family-sans)",
              }}
            >
              {t("ext.reloadAll")}
            </button>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
