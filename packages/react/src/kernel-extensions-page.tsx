// 内核拓展管理共享 UI —— 内核无关的设置页组件(内容层的共享部分)。
//
// pi-manager 与 dsh-manager 的「拓展」TAB 都挂本组件,只传 kernel 参数。
// 功能态统一(docs/core/extension-management.md §0):一根 enabled 轴,合并启用+禁用
// 单一列表;元信息(name/version/description/tags/受保护)两边同形状;重启协调经
// ctx.restart(中性)。本组件只消费 ctx.kernelExtensions(kernel) + ctx.restart,
// 不含任何内核身份分支。
import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { KernelExtensionInfo, KernelId } from "@my-harness-desktop/contract";
import { SettingsSection } from "./settings-section";
import { Button } from "./widgets/button";
import { usePluginContext } from "./plugin-context";

/** tag 筛选态:tag -> "inc"(只看) | "exc"(排除);不存在的 key = 不过滤。 */
type TagFilter = Record<string, "inc" | "exc">;

export interface KernelExtensionsPageProps {
  kernel: KernelId;
  /** 区块标题(内核专属文案:pi = "PI 拓展",dsh = "DSH 拓展",由外层薄封装传翻译好的值)。 */
  title: string;
  refreshSignal?: number;
}

export function KernelExtensionsPage({ kernel, title, refreshSignal = 0 }: KernelExtensionsPageProps): React.ReactNode {
  return (
    <>
      <ListSection kernel={kernel} title={title} refreshSignal={refreshSignal} />
      <div style={{ borderTop: "2px solid var(--color-border)" }} />
      <InstallSection kernel={kernel} />
      <PendingRestartSection />
    </>
  );
}

function ListSection({ kernel, title, refreshSignal }: { kernel: KernelId; title: string; refreshSignal: number }): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [extensions, setExtensions] = useState<KernelExtensionInfo[]>([]);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<TagFilter>({});

  const loadExtensions = useCallback(() => {
    ctx.kernelExtensions.list(kernel).then((list) => setExtensions(list));
  }, [ctx, kernel]);

  useEffect(() => {
    loadExtensions();
  }, [loadExtensions, refreshSignal]);

  useEffect(() => {
    ctx.config.get<TagFilter>("tagFilter").then((saved) => {
      if (saved && typeof saved === "object") setTagFilter(saved);
    });
  }, [ctx]);

  const handleToggle = async (ext: KernelExtensionInfo): Promise<void> => {
    if (ext.enabled) await ctx.kernelExtensions.disable(kernel, ext.id);
    else await ctx.kernelExtensions.enable(kernel, ext.id);
    loadExtensions();
  };

  const cycleTag = (tag: string) => {
    const next = { ...tagFilter };
    if (next[tag] === "inc") next[tag] = "exc";
    else if (next[tag] === "exc") delete next[tag];
    else next[tag] = "inc";
    setTagFilter(next);
    void ctx.config.set("tagFilter", next, { scope: "global" });
  };

  const resetTagFilter = () => {
    setTagFilter({});
    void ctx.config.set("tagFilter", {}, { scope: "global" });
  };

  const allTags = useMemo(() => {
    const present = new Set(extensions.flatMap((e) => e.tags ?? []));
    const recommended = ["desktop", "file", "local", "npm", "git", "protected"].filter((t) => present.has(t));
    const extras = [...present].filter((t) => !["desktop", "file", "local", "npm", "git", "protected"].includes(t)).sort();
    return [...recommended, ...extras];
  }, [extensions]);

  const filtered = extensions
    .filter((ext) => {
      const q = search.toLowerCase();
      return ext.name.toLowerCase().includes(q) || ext.description?.toLowerCase().includes(q);
    })
    .filter((ext) => {
      const inc = Object.keys(tagFilter).filter((k) => tagFilter[k] === "inc");
      const exc = Object.keys(tagFilter).filter((k) => tagFilter[k] === "exc");
      if (inc.length && !ext.tags.some((t) => inc.includes(t))) return false;
      if (exc.length && ext.tags.some((t) => exc.includes(t))) return false;
      return true;
    })
    .sort((a, b) => {
      if (Boolean(a.disallowOff) !== Boolean(b.disallowOff)) return a.disallowOff ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  if (extensions.length === 0) {
    return (
      <SettingsSection title={title}>
        <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", margin: 0 }}>
          {t("ext.empty")}
        </p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={title}>
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

        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-xs)", alignItems: "center" }}>
          {allTags.map((tag) => {
            const st = tagFilter[tag];
            const count = extensions.filter((e) => (e.tags ?? []).includes(tag)).length;
            return (
              <button
                key={tag}
                onClick={() => cycleTag(tag)}
                style={{
                  cursor: "pointer",
                  padding: "2px 10px",
                  fontSize: "var(--font-size-xs)",
                  borderRadius: "var(--radius-md)",
                  border: `1px ${st ? "solid" : "dashed"} ${st === "inc" ? "var(--color-primary)" : st === "exc" ? "var(--color-accent-error)" : "var(--color-border)"}`,
                  background: st === "inc" ? "var(--color-primary)" : "transparent",
                  color: st === "inc" ? "var(--color-primary-fg)" : st === "exc" ? "var(--color-accent-error)" : "var(--color-muted)",
                  textDecoration: st === "exc" ? "line-through" : "none",
                }}
              >
                {t(`ext.tag.${tag}`, { defaultValue: tag })} {count}
              </button>
            );
          })}
          {Object.keys(tagFilter).length > 0 && (
            <button
              onClick={resetTagFilter}
              style={{ cursor: "pointer", border: "none", background: "transparent", color: "var(--color-primary)", fontSize: "var(--font-size-xs)", textDecoration: "underline", padding: "2px 4px" }}
            >
              {t("ext.filterReset")}
            </button>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: "var(--spacing-sm)",
          }}
        >
          {filtered.map((ext) => (
            <ExtensionCard
              key={ext.id}
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
  ext: KernelExtensionInfo;
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
        {(ext.tags ?? []).map((tag) => {
          const isProtected = tag === "protected";
          return (
            <span
              key={tag}
              style={{
                fontSize: "var(--font-size-xs)",
                color: isProtected ? "var(--color-accent-warning)" : "var(--color-muted)",
                border: `1px solid ${isProtected ? "var(--color-accent-warning)" : "var(--color-border)"}`,
                padding: "0 var(--spacing-xs)",
                borderRadius: "var(--radius-sm)",
                fontFamily: "var(--font-family-mono)",
              }}
            >
              {t(`ext.tag.${tag}`, { defaultValue: tag })}
            </span>
          );
        })}
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

function InstallSection({ kernel }: { kernel: KernelId }): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [installSource, setInstallSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState("");

  const handleInstall = async (): Promise<void> => {
    if (!installSource.trim() || installing) return;
    setInstalling(true);
    setInstallProgress("");
    const result = await ctx.kernelExtensions.install(kernel, installSource.trim(), (line) => {
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
