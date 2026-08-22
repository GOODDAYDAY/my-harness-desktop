// packages/react 内核管理共享 base —— 「模型配置页」骨架（kernel-design-spec.md §12.5）。
//
// pi-manager 的 ModelManagerPage 与 dsh-manager 的 DshModelsPage 曾是两份独立 copy，
// 功能态漂移（保存方式/字段拼写/删除改名不落盘）。本组件把 provider 列表 + 详情 +
// 模型行 + 默认模型 + 测试 + 导入收敛成一份，pi/dsh 只填 spec（api + i18nPrefix +
// capabilities）。差异经适配器翻译（形状）+ capabilities（能力旗标降级）抹平，
// 不含 `if (kernel === "pi")` 分支。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Button } from "../widgets/button";
import { ListItem } from "../list-item";
import { Select } from "../widgets/select";
import { SettingsSection } from "../settings-section";
import { usePluginContext } from "../plugin-context";
import { useUiStore } from "../../../../src/api/renderer/stores/ui-store";
import type { KernelModelsApi, KernelModelsCapabilities, NeutralModel, NeutralProvider } from "@my-harness-desktop/contract";

type TestState = "testing" | "success" | "error";

export interface ModelConfigPageProps {
  api: KernelModelsApi;
  i18nPrefix: string;
  capabilities: KernelModelsCapabilities;
  /** 页头「打开原始配置」按钮目标（如 pi 的 ~/.pi/agent/models.json / dsh 的 ~/.dsh/settings.yaml）。不传则不显示。 */
  openConfigPath?: string;
  /** 默认模型变更后回调（插件据此 emit 自己的 defaultChanged 频道，base 不硬编码频道名）。 */
  onDefaultChanged?: (sel: { provider: string; model: string }) => void;
}

export function ModelConfigPage({ api, i18nPrefix, capabilities, openConfigPath, onDefaultChanged }: ModelConfigPageProps): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const k = (suffix: string, vars?: Record<string, unknown>): string => t(`${i18nPrefix}.${suffix}`, vars);
  const [providers, setProviders] = useState<NeutralProvider[]>([]);
  const [selected, setSelected] = useState("");
  const [dirty, setDirty] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const reload = (): void => {
    void api.list().then((ps) => {
      setProviders(ps);
      setSelected((prev) => (ps.some((p) => p.id === prev) ? prev : (ps[0]?.id ?? "")));
      setDirty(false);
    });
  };
  useEffect(reload, [api]);

  const activeProvider = providers.find((p) => p.id === selected);

  const updateProviders = (next: NeutralProvider[]): void => {
    setProviders(next);
    setDirty(true);
  };

  const addProvider = (): void => {
    const id = `provider-${crypto.randomUUID().slice(0, 8)}`;
    updateProviders([...providers, { id, displayName: id, api: "openai-completions", models: [] }]);
    setSelected(id);
  };
  const copyProvider = (id: string): void => {
    const src = providers.find((p) => p.id === id);
    if (!src) return;
    let newId = `${id}-copy`;
    let i = 1;
    while (providers.some((p) => p.id === newId)) newId = `${id}-copy-${i++}`;
    updateProviders([...providers, { ...structuredClone(src), id: newId }]);
    setSelected(newId);
  };
  // 改名/删除立即落盘（api.rename/api.remove），不再「改本地 state + 靠 set 覆盖」——
  // 后者会残留旧 route（dsh settings.yaml 旧 route 复活 bug 的根因）。
  const renameProvider = (oldId: string, newId: string): boolean => {
    const id = newId.trim();
    if (id === oldId) return true;
    if (!id || providers.some((p) => p.id === id)) return false;
    void api.rename(oldId, id).then(setProviders).catch((e) => console.error(e));
    setSelected(id);
    return true;
  };
  const deleteProvider = (id: string): void => {
    const next = providers.filter((p) => p.id !== id);
    updateProviders(next);
    void api.remove(id).then(setProviders).catch((e) => console.error(e));
    if (selected === id) setSelected(next[0]?.id ?? "");
  };

  const save = async (): Promise<void> => {
    // 逐 provider 写回；删除/改名已实时落盘，这里只写存量 provider 的字段/模型。
    let next = providers;
    for (const p of next) {
      next = await api.set(p.id, { displayName: p.displayName, baseUrl: p.baseUrl, api: p.api, apiKey: p.apiKey, models: p.models });
    }
    setProviders(next);
    setDirty(false);
  };

  // 导出：当前 provider 列表序列化为中性 JSON（与导入同形状，导出→导入无损往返），
  // 走系统保存对话框（main 写盘，renderer 不碰任意路径）。含 apiKey——它是 pi models.json
  // 内联的一部分、dsh prefs 密钥的字面备份，导出即「完整配置备份」语义。
  const exportConfig = async (): Promise<void> => {
    const json = JSON.stringify(providers, null, 2);
    await ctx.dialog.saveTextFile({
      name: "model-config.json",
      content: json,
      defaultFileName: "model-config.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
  };

  return (
    <SettingsSection title={k("title")} description={k("desc")} actions={
      <span style={{ marginLeft: "auto", display: "flex", gap: "var(--spacing-xs)", alignItems: "center" }}>
        {openConfigPath && (
          <Button variant="secondary" onClick={() => void ctx.openFile(openConfigPath)}>{k("openConfig")}</Button>
        )}
        <Button variant="secondary" onClick={() => void exportConfig()}>{k("export")}</Button>
        <Button variant="secondary" onClick={() => setImportOpen(true)}>{k("import")}</Button>
      </span>
    }>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 160px) 1fr", gap: "var(--spacing-lg)", alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
          {providers.map((p) => (
            <ContextMenu.Root key={p.id}>
              <ContextMenu.Trigger asChild>
                <div>
                  <ListItem
                    active={selected === p.id}
                    onClick={() => setSelected(p.id)}
                    style={{ fontFamily: "var(--font-family-mono)", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                  >
                    <span>{p.displayName ?? p.id}</span>
                    <span style={{ color: "var(--color-muted)", fontSize: "var(--spacing-xs)" }}>({p.models.length})</span>
                  </ListItem>
                </div>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content style={menuContentStyle}>
                  <ContextMenu.Item onSelect={() => copyProvider(p.id)} style={ctxItemStyle(false)}>{k("copyProvider")}</ContextMenu.Item>
                  <ContextMenu.Item onSelect={() => deleteProvider(p.id)} style={ctxItemStyle(true)}>{k("deleteProvider")}</ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ))}
          <Button variant="primary" onClick={addProvider} style={{ marginTop: "var(--spacing-sm)" }}>{k("addProvider")}</Button>
        </div>

        <div style={{ minWidth: 0 }}>
          {activeProvider ? (
            <ProviderDetail
              provider={activeProvider}
              api={api}
              i18nPrefix={i18nPrefix}
              capabilities={capabilities}
              dirty={dirty}
              onDefaultChanged={onDefaultChanged}
              onUpdate={(patch) => updateProviders(providers.map((p) => (p.id === selected ? { ...p, ...patch } : p)))}
              onRename={(newId) => renameProvider(selected, newId)}
              onCopyProvider={() => copyProvider(selected)}
              onDeleteProvider={() => deleteProvider(selected)}
              onAddModel={(m) => updateProviders(providers.map((p) => (p.id === selected ? { ...p, models: [m, ...p.models] } : p)))}
              onSave={save}
            />
          ) : (
            <div style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)" }}>{k("selectProvider")}</div>
          )}
        </div>
      </div>
      {importOpen && (
        <ImportModal
          providers={providers}
          i18nPrefix={i18nPrefix}
          onConfirm={(merged) => { updateProviders(merged); setImportOpen(false); }}
          onClose={() => setImportOpen(false)}
        />
      )}
    </SettingsSection>
  );
}

function ProviderDetail({ provider, api, i18nPrefix, capabilities, dirty, onDefaultChanged, onUpdate, onRename, onCopyProvider, onDeleteProvider, onAddModel, onSave }: {
  provider: NeutralProvider;
  api: KernelModelsApi;
  i18nPrefix: string;
  capabilities: KernelModelsCapabilities;
  dirty: boolean;
  onDefaultChanged?: (sel: { provider: string; model: string }) => void;
  onUpdate: (patch: Partial<NeutralProvider>) => void;
  onRename: (newId: string) => boolean;
  onCopyProvider: () => void;
  onDeleteProvider: () => void;
  onAddModel: (m: NeutralModel) => void;
  onSave: () => Promise<void>;
}): React.ReactNode {
  const { t } = useTranslation();
  const k = (suffix: string, vars?: Record<string, unknown>): string => t(`${i18nPrefix}.${suffix}`, vars);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [defaultSel, setDefaultSel] = useState<{ provider: string; model: string } | null>(null);
  const [testStates, setTestStates] = useState<Record<string, { state: TestState; error?: string }>>({});
  const testingRef = useRef<Set<string>>(new Set());
  const [editId, setEditId] = useState(provider.id);

  useEffect(() => { setEditId(provider.id); }, [provider.id]);
  useEffect(() => { void api.getDefault().then((d) => setDefaultSel(d ? { provider: d.provider, model: d.model } : null)); }, [api]);

  const setDefault = async (modelId: string): Promise<void> => {
    try {
      const sel = await api.setDefault({ provider: provider.id, model: modelId });
      setDefaultSel(sel ? { provider: sel.provider, model: sel.model } : null);
      onDefaultChanged?.({ provider: provider.id, model: modelId });
    } catch (err) {
      console.error("[kernel-models] 设为默认失败:", err);
    }
  };

  const testModel = async (modelId: string): Promise<void> => {
    const testKey = `${provider.id}/${modelId}`;
    if (testingRef.current.has(testKey)) return;
    testingRef.current.add(testKey);
    setTestStates((prev) => ({ ...prev, [testKey]: { state: "testing" } }));
    try {
      const cwd = useUiStore.getState().currentCwd;
      const r = await api.test(cwd, provider.id, modelId);
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
    onAddModel({ id: `model-${crypto.randomUUID().slice(0, 8)}`, name: k("newModel"), contextWindow: 128000, maxTokens: 8192 });
  const updateModel = (idx: number, patch: Partial<NeutralModel>): void =>
    onUpdate({ models: provider.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
  const copyModel = (idx: number): void => {
    const src = provider.models[idx];
    const ids = new Set(provider.models.map((m) => m.id));
    let id = `${src.id}-copy`;
    let i = 1;
    while (ids.has(id)) id = `${src.id}-copy-${i++}`;
    onUpdate({ models: [...provider.models.slice(0, idx + 1), { ...src, id, name: k("copyName", { name: src.name }) }, ...provider.models.slice(idx + 1)] });
  };
  const deleteModel = (idx: number): void =>
    onUpdate({ models: provider.models.filter((_, i) => i !== idx) });

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await onSave();
      setSaveMsg({ ok: true, text: k("saved") });
    } catch (err) {
      setSaveMsg({ ok: false, text: k("saveFailed", { error: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderBottom: "1px solid var(--color-border)", paddingBottom: "var(--spacing-md)" }}>
        <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{k("providerId")}</label>
          <input value={editId} onChange={(e) => setEditId(e.target.value)} onBlur={() => { if (!onRename(editId)) setEditId(provider.id); }} style={inputStyle()} />
          <Button variant="secondary" onClick={onCopyProvider}>{k("copyProvider")}</Button>
          <Button variant="danger" onClick={onDeleteProvider}>{k("deleteProvider")}</Button>
        </div>
        <FieldInput label={k("displayName")} value={provider.displayName ?? provider.id} onChange={(v) => onUpdate({ displayName: v || undefined })} />
        <FieldInput label={k("baseUrl")} value={provider.baseUrl ?? ""} onChange={(v) => onUpdate({ baseUrl: v || undefined })} mono />
        <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{k("api")}</label>
          <Select value={provider.api ?? "openai-completions"} onChange={(v) => onUpdate({ api: v })} style={{ flex: 1, minWidth: 0 }} ariaLabel="api">
            <option value="openai-completions">openai-completions</option>
            <option value="anthropic-messages">anthropic-messages</option>
            <option value="google-genai">google-genai</option>
            <option value="openai-responses">openai-responses</option>
          </Select>
        </div>
        <FieldInput label={k("apiKey")} value={provider.apiKey ?? ""} onChange={(v) => onUpdate({ apiKey: v || undefined })} mono secret i18nPrefix={i18nPrefix} />
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>{k("apiKeyDesc")}</div>
      </div>

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--spacing-sm)" }}>
          <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{k("modelsCount", { count: provider.models.length })}</h3>
          <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
            <Button variant="primary" onClick={addModel}>{k("addModel")}</Button>
            <Button variant="secondary" onClick={() => void save()} disabled={saving}>{saving ? k("saving") : k("save")}</Button>
          </div>
        </div>
        {saveMsg && (
          <p style={{ margin: "0 0 var(--spacing-sm)", fontSize: "var(--font-size-sm)", color: saveMsg.ok ? "var(--color-accent-success)" : "var(--color-accent-error)" }}>
            {saveMsg.text}
          </p>
        )}
        <AnimatePresence initial={false}>
          {provider.models.map((m, idx) => (
            <ModelRow
              key={idx}
              model={m}
              idx={idx}
              providerId={provider.id}
              defaultTarget={defaultSel}
              testStates={testStates}
              dirty={dirty}
              capabilities={capabilities}
              i18nPrefix={i18nPrefix}
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

function ModelRow({ model, idx, providerId, defaultTarget, testStates, dirty, capabilities, i18nPrefix, onUpdateModel, setDefault, testModel, onCopyModel, onDeleteModel }: {
  model: NeutralModel;
  idx: number;
  providerId: string;
  defaultTarget: { provider: string; model: string } | null;
  testStates: Record<string, { state: TestState; error?: string }>;
  dirty: boolean;
  capabilities: KernelModelsCapabilities;
  i18nPrefix: string;
  onUpdateModel: (idx: number, patch: Partial<NeutralModel>) => void;
  setDefault: (modelId: string) => Promise<void>;
  testModel: (modelId: string) => Promise<void>;
  onCopyModel: (idx: number) => void;
  onDeleteModel: (idx: number) => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const k = (suffix: string, vars?: Record<string, unknown>): string => t(`${i18nPrefix}.${suffix}`, vars);
  const [editId, setEditId] = useState(model.id);
  useEffect(() => { setEditId(model.id); }, [model.id]);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--spacing-sm) var(--spacing-md)", marginBottom: "var(--spacing-sm)", display: "grid", gridTemplateColumns: "80px minmax(0, 1fr)", columnGap: "var(--spacing-sm)", rowGap: "var(--spacing-xs)", alignItems: "center" }}
    >
      <label style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{k("modelId")}</label>
      <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center", minWidth: 0 }}>
        <input value={editId} onChange={(e) => setEditId(e.target.value)} onBlur={() => onUpdateModel(idx, { id: editId })} style={inputStyle()} placeholder={k("modelId")} />
        {defaultTarget?.provider === providerId && defaultTarget?.model === model.id ? (
          <Button variant="secondary" disabled title={`${defaultTarget.provider}/${defaultTarget.model}`} style={{ padding: "var(--spacing-xs) var(--spacing-sm)", borderColor: "var(--color-primary)", color: "var(--color-primary)", flexShrink: 0 }}>★ {k("defaultBadge")}</Button>
        ) : (
          <Button variant="secondary" onClick={() => void setDefault(model.id)} style={{ padding: "var(--spacing-xs) var(--spacing-sm)", flexShrink: 0 }}>{k("setDefault")}</Button>
        )}
        <Button
          variant="secondary"
          onClick={() => void testModel(model.id)}
          disabled={testStates[`${providerId}/${model.id}`]?.state === "testing" || dirty}
          title={dirty ? k("saveBeforeTest") : testStates[`${providerId}/${model.id}`]?.error}
          style={{
            padding: "var(--spacing-xs) var(--spacing-sm)", flexShrink: 0,
            ...(testStates[`${providerId}/${model.id}`]?.state === "success" ? { borderColor: "var(--color-accent-success)", color: "var(--color-accent-success)" } : {}),
            ...(testStates[`${providerId}/${model.id}`]?.state === "error" ? { borderColor: "var(--color-accent-error)", color: "var(--color-accent-error)" } : {}),
          }}
        >
          {testStates[`${providerId}/${model.id}`]?.state === "testing" ? k("testing") : testStates[`${providerId}/${model.id}`]?.state === "success" ? "✓" : testStates[`${providerId}/${model.id}`]?.state === "error" ? "✗" : k("test")}
        </Button>
        <Button variant="secondary" onClick={() => onCopyModel(idx)} style={{ padding: "var(--spacing-xs)" }}>{k("copy")}</Button>
        <Button variant="danger" onClick={() => onDeleteModel(idx)} style={{ padding: "var(--spacing-xs)" }}>{k("delete")}</Button>
      </div>
      <label style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{k("name")}</label>
      <input value={model.name ?? ""} onChange={(e) => onUpdateModel(idx, { name: e.target.value || undefined })} style={inputStyle()} placeholder={k("modelName")} />
      <span />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-md)", rowGap: "var(--spacing-xs)", fontSize: "var(--font-size-sm)", alignItems: "center" }}>
        {capabilities.reasoning && (
          <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", cursor: "pointer" }}>
            <input type="checkbox" checked={!!model.reasoning} onChange={(e) => onUpdateModel(idx, { reasoning: e.target.checked })} />
            reasoning
          </label>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", flexShrink: 0 }}>
          contextWindow
          <input type="number" value={model.contextWindow ?? 0} onChange={(e) => onUpdateModel(idx, { contextWindow: Number(e.target.value) })} style={{ ...inputStyle(), width: "90px", minWidth: "90px", flexShrink: 0 }} />
          <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-family-mono)", whiteSpace: "nowrap" }}>≈ {Math.round((model.contextWindow ?? 0) / 1024)}K</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", flexShrink: 0 }}>
          maxTokens
          <input type="number" value={model.maxTokens ?? 0} onChange={(e) => onUpdateModel(idx, { maxTokens: Number(e.target.value) })} style={{ ...inputStyle(), width: "90px", minWidth: "90px", flexShrink: 0 }} />
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

function ImportModal({ providers, i18nPrefix, onConfirm, onClose }: { providers: NeutralProvider[]; i18nPrefix: string; onConfirm: (merged: NeutralProvider[]) => void; onClose: () => void }): React.ReactNode {
  const { t } = useTranslation();
  const k = (suffix: string): string => t(`${i18nPrefix}.${suffix}`);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const confirm = (): void => {
    try {
      const data = JSON.parse(text) as unknown;
      const list = Array.isArray(data) ? data : [data];
      let next = providers;
      for (const item of list) {
        const o = item as NeutralProvider;
        if (!o || typeof o.id !== "string" || !Array.isArray(o.models)) {
          setErr(k("importInvalid"));
          return;
        }
        const idx = next.findIndex((p) => p.id === o.id);
        next = idx >= 0 ? next.map((p, i) => (i === idx ? o : p)) : [...next, o];
      }
      onConfirm(next);
    } catch {
      setErr(k("importInvalid"));
    }
  };

  return (
    <div style={{ marginTop: "var(--spacing-md)", display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--spacing-md)" }}>
      <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{k("importDesc")}</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='[{"id":"openai","api":"openai-completions","baseUrl":"https://api.openai.com/v1","models":[{"id":"gpt-4o"}]}]'
        style={{ ...inputStyle(), minHeight: "120px", resize: "vertical" }}
      />
      {err && <p style={{ margin: 0, fontSize: "var(--font-size-sm)", color: "var(--color-accent-error)" }}>{err}</p>}
      <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
        <Button variant="primary" onClick={confirm} disabled={!text.trim()}>{k("importConfirm")}</Button>
        <Button variant="secondary" onClick={onClose}>{k("importCancel")}</Button>
      </div>
    </div>
  );
}

function FieldInput({ label, value, onChange, mono, secret, i18nPrefix }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; secret?: boolean; i18nPrefix?: string }): React.ReactNode {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  return (
    <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
      <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{label}</label>
      <input
        type={secret && !revealed ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle(), fontFamily: mono ? "var(--font-family-mono)" : "var(--font-family-sans)" }}
      />
      {secret && (
        <Button variant="secondary" onClick={() => setRevealed((r) => !r)} style={{ padding: "var(--spacing-xs) var(--spacing-sm)", flexShrink: 0 }}>
          {revealed ? t(`${i18nPrefix}.hideKey`) : t(`${i18nPrefix}.showKey`)}
        </Button>
      )}
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return {
    padding: "var(--spacing-xs) var(--spacing-sm)",
    border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
    background: "var(--color-surface)", color: "var(--color-fg)",
    fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)",
    minWidth: 0, width: "100%", boxSizing: "border-box",
  };
}

const menuContentStyle: React.CSSProperties = {
  background: "var(--color-surface)", border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)", boxShadow: "var(--shadow-md)",
  padding: "var(--spacing-xs) 0", minWidth: "120px", zIndex: 99999,
};

function ctxItemStyle(danger: boolean): React.CSSProperties {
  return {
    display: "block", width: "100%", padding: "var(--spacing-xs) var(--spacing-md)",
    border: "none", background: "transparent", cursor: "pointer", textAlign: "left",
    fontFamily: "var(--font-family-sans)", fontSize: "var(--font-size-sm)",
    color: danger ? "var(--color-accent-error)" : "var(--color-fg)",
    outline: "none",
  };
}
