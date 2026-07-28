import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { EyeOff, Plus, Trash2, Send, MessageSquare, Star } from "lucide-react";
import {
  registerSettingsComponent,
  registerSidePanelComponent,
  usePluginContext,
  useUiStore,
  EmptyState,
  SettingsSection,
  type SettingsComponentProps,
} from "@pi-desktop/react";

const PLUGIN_ID = "blind-review";
const CONFIG_PATH = "~/.pi-desktop/config/blind-review.json";

registerSettingsComponent("BlindReviewSettings", BlindReviewSettings);
registerSidePanelComponent("BlindReviewTab", BlindReviewTab);

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

function BlindReviewSettings({ config, onChange }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const cfg = resolveConfig(config);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPrompt, setEditPrompt] = useState("");

  const isAdding = expandedId === "__new__";

  const handleClick = (tpl: PromptTemplate): void => {
    if (expandedId === tpl.id) {
      setExpandedId(null);
    } else {
      setExpandedId(tpl.id);
      setEditName(tpl.name);
      setEditPrompt(tpl.prompt);
    }
  };

  const handleAdd = (): void => {
    setExpandedId("__new__");
    setEditName("");
    setEditPrompt("");
  };

  const handleSave = (): void => {
    if (!editName.trim() || !editPrompt.trim()) return;
    if (isAdding) {
      const id = `tpl-${Date.now()}`;
      onChange({ ...cfg, prompts: [...cfg.prompts, { id, name: editName.trim(), prompt: editPrompt }] });
    } else if (expandedId) {
      onChange({
        ...cfg,
        prompts: cfg.prompts.map((p) => (p.id === expandedId ? { ...p, name: editName.trim(), prompt: editPrompt } : p)),
      });
    }
    setExpandedId(null);
  };

  const handleDelete = (id: string): void => {
    const prompts = cfg.prompts.filter((p) => p.id !== id);
    const defaultPromptId = cfg.defaultPromptId === id ? (prompts[0]?.id ?? "") : cfg.defaultPromptId;
    onChange({ prompts, defaultPromptId });
    if (expandedId === id) setExpandedId(null);
  };

  const handleSetDefault = (id: string): void => {
    onChange({ ...cfg, defaultPromptId: id });
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)" }}>
      <SettingsSection title={t("review.blindReview")} description={t("review.blindReviewDesc")}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
          {cfg.prompts.map((tpl) => {
            const isDefault = cfg.defaultPromptId === tpl.id;
            const isExpanded = expandedId === tpl.id;
            return (
              <div
                key={tpl.id}
                style={{
                  border: `1px solid ${isExpanded ? "var(--color-primary)" : "var(--color-border)"}`,
                  borderRadius: "var(--radius-sm)",
                  background: "var(--color-surface)",
                  overflow: "hidden",
                }}
              >
                <div
                  onClick={() => handleClick(tpl)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--spacing-sm)",
                    padding: "var(--spacing-xs) var(--spacing-sm)",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ flex: 1, fontSize: "var(--font-size-sm)", color: "var(--color-fg)" }}>{tpl.name}</span>
                  {isDefault && (
                    <span style={defaultBadgeStyle}>
                      <Star className="size-3" /> {t("review.default")}
                    </span>
                  )}
                  {!isDefault && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleSetDefault(tpl.id); }}
                      title={t("review.setDefault")}
                      style={textBtnStyle}
                    >
                      {t("review.setDefault")}
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(tpl.id); }}
                    title={t("review.delete")}
                    style={iconBtnStyle}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                {isExpanded && (
                  <div style={{ padding: "var(--spacing-sm)", borderTop: "1px solid var(--color-border)" }}>
                    <div style={{ marginBottom: "var(--spacing-sm)" }}>
                      <label style={labelStyle}>{t("review.templateName")}</label>
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        style={inputStyle}
                      />
                    </div>
                    <div style={{ marginBottom: "var(--spacing-sm)" }}>
                      <label style={labelStyle}>{t("review.templatePrompt")}</label>
                      <textarea
                        value={editPrompt}
                        onChange={(e) => setEditPrompt(e.target.value)}
                        placeholder={t("review.templatePromptPlaceholder")}
                        style={textareaStyle}
                      />
                    </div>
                    <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
                      <button
                        onClick={handleSave}
                        disabled={!editName.trim() || !editPrompt.trim()}
                        style={primaryBtnStyle}
                      >
                        {t("review.save")}
                      </button>
                      <button onClick={() => setExpandedId(null)} style={secondaryBtnStyle}>
                        {t("review.cancel")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <button onClick={handleAdd} style={addBtnStyle}>
            <Plus className="size-4" /> {t("review.addTemplate")}
          </button>
        </div>
      </SettingsSection>

      {isAdding && (
        <div style={{ marginTop: "var(--spacing-lg)" }}>
          <SettingsSection title={t("review.addTemplate")}>
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
                <button
                  onClick={handleSave}
                  disabled={!editName.trim() || !editPrompt.trim()}
                  style={primaryBtnStyle}
                >
                  {t("review.save")}
                </button>
                <button onClick={() => setExpandedId(null)} style={secondaryBtnStyle}>
                  {t("review.cancel")}
                </button>
              </div>
            </div>
          </SettingsSection>
        </div>
      )}
    </div>
  );
}

function BlindReviewTab(): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext(PLUGIN_ID);
  const { currentCwd, activeSidePanelTab } = useUiStore();
  const [cfg, setCfg] = useState<BlindReviewConfig | null>(null);
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [noReply, setNoReply] = useState(false);

  const visible = activeSidePanelTab === "blind-review";

  const loadConfig = useCallback(async () => {
    const raw = await window.pi.configFile.get(CONFIG_PATH);
    const resolved = resolveConfig(raw);
    setCfg(resolved);
    setSelectedPromptId((prev) => prev || resolved.defaultPromptId);
  }, []);

  useEffect(() => {
    if (visible) void loadConfig();
  }, [visible, loadConfig]);

  const handleBlindReview = async (): Promise<void> => {
    if (!input.trim() || !selectedPromptId || !cfg) return;
    const tpl = cfg.prompts.find((p) => p.id === selectedPromptId);
    if (!tpl) return;
    setSending(true);
    try {
      await ctx.messaging.prompt(assemblePrompt(tpl, input));
      setInput("");
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
    try {
      await ctx.messaging.prompt(assemblePrompt(tpl, text));
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
      <select
        value={selectedPromptId}
        onChange={(e) => setSelectedPromptId(e.target.value)}
        style={selectStyle}
      >
        {cfg.prompts.map((tpl) => (
          <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
        ))}
      </select>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={t("review.pasteContent")}
        style={reviewTextareaStyle}
        disabled={sending}
      />

      <button
        onClick={() => void handleBlindReview()}
        disabled={!canSend}
        style={canSend ? primaryBtnStyle : { ...primaryBtnStyle, opacity: 0.5, cursor: "not-allowed" }}
      >
        <Send className="size-3.5" /> {sending ? t("review.sending") : t("review.startBlindReview")}
      </button>

      <div style={{ borderTop: "1px solid var(--color-border)", margin: "var(--spacing-xs) 0" }} />

      <button
        onClick={() => void handleReviewLastReply()}
        disabled={sending}
        style={secondaryBtnStyle}
      >
        <MessageSquare className="size-3.5" /> {t("review.reviewLastReply")}
      </button>

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

const textBtnStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "var(--color-muted)",
  fontFamily: "var(--font-family-sans)",
  fontSize: "var(--font-size-xs)",
  cursor: "pointer",
  padding: "2px var(--spacing-xs)",
};

const defaultBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "2px",
  padding: "2px var(--spacing-xs)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-primary)",
  color: "var(--color-primary-fg)",
  fontSize: "var(--font-size-xs)",
  fontFamily: "var(--font-family-sans)",
};

const addBtnStyle: React.CSSProperties = {
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

const selectStyle: React.CSSProperties = {
  padding: "var(--spacing-xs) var(--spacing-sm)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
  color: "var(--color-fg)",
  fontFamily: "var(--font-family-sans)",
  fontSize: "var(--font-size-sm)",
  width: "100%",
  boxSizing: "border-box",
  cursor: "pointer",
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

const primaryBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--spacing-xs)",
  padding: "var(--spacing-xs) var(--spacing-md)",
  border: "1px solid var(--color-primary)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-primary)",
  color: "var(--color-primary-fg)",
  fontFamily: "var(--font-family-sans)",
  fontSize: "var(--font-size-sm)",
  cursor: "pointer",
};

const secondaryBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--spacing-xs)",
  padding: "var(--spacing-xs) var(--spacing-md)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--color-fg)",
  fontFamily: "var(--font-family-sans)",
  fontSize: "var(--font-size-sm)",
  cursor: "pointer",
};
