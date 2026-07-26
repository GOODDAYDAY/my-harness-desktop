// pi-model-manager 插件 renderer —— pi 底座模型配置管理(~/.pi/agent/models.json)。
//
// 增删改查:provider(增删改)+ 每个 provider 的 models(增删改)。
// 用框架 saveBar(register save/reset + setDirty)+ refreshSignal(刷新重拉)。
// 经 @pi-desktop/react 受控 API(守薄壳:不直连 shell)。
//
// ⚠ 偏离文档(标注):同 pi-settings,底座 models.json 是公开标准契约,
// 桌面端写标准字段不算重复领域知识。用户明确要管理 pi 模型。
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { registerSettingsComponent, usePiApi, type SettingsComponentProps } from "@pi-desktop/react";
import type { ModelsConfig, ProviderConfig, ModelConfig } from "../../../application/models/models-store";

registerSettingsComponent("ModelManagerPage", ModelManagerPage);

export function ModelManagerPage({ refreshSignal, saveBar }: SettingsComponentProps): React.ReactNode {
  const pi = usePiApi();
  const [config, setConfig] = useState<ModelsConfig | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  /** 右键菜单元数据:target=右键的 provider id、x/y=菜单位置;null=不显示 */
  const [ctxMenu, setCtxMenu] = useState<{ target: string; x: number; y: number } | null>(null);

  // 启动 + refreshSignal 变 → 拉模型配置
  useEffect(() => {
    void pi.models.get<ModelsConfig>().then((c) => {
      setConfig(c);
      setSelectedProvider((prev) => prev || Object.keys(c.providers)[0] || "");
    });
  }, [pi, refreshSignal]);

  // 注册 save/reset 给框架 saveBar
  useEffect(() => {
    saveBar.register({
      save: async () => {
        if (config) await pi.models.set(config);
      },
      reset: async () => {
        const fresh = await pi.models.get<ModelsConfig>();
        setConfig(fresh);
      },
    });
  }, [saveBar, pi, config]);

  if (!config) return <div style={{ padding: "var(--spacing-xl)", color: "var(--color-muted)" }}>加载中…</div>;

  const providers = config.providers;
  const providerIds = Object.keys(providers);
  const activeProvider = providers[selectedProvider];

  // ---- Provider CRUD ----
  const addProvider = (): void => {
    const id = `provider-${Date.now()}`;
    const newConfig: ModelsConfig = {
      ...config,
      providers: { ...providers, [id]: { baseUrl: "", api: "openai-completions", apiKey: "", models: [] } },
    };
    setConfig(newConfig);
    setSelectedProvider(id);
    saveBar.setDirty(true);
  };
  const deleteProvider = (id: string): void => {
    const { [id]: _removed, ...rest } = providers;
    setConfig({ ...config, providers: rest });
    if (selectedProvider === id) setSelectedProvider(Object.keys(rest)[0] ?? "");
    saveBar.setDirty(true);
  };
  /** 复制 provider(深拷贝,新 id 加 -copy 后缀,自动选中)。 */
  const copyProvider = (id: string): void => {
    let newId = `${id}-copy`;
    let i = 1;
    while (providers[newId]) { newId = `${id}-copy-${i++}`; }
    setConfig({ ...config, providers: { ...providers, [newId]: JSON.parse(JSON.stringify(providers[id])) } });
    setSelectedProvider(newId);
    saveBar.setDirty(true);
  };
  const updateProvider = (id: string, patch: Partial<ProviderConfig>): void => {
    setConfig({ ...config, providers: { ...providers, [id]: { ...providers[id], ...patch } } });
    saveBar.setDirty(true);
  };
  const renameProvider = (oldId: string, newId: string): void => {
    if (oldId === newId || providers[newId]) return;
    const { [oldId]: cur, ...rest } = providers;
    setConfig({ ...config, providers: { ...rest, [newId]: cur } });
    setSelectedProvider(newId);
    saveBar.setDirty(true);
  };

  // ---- Model CRUD ----
  const addModel = (providerId: string): void => {
    const newModel: ModelConfig = { id: "new-model", name: "新模型", reasoning: false, contextWindow: 128000, maxTokens: 8192 };
    updateProvider(providerId, { models: [...(providers[providerId].models ?? []), newModel] });
  };
  const deleteModel = (providerId: string, idx: number): void => {
    const models = (providers[providerId].models ?? []).filter((_, i) => i !== idx);
    updateProvider(providerId, { models });
  };
  const copyModel = (providerId: string, idx: number): void => {
    const models = providers[providerId].models ?? [];
    const copy = JSON.parse(JSON.stringify(models[idx])) as ModelConfig;
    copy.id = `${copy.id}-copy`;
    copy.name = `${copy.name} (副本)`;
    updateProvider(providerId, { models: [...models, copy] });
  };
  const updateModel = (providerId: string, idx: number, patch: Partial<ModelConfig>): void => {
    const models = (providers[providerId].models ?? []).map((m, i) => (i === idx ? { ...m, ...patch } : m));
    updateProvider(providerId, { models });
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "var(--spacing-xl)", display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      <div>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)", fontWeight: 600 }}>模型配置</h2>
        <p style={{ margin: "var(--spacing-xs) 0 0", color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>
          管理 pi 底座的模型供应商与模型(<code style={{ fontFamily: "var(--font-family-mono)" }}>~/.pi/agent/models.json</code>)。增删改 provider 与 model,改动经顶部浮层保存。
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: "var(--spacing-lg)", alignItems: "start" }}>
        {/* 左:provider 列表 */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
          {providerIds.map((id) => (
            <button
              key={id}
              onClick={() => setSelectedProvider(id)}
              onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ target: id, x: e.clientX, y: e.clientY }); }}
              style={{
                padding: "var(--spacing-sm) var(--spacing-md)",
                border: `1px solid ${selectedProvider === id ? "var(--color-primary)" : "var(--color-border)"}`,
                borderRadius: "var(--radius-sm)",
                background: selectedProvider === id ? "var(--color-surface)" : "transparent",
                color: selectedProvider === id ? "var(--color-fg)" : "var(--color-muted)",
                cursor: "pointer", textAlign: "left",
                fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
              }}
            >
              {id} <span style={{ color: "var(--color-muted)", fontSize: "var(--spacing-xs)" }}>({providers[id].models?.length ?? 0})</span>
            </button>
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

      {/* 右键菜单(供应商复制/删除) */}
      {ctxMenu && (
        <>
          {/* 透明遮罩,点击外部关闭菜单 */}
          <div style={{ position: "fixed", inset: 0, zIndex: 99998 }} onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }} />
          <div style={{
            position: "fixed", top: ctxMenu.y, left: ctxMenu.x, zIndex: 99999,
            background: "var(--color-surface)", border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-md)",
            padding: "var(--spacing-xs) 0", minWidth: "120px",
          }}>
            <button
              onClick={() => { copyProvider(ctxMenu.target); setCtxMenu(null); }}
              style={{ display: "block", width: "100%", padding: "var(--spacing-xs) var(--spacing-md)", border: "none", background: "transparent", color: "var(--color-fg)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)" }}
            >
              复制供应商
            </button>
            <button
              onClick={() => { deleteProvider(ctxMenu.target); setCtxMenu(null); }}
              style={{ display: "block", width: "100%", padding: "var(--spacing-xs) var(--spacing-md)", border: "none", background: "transparent", color: "var(--color-accent.error)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)" }}
            >
              删除供应商
            </button>
          </div>
        </>
      )}
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
          <input value={editId} onChange={(e) => setEditId(e.target.value)} onBlur={() => onRename(providerId, editId)} style={{ ...inputStyle, flex: 1 }} />
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
            key={idx}
            initial={{ opacity: 0, height: 0, marginBottom: 0 }}
            animate={{ opacity: 1, height: "auto", marginBottom: "var(--spacing-sm)" }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            style={{ overflow: "hidden", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--spacing-sm) var(--spacing-md)", display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}
          >
            <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
              <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)", flexShrink: 0 }}>模型 ID</label>
              <input value={m.id} onChange={(e) => onUpdateModel(providerId, idx, { id: e.target.value })} style={{ ...inputStyle, flex: 1 }} placeholder="model id" />
              <button onClick={() => onCopyModel(providerId, idx)} style={{ ...btnStyle(false), padding: "var(--spacing-xs)" }}>复制</button>
              <button onClick={() => onDeleteModel(providerId, idx)} style={{ ...btnStyle(false), borderColor: "var(--color-accent.error)", color: "var(--color-accent.error)", padding: "var(--spacing-xs)" }}>删除</button>
            </div>
            <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
              <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)", flexShrink: 0 }}>名称</label>
              <input value={m.name} onChange={(e) => onUpdateModel(providerId, idx, { name: e.target.value })} style={{ ...inputStyle, flex: 1 }} placeholder="model name" />
            </div>
            <div style={{ display: "flex", gap: "var(--spacing-md)", fontSize: "var(--font-size-sm)", marginLeft: "92px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", cursor: "pointer" }}>
                <input type="checkbox" checked={!!m.reasoning} onChange={(e) => onUpdateModel(providerId, idx, { reasoning: e.target.checked })} />
                reasoning
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
                contextWindow
                <input type="number" value={m.contextWindow ?? 0} onChange={(e) => onUpdateModel(providerId, idx, { contextWindow: Number(e.target.value) })} style={{ ...inputStyle, width: "130px" }} />
                <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-family-mono)" }}>≈ {Math.round((m.contextWindow ?? 0) / 1024)}K</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
                maxTokens
                <input type="number" value={m.maxTokens ?? 0} onChange={(e) => onUpdateModel(providerId, idx, { maxTokens: Number(e.target.value) })} style={{ ...inputStyle, width: "130px" }} />
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
      <input value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputBaseStyle(), flex: 1, fontFamily: mono ? "var(--font-family-mono)" : "var(--font-family-sans)" }} />
    </div>
  );
}

function inputBaseStyle(): React.CSSProperties {
  return {
    padding: "var(--spacing-xs) var(--spacing-sm)",
    border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
    background: "var(--color-surface)", color: "var(--color-fg)",
    fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
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
