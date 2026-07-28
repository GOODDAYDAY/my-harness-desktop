import { useEffect, useState, useCallback } from "react";
import { EyeOff, Plus, Trash2, Pencil, Send, MessageSquare } from "lucide-react";
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

function BlindReviewSettings({ config, onChange }: SettingsComponentProps): React.ReactNode {
  const cfg = resolveConfig(config);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPrompt, setEditPrompt] = useState("");

  const startEdit = (tpl: PromptTemplate): void => {
    setEditingId(tpl.id);
    setEditName(tpl.name);
    setEditPrompt(tpl.prompt);
  };

  const startNew = (): void => {
    const id = `tpl-${Date.now()}`;
    setEditingId(id);
    setEditName("");
    setEditPrompt("");
  };

  const saveEdit = (): void => {
    if (!editingId || !editName.trim() || !editPrompt.trim()) return;
    const existing = cfg.prompts.find((p) => p.id === editingId);
    const updated: PromptTemplate = { id: editingId, name: editName.trim(), prompt: editEditPrompt };
    const prompts = existing
      ? cfg.prompts.map((p) => (p.id === editingId ? updated : p))
      : [...cfg.prompts, updated];
    onChange({ ...cfg, prompts });
    setEditingId(null);
  };

  const deleteTemplate = (id: string): void => {
    const prompts = cfg.prompts.filter((p) => p.id !== id);
    const defaultPromptId = cfg.defaultPromptId === id ? (prompts[0]?.id ?? "") : cfg.defaultPromptId;
    onChange({ prompts, defaultPromptId });
  };

  const setDefault = (id: string): void => {
    onChange({ ...cfg, defaultPromptId: id });
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)" }}>
      <SettingsSection title="盲审 Prompt 模板" description="管理盲审使用的 prompt 模板。{{content}} 是内容占位符，运行时替换为实际审查内容。">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
          {cfg.prompts.map((tpl) => (
            <div
              key={tpl.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--spacing-sm)",
                padding: "var(--spacing-xs) var(--spacing-sm)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
                background: "var(--color-surface)",
              }}
            >
              <input
                type="radio"
                checked={cfg.defaultPromptId === tpl.id}
                onChange={() => setDefault(tpl.id)}
                title="设为默认"
                style={{ cursor: "pointer" }}
              />
              <span style={{ flex: 1, fontSize: "var(--font-size-sm)", color: "var(--color-fg)" }}>{tpl.name}</span>
              <button onClick={() => startEdit(tpl)} title="编辑" style={iconBtnStyle}>
                <Pencil className="size-3.5" />
              </button>
              <button onClick={() => deleteTemplate(tpl.id)} title="删除" style={iconBtnStyle}>
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
          <button onClick={startNew} style={addBtnStyle}>
            <Plus className="size-4" /> 新增模板
          </button>
        </div>
      </SettingsSection>

      {editingId && (
        <div style={{ marginTop: "var(--spacing-lg)" }}>
          <SettingsSection title={cfg.prompts.find((p) => p.id === editingId) ? "编辑模板" : "新增模板"}>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
              <div>
                <label style={labelStyle}>名称</label>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="模板名称"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>Prompt</label>
                <textarea
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  placeholder={"输入审查 prompt...\n{{content}} 是内容占位符"}
                  style={textareaStyle}
                />
              </div>
              <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
                <button
                  onClick={saveEdit}
                  disabled={!editName.trim() || !editPrompt.trim()}
                  style={primaryBtnStyle}
                >
                  保存
                </button>
                <button onClick={() => setEditingId(null)} style={secondaryBtnStyle}>
                  取消
                </button>
              </div>
            </div>
          </SettingsSection>
        </div>
      )}
    </div>
  );
}

// ============ SidePanel: 盲审面板 ============

function BlindReviewTab(): React.ReactNode {
  const ctx = usePluginContext(PLUGIN_ID);
  const { currentCwd, activeSidePanelTab } = useUiStore();
  const [cfg, setCfg] = useState<BlindReviewConfig | null>(null);
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

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

  const assemblePrompt = (template: PromptTemplate, content: string): string => {
    return template.prompt.replace("{{content}}", content);
  };

  const handleBlindReview = async (): Promise<void> => {
    if (!input.trim() || !selectedPromptId || !cfg) return;
    const tpl = cfg.prompts.find((p) => p.id === selectedPromptId);
    if (!tpl) return;
    const assembled = assemblePrompt(tpl, input);
    setSending(true);
    try {
      await ctx.messaging.prompt(assembled);
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
    if (!text.trim()) return;
    const tpl = cfg.prompts.find((p) => p.id === selectedPromptId);
    if (!tpl) return;
    const assembled = assemblePrompt(tpl, text);
    setSending(true);
    try {
      await ctx.messaging.prompt(assembled);
    } catch {
    } finally {
      setSending(false);
    }
  };

  if (!cfg) return null;

  const noPrompt = cfg.prompts.length === 0;

  if (noPrompt) {
    return (
      <EmptyState
        icon={<EyeOff className="size-8" />}
        title="暂无 Prompt 模板"
        description="请在设置页添加至少一个模板"
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
        placeholder="粘贴要盲审的内容..."
        style={reviewTextareaStyle}
        disabled={sending}
      />

      <button
        onClick={() => void handleBlindReview()}
        disabled={!canSend}
        style={canSend ? primaryBtnStyle : { ...primaryBtnStyle, opacity: 0.5, cursor: "not-allowed" }}
      >
        <Send className="size-3.5" /> 开始盲审
      </button>

      <div style={{ borderTop: "1px solid var(--color-border)", margin: "var(--spacing-xs) 0" }} />

      <button
        onClick={() => void handleReviewLastReply()}
        disabled={sending}
        style={secondaryBtnStyle}
      >
        <MessageSquare className="size-3.5" /> 盲审最后回复
      </button>

      {!currentCwd && (
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)", textAlign: "center" }}>
          请先选择工作目录
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
