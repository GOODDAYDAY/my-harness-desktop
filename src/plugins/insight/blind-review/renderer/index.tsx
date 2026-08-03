import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { EyeOff, Plus, Trash2, Send, MessageSquare, Square, Users } from "lucide-react";
import {
  usePluginContext,
  useUiStore,
  useSessionStore,
  EmptyState,
  SettingsSection,
  Button,
  Select,
  type SettingsComponentProps,
  type FileActionInvokePayload,
} from "@pi-desktop/react";
import {
  resolveConfig,
  squadTeams,
  type AccessLevel,
  type BlindReviewConfig,
  type DefaultContentDict,
  type TeamConfig,
} from "../core/config";
import type { TeamReport } from "../core/assemble";
import type { RunItemStatus, SquadRunState } from "../core/run-state";
import { runSquad, type SquadRunLabels } from "../client/squad-runner";

// invoke 约定频道:收 fileActions 槽触发的文件动作(文件树右键「盲审文件」)。
// 框架加载 module 后自动注册;订阅在 BlindReviewTab 挂载时 attach,eventBus 队列会冲刷等着的 invoke。
export const channels = ["blind-review:fileActionInvoke"] as const;

type Translate = (key: string) => string;

/** 默认编制文案字典:t(key) 不传 vars 是纯查表,prompt 里的 {{content}}/{{tree}} 占位符原样保留。 */
function buildDefaultDict(t: Translate): DefaultContentDict {
  return {
    teams: [
      { id: "correctness", name: t("review.defaults.correctness.name"), prompt: t("review.defaults.correctness.prompt") },
      { id: "security", name: t("review.defaults.security.name"), prompt: t("review.defaults.security.prompt") },
      { id: "logic", name: t("review.defaults.logic.name"), prompt: t("review.defaults.logic.prompt") },
      { id: "hidden-intent", name: t("review.defaults.hiddenIntent.name"), prompt: t("review.defaults.hiddenIntent.prompt") },
    ],
    judgeName: t("review.defaults.judge.name"),
    judgePrompt: t("review.defaults.judge.prompt"),
  };
}

/** 运行期文案:prompt 标注 + 树失败占位 + 会话命名标记,全部按界面语言取。 */
function buildLabels(t: Translate): SquadRunLabels {
  return {
    reportHeading: t("review.label.reportHeading"),
    failedHeading: t("review.label.failedHeading"),
    contentTruncated: t("review.label.contentTruncated"),
    treeTruncated: t("review.label.treeTruncated"),
    treeUnavailable: t("review.label.treeUnavailable"),
    sessionMark: t("review.label.sessionMark"),
  };
}

/** 加载盲审配置(设置页和右面板共用)。统一通道两层合并读:项目级覆盖全局,无项目落全局。 */
async function loadBlindReviewConfig(ctx: ReturnType<typeof usePluginContext>, dict: DefaultContentDict): Promise<BlindReviewConfig> {
  const raw = await ctx.config.all();
  return resolveConfig(raw, dict);
}

export function BlindReviewSettings({ config, onChange, refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const cfg = resolveConfig(config, buildDefaultDict(t));
  const [selectedId, setSelectedId] = useState<string>(cfg.defaultPromptId || cfg.prompts[0]?.id || "");
  const [isAdding, setIsAdding] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editAccess, setEditAccess] = useState<AccessLevel>("content");
  const [editJudgeName, setEditJudgeName] = useState(cfg.judge.name);
  const [editJudgePrompt, setEditJudgePrompt] = useState(cfg.judge.prompt);

  const syncEditor = useCallback((c: BlindReviewConfig, id: string): void => {
    const tpl = c.prompts.find((p) => p.id === id) ?? c.prompts[0];
    if (tpl) {
      setSelectedId(tpl.id);
      setEditName(tpl.name);
      setEditPrompt(tpl.prompt);
      setEditAccess(tpl.access);
    }
  }, []);

  // 框架刷新(refreshSignal 变化)= 重读 configFile 完成:本地未保存编辑按刷新语义丢弃,编辑区同步新配置。
  useEffect(() => {
    syncEditor(cfg, selectedId);
    setEditJudgeName(cfg.judge.name);
    setEditJudgePrompt(cfg.judge.prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  const handleSelect = (tpl: TeamConfig): void => {
    setSelectedId(tpl.id);
    setIsAdding(false);
    setEditName(tpl.name);
    setEditPrompt(tpl.prompt);
    setEditAccess(tpl.access);
  };

  const handleAdd = (): void => {
    setIsAdding(true);
    setEditName("");
    setEditPrompt("");
    setEditAccess("content");
  };

  const handleSave = (): void => {
    if (!editName.trim() || !editPrompt.trim()) return;
    if (isAdding) {
      const id = `tpl-${Date.now()}`;
      onChange({ ...cfg, prompts: [...cfg.prompts, { id, name: editName.trim(), access: editAccess, enabled: true, prompt: editPrompt }] });
      setSelectedId(id);
    } else if (selectedId) {
      onChange({
        ...cfg,
        prompts: cfg.prompts.map((p) => (p.id === selectedId ? { ...p, name: editName.trim(), access: editAccess, prompt: editPrompt } : p)),
      });
    }
    setIsAdding(false);
  };

  const handleCancel = (): void => {
    setIsAdding(false);
    syncEditor(cfg, selectedId);
  };

  const handleDelete = (id: string): void => {
    const prompts = cfg.prompts.filter((p) => p.id !== id);
    const defaultPromptId = cfg.defaultPromptId === id ? (prompts[0]?.id ?? "") : cfg.defaultPromptId;
    onChange({ ...cfg, prompts, defaultPromptId });
    if (selectedId === id) syncEditor({ ...cfg, prompts, defaultPromptId }, "");
  };

  const handleSetDefault = (id: string): void => {
    onChange({ ...cfg, defaultPromptId: id });
  };

  const handleToggleSquad = (id: string): void => {
    onChange({ ...cfg, prompts: cfg.prompts.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)) });
  };

  const handleSaveJudge = (): void => {
    if (!editJudgePrompt.trim()) return;
    onChange({ ...cfg, judge: { name: editJudgeName.trim() || cfg.judge.name, prompt: editJudgePrompt } });
  };

  const showEditor = isAdding || cfg.prompts.length > 0;

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)" }}>
      <SettingsSection title={t("review.blindReview")} description={t("review.blindReviewDesc")}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "var(--spacing-xs)" }}>
          {cfg.prompts.map((tpl) => {
            const isDefault = cfg.defaultPromptId === tpl.id;
            const isSelected = selectedId === tpl.id;
            return (
              <div
                key={tpl.id}
                onClick={() => handleSelect(tpl)}
                style={{
                  ...cardStyle,
                  border: `1px solid ${isDefault ? "var(--color-primary)" : isSelected ? "var(--color-fg)" : "var(--color-border)"}`,
                  background: isSelected ? "var(--color-bg)" : "var(--color-surface)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", marginBottom: "var(--spacing-xs)" }}>
                  <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-fg)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tpl.name}</span>
                  <span style={accessBadgeStyle(tpl.access)}>{t(tpl.access === "project" ? "review.accessProject" : "review.accessContent")}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div
                    onClick={(e) => { e.stopPropagation(); handleToggleSquad(tpl.id); }}
                    title={t("review.inSquadTip")}
                    style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", cursor: "pointer" }}
                  >
                    <div style={toggleSwitchStyle(tpl.enabled)}>
                      <div style={toggleKnobStyle(tpl.enabled)} />
                    </div>
                    <span style={{ fontSize: "var(--font-size-xs)", color: tpl.enabled ? "var(--color-fg)" : "var(--color-muted)" }}>{t("review.inSquad")}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
                    <div
                      onClick={(e) => { e.stopPropagation(); if (!isDefault) handleSetDefault(tpl.id); }}
                      title={t("review.setDefault")}
                      style={{ cursor: isDefault ? "default" : "pointer", fontSize: "var(--font-size-xs)", color: isDefault ? "var(--color-fg)" : "var(--color-muted)" }}
                    >
                      {t("review.default")}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(tpl.id); }}
                      title={t("review.delete")}
                      style={iconBtnStyle}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          <button onClick={handleAdd} style={addCardStyle}>
            <Plus className="size-4" /> {t("review.addTemplate")}
          </button>
        </div>
      </SettingsSection>

      {showEditor && (
        <div style={{ marginTop: "var(--spacing-lg)" }}>
          <SettingsSection title={isAdding ? t("review.addTemplate") : t("review.editTemplate")}>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
              <div>
                <label style={labelStyle}>{t("review.templateName")}</label>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>{t("review.access")}</label>
                <Select value={editAccess} onChange={(v) => setEditAccess(v as AccessLevel)} style={{ width: "100%" }} ariaLabel={t("review.access")}>
                  <option value="content">{t("review.accessContent")}</option>
                  <option value="project">{t("review.accessProject")}</option>
                </Select>
              </div>
              <div>
                <label style={labelStyle}>{t("review.templatePrompt")}</label>
                <textarea
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  placeholder={t("review.templatePromptPlaceholder")}
                  style={textareaStyle}
                />
              </div>
              <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
                <Button
                  variant="primary"
                  onClick={handleSave}
                  disabled={!editName.trim() || !editPrompt.trim()}
                >
                  {t("review.save")}
                </Button>
                <Button variant="secondary" onClick={handleCancel}>
                  {t("review.cancel")}
                </Button>
              </div>
            </div>
          </SettingsSection>
        </div>
      )}

      <div style={{ marginTop: "var(--spacing-lg)" }}>
        <SettingsSection title={t("review.judgeSection")} description={t("review.judgeSectionDesc")}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
            <div>
              <label style={labelStyle}>{t("review.templateName")}</label>
              <input
                value={editJudgeName}
                onChange={(e) => setEditJudgeName(e.target.value)}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>{t("review.templatePrompt")}</label>
              <textarea
                value={editJudgePrompt}
                onChange={(e) => setEditJudgePrompt(e.target.value)}
                placeholder={t("review.judgePromptPlaceholder")}
                style={textareaStyle}
              />
            </div>
            <div>
              <Button variant="primary" onClick={handleSaveJudge} disabled={!editJudgePrompt.trim()}>
                {t("review.save")}
              </Button>
            </div>
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}

interface ReviewResult {
  reports: TeamReport[];
  judgeText: string | null;
}

const STATUS_COLOR: Record<RunItemStatus, string> = {
  pending: "var(--color-muted)",
  running: "var(--color-primary)",
  done: "var(--color-accent-success)",
  failed: "var(--color-accent-error)",
  skipped: "var(--color-muted)",
};

export function BlindReviewTab({ isActive }: { isActive: boolean }): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const { currentCwd } = useUiStore();
  const streaming = useSessionStore((s) => s.streaming);
  const [cfg, setCfg] = useState<BlindReviewConfig | null>(null);
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [runState, setRunState] = useState<SquadRunState | null>(null);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noReply, setNoReply] = useState(false);
  const cancelRef = useRef(false);
  // 文件动作 invoke 的待发 payload:订阅即收(队列冲刷),但 cfg 可能在途、或上一轮审查还在跑——
  // 先落 ref,条件就绪后由处理效应消费,不 sleep 不轮询。
  const pendingFileRef = useRef<{ path: string } | null>(null);
  const [pendingFileTick, setPendingFileTick] = useState(0);

  const loadConfig = useCallback(async () => {
    const resolved = await loadBlindReviewConfig(ctx, buildDefaultDict(t));
    setCfg(resolved);
    setSelectedPromptId((prev) => prev || resolved.defaultPromptId);
    // currentCwd 在依赖数组而非函数体:统一通道 main 侧自动解析当前项目,
    // 这里订阅 cwd 只为切项目时重建引用、触发重读(项目层配置随项目切换)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, currentCwd, t]);

  useEffect(() => {
    if (isActive) void loadConfig();
  }, [isActive, loadConfig]);

  // 设置页改了配置 → settings:changed 广播 → 重新加载(统一配置源,消灭双源失同步)。
  useEffect(() => {
    const off = ctx.events.on("system:settingsChanged", () => {
      void loadConfig();
    });
    return off;
  }, [ctx.events, loadConfig]);

  // cwd 守卫:审查在途时切工作目录,fs 圈禁锚点已变、继续跑语义即错——立即中止。
  useEffect(() => {
    if (running && cancelRef.current === false) {
      cancelRef.current = true;
      void ctx.messaging.abort();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd]);

  const run = useCallback(async (content: string, mode: "squad" | "single"): Promise<void> => {
    if (!cfg || running || !currentCwd) return;
    const teams = mode === "squad" ? squadTeams(cfg) : cfg.prompts.filter((p) => p.id === selectedPromptId);
    if (teams.length === 0) {
      setError(t("review.squadEmpty"));
      return;
    }
    cancelRef.current = false;
    setRunning(true);
    setRunState(null);
    setResult(null);
    setError(null);
    try {
      const r = await runSquad(ctx, {
        cwd: currentCwd,
        content,
        teams,
        judge: mode === "squad" ? cfg.judge : null,
        labels: buildLabels(t),
        onProgress: setRunState,
        isCancelled: () => cancelRef.current,
      });
      if (r.cancelled) setError(t("review.aborted"));
      else setResult({ reports: r.reports, judgeText: r.judgeText });
    } catch {
      setError(t("review.sendFailed"));
    } finally {
      setRunning(false);
    }
  }, [cfg, running, currentCwd, selectedPromptId, ctx, t]);

  const handleAbort = (): void => {
    cancelRef.current = true;
    void ctx.messaging.abort();
  };

  const handleReviewLastReply = async (): Promise<void> => {
    let text: string;
    try {
      text = await ctx.maintenance.getLastAssistantText();
    } catch {
      text = "";
    }
    if (!text.trim()) {
      setNoReply(true);
      setTimeout(() => setNoReply(false), 3000);
      return;
    }
    await run(text, "squad");
  };

  // 文件动作 invoke(插件卸载时总线会补发 null,守卫掉)。
  useEffect(() => {
    const off = ctx.events.on("blind-review:fileActionInvoke", (payload) => {
      const p = payload as FileActionInvokePayload | null;
      if (!p || p.isDir) return;
      pendingFileRef.current = { path: p.path };
      setPendingFileTick((n) => n + 1);
    });
    return off;
  }, [ctx.events]);

  // 消费待发文件动作:读文件 → 全编制审查(右键一步到位的语义,不经输入框)。
  // running 时不消费——payload 留在 ref 里,本轮跑完后 effect 重跑自然接上。
  useEffect(() => {
    const pending = pendingFileRef.current;
    if (!pending || !cfg || running || !currentCwd) return;
    pendingFileRef.current = null;
    void (async () => {
      let content: string;
      try {
        const text = await ctx.fs?.readFile(pending.path);
        if (text == null) throw new Error("fs unavailable");
        content = text;
      } catch {
        setError(t("review.readFileFailed"));
        return;
      }
      await run(content, "squad");
    })();
  }, [cfg, pendingFileTick, running, currentCwd, ctx, t, run]);

  if (!cfg) return null;

  if (cfg.prompts.length === 0) {
    return (
      <EmptyState
        icon={<EyeOff className="size-8" />}
        title={t("review.noTemplates")}
        description={t("review.noTemplatesDesc")}
      />
    );
  }

  const canSend = input.trim().length > 0 && !running && !streaming && !!currentCwd;

  const statusLabel = (s: RunItemStatus): string =>
    s === "pending" ? t("review.statusPending")
    : s === "running" ? t("review.statusRunning")
    : s === "done" ? t("review.statusDone")
    : s === "skipped" ? t("review.statusSkipped")
    : t("review.statusFailed");

  return (
    <div className="flex-1 flex flex-col min-h-0 p-3 gap-2 overflow-y-auto">
      <Select
        value={selectedPromptId}
        onChange={setSelectedPromptId}
        style={{ width: "100%" }}
        ariaLabel={t("review.templatePrompt")}
      >
        {cfg.prompts.map((tpl) => (
          <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
        ))}
      </Select>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={t("review.pasteContent")}
        style={reviewTextareaStyle}
        disabled={running}
      />

      <Button
        variant="primary"
        onClick={() => { void run(input, "squad"); setInput(""); }}
        disabled={!canSend || squadTeams(cfg).length === 0}
      >
        <Users className="size-3.5" /> {t("review.squadReview")}
      </Button>

      <div style={{ display: "flex", gap: "var(--spacing-xs)" }}>
        <Button
          variant="secondary"
          onClick={() => { void run(input, "single"); setInput(""); }}
          disabled={!canSend}
          style={{ flex: 1 }}
        >
          <Send className="size-3.5" /> {t("review.singleReview")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => void handleReviewLastReply()}
          disabled={running || streaming}
          style={{ flex: 1 }}
        >
          <MessageSquare className="size-3.5" /> {t("review.reviewLastReply")}
        </Button>
      </div>

      {noReply && (
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", textAlign: "center" }}>
          {t("review.noLastReply")}
        </div>
      )}

      {!currentCwd && (
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", textAlign: "center" }}>
          {t("review.selectWorkdir")}
        </div>
      )}

      {runState && (
        <>
          <div style={{ borderTop: "1px solid var(--color-border)", margin: "var(--spacing-xs) 0" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
            {runState.teams.map((team) => (
              <div key={team.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "var(--font-size-xs)" }}>
                <span style={{ color: "var(--color-fg)" }}>{team.name}</span>
                <span style={{ color: STATUS_COLOR[team.status] }}>{statusLabel(team.status)}</span>
              </div>
            ))}
            {runState.judgeStatus !== null && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "var(--font-size-xs)" }}>
                <span style={{ color: "var(--color-fg)" }}>{t("review.judge")}</span>
                <span style={{ color: STATUS_COLOR[runState.judgeStatus] }}>{statusLabel(runState.judgeStatus)}</span>
              </div>
            )}
            {running && (
              <Button variant="secondary" onClick={handleAbort}>
                <Square className="size-3" /> {t("review.abort")}
              </Button>
            )}
          </div>
        </>
      )}

      {error && (
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-accent-error)", textAlign: "center" }}>
          {error}
        </div>
      )}

      {result && (
        <>
          <div style={{ borderTop: "1px solid var(--color-border)", margin: "var(--spacing-xs) 0" }} />
          {result.judgeText && (
            <>
              <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", fontWeight: 600 }}>
                {t("review.judgeReport")}
              </div>
              <div style={resultStyle}>
                <pre style={preStyle}>{result.judgeText}</pre>
              </div>
            </>
          )}
          <details style={{ fontSize: "var(--font-size-xs)" }}>
            <summary style={{ cursor: "pointer", color: "var(--color-muted)", fontWeight: 600 }}>{t("review.teamReports")}</summary>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", marginTop: "var(--spacing-xs)" }}>
              {result.reports.map((r) => (
                <div key={r.teamId}>
                  <div style={{ color: r.ok ? "var(--color-fg)" : "var(--color-accent-error)", marginBottom: "var(--spacing-xs)" }}>
                    {r.teamName}{!r.ok && ` (${t("review.statusFailed")})`}
                  </div>
                  <div style={reportItemStyle}>
                    <pre style={preStyle}>{r.text}</pre>
                  </div>
                </div>
              ))}
            </div>
          </details>
        </>
      )}
    </div>
  );
}

const iconBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "22px",
  height: "22px",
  border: "none",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--color-muted)",
  cursor: "pointer",
};

const toggleSwitchStyle = (on: boolean): React.CSSProperties => ({
  width: "32px",
  height: "18px",
  borderRadius: "9px",
  background: on ? "var(--color-accent-success)" : "var(--color-border)",
  position: "relative",
  flexShrink: 0,
  transition: "background 0.2s",
});

const toggleKnobStyle = (on: boolean): React.CSSProperties => ({
  position: "absolute",
  width: "14px",
  height: "14px",
  borderRadius: "50%",
  background: "var(--color-fg)",
  top: "2px",
  left: on ? "16px" : "2px",
  transition: "left 0.2s",
});

const accessBadgeStyle = (access: AccessLevel): React.CSSProperties => ({
  fontSize: "var(--font-size-xs)",
  color: access === "project" ? "var(--color-primary)" : "var(--color-muted)",
  border: `1px solid ${access === "project" ? "var(--color-primary)" : "var(--color-border)"}`,
  borderRadius: "var(--radius-sm)",
  padding: "0 var(--spacing-xs)",
  flexShrink: 0,
});

const cardStyle: React.CSSProperties = {
  borderRadius: "var(--radius-sm)",
  padding: "var(--spacing-xs) var(--spacing-sm)",
  cursor: "pointer",
};

const addCardStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--spacing-xs)",
  padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "1px dashed var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--color-muted)",
  fontFamily: "var(--font-family-sans)",
  fontSize: "var(--font-size-sm)",
  cursor: "pointer",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "var(--font-size-sm)",
  fontWeight: 500,
  marginBottom: "var(--spacing-xs)",
  color: "var(--color-fg)",
};

const inputStyle: React.CSSProperties = {
  padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
  color: "var(--color-fg)",
  fontFamily: "var(--font-family-sans)",
  fontSize: "var(--font-size-sm)",
  width: "100%",
  boxSizing: "border-box",
};

const textareaStyle: React.CSSProperties = {
  padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
  color: "var(--color-fg)",
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-sm)",
  width: "100%",
  minHeight: "120px",
  resize: "vertical",
  boxSizing: "border-box",
};

const reviewTextareaStyle: React.CSSProperties = {
  padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
  color: "var(--color-fg)",
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-sm)",
  width: "100%",
  minHeight: "120px",
  resize: "none",
  boxSizing: "border-box",
};

const resultStyle: React.CSSProperties = {
  maxHeight: "300px",
  overflowY: "auto",
  padding: "var(--spacing-sm)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
};

const reportItemStyle: React.CSSProperties = {
  maxHeight: "160px",
  overflowY: "auto",
  padding: "var(--spacing-sm)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
};

const preStyle: React.CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-xs)",
  lineHeight: 1.5,
};
