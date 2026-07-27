// pi-model-manager 插件 renderer —— pi 底座模型配置管理(~/.pi/agent/models.json)。
//
// 增删改查:provider(增删改)+ 每个 provider 的 models(增删改)。
// 用框架 config/onChange(框架管 dirty/save/reset)+ refreshSignal(刷新)。
// 经 @pi-desktop/react 受控 API + @pi-desktop/core 拿模型配置契约(守薄壳:不直连 shell/application)。
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { registerSettingsComponent, ListItem, SettingsSection, type SettingsComponentProps } from "@pi-desktop/react";
import type { ModelsConfig, ProviderConfig, ModelConfig } from "@pi-desktop/core";

registerSettingsComponent("ModelManagerPage", ModelManagerPage);

export function ModelManagerPage({ refreshSignal, config: frameworkConfig, onChange }: SettingsComponentProps): React.ReactNode {
  const [selectedProvider, setSelectedProvider] = useState<string>("");

  // config 由框架从 models.json 读了传入;本地用 ModelsConfig 强转
  const config = frameworkConfig as unknown as ModelsConfig;

  // refreshSignal 变时重设默认 provider(框架已重读 config 传入)
  useEffect(() => {
    if (config?.providers) setSelectedProvider((prev) => prev || Object.keys(config.providers)[0] || "");
  }, [config, refreshSignal]);

  if (!config) return <div style={{ color: "var(--color-muted)" }}>加载中…</div>;

  const providers = config.providers;
  const providerIds = Object.keys(providers);
  const activeProvider = providers[selectedProvider];

  // 更新配置 = 调框架 onChange(框架管 dirty/save/reset)
  const updateConfig = (newConfig: ModelsConfig): void => {
    onChange(newConfig as unknown as Record<string, unknown>);
  };

  // ---- Provider CRUD ----
  const addProvider = (): void => {
    const id = `provider-${crypto.randomUUID().slice(0, 8)}`;
    updateConfig({ ...config, providers: { ...providers, [id]: { baseUrl: "", api: "openai-completions", apiKey: "", models: [] } } });
    setSelectedProvider(id);
  };
  const deleteProvider = (id: string): void => {
    const { [id]: _removed, ...rest } = providers;
    updateConfig({ ...config, providers: rest });
    if (selectedProvider === id) setSelectedProvider(Object.keys(rest)[0] ?? "");
  };
  const copyProvider = (id: string): void => {
    let newId = `${id}-copy`;
    let i = 1;
    while (providers[newId]) { newId = `${id}-copy-${i++}`; }
    updateConfig({ ...config, providers: { ...providers, [newId]: structuredClone(providers[id]) } });
    setSelectedProvider(newId);
  };
  const updateProvider = (id: string, patch: Partial<ProviderConfig>): void => {
    updateConfig({ ...config, providers: { ...providers, [id]: { ...providers[id], ...patch } } });
  };
  const renameProvider = (oldId: string, newId: string): void => {
    if (oldId === newId || providers[newId]) return;
    const { [oldId]: cur, ...rest } = providers;
    updateConfig({ ...config, providers: { ...rest, [newId]: cur } });
    setSelectedProvider(newId);
  };

  // ---- Model CRUD ----
  const addModel = (providerId: string): void => {
    const newModel: ModelConfig = { id: "new-model", name: "新模型", reasoning: false, contextWindow: 128000, maxTokens: 8192 };
    // 从最上面插入(新模型在前)
    updateProvider(providerId, { models: [newModel, ...(providers[providerId].models ?? [])] });
  };
  const deleteModel = (providerId: string, idx: number): void => {
    const models = (providers[providerId].models ?? []).filter((_, i) => i !== idx);
    updateProvider(providerId, { models });
  };
  const copyModel = (providerId: string, idx: number): void => {
    const models = providers[providerId].models ?? [];
    const copy = structuredClone(models[idx]);
    copy.id = `${copy.id}-copy`;
    copy.name = `${copy.name} (副本)`;
    // 在该模型下方插入(idx+1 位置)
    updateProvider(providerId, { models: [...models.slice(0, idx + 1), copy, ...models.slice(idx + 1)] });
  };
  const updateModel = (providerId: string, idx: number, patch: Partial<ModelConfig>): void => {
    const models = (providers[providerId].models ?? []).map((m, i) => (i === idx ? { ...m, ...patch } : m));
    updateProvider(providerId, { models });
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)", display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      <SettingsSection title="模型配置" description="管理 pi 底座的模型供应商与模型(~/.pi/agent/models.json)。增删改 provider 与 model,改动经顶部浮层保存。">

      <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 160px) 1fr", gap: "var(--spacing-lg)", alignItems: "start" }}>
        {/* 左:provider 列表(右键菜单走 Radix ContextMenu:焦点管理/Esc/边缘避让自带) */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
          {providerIds.map((id) => (
            <ContextMenu.Root key={id}>
              <ContextMenu.Trigger asChild>
                <div>
                  <ListItem
                    active={selectedProvider === id}
                    onClick={() => setSelectedProvider(id)}
                    style={{ fontFamily: "var(--font-family-mono)", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                  >
                    <span>{id}</span>
                    <span style={{ color: "var(--color-muted)", fontSize: "var(--spacing-xs)" }}>({providers[id].models?.length ?? 0})</span>
                  </ListItem>
                </div>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content style={{
                  background: "var(--color-surface)", border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-md)",
                  padding: "var(--spacing-xs) 0", minWidth: "120px", zIndex: 99999,
                }}>
                  <ContextMenu.Item onSelect={() => copyProvider(id)} style={ctxItemStyle(false)}>复制供应商</ContextMenu.Item>
                  <ContextMenu.Item onSelect={() => deleteProvider(id)} style={ctxItemStyle(true)}>删除供应商</ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ))}
          <button onClick={addProvider} style={{ ...btnStyle(true), marginTop: "var(--spacing-sm)" }}>+ 添加供应商</button>
        </div>

        {/* 右:provider 详情 + model 列表 */}
        <div>
          {activeProvider ? (
            <ProviderDetail
              providerId={selectedProvider}
              provider={activeProvider}
              onRename={renameProvider}
              onUpdate={updateProvider}
              onDelete={deleteProvider}
              onCopyProvider={copyProvider}
              onAddModel={addModel}
              onDeleteModel={deleteModel}
              onCopyModel={copyModel}
              onUpdateModel={updateModel}
            />
          ) : (
            <div style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>选择或添加一个供应商</div>
          )}
        </div>
      </div>
    </SettingsSection>
    </div>
  );
}

function ProviderDetail({
  providerId, provider, onRename, onUpdate, onDelete, onCopyProvider, onAddModel, onDeleteModel, onCopyModel, onUpdateModel,
}: {
  providerId: string;
  provider: ProviderConfig;
  onRename: (oldId: string, newId: string) => void;
  onUpdate: (id: string, patch: Partial<ProviderConfig>) => void;
  onDelete: (id: string) => void;
  onCopyProvider: (id: string) => void;
  onAddModel: (providerId: string) => void;
  onDeleteModel: (providerId: string, idx: number) => void;
  onCopyModel: (providerId: string, idx: number) => void;
  onUpdateModel: (providerId: string, idx: number, patch: Partial<ModelConfig>) => void;
}): React.ReactNode {
  const [editId, setEditId] = useState(providerId);
  // providerId 变(切 provider)时同步 editId(切 tab 不重 mount,useState 初值不会更新)
  useEffect(() => { setEditId(providerId); }, [providerId]);
  const inputStyle: React.CSSProperties = inputBaseStyle();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
      {/* Provider 字段 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderBottom: "1px solid var(--color-border)", paddingBottom: "var(--spacing-md)" }}>
        <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>供应商 ID</label>
          <input value={editId} onChange={(e) => setEditId(e.target.value)} onBlur={() => onRename(providerId, editId)} style={inputStyle} />
          <button onClick={() => onCopyProvider(providerId)} style={btnStyle(false)}>复制供应商</button>
          <button onClick={() => onDelete(providerId)} style={{ ...btnStyle(false), borderColor: "var(--color-accent.error)", color: "var(--color-accent.error)" }}>删除供应商</button>
        </div>
        <FieldInput label="baseUrl" value={provider.baseUrl ?? ""} onChange={(v) => onUpdate(providerId, { baseUrl: v })} />
        <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>api</label>
          <select value={provider.api ?? "openai-completions"} onChange={(e) => onUpdate(providerId, { api: e.target.value })} style={inputStyle}>
            <option value="openai-completions">openai-completions</option>
            <option value="anthropic-messages">anthropic-messages</option>
            <option value="google-genai">google-genai</option>
            <option value="openai-responses">openai-responses</option>
          </select>
        </div>
        <FieldInput label="apiKey" value={provider.apiKey ?? ""} onChange={(v) => onUpdate(providerId, { apiKey: v })} mono />
      </div>

      {/* Model 列表 */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--spacing-sm)" }}>
          <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>模型 ({provider.models?.length ?? 0})</h3>
          <button onClick={() => onAddModel(providerId)} style={btnStyle(true)}>+ 添加模型</button>
        </div>
        <AnimatePresence initial={false}>
        {(provider.models ?? []).map((m, idx) => (
          <motion.div
            key={m.id + "-" + m.name}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--spacing-sm) var(--spacing-md)", marginBottom: "var(--spacing-sm)", display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}
          >
            <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
              <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)", flexShrink: 0 }}>模型 ID</label>
              <input value={m.id} onChange={(e) => onUpdateModel(providerId, idx, { id: e.target.value })} style={inputStyle} placeholder="model id" />
              <button onClick={() => onCopyModel(providerId, idx)} style={{ ...btnStyle(false), padding: "var(--spacing-xs)" }}>复制</button>
              <button onClick={() => onDeleteModel(providerId, idx)} style={{ ...btnStyle(false), borderColor: "var(--color-accent.error)", color: "var(--color-accent.error)", padding: "var(--spacing-xs)" }}>删除</button>
            </div>
            <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
              <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)", flexShrink: 0 }}>名称</label>
              <input value={m.name} onChange={(e) => onUpdateModel(providerId, idx, { name: e.target.value })} style={inputStyle} placeholder="model name" />
            </div>
            <div style={{ display: "flex", gap: "var(--spacing-md)", fontSize: "var(--font-size-sm)", marginLeft: "92px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", cursor: "pointer" }}>
                <input type="checkbox" checked={!!m.reasoning} onChange={(e) => onUpdateModel(providerId, idx, { reasoning: e.target.checked })} />
                reasoning
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
                contextWindow
                <input type="number" value={m.contextWindow ?? 0} onChange={(e) => onUpdateModel(providerId, idx, { contextWindow: Number(e.target.value) })} style={inputStyle} />
                <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-family-mono)" }}>≈ {Math.round((m.contextWindow ?? 0) / 1024)}K</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
                maxTokens
                <input type="number" value={m.maxTokens ?? 0} onChange={(e) => onUpdateModel(providerId, idx, { maxTokens: Number(e.target.value) })} style={inputStyle} />
                <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-family-mono)" }}>≈ {Math.round((m.maxTokens ?? 0) / 1024)}K</span>
              </label>
            </div>
          </motion.div>
        ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function FieldInput({ label, value, onChange, mono }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean }): React.ReactNode {
  return (
    <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
      <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputBaseStyle(), fontFamily: mono ? "var(--font-family-mono)" : "var(--font-family-sans)" }} />
    </div>
  );
}

function inputBaseStyle(): React.CSSProperties {
  return {
    padding: "var(--spacing-xs) var(--spacing-sm)",
    border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
    background: "var(--color-surface)", color: "var(--color-fg)",
    fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
    width: "100%", boxSizing: "border-box",
  };
}

function btnStyle(primary: boolean, disabled = false): React.CSSProperties {
  return {
    padding: "var(--spacing-xs) var(--spacing-md)",
    border: `1px solid ${primary ? "var(--color-primary)" : "var(--color-border)"}`,
    borderRadius: "var(--radius-sm)",
    background: primary ? "var(--color-primary)" : "transparent",
    color: primary ? "var(--color-primary-fg)" : "var(--color-fg)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)",
    opacity: disabled ? 0.5 : 1,
  };
}

function ctxItemStyle(danger: boolean): React.CSSProperties {
  return {
    display: "block", width: "100%", padding: "var(--spacing-xs) var(--spacing-md)",
    border: "none", background: "transparent", cursor: "pointer", textAlign: "left",
    fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)",
    color: danger ? "var(--color-accent.error)" : "var(--color-fg)",
    outline: "none",
  };
}
