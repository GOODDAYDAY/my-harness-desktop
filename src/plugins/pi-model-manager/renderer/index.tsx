// pi-model-manager 插件 renderer —— pi 底座模型配置管理(~/.pi/agent/models.json)。
//
// 增删改查:provider(增删改)+ 每个 provider 的 models(增删改)。
// 用框架 config/onChange(框架管 dirty/save/reset)+ refreshSignal(刷新)。
// 经 @pi-desktop/react 受控 API + @pi-desktop/core 拿模型配置契约(守薄壳:不直连 shell/application)。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { ListItem, SettingsSection, type SettingsComponentProps, usePluginContext, useUiStore } from "@pi-desktop/react";
import type { ModelsConfig, ProviderConfig, ModelConfig, SyncSnapshot, SessionEvent, KernelEvent, NeutralMessage, PluginContext } from "@pi-desktop/core";

type TestState = "testing" | "success" | "error";

/** 框架 configFile 通道契约:文件缺失/解析失败返回 {} —— 兜底成带 providers 的形状,消费侧唯一入口。 */
function normalizeModelsConfig(raw: unknown): ModelsConfig {
  const cfg = (raw ?? {}) as Partial<ModelsConfig>;
  return { ...cfg, providers: cfg.providers ?? {} };
}


export function ModelManagerPage({ refreshSignal, config: frameworkConfig, onChange }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [selectedProvider, setSelectedProvider] = useState<string>("");

  // config 由框架从 models.json 读了传入;useMemo 保引用稳定(下方 effect 依赖 config,避免每 render 重跑)
  const config = useMemo(() => (frameworkConfig ? normalizeModelsConfig(frameworkConfig) : null), [frameworkConfig]);

  // refreshSignal 变时重设默认 provider(框架已重读 config 传入)
  useEffect(() => {
    if (config?.providers) setSelectedProvider((prev) => prev || Object.keys(config.providers)[0] || "");
  }, [config, refreshSignal]);

  if (!config) return <div style={{ color: "var(--color-muted)" }}>{t("models.loading")}</div>;

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
    const rest = { ...providers };
    delete rest[id];
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
  // 返回是否改名成功;失败(空串/撞名)时调用方回滚输入框,避免 UI 与持久数据不一致
  const renameProvider = (oldId: string, newId: string): boolean => {
    const id = newId.trim();
    if (id === oldId) return true;
    if (!id || providers[id]) return false;
    const { [oldId]: cur, ...rest } = providers;
    updateConfig({ ...config, providers: { ...rest, [id]: cur } });
    setSelectedProvider(id);
    return true;
  };

  // ---- Model CRUD ----
  const addModel = (providerId: string): void => {
    // provider 内唯一 id:重复 id 会让底座 setModel 二义,也撑不起稳定 React key
    const existing = new Set((providers[providerId].models ?? []).map((m) => m.id));
    let id = `new-model-${crypto.randomUUID().slice(0, 8)}`;
    while (existing.has(id)) id = `new-model-${crypto.randomUUID().slice(0, 8)}`;
    const newModel: ModelConfig = { id, name: t("models.newModel"), reasoning: false, contextWindow: 128000, maxTokens: 8192 };
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
    const ids = new Set(models.map((m) => m.id));
    let id = `${copy.id}-copy`;
    let i = 1;
    while (ids.has(id)) id = `${copy.id}-copy-${i++}`;
    copy.id = id;
    copy.name = t("models.copyName", { name: copy.name });
    // 在该模型下方插入(idx+1 位置)
    updateProvider(providerId, { models: [...models.slice(0, idx + 1), copy, ...models.slice(idx + 1)] });
  };
  const updateModel = (providerId: string, idx: number, patch: Partial<ModelConfig>): void => {
    const models = (providers[providerId].models ?? []).map((m, i) => (i === idx ? { ...m, ...patch } : m));
    updateProvider(providerId, { models });
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "var(--spacing-xl)", display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
      <SettingsSection title={t("settings.models")} description={t("settings.modelsDesc")}>

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
                  <ContextMenu.Item onSelect={() => copyProvider(id)} style={ctxItemStyle(false)}>{t("models.copyProvider")}</ContextMenu.Item>
                  <ContextMenu.Item onSelect={() => deleteProvider(id)} style={ctxItemStyle(true)}>{t("models.deleteProvider")}</ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ))}
          <button onClick={addProvider} style={{ ...btnStyle(true), marginTop: "var(--spacing-sm)" }}>{t("models.addProvider")}</button>
        </div>

        {/* 右:provider 详情 + model 列表。minWidth:0 必要——grid item 默认 min-width:auto,
            不能窄于内容固有宽度,不加则面板收窄时右栏被内容顶死、溢出 */}
        <div style={{ minWidth: 0 }}>
          {activeProvider ? (
            <ProviderDetail
               providerId={selectedProvider}
               provider={activeProvider}
               ctx={ctx}
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
            <div style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>{t("models.selectProvider")}</div>
          )}
        </div>
      </div>
    </SettingsSection>
    </div>
  );
}

function ProviderDetail({
  providerId, provider, ctx, onRename, onUpdate, onDelete, onCopyProvider, onAddModel, onDeleteModel, onCopyModel, onUpdateModel,
}: {
  providerId: string;
  provider: ProviderConfig;
  ctx: PluginContext;
  onRename: (oldId: string, newId: string) => boolean;
  onUpdate: (id: string, patch: Partial<ProviderConfig>) => void;
  onDelete: (id: string) => void;
  onCopyProvider: (id: string) => void;
  onAddModel: (providerId: string) => void;
  onDeleteModel: (providerId: string, idx: number) => void;
  onCopyModel: (providerId: string, idx: number) => void;
  onUpdateModel: (providerId: string, idx: number, patch: Partial<ModelConfig>) => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const [editId, setEditId] = useState(providerId);
  // providerId 变(切 provider)时同步 editId(切 tab 不重 mount,useState 初值不会更新)
  useEffect(() => { setEditId(providerId); }, [providerId]);
  const inputStyle: React.CSSProperties = inputBaseStyle();

  const [testStates, setTestStates] = useState<Record<string, { state: TestState; error?: string }>>({});
  const [testingId, setTestingId] = useState<string | null>(null);

  const testModel = async (modelId: string): Promise<void> => {
    if (testingId) return;
    setTestingId(modelId);
    setTestStates((prev) => ({ ...prev, [modelId]: { state: "testing" } }));

    const { currentCwd, currentSessionPath } = useUiStore.getState();
    if (!currentCwd) {
      setTestStates((prev) => ({ ...prev, [modelId]: { state: "error", error: "no working directory" } }));
      setTestingId(null);
      return;
    }

    let sessionFile: string | undefined;
    let offEvent: (() => void) | undefined;
    let offKernel: (() => void) | undefined;

    try {
      ctx.sessions.setContext(currentCwd, null);
      await ctx.sessions.start(currentCwd);
      const snapshot = await ctx.sessions.getSnapshot() as SyncSnapshot | null;
      sessionFile = snapshot?.state?.sessionFile;
      await ctx.models.setModel(providerId, modelId);

      const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        let resolved = false;
        let gotAssistantReply = false;
        const timer = setTimeout(() => {
          if (!resolved) { resolved = true; resolve({ ok: false, error: "timeout" }); }
        }, 30000);

        offEvent = ctx.sessions.onEvent((event) => {
          const e = event as SessionEvent;
          if (!resolved && e.type === "messageStart") {
            const msg = (e as { message?: NeutralMessage }).message;
            if (msg?.role === "assistant") gotAssistantReply = true;
          }
          if (!resolved && e.type === "messageEnd") {
            const msg = (e as { message?: NeutralMessage }).message;
            if (msg?.error) { resolved = true; clearTimeout(timer); resolve({ ok: false, error: "model error" }); }
          }
          if (!resolved && (e.type === "agentEnd" || e.type === "agentSettled")) {
            resolved = true; clearTimeout(timer);
            resolve(gotAssistantReply ? { ok: true } : { ok: false, error: "no response" });
          }
        });

        offKernel = ctx.sessions.onKernelEvent((event) => {
          const e = event as KernelEvent;
          if (!resolved && e.source === "desktop" && e.kind === "processExit" && !e.expected) {
            resolved = true; clearTimeout(timer); resolve({ ok: false, error: `process exited (code ${e.code})` });
          }
          if (!resolved && e.source === "desktop" && e.kind === "rpcError") {
            resolved = true; clearTimeout(timer); resolve({ ok: false, error: e.message });
          }
        });

        void ctx.messaging.prompt("ping").catch((err: unknown) => {
          if (!resolved) { resolved = true; clearTimeout(timer); resolve({ ok: false, error: String(err) }); }
        });
      });

      setTestStates((prev) => ({ ...prev, [modelId]: { state: result.ok ? "success" : "error", error: result.error } }));
      if (result.ok) {
        setTimeout(() => {
          setTestStates((prev) => {
            if (prev[modelId]?.state === "success") {
              const next = { ...prev }; delete next[modelId]; return next;
            }
            return prev;
          });
        }, 3000);
      }
    } catch (err) {
      setTestStates((prev) => ({ ...prev, [modelId]: { state: "error", error: String(err) } }));
    } finally {
      // 清理失败仅留观测,不影响测试结果本身
      try { offEvent?.(); } catch (e) { console.warn("model test cleanup: offEvent failed", e); }
      try { offKernel?.(); } catch (e) { console.warn("model test cleanup: offKernel failed", e); }
      try { await ctx.sessions.stop(); } catch (e) { console.warn("model test cleanup: stop failed", e); }
      if (sessionFile) { try { await ctx.fs?.removePath(sessionFile); } catch (e) { console.warn("model test cleanup: remove session file failed", e); } }
      // compare-and-restore:测试期间 store 经 sessionStart 指向测试 sessionFile;
      // 此刻指向别处(null=用户开了新会话)= 用户已介入,放弃恢复,不覆盖用户状态
      const now = useUiStore.getState();
      const untouched = now.currentCwd === currentCwd
        && (now.currentSessionPath === sessionFile || now.currentSessionPath === currentSessionPath);
      if (untouched) {
        try { ctx.sessions.setContext(currentCwd, currentSessionPath); } catch (e) { console.warn("model test cleanup: restore context failed", e); }
      }
      setTestingId(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
      {/* Provider 字段 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderBottom: "1px solid var(--color-border)", paddingBottom: "var(--spacing-md)" }}>
        <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("models.providerId")}</label>
          <input value={editId} onChange={(e) => setEditId(e.target.value)} onBlur={() => { if (!onRename(providerId, editId)) setEditId(providerId); }} style={inputStyle} />
          <button onClick={() => onCopyProvider(providerId)} style={btnStyle(false)}>{t("models.copyProvider")}</button>
          <button onClick={() => onDelete(providerId)} style={{ ...btnStyle(false), borderColor: "var(--color-accent.error)", color: "var(--color-accent.error)" }}>{t("models.deleteProvider")}</button>
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
          <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{t("models.title", { count: provider.models?.length ?? 0 })}</h3>
          <button onClick={() => onAddModel(providerId)} style={btnStyle(true)}>{t("models.addModel")}</button>
        </div>
        <AnimatePresence initial={false}>
        {(provider.models ?? []).map((m, idx) => (
          <motion.div
            key={m.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--spacing-sm) var(--spacing-md)", marginBottom: "var(--spacing-sm)", display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}
          >
            <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
              <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)", flexShrink: 0 }}>{t("models.modelId")}</label>
              <input value={m.id} onChange={(e) => onUpdateModel(providerId, idx, { id: e.target.value })} style={inputStyle} placeholder={t("models.modelId")} />
              <button
                onClick={() => testModel(m.id)}
                disabled={testStates[m.id]?.state === "testing" || !!testingId}
                title={testStates[m.id]?.error}
                style={{
                  ...btnStyle(false), padding: "var(--spacing-xs) var(--spacing-sm)",
                  whiteSpace: "nowrap", flexShrink: 0,
                  ...(testStates[m.id]?.state === "success" ? { borderColor: "var(--color-accent.success)", color: "var(--color-accent.success)" } : {}),
                  ...(testStates[m.id]?.state === "error" ? { borderColor: "var(--color-accent.error)", color: "var(--color-accent.error)" } : {}),
                }}
              >
                {testStates[m.id]?.state === "testing" ? t("models.testing")
                  : testStates[m.id]?.state === "success" ? "✓"
                  : testStates[m.id]?.state === "error" ? "✗"
                  : t("models.test")}
              </button>
              <button onClick={() => onCopyModel(providerId, idx)} style={{ ...btnStyle(false), padding: "var(--spacing-xs)" }}>{t("models.copy")}</button>
              <button onClick={() => onDeleteModel(providerId, idx)} style={{ ...btnStyle(false), borderColor: "var(--color-accent.error)", color: "var(--color-accent.error)", padding: "var(--spacing-xs)" }}>{t("models.delete")}</button>
            </div>
            <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
              <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)", flexShrink: 0 }}>{t("models.name")}</label>
              <input value={m.name} onChange={(e) => onUpdateModel(providerId, idx, { name: e.target.value })} style={inputStyle} placeholder={t("models.modelName")} />
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-md)", rowGap: "var(--spacing-xs)", fontSize: "var(--font-size-sm)", marginLeft: "calc(80px + var(--spacing-sm))" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", cursor: "pointer" }}>
                <input type="checkbox" checked={!!m.reasoning} onChange={(e) => onUpdateModel(providerId, idx, { reasoning: e.target.checked })} />
                reasoning
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", flexShrink: 0 }}>
                contextWindow
                <input type="number" value={m.contextWindow ?? 0} onChange={(e) => onUpdateModel(providerId, idx, { contextWindow: Number(e.target.value) })} style={{ ...inputStyle, width: "auto", minWidth: "80px", flexShrink: 0 }} />
                <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-family-mono)", whiteSpace: "nowrap" }}>≈ {Math.round((m.contextWindow ?? 0) / 1024)}K</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", flexShrink: 0 }}>
                maxTokens
                <input type="number" value={m.maxTokens ?? 0} onChange={(e) => onUpdateModel(providerId, idx, { maxTokens: Number(e.target.value) })} style={{ ...inputStyle, width: "auto", minWidth: "80px", flexShrink: 0 }} />
                <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-family-mono)", whiteSpace: "nowrap" }}>≈ {Math.round((m.maxTokens ?? 0) / 1024)}K</span>
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
    // flex 行内 input 默认 min-width:auto(≈固有宽 20 字符)不收缩;归 0 让右栏可适配窄面板。
    // number 输入的覆盖处自带 minWidth:80px,不受影响。
    minWidth: 0,
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
