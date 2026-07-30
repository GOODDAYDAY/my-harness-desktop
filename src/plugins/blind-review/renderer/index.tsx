import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { EyeOff, Plus, Trash2, Send, MessageSquare } from "lucide-react";
import {


  usePluginContext,
  useUiStore,
  useSessionStore,
  EmptyState,
  SettingsSection,
  Button,
  Select,
  type SettingsComponentProps,
} from "@pi-desktop/react";

const CONFIG_REL_PATH = "config/blind-review.json";


interface PromptTemplate {
  id: string;
  name: string;
  prompt: string;
}

interface BlindReviewConfig {
  prompts: PromptTemplate[];
  defaultPromptId: string;
}

const DEFAULT_CONFIG: BlindReviewConfig = {
  prompts: [
    {
      id: "correctness",
      name: "正确性审查",
      prompt:
        "请审查以下内容，只关注会导致错误的实际问题：编译失败、逻辑错误、类型错误、缺失的导入。不要报告风格问题或主观建议。如果不确定是问题，不要报告。\n\n```\n{{content}}\n```",
    },
    {
      id: "security",
      name: "安全审查",
      prompt:
        "从安全角度审查以下内容：注入风险、越权、敏感信息泄露、认证缺陷。只报告高置信度问题。\n\n```\n{{content}}\n```",
    },
    {
      id: "logic",
      name: "逻辑审查",
      prompt:
        "审查以下内容的逻辑正确性。关注：边界条件、空值处理、异常路径、并发问题。\n\n```\n{{content}}\n```",
    },
  ],
  defaultPromptId: "correctness",
};

function resolveConfig(raw: Record<string, unknown> | null): BlindReviewConfig {
  if (!raw || !raw.prompts || !Array.isArray(raw.prompts) || (raw.prompts as unknown[]).length === 0) {
    return DEFAULT_CONFIG;
  }
  return {
    prompts: (raw.prompts as PromptTemplate[]).filter((p) => p && p.id && p.name && p.prompt),
    defaultPromptId: typeof raw.defaultPromptId === "string" ? raw.defaultPromptId : (raw.prompts as PromptTemplate[])[0]?.id ?? "correctness",
  };
}

function assemblePrompt(template: PromptTemplate, content: string): string {
  return template.prompt.replace("{{content}}", content);
}

/** 从 NeutralMessage.content 提取纯文本(与 session-store textOf 同逻辑,本地复制避免跨层 import)。 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text")
      .map((c) => String((c as Record<string, unknown>).text ?? ""))
      .join("");
  }
  return "";
}

/** 加载盲审配置(设置页和右面板共用)。有 cwd 走分层读,无 cwd 退回用户级直接读。 */
async function loadBlindReviewConfig(ctx: ReturnType<typeof usePluginContext>, cwd: string | null): Promise<BlindReviewConfig> {
  if (cwd) {
    const raw = await ctx.configFile.getLayered(cwd, CONFIG_REL_PATH);
    return resolveConfig(raw);
  }
  const raw = await ctx.configFile.get(`~/.pi-desktop/${CONFIG_REL_PATH}`);
  return resolveConfig(raw);
}

export function BlindReviewSettings({ config, onChange, refreshSignal }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const cfg = resolveConfig(config);
  const [selectedId, setSelectedId] = useState<string>(cfg.defaultPromptId || cfg.prompts[0]?.id || "");
  const [isAdding, setIsAdding] = useState(false);
  const [editName, setEditName] = useState(cfg.prompts.find((p) => p.id === (cfg.defaultPromptId || cfg.prompts[0]?.id))?.name ?? "");
  const [editPrompt, setEditPrompt] = useState(cfg.prompts.find((p) => p.id === (cfg.defaultPromptId || cfg.prompts[0]?.id))?.prompt ?? "");

  const handleSelect = (tpl: PromptTemplate): void => {
    setSelectedId(tpl.id);
    setIsAdding(false);
    setEditName(tpl.name);
    setEditPrompt(tpl.prompt);
  };

  const handleAdd = (): void => {
    setIsAdding(true);
    setEditName("");
    setEditPrompt("");
  };

  const handleSave = (): void => {
    if (!editName.trim() || !editPrompt.trim()) return;
    if (isAdding) {
      const id = `tpl-${Date.now()}`;
      onChange({ ...cfg, prompts: [...cfg.prompts, { id, name: editName.trim(), prompt: editPrompt }] });
      setSelectedId(id);
    } else if (selectedId) {
      onChange({
        ...cfg,
        prompts: cfg.prompts.map((p) => (p.id === selectedId ? { ...p, name: editName.trim(), prompt: editPrompt } : p)),
      });
    }
    setIsAdding(false);
  };

  const handleCancel = (): void => {
    setIsAdding(false);
    const tpl = cfg.prompts.find((p) => p.id === selectedId);
    if (tpl) {
      setEditName(tpl.name);
      setEditPrompt(tpl.prompt);
    }
  };

  const handleDelete = (id: string): void => {
    const prompts = cfg.prompts.filter((p) => p.id !== id);
    const defaultPromptId = cfg.defaultPromptId === id ? (prompts[0]?.id ?? "") : cfg.defaultPromptId;
    onChange({ prompts, defaultPromptId });
    if (selectedId === id) {
      const next = prompts[0];
      if (next) {
        setSelectedId(next.id);
        setEditName(next.name);
        setEditPrompt(next.prompt);
      }
    }
  };

  const handleSetDefault = (id: string): void => {
    onChange({ ...cfg, defaultPromptId: id });
  };

  useEffect(() => {
    if (!cfg.prompts.find((p) => p.id === selectedId)) {
      const next = cfg.prompts[0];
      if (next) {
        setSelectedId(next.id);
        setEditName(next.name);
        setEditPrompt(next.prompt);
      }
    }
  }, [cfg, selectedId, refreshSignal]);

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
                <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-fg)", marginBottom: "var(--spacing-xs)" }}>{tpl.name}</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div
                    onClick={(e) => { e.stopPropagation(); if (!isDefault) handleSetDefault(tpl.id); }}
                    style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", cursor: isDefault ? "default" : "pointer" }}
                  >
                    <div style={toggleSwitchStyle(isDefault)}>
                      <div style={toggleKnobStyle(isDefault)} />
                    </div>
                    <span style={{ fontSize: "var(--font-size-xs)", color: isDefault ? "var(--color-fg)" : "var(--color-muted)" }}>{t("review.default")}</span>
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
    </div>
  );
}

export function BlindReviewTab({ isActive }: { isActive: boolean }): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const { currentCwd } = useUiStore();
  const messages = useSessionStore((s) => s.messages);
  const streaming = useSessionStore((s) => s.streaming);
  const [cfg, setCfg] = useState<BlindReviewConfig | null>(null);
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [noReply, setNoReply] = useState(false);
  const [reviewResult, setReviewResult] = useState<string | null>(null);
  const reviewSentRef = useRef(false);

  const visible = isActive;

  const loadConfig = useCallback(async () => {
    const resolved = await loadBlindReviewConfig(ctx, currentCwd);
    setCfg(resolved);
    setSelectedPromptId((prev) => prev || resolved.defaultPromptId);
  }, [ctx, currentCwd]);

  useEffect(() => {
    if (visible) void loadConfig();
  }, [visible, loadConfig]);

  // 设置页改了配置 → settings:changed 广播 → 重新加载(统一配置源,消灭双源失同步)
  useEffect(() => {
    const off = ctx.events.on("system:settingsChanged", () => {
      if (currentCwd) void loadConfig();
    });
    return off;
  }, [ctx.events, currentCwd, loadConfig]);

  // 发送审查后,监听 assistant 回复完成 → 拉取结果展示
  useEffect(() => {
    if (!reviewSentRef.current) return;
    if (!streaming && messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last.role === "assistant" && !last.pending) {
        const text = extractText(last.content);
        if (text.trim()) {
          setReviewResult(text);
          reviewSentRef.current = false;
        }
      }
    }
  }, [messages, streaming]);

  const handleBlindReview = async (): Promise<void> => {
    if (!input.trim() || !selectedPromptId || !cfg) return;
    const tpl = cfg.prompts.find((p) => p.id === selectedPromptId);
    if (!tpl) return;
    setSending(true);
    setReviewResult(null);
    try {
      await ctx.messaging.prompt(assemblePrompt(tpl, input));
      setInput("");
      reviewSentRef.current = true;
    } catch {
    } finally {
      setSending(false);
    }
  };

  const handleReviewLastReply = async (): Promise<void> => {
    if (!selectedPromptId || !cfg) return;
    let text = "";
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
    const tpl = cfg.prompts.find((p) => p.id === selectedPromptId);
    if (!tpl) return;
    setSending(true);
    setReviewResult(null);
    try {
      await ctx.messaging.prompt(assemblePrompt(tpl, text));
      reviewSentRef.current = true;
    } catch {
    } finally {
      setSending(false);
    }
  };

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

  const canSend = input.trim().length > 0 && !sending;

  return (
    <div className="flex-1 flex flex-col min-h-0 p-3 gap-2">
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
        disabled={sending}
      />

      <Button
        variant="primary"
        onClick={() => void handleBlindReview()}
        disabled={!canSend}
      >
        <Send className="size-3.5" /> {sending ? t("review.sending") : t("review.startBlindReview")}
      </Button>

      <div style={{ borderTop: "1px solid var(--color-border)", margin: "var(--spacing-xs) 0" }} />

      <Button
        variant="secondary"
        onClick={() => void handleReviewLastReply()}
        disabled={sending}
      >
        <MessageSquare className="size-3.5" /> {t("review.reviewLastReply")}
      </Button>

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

      {reviewResult && (
        <>
          <div style={{ borderTop: "1px solid var(--color-border)", margin: "var(--spacing-xs) 0" }} />
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", fontWeight: 600 }}>
            {t("review.result")}
          </div>
          <div style={resultStyle}>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-xs)", lineHeight: 1.5 }}>
              {reviewResult}
            </pre>
          </div>
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
  flex: 1,
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
  flex: 1,
  overflowY: "auto",
  padding: "var(--spacing-sm)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
  minHeight: "80px",
};

