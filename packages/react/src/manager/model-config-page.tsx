// packages/react 内核管理共享 base —— 「模型配置页」骨架（kernel-design-spec.md §12.5）。
//
// pi-manager 的 ModelManagerPage 与 dsh-manager 的 DshModelsPage 曾是两份独立 copy，
// 功能态漂移（保存方式/字段拼写/删除改名不落盘）。本组件把 provider 列表 + 详情 +
// 模型行 + 默认模型 + 测试 + 导入收敛成一份，pi/dsh 只填 spec（api + i18nPrefix +
// capabilities）。差异经适配器翻译（形状）+ capabilities（能力旗标降级）抹平，
// 不含 `if (kernel === "pi")` 分支。
//
// 保存走框架管：本组件是「受控组件」——数据来自框架传的 config(中性 KernelModelConfig)、
// 改动经 onChange 上报，框架顶部保存浮层负责落盘(pi/dsh 各自实现 kernelModels.saveConfig)。
// 本组件不自己 set api、不自己管 dirty、不带保存按钮。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Button } from "../widgets/button";
import { ListItem } from "../list-item";
import { Select } from "../widgets/select";
import { SettingsSection } from "../settings-section";
import { usePluginContext } from "../plugin-context";
import { useUiStore } from "../../../../src/web/stores/ui-store";
import type { KernelModelsApi, KernelModelsCapabilities, KernelModelConfig, ModelProbeResult, NeutralDefaultModel, NeutralModel, NeutralProvider } from "@my-harness-desktop/shared";

/** 探测支持的 api 类型(与 server provider-probe 的 PROBEABLE_APIS 一致;UI 预闸门,server 仍兜底降级)。 */
const PROBEABLE_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);

/** 耗时格式化:不足 1s 显示毫秒,以上显示秒。 */
function fmtLatency(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

type TestState = "testing" | "success" | "error";

export interface ModelConfigPageProps {
  api: KernelModelsApi;
  i18nPrefix: string;
  capabilities: KernelModelsCapabilities;
  /** 默认模型变更后回调（插件据此 emit 自己的 defaultChanged 频道，base 不硬编码频道名）。 */
  onDefaultChanged?: (sel: { provider: string; model: string }) => void;
  /** 框架传入的中性模型配置（KernelModelConfig）。 */
  config: Record<string, unknown> | null;
  /** 框架传入的未保存标记。 */
  dirty: boolean;
  /** 改动上报（框架置 dirty + 顶部保存浮层）。 */
  onChange: (config: Record<string, unknown>) => void;
}

export function ModelConfigPage({ api, i18nPrefix, capabilities, onDefaultChanged, config, dirty, onChange }: ModelConfigPageProps): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const k = (suffix: string, vars?: Record<string, unknown>): string => t(`${i18nPrefix}.${suffix}`, vars);
  const [selected, setSelected] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  const modelConfig = config as unknown as KernelModelConfig | null;
  const providers = modelConfig?.providers ?? [];
  const defaultSel = modelConfig?.default ?? null;

  // 选中项兜底：providers 变化(增删改名)时保持选中态指向仍存在的 id。
  useEffect(() => {
    setSelected((prev) => (providers.some((p) => p.id === prev) ? prev : (providers[0]?.id ?? "")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length]);

  const activeProvider = providers.find((p) => p.id === selected);

  /** 提交新的 providers(保留当前 default)。 */
  const commitProviders = (next: NeutralProvider[]): void => {
    onChange({ providers: next, default: defaultSel } as unknown as Record<string, unknown>);
  };
  /** 提交新的 default(保留当前 providers)。 */
  const commitDefault = (next: NeutralDefaultModel | null): void => {
    onChange({ providers, default: next } as unknown as Record<string, unknown>);
  };

  const addProvider = (): void => {
    const id = `provider-${crypto.randomUUID().slice(0, 8)}`;
    commitProviders([...providers, { id, displayName: id, api: "openai-completions", baseUrl: "https://", models: [] }]);
    setSelected(id);
  };
  const copyProvider = (id: string): void => {
    const src = providers.find((p) => p.id === id);
    if (!src) return;
    let newId = `${id}-copy`;
    let i = 1;
    while (providers.some((p) => p.id === newId)) newId = `${id}-copy-${i++}`;
    commitProviders([...providers, { ...structuredClone(src), id: newId }]);
    setSelected(newId);
  };
  // 改名/删除改为「改中性配置 + onChange」，由框架保存浮层统一落盘（不再各自即调 api.rename/remove，
  // 避免一处即写、一处待保存的割裂；也修掉「改名先即写、又被整份 set 覆盖残留旧 route」的老毛病）。
  const renameProvider = (oldId: string, newId: string): boolean => {
    const id = newId.trim();
    if (id === oldId) return true;
    if (!id || providers.some((p) => p.id === id)) return false;
    // 一次 onChange 同时提交改名后的 providers + 同步更新的 default(避免两次 onChange 用旧 providers 互相覆盖)。
    const nextProviders = providers.map((p) => (p.id === oldId ? { ...p, id } : p));
    const nextDefault = defaultSel?.provider === oldId ? { ...defaultSel, provider: id } : defaultSel;
    onChange({ providers: nextProviders, default: nextDefault } as unknown as Record<string, unknown>);
    setSelected(id);
    return true;
  };
  const deleteProvider = (id: string): void => {
    const nextProviders = providers.filter((p) => p.id !== id);
    const nextDefault = defaultSel?.provider === id ? null : defaultSel;
    onChange({ providers: nextProviders, default: nextDefault } as unknown as Record<string, unknown>);
    if (selected === id) setSelected(nextProviders[0]?.id ?? "");
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
              defaultSel={defaultSel}
              onDefaultChanged={onDefaultChanged}
              onUpdate={(patch) => commitProviders(providers.map((p) => (p.id === selected ? { ...p, ...patch } : p)))}
              onRename={(newId) => renameProvider(selected, newId)}
              onCopyProvider={() => copyProvider(selected)}
              onDeleteProvider={() => deleteProvider(selected)}
              onAddModel={(m) => commitProviders(providers.map((p) => (p.id === selected ? { ...p, models: [m, ...p.models] } : p)))}
              onSetDefault={(sel) => commitDefault(sel)}
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
          onConfirm={(merged) => { commitProviders(merged); setImportOpen(false); }}
          onClose={() => setImportOpen(false)}
        />
      )}
    </SettingsSection>
  );
}

function ProviderDetail({ provider, api, i18nPrefix, capabilities, dirty, defaultSel, onDefaultChanged, onUpdate, onRename, onCopyProvider, onDeleteProvider, onAddModel, onSetDefault }: {
  provider: NeutralProvider;
  api: KernelModelsApi;
  i18nPrefix: string;
  capabilities: KernelModelsCapabilities;
  dirty: boolean;
  defaultSel: NeutralDefaultModel | null;
  onDefaultChanged?: (sel: { provider: string; model: string }) => void;
  onUpdate: (patch: Partial<NeutralProvider>) => void;
  onRename: (newId: string) => boolean;
  onCopyProvider: () => void;
  onDeleteProvider: () => void;
  onAddModel: (m: NeutralModel) => void;
  onSetDefault: (sel: NeutralDefaultModel) => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const k = (suffix: string, vars?: Record<string, unknown>): string => t(`${i18nPrefix}.${suffix}`, vars);
  const [testStates, setTestStates] = useState<Record<string, { state: TestState; error?: string }>>({});
  const testingRef = useRef<Set<string>>(new Set());
  const [editId, setEditId] = useState(provider.id);
  // 发现区块默认收起(不占版面);baseUrl 行内的「发现模型」按钮点开才展开。切换 provider 时收回。
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const discoverProbeable = !provider.api || PROBEABLE_APIS.has(provider.api);
  const discoverHasBaseUrl = !!(provider.baseUrl && provider.baseUrl.trim());

  useEffect(() => { setEditId(provider.id); setDiscoverOpen(false); }, [provider.id]);

  const setDefault = (modelId: string): void => {
    onSetDefault({ provider: provider.id, model: modelId });
    onDefaultChanged?.({ provider: provider.id, model: modelId });
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
        <FieldInput
          label={k("baseUrl")}
          value={provider.baseUrl ?? ""}
          onChange={(v) => onUpdate({ baseUrl: v || undefined })}
          mono
          trailing={
            <Button
              variant="secondary"
              onClick={() => setDiscoverOpen((o) => !o)}
              disabled={!discoverProbeable || !discoverHasBaseUrl}
              title={!discoverProbeable ? k("discoverUnsupported") : !discoverHasBaseUrl ? k("discoverNoBaseUrl") : undefined}
              style={{ padding: "var(--spacing-xs) var(--spacing-sm)", flexShrink: 0 }}
            >
              {discoverOpen ? k("discoverCollapse") : k("discoverToggle")}
            </Button>
          }
        />
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

      <DiscoverySection provider={provider} i18nPrefix={i18nPrefix} onAddModel={onAddModel} open={discoverOpen} />

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--spacing-sm)" }}>
          <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{k("modelsCount", { count: provider.models.length })}</h3>
          <Button variant="primary" onClick={addModel}>{k("addModel")}</Button>
        </div>
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

type PingState = { state: "pinging" } | { state: "ok"; latencyMs: number } | { state: "error"; latencyMs?: number; error?: string };

/** 「从 Base URL 发现」区块：扫描端点模型清单 + 逐行 ping 记往返耗时。
 *  探测的是表单当前值（含未保存改动）——不像内核测试依赖落盘配置，故不受 dirty 门控。
 *  发现/ping 走纯 HTTP（ctx.modelsProbe），不起内核进程；「+ 添加」复用 onAddModel 加成配置模型。
 *  显式降级：api 非 OpenAI 兼容 / 未填 baseUrl 时 baseUrl 行内的开启按钮即禁用（tooltip 说明）。
 *  收起用 display:none 而非卸载——保留已扫描/ping 结果，再展开不用重扫。 */
function DiscoverySection({ provider, i18nPrefix, onAddModel, open }: {
  provider: NeutralProvider;
  i18nPrefix: string;
  onAddModel: (m: NeutralModel) => void;
  open: boolean;
}): React.ReactNode {
  const ctx = usePluginContext();
  const { t } = useTranslation();
  const k = (suffix: string, vars?: Record<string, unknown>): string => t(`${i18nPrefix}.${suffix}`, vars);
  const probeable = !provider.api || PROBEABLE_APIS.has(provider.api);
  const hasBaseUrl = !!(provider.baseUrl && provider.baseUrl.trim());
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [pings, setPings] = useState<Record<string, PingState>>({});
  const pingingRef = useRef<Set<string>>(new Set());

  // 端点连接事实变了，旧发现结果作废——防止把 A 端点的扫描/ping 结果当成 B 的。
  useEffect(() => {
    setDiscovered(null); setScanError(null); setPings({}); pingingRef.current.clear();
  }, [provider.id, provider.baseUrl, provider.api, provider.apiKey]);

  const probeInput = (): { baseUrl: string; apiKey?: string; api?: string } =>
    ({ baseUrl: provider.baseUrl ?? "", apiKey: provider.apiKey, api: provider.api });

  const scan = async (): Promise<void> => {
    if (scanning) return;
    setScanning(true); setScanError(null);
    try {
      const r = await ctx.modelsProbe.discover(probeInput());
      if (r.ok) setDiscovered(r.models ?? []);
      else setScanError(r.error ?? "unknown error");
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  const pingOne = async (modelId: string): Promise<void> => {
    if (pingingRef.current.has(modelId)) return;
    pingingRef.current.add(modelId);
    setPings((prev) => ({ ...prev, [modelId]: { state: "pinging" } }));
    try {
      const r: ModelProbeResult = await ctx.modelsProbe.ping({ ...probeInput(), model: modelId });
      setPings((prev) => ({
        ...prev,
        [modelId]: r.ok ? { state: "ok", latencyMs: r.latencyMs ?? 0 } : { state: "error", latencyMs: r.latencyMs, error: r.error },
      }));
    } catch (err) {
      setPings((prev) => ({ ...prev, [modelId]: { state: "error", error: err instanceof Error ? err.message : String(err) } }));
    } finally {
      pingingRef.current.delete(modelId);
    }
  };

  /** 全部 Ping：串行逐个跑，不并发——不给网关施压，每行独立状态。 */
  const pingAll = async (): Promise<void> => {
    for (const id of discovered ?? []) await pingOne(id);
  };

  const configuredCount = discovered?.filter((id) => provider.models.some((m) => m.id === id)).length ?? 0;

  return (
    <div style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", overflow: "hidden", display: open ? undefined : "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", padding: "var(--spacing-sm) var(--spacing-md)", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface)" }}>
        <span style={{ fontSize: "var(--font-size-sm)", fontWeight: 600 }}>{k("discoverTitle")}</span>
        <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-muted)" }}>
          {scanning ? k("discoverScanning") : discovered ? k("discoverSummary", { found: discovered.length, configured: configuredCount }) : ""}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: "var(--spacing-xs)" }}>
          <Button variant="secondary" onClick={() => void scan()} disabled={scanning || !probeable || !hasBaseUrl}>{k("discoverScan")}</Button>
          <Button variant="secondary" onClick={() => void pingAll()} disabled={!discovered || discovered.length === 0 || scanning}>{k("discoverPingAll")}</Button>
        </span>
      </div>
      {!probeable ? (
        <div style={{ padding: "var(--spacing-md)", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{k("discoverUnsupported")}</div>
      ) : !hasBaseUrl ? (
        <div style={{ padding: "var(--spacing-md)", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{k("discoverNoBaseUrl")}</div>
      ) : scanError ? (
        <div style={{ padding: "var(--spacing-md)", fontSize: "var(--font-size-sm)", display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
          <span style={{ color: "var(--color-accent-error)", wordBreak: "break-all" }}>{scanError}</span>
          {provider.models.length > 0 && (
            <span>
              <Button variant="secondary" onClick={() => { setScanError(null); setDiscovered(provider.models.map((m) => m.id)); }}>
                {k("discoverUseConfigured", { count: provider.models.length })}
              </Button>
            </span>
          )}
        </div>
      ) : discovered === null ? (
        <div style={{ padding: "var(--spacing-md)", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{k("discoverEmpty")}</div>
      ) : discovered.length === 0 ? (
        <div style={{ padding: "var(--spacing-md)", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{k("discoverNone")}</div>
      ) : (
        discovered.map((id) => {
          const configured = provider.models.some((m) => m.id === id);
          const p = pings[id];
          return (
            <div key={id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto minmax(90px, auto) auto", gap: "var(--spacing-sm)", alignItems: "center", padding: "var(--spacing-xs) var(--spacing-md)", borderBottom: "1px solid var(--color-border)" }}>
              <span style={{ fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{id}</span>
              <span style={{ fontSize: "var(--font-size-xs)", color: configured ? "var(--color-primary)" : "var(--color-muted)" }}>
                {configured ? k("discoverConfigured") : k("discoverNotConfigured")}
              </span>
              <span style={{
                fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-xs)", textAlign: "right",
                color: p?.state === "ok" ? "var(--color-accent-success)" : p?.state === "error" ? "var(--color-accent-error)" : "var(--color-muted)",
              }} title={p?.state === "error" ? p.error : undefined}>
                {p?.state === "pinging" ? k("discoverPinging")
                  : p?.state === "ok" ? `✓ ${fmtLatency(p.latencyMs)}`
                  : p?.state === "error" ? `✗ ${p.latencyMs != null ? `${fmtLatency(p.latencyMs)} · ` : ""}${p.error ?? ""}`
                  : "—"}
              </span>
              <span style={{ display: "flex", gap: "var(--spacing-xs)", justifyContent: "flex-end" }}>
                <Button variant="secondary" onClick={() => void pingOne(id)} disabled={p?.state === "pinging"} style={{ padding: "var(--spacing-xs) var(--spacing-sm)" }}>{k("discoverPing")}</Button>
                {!configured && (
                  <Button variant="secondary" onClick={() => onAddModel({ id, name: id, contextWindow: 128000, maxTokens: 8192 })} style={{ padding: "var(--spacing-xs) var(--spacing-sm)" }}>{k("discoverAdd")}</Button>
                )}
              </span>
            </div>
          );
        })
      )}
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
  setDefault: (modelId: string) => void;
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
          <Button variant="secondary" onClick={() => setDefault(model.id)} style={{ padding: "var(--spacing-xs) var(--spacing-sm)", flexShrink: 0 }}>{k("setDefault")}</Button>
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

function FieldInput({ label, value, onChange, mono, secret, i18nPrefix, trailing }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; secret?: boolean; i18nPrefix?: string; trailing?: React.ReactNode }): React.ReactNode {
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
      {trailing}
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
