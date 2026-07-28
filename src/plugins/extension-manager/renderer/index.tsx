import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { usePiApi, registerSettingsComponent, type SettingsComponentProps } from "@pi-desktop/react";
import type { ExtensionInfo } from "@pi-desktop/core";

function ExtensionManagerPage({ refreshSignal }: SettingsComponentProps) {
  const { t } = useTranslation();
  const api = usePiApi();
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [installSource, setInstallSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState("");
  const [pendingSessions, setPendingSessions] = useState<{ sessionKey: string; state: { status: string; reason?: string } }[]>([]);

  const PAGE_SIZE = 8;

  const loadExtensions = useCallback(() => {
    api.extension.list().then((list) => {
      setExtensions(list as ExtensionInfo[]);
    });
  }, [api]);

  const loadPending = useCallback(() => {
    api.restart.pendingSessions().then((sessions) => {
      setPendingSessions(sessions as { sessionKey: string; state: { status: string; reason?: string } }[]);
    });
  }, [api]);

  useEffect(() => {
    loadExtensions();
    loadPending();
  }, [loadExtensions, loadPending, refreshSignal]);

  useEffect(() => {
    const unsub = api.restart.onStateChange((_key, _state) => {
      loadPending();
    });
    return unsub;
  }, [api, loadPending]);

  const filtered = extensions.filter((ext) => {
    const q = search.toLowerCase();
    return ext.name.toLowerCase().includes(q) || ext.description?.toLowerCase().includes(q);
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleToggle = async (ext: ExtensionInfo) => {
    if (ext.enabled) {
      await api.extension.disable(ext.source);
    } else {
      await api.extension.enable(ext.source);
    }
    loadExtensions();
    loadPending();
  };

  const handleReorder = async (sources: string[]) => {
    await api.extension.reorder(sources);
    loadExtensions();
  };

  const handleInstall = async () => {
    if (!installSource.trim() || installing) return;
    setInstalling(true);
    setInstallProgress("");
    const result = await api.extension.install(installSource.trim(), (line) => {
      setInstallProgress((prev) => prev + line);
    });
    setInstalling(false);
    if (result.ok) {
      setInstallSource("");
      setInstallProgress("");
      loadExtensions();
      loadPending();
    } else {
      setInstallProgress(result.error ?? "安装失败");
    }
  };

  const handleRestart = async (sessionKey: string) => {
    await api.restart.restart(sessionKey);
    loadPending();
  };

  const handleRestartAll = async () => {
    await api.restart.restartAllIdle();
    loadPending();
  };

  const sourceLabel = (ext: ExtensionInfo): string => {
    switch (ext.sourceType) {
      case "file": return ".ts";
      case "local": return "local";
      case "npm": return "npm";
      case "git": return "git";
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "16px" }}>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <input
          type="text"
          placeholder="搜索..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          style={{ flex: 1, padding: "6px 10px", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", color: "var(--color-fg)" }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
        {pageItems.length === 0 && (
          <div style={{ textAlign: "center", padding: "32px", color: "var(--color-muted)" }}>
            {extensions.length === 0 ? "还没有 extension" : "没有匹配结果"}
          </div>
        )}
        {pageItems.map((ext) => (
          <div
            key={ext.source}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "10px 12px",
              background: "var(--color-surface)",
              borderBottom: "1px solid var(--color-border)",
            }}
          >
            {ext.origin === "settings-packages" && (
              <span style={{ cursor: "grab", color: "var(--color-muted)", userSelect: "none" }} title="拖拽排序">☰</span>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontWeight: 600, color: "var(--color-fg)" }}>{ext.name}</span>
                {ext.version && <span style={{ fontSize: "0.8em", color: "var(--color-muted)" }}>v{ext.version}</span>}
                <span style={{ fontSize: "0.7em", color: "var(--color-muted)", border: "1px solid var(--color-border)", padding: "1px 5px", borderRadius: "3px" }}>{sourceLabel(ext)}</span>
              </div>
              {ext.description && <div style={{ fontSize: "0.85em", color: "var(--color-muted)", marginTop: "2px" }}>{ext.description}</div>}
            </div>
            <button
              onClick={() => handleToggle(ext)}
              style={{
                padding: "4px 12px",
                border: ext.enabled ? "none" : "1px solid var(--color-border)",
                borderRadius: "12px",
                cursor: "pointer",
                background: ext.enabled ? "var(--color-primary)" : "transparent",
                color: ext.enabled ? "var(--color-primary-fg)" : "var(--color-muted)",
                fontSize: "0.8em",
                fontWeight: 600,
              }}
            >
              {ext.enabled ? "ON" : "OFF"}
            </button>
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div style={{ display: "flex", gap: "8px", justifyContent: "center", alignItems: "center" }}>
          <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} style={{ padding: "2px 8px", background: "transparent", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", color: "var(--color-fg)" }}>‹</button>
          {Array.from({ length: totalPages }, (_, i) => (
            <button
              key={i}
              onClick={() => setPage(i)}
              style={{
                padding: "2px 8px",
                background: i === page ? "var(--color-primary)" : "transparent",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
                color: i === page ? "var(--color-primary-fg)" : "var(--color-fg)",
              }}
            >
              {i + 1}
            </button>
          ))}
          <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page === totalPages - 1} style={{ padding: "2px 8px", background: "transparent", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", color: "var(--color-fg)" }}>›</button>
          <span style={{ fontSize: "0.8em", color: "var(--color-muted)" }}>共 {filtered.length} 个</span>
        </div>
      )}

      <div style={{ display: "flex", gap: "8px", alignItems: "center", padding: "12px", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
        <span style={{ color: "var(--color-muted)", fontSize: "0.9em" }}>来源</span>
        <input
          type="text"
          placeholder="@scope/pkg 或 git-url 或 /path"
          value={installSource}
          onChange={(e) => setInstallSource(e.target.value)}
          disabled={installing}
          style={{ flex: 1, padding: "6px 10px", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", color: "var(--color-fg)" }}
        />
        <button
          onClick={handleInstall}
          disabled={installing || !installSource.trim()}
          style={{ padding: "6px 16px", background: "var(--color-primary)", color: "var(--color-primary-fg)", border: "none", borderRadius: "var(--radius-sm)", cursor: installing ? "not-allowed" : "pointer" }}
        >
          {installing ? "安装中..." : "安装"}
        </button>
      </div>
      {installProgress && (
        <pre style={{ padding: "8px", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", fontSize: "0.8em", color: "var(--color-muted)", maxHeight: "200px", overflow: "auto", whiteSpace: "pre-wrap" }}>
          {installProgress}
        </pre>
      )}

      {pendingSessions.length > 0 && (
        <div style={{ padding: "12px", background: "var(--color-surface)", border: "1px solid var(--color-accent-warning)", borderRadius: "var(--radius-md)" }}>
          <div style={{ fontSize: "0.9em", color: "var(--color-accent-warning)", marginBottom: "8px" }}>
            ⚠ {pendingSessions.length} 个会话需要重载使配置生效
          </div>
          {pendingSessions.map((s) => (
            <div key={s.sessionKey} style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "4px" }}>
              <span style={{ color: "var(--color-fg)", fontSize: "0.85em" }}>{s.sessionKey.split("/").pop() ?? s.sessionKey}</span>
              <span style={{ color: "var(--color-muted)", fontSize: "0.8em" }}>[{s.state.status}]</span>
              {s.state.status === "pending" && (
                <button onClick={() => handleRestart(s.sessionKey)} style={{ padding: "2px 8px", background: "transparent", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)", color: "var(--color-fg)", fontSize: "0.8em", cursor: "pointer" }}>重载</button>
              )}
            </div>
          ))}
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "8px" }}>
            <button onClick={handleRestartAll} style={{ padding: "4px 12px", background: "var(--color-primary)", color: "var(--color-primary-fg)", border: "none", borderRadius: "var(--radius-sm)", fontSize: "0.8em", cursor: "pointer" }}>全部重载</button>
          </div>
        </div>
      )}
    </div>
  );
}

registerSettingsComponent("ExtensionManagerPage", ExtensionManagerPage);
