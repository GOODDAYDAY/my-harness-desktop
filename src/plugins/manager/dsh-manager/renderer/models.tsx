// dsh-manager 插件 renderer ——「DSH 入口 · 模型配置」TAB。
//
// dsh 的 provider = LLM 适配器路由：llm-deepseek 一个固定 route「deepseek-official」+
// llm-pi-ai 的 providers 多路由 dict（key = route）。对齐官方 schema（§design 2.3/3.7）：
// 每 route 有 apiKeyEnv / displayName / api / baseURL / models。密钥字面值按 provider 存
// prefs.dshApiKeys（spawn 时注入各 route 的 apiKeyEnv 名下）；baseURL/api/models 写 settings.yaml。
// saveMode=manual：本页自己管 save，框架的 configFile 通道只认 JSON，dsh 的 settings.yaml 是 YAML。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Button, ListItem, Select, SettingsSection, type SettingsComponentProps, usePluginContext, useUiStore } from "@my-harness-desktop/react";
import type { DshModelSpec, DshProvider, DshDefaultModel } from "@my-harness-desktop/contract";
import { DSH_OFFICIAL_PROVIDER } from "@my-harness-desktop/contract";

type TestState = "testing" | "success" | "error";

/** 默认模型变更广播（对齐 pi-manager 的 defaultChanged）：会话流等订阅方据此切当前选择。 */
export const channels = ["dsh-manager:defaultChanged"] as const;

export function DshModelsPage({ refreshSignal }: SettingsComponentProps): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const [providers, setProviders] = useState<DshProvider[]>([]);
  const [selected, setSelected] = useState("");
  const [dirty, setDirty] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    void ctx.dshModels.get().then((ps) => {
      setProviders(ps);
      setSelected((prev) => (ps.some((p) => p.provider === prev) ? prev : (ps[0]?.provider ?? "")));
      setDirty(false);
    });
  }, [ctx, refreshSignal]);

  const activeProvider = providers.find((p) => p.provider === selected);

  // 所有增删改都走这里：本地 state 更新 + 标 dirty（manual save 下「测试」据此禁用，避免测未落盘配置）。
  const updateProviders = (next: DshProvider[]): void => {
    setProviders(next);
    setDirty(true);
  };

  const addProvider = (): void => {
    const id = `provider-${crypto.randomUUID().slice(0, 8)}`;
    updateProviders([...providers, { provider: id, displayName: id, api: "openai-completions", models: [] }]);
    setSelected(id);
  };
  const copyProvider = (id: string): void => {
    const src = providers.find((p) => p.provider === id);
    if (!src) return;
    let newId = `${id}-copy`;
    let i = 1;
    while (providers.some((p) => p.provider === newId)) newId = `${id}-copy-${i++}`;
    updateProviders([...providers, { ...structuredClone(src), provider: newId }]);
    setSelected(newId);
  };
  const renameProvider = (oldId: string, newId: string): boolean => {
    const id = newId.trim();
    if (id === oldId) return true;
    if (!id || providers.some((p) => p.provider === id)) return false;
    updateProviders(providers.map((p) => (p.provider === oldId ? { ...p, provider: id } : p)));
    setSelected(id);
    return true;
  };
  const deleteProvider = (id: string): void => {
    const next = providers.filter((p) => p.provider !== id);
    updateProviders(next);
    if (selected === id) setSelected(next[0]?.provider ?? "");
  };

  const save = async (): Promise<void> => {
    // 逐个 provider 写回（deepseek-official 走 llm-deepseek namespace，其余走 llm-pi-ai.providers）。
    // 删除的 provider 额外调 removeProvider 清掉 settings.yaml 里的残留路由。
    let next = providers;
    for (const p of next) {
      next = await ctx.dshModels.set(p.provider, { apiKeyEnv: p.apiKeyEnv, displayName: p.displayName, api: p.api, baseURL: p.baseURL, models: p.models });
    }
    setProviders(next);
    setDirty(false);
  };

  return (
    <SettingsSection title={t("dsh.modelsTitle")} description={t("dsh.modelsDesc")} actions={
      <>
        <Button variant="secondary" onClick={() => void ctx.openFile("~/.dsh/settings.yaml")}>{t("dsh.openConfig")}</Button>
        <Button variant="secondary" style={{ marginLeft: "auto" }} onClick={() => setImportOpen(true)}>{t("dsh.import")}</Button>
      </>
    }>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 160px) 1fr", gap: "var(--spacing-lg)", alignItems: "start" }}>
        {/* 左:provider 路由列表(deepseek-official 固定不可删/改名,其余 llm-pi-ai 路由可增删改) */}
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
          {providers.map((p) => (
            <ContextMenu.Root key={p.provider}>
              <ContextMenu.Trigger asChild>
                <div>
                  <ListItem
                    active={selected === p.provider}
                    onClick={() => setSelected(p.provider)}
                    style={{ fontFamily: "var(--font-family-mono)", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                  >
                    <span>{p.displayName ?? p.provider}</span>
                    <span style={{ color: "var(--color-muted)", fontSize: "var(--spacing-xs)" }}>({p.models.length})</span>
                  </ListItem>
                </div>
              </ContextMenu.Trigger>
              {p.provider !== DSH_OFFICIAL_PROVIDER && (
                <ContextMenu.Portal>
                  <ContextMenu.Content style={{
                    background: "var(--color-surface)", border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-md)",
                    padding: "var(--spacing-xs) 0", minWidth: "120px", zIndex: 99999,
                  }}>
                    <ContextMenu.Item onSelect={() => copyProvider(p.provider)} style={ctxItemStyle(false)}>{t("dsh.copyProvider")}</ContextMenu.Item>
                    <ContextMenu.Item onSelect={() => deleteProvider(p.provider)} style={ctxItemStyle(true)}>{t("dsh.deleteProvider")}</ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              )}
            </ContextMenu.Root>
          ))}
          <Button variant="primary" onClick={addProvider} style={{ marginTop: "var(--spacing-sm)" }}>{t("dsh.addProvider")}</Button>
        </div>

        {/* 右:provider 详情 + model 列表 */}
        <div style={{ minWidth: 0 }}>
          {activeProvider ? (
            <DshProviderDetail
              provider={activeProvider}
              ctx={ctx}
              dirty={dirty}
              onUpdate={(patch) => updateProviders(providers.map((p) => (p.provider === selected ? { ...p, ...patch } : p)))}
              onRename={(newId) => renameProvider(selected, newId)}
              onCopyProvider={() => copyProvider(selected)}
              onDeleteProvider={() => deleteProvider(selected)}
              onAddModel={(m) => updateProviders(providers.map((p) => (p.provider === selected ? { ...p, models: [m, ...p.models] } : p)))}
              onSave={save}
            />
          ) : (
            <div style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>{t("dsh.selectProvider")}</div>
          )}
        </div>
      </div>
      {importOpen && (
        <DshImportModal providers={providers} onConfirm={(merged) => { updateProviders(merged); setImportOpen(false); }} onClose={() => setImportOpen(false)} />
      )}
    </SettingsSection>
  );
}

function DshProviderDetail({
  provider, ctx, dirty, onUpdate, onRename, onCopyProvider, onDeleteProvider, onAddModel, onSave,
}: {
  provider: DshProvider;
  ctx: ReturnType<typeof usePluginContext>;
  dirty: boolean;
  onUpdate: (patch: Partial<DshProvider>) => void;
  onRename: (newId: string) => boolean;
  onCopyProvider: () => void;
  onDeleteProvider: () => void;
  onAddModel: (m: DshModelSpec) => void;
  onSave: () => Promise<void>;
}): React.ReactNode {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [defaultSel, setDefaultSel] = useState<DshDefaultModel | null>(null);
  const [testStates, setTestStates] = useState<Record<string, { state: TestState; error?: string }>>({});
  const testingRef = useRef<Set<string>>(new Set());
  const [apiKey, setApiKey] = useState("");
  const [editId, setEditId] = useState(provider.provider);

  const isOfficial = provider.provider === DSH_OFFICIAL_PROVIDER;

  useEffect(() => { setEditId(provider.provider); }, [provider.provider]);

  useEffect(() => {
    void ctx.dshModels.getDefault().then(setDefaultSel);
    // 密钥按 provider 存 prefs.dshApiKeys（map）;旧单值 dshApiKey 已在 bootstrap 迁移为 deepseek-official。
    void ctx.prefs.get<Record<string, string>>("dshApiKeys").then((m) => setApiKey(m?.[provider.provider] ?? ""));
  }, [ctx, provider.provider]);

  const setApiKeyPersist = (v: string): void => {
    setApiKey(v);
    void ctx.prefs.get<Record<string, string>>("dshApiKeys").then((m) => {
      const next = { ...(m ?? {}) };
      if (v) next[provider.provider] = v; else delete next[provider.provider];
      void ctx.prefs.set("dshApiKeys", next);
    });
  };

  const setDefault = async (modelId: string): Promise<void> => {
    try {
      const sel = await ctx.dshModels.setDefault({ provider: provider.provider, model: modelId });
      setDefaultSel(sel);
      ctx.events.emit(channels[0], { provider: provider.provider, modelId });
    } catch (err) {
      console.error("[dsh] 设为默认失败:", err);
    }
  };

  const testModel = async (modelId: string): Promise<void> => {
    const testKey = `${provider.provider}/${modelId}`;
    if (testingRef.current.has(testKey)) return;
    testingRef.current.add(testKey);
    setTestStates((prev) => ({ ...prev, [testKey]: { state: "testing" } }));
    try {
      const cwd = useUiStore.getState().currentCwd;
      const r = await ctx.dshModels.test(cwd, provider.provider, modelId);
      setTestStates((prev) => ({ ...prev, [testKey]: { state: r.ok ? "success" : "error", error: r.error } }));
      if (r.ok) {
        setTimeout(() => setTestStates((prev) => {
          if (prev[testKey]?.state === "success") { const n = { ...prev }; delete n[testKey]; return n; }
          return prev;
        }), 3000);
      }
    } catch (err) {
      setTestStates((prev) => ({ ...prev, [testKey]: { state: "error", error: err instanceof Error ? err.message : String(err) } }));
    } finally {
      testingRef.current.delete(testKey);
    }
  };

  const addModel = (): void =>
    onAddModel({ id: `model-${crypto.randomUUID().slice(0, 8)}`, contextWindow: 128000, maxTokens: 8192 });
  const updateModel = (idx: number, patch: Partial<DshModelSpec>): void =>
    onUpdate({ models: provider.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
  const copyModel = (idx: number): void =>
    onUpdate({ models: [...provider.models.slice(0, idx + 1), { ...provider.models[idx], id: `${provider.models[idx].id}-copy` }, ...provider.models.slice(idx + 1)] });
  const deleteModel = (idx: number): void =>
    onUpdate({ models: provider.models.filter((_, i) => i !== idx) });

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await onSave();
      setSaveMsg({ ok: true, text: t("dsh.modelsSaved") });
    } catch (err) {
      setSaveMsg({ ok: false, text: t("dsh.modelsSaveFailed", { error: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
      {/* Provider 字段 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderBottom: "1px solid var(--color-border)", paddingBottom: "var(--spacing-md)" }}>
        <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("dsh.providerId")}</label>
          {isOfficial ? (
            <span style={{ ...inputBaseStyle(), fontFamily: "var(--font-family-mono)", display: "flex", alignItems: "center" }}>{provider.provider}</span>
          ) : (
            <input value={editId} onChange={(e) => setEditId(e.target.value)} onBlur={() => { if (!onRename(editId)) setEditId(provider.provider); }} style={inputBaseStyle()} />
          )}
          {!isOfficial && (
            <>
              <Button variant="secondary" onClick={onCopyProvider}>{t("dsh.copyProvider")}</Button>
              <Button variant="danger" onClick={onDeleteProvider}>{t("dsh.deleteProvider")}</Button>
            </>
          )}
        </div>

        {!isOfficial && (
          <FieldInput label={t("dsh.displayName")} value={provider.displayName ?? provider.provider} onChange={(v) => onUpdate({ displayName: v || undefined })} />
        )}
        {!isOfficial && (
          <FieldInput label={t("dsh.apiKeyEnv")} value={provider.apiKeyEnv ?? ""} onChange={(v) => onUpdate({ apiKeyEnv: v || undefined })} mono />
        )}
        {!isOfficial && (
          <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
            <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("dsh.api")}</label>
            <Select value={provider.api ?? "openai-completions"} onChange={(v) => onUpdate({ api: v })} style={{ flex: 1, minWidth: 0 }} ariaLabel="api">
              <option value="openai-completions">openai-completions</option>
              <option value="anthropic-messages">anthropic-messages</option>
              <option value="google-genai">google-genai</option>
              <option value="openai-responses">openai-responses</option>
            </Select>
          </div>
        )}
        <FieldInput label={t("dsh.baseURL")} value={provider.baseURL ?? ""} onChange={(v) => onUpdate({ baseURL: v || undefined })} mono placeholder="https://…" />
        <FieldInput label={t("dsh.apiKey")} value={apiKey} onChange={setApiKeyPersist} mono secret placeholder="sk-…" />
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>
          {t("dsh.apiKeyDesc", { env: provider.apiKeyEnv ?? (isOfficial ? "DEEPSEEK_API_KEY" : "") })}
        </div>
      </div>

      {/* Model 列表 */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--spacing-sm)" }}>
          <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{t("dsh.modelsCount", { count: provider.models.length })}</h3>
          <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
            <Button variant="primary" onClick={addModel}>{t("dsh.addModel")}</Button>
            <Button variant="secondary" onClick={() => void save()} disabled={saving}>{saving ? t("dsh.saving") : t("dsh.save")}</Button>
          </div>
        </div>
        {saveMsg && (
          <p style={{ margin: "0 0 var(--spacing-sm)", fontSize: "var(--font-size-sm)", color: saveMsg.ok ? "var(--color-accent-success)" : "var(--color-accent-error)" }}>
            {saveMsg.text}
          </p>
        )}
        <AnimatePresence initial={false}>
          {provider.models.map((m, idx) => (
            <DshModelRow
              key={idx}
              model={m}
              idx={idx}
              providerId={provider.provider}
              defaultTarget={defaultSel}
              testStates={testStates}
              dirty={dirty}
              onUpdateModel={updateModel}
              setDefault={setDefault}
              testModel={testModel}
              onCopyModel={copyModel}
              onDeleteModel={deleteModel}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function DshModelRow({
  model, idx, providerId, defaultTarget, testStates, dirty,
  onUpdateModel, setDefault, testModel, onCopyModel, onDeleteModel,
}: {
  model: DshModelSpec;
  idx: number;
  providerId: string;
  defaultTarget: DshDefaultModel | null;
  testStates: Record<string, { state: TestState; error?: string }>;
  dirty: boolean;
  onUpdateModel: (idx: number, patch: Partial<DshModelSpec>) => void;
  setDefault: (modelId: string) => Promise<void>;
  testModel: (modelId: string) => Promise<void>;
  onCopyModel: (idx: number) => void;
  onDeleteModel: (idx: number) => void;
}): React.ReactNode {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--spacing-sm) var(--spacing-md)", marginBottom: "var(--spacing-sm)", display: "grid", gridTemplateColumns: "80px minmax(0, 1fr)", columnGap: "var(--spacing-sm)", rowGap: "var(--spacing-xs)", alignItems: "center" }}
    >
      <label style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("dsh.modelId")}</label>
      <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center", minWidth: 0 }}>
        <input value={model.id} onChange={(e) => onUpdateModel(idx, { id: e.target.value })} style={inputBaseStyle()} placeholder={t("dsh.modelId")} />
        {defaultTarget?.provider === providerId && defaultTarget?.model === model.id ? (
          <Button variant="secondary" disabled title={`${defaultTarget.provider}/${defaultTarget.model}`} style={{ padding: "var(--spacing-xs) var(--spacing-sm)", borderColor: "var(--color-primary)", color: "var(--color-primary)", flexShrink: 0 }}>★ {t("dsh.defaultBadge")}</Button>
        ) : (
          <Button variant="secondary" onClick={() => void setDefault(model.id)} style={{ padding: "var(--spacing-xs) var(--spacing-sm)", flexShrink: 0 }}>{t("dsh.setDefault")}</Button>
        )}
        <Button
          variant="secondary"
          onClick={() => void testModel(model.id)}
          disabled={testStates[`${providerId}/${model.id}`]?.state === "testing" || dirty}
          title={dirty ? t("dsh.saveBeforeTest") : testStates[`${providerId}/${model.id}`]?.error}
          style={{
            padding: "var(--spacing-xs) var(--spacing-sm)", flexShrink: 0,
            ...(testStates[`${providerId}/${model.id}`]?.state === "success" ? { borderColor: "var(--color-accent-success)", color: "var(--color-accent-success)" } : {}),
            ...(testStates[`${providerId}/${model.id}`]?.state === "error" ? { borderColor: "var(--color-accent-error)", color: "var(--color-accent-error)" } : {}),
          }}
        >
          {testStates[`${providerId}/${model.id}`]?.state === "testing" ? t("dsh.testing") : testStates[`${providerId}/${model.id}`]?.state === "success" ? "✓" : testStates[`${providerId}/${model.id}`]?.state === "error" ? "✗" : t("dsh.test")}
        </Button>
        <Button variant="secondary" onClick={() => onCopyModel(idx)} style={{ padding: "var(--spacing-xs)" }}>{t("dsh.copy")}</Button>
        <Button variant="danger" onClick={() => onDeleteModel(idx)} style={{ padding: "var(--spacing-xs)" }}>{t("dsh.delete")}</Button>
      </div>
      <label style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("dsh.name")}</label>
      <input value={model.name ?? ""} onChange={(e) => onUpdateModel(idx, { name: e.target.value || undefined })} style={inputBaseStyle()} placeholder={t("dsh.modelName")} />
      <span />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-md)", rowGap: "var(--spacing-xs)", fontSize: "var(--font-size-sm)", alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", flexShrink: 0 }}>
          contextWindow
          <input type="number" value={model.contextWindow ?? 0} onChange={(e) => onUpdateModel(idx, { contextWindow: Number(e.target.value) })} style={{ ...inputBaseStyle(), width: "90px", minWidth: "90px", flexShrink: 0 }} />
          <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-family-mono)", whiteSpace: "nowrap" }}>≈ {Math.round((model.contextWindow ?? 0) / 1024)}K</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", flexShrink: 0 }}>
          maxTokens
          <input type="number" value={model.maxTokens ?? 0} onChange={(e) => onUpdateModel(idx, { maxTokens: Number(e.target.value) })} style={{ ...inputBaseStyle(), width: "90px", minWidth: "90px", flexShrink: 0 }} />
          <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-family-mono)", whiteSpace: "nowrap" }}>≈ {Math.round((model.maxTokens ?? 0) / 1024)}K</span>
        </label>
      </div>
      {testStates[`${providerId}/${model.id}`]?.state === "error" && (
        <>
          <span />
          <div style={{ color: "var(--color-accent-error)", fontSize: "var(--font-size-sm)", wordBreak: "break-all" }}>
            {testStates[`${providerId}/${model.id}`]?.error}
          </div>
        </>
      )}
    </motion.div>
  );
}

/** 导入弹层：粘贴 JSON（dsh provider 路由形状），已存在 provider 覆盖，否则追加。 */
function DshImportModal({ providers, onConfirm, onClose }: { providers: DshProvider[]; onConfirm: (merged: DshProvider[]) => void; onClose: () => void }): React.ReactNode {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const confirm = (): void => {
    try {
      const data = JSON.parse(text) as unknown;
      const list = Array.isArray(data) ? data : [data];
      let next = providers;
      for (const item of list) {
        const o = item as DshProvider;
        if (!o || typeof o.provider !== "string" || !Array.isArray(o.models)) {
          setErr(t("dsh.importInvalid"));
          return;
        }
        const idx = next.findIndex((p) => p.provider === o.provider);
        next = idx >= 0 ? next.map((p, i) => (i === idx ? o : p)) : [...next, o];
      }
      onConfirm(next);
    } catch {
      setErr(t("dsh.importInvalid"));
    }
  };

  return (
    <div style={{ marginTop: "var(--spacing-md)", display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--spacing-md)" }}>
      <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("dsh.importDesc")}</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='[{"provider":"openai","api":"openai-completions","baseURL":"https://api.openai.com/v1","models":[{"id":"gpt-4o"}]}]'
        style={{ ...inputBaseStyle(), minHeight: "120px", resize: "vertical" }}
      />
      {err && <p style={{ margin: 0, fontSize: "var(--font-size-sm)", color: "var(--color-accent-error)" }}>{err}</p>}
      <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
        <Button variant="primary" onClick={confirm} disabled={!text.trim()}>{t("dsh.importConfirm")}</Button>
        <Button variant="secondary" onClick={onClose}>{t("dsh.importCancel")}</Button>
      </div>
    </div>
  );
}

function FieldInput({ label, value, onChange, mono, secret, placeholder }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; secret?: boolean; placeholder?: string }): React.ReactNode {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  return (
    <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
      <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{label}</label>
      <input
        type={secret && !revealed ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ ...inputBaseStyle(), fontFamily: mono ? "var(--font-family-mono)" : "var(--font-family-sans)" }}
      />
      {secret && (
        <Button variant="secondary" onClick={() => setRevealed((r) => !r)} style={{ padding: "var(--spacing-xs) var(--spacing-sm)", flexShrink: 0 }}>
          {revealed ? t("dsh.hideKey") : t("dsh.showKey")}
        </Button>
      )}
    </div>
  );
}

function inputBaseStyle(): React.CSSProperties {
  return {
    padding: "var(--spacing-xs) var(--spacing-sm)",
    border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
    background: "var(--color-surface)", color: "var(--color-fg)",
    fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
    minWidth: 0, width: "100%", boxSizing: "border-box",
  };
}

function ctxItemStyle(danger: boolean): React.CSSProperties {
  return {
    display: "block", width: "100%", padding: "var(--spacing-xs) var(--spacing-md)",
    border: "none", background: "transparent", cursor: "pointer", textAlign: "left",
    fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)",
    color: danger ? "var(--color-accent-error)" : "var(--color-fg)",
    outline: "none",
  };
}
