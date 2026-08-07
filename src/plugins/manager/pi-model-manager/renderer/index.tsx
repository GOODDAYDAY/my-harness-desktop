// pi-model-manager 插件 renderer —— pi 底座模型配置管理(~/.pi/agent/models.json)。
//
// 增删改查:provider(增删改)+ 每个 provider 的 models(增删改)。
// 另:默认模型(写底座 settings.json 的 defaultProvider/defaultModel)+ 连通性测试(内核 session:testModel)。
// 用框架 config/onChange(框架管 dirty/save/reset)+ refreshSignal(刷新)。
// 经 @pi-desktop/react 受控 API + @pi-desktop/contract 拿模型配置契约(守薄壳:不直连 shell/application)。
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Button, ListItem, Select, SettingsSection, type SettingsComponentProps, usePluginContext, useUiStore } from "@pi-desktop/react";
import type { ModelsConfig, ProviderConfig, ModelConfig, PluginContext } from "@pi-desktop/contract";
import { ImportModal } from "./import-modal";
import { BaseUrlInput } from "./base-url-input";

type TestState = "testing" | "success" | "error";

/** 框架 configFile 通道契约:文件缺失/解析失败返回 {} —— 兜底成带 providers 的形状,消费侧唯一入口。 */
// 事件:设为默认成功后广播,会话流(timeline)等订阅方据此把当前选择切到新默认——
// 「设为默认」的语义是全局生效,各消费方自己决定怎么用(会话流切当前选择,配置页可忽略)。
export const channels = ["pi-model-manager:defaultChanged"] as const;

function normalizeModelsConfig(raw: unknown): ModelsConfig {
  const cfg = (raw ?? {}) as Partial<ModelsConfig>;
  return { ...cfg, providers: cfg.providers ?? {} };
}


export function ModelManagerPage({ refreshSignal, config: frameworkConfig, dirty: configDirty, onChange }: SettingsComponentProps): React.ReactNode {
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [importOpen, setImportOpen] = useState(false);

  // config 由框架从 models.json 读了传入;useMemo 保引用稳定(下方 effect 依赖 config,避免每 render 重跑)
  const config = useMemo(() => (frameworkConfig ? normalizeModelsConfig(frameworkConfig) : null), [frameworkConfig]);

  // 初始选中 provider:优先默认模型所在 provider(底座 settings.json 的 defaultProvider),
  // 无默认/默认 provider 不存在才落回首个。refreshSignal 变时重试(框架已重读 config)。
  useEffect(() => {
    if (!config?.providers) return;
    let alive = true;
    void ctx.piSettings.get().then((s) => {
      if (!alive) return;
      const dp = typeof s.defaultProvider === "string" ? s.defaultProvider : "";
      setSelectedProvider((prev) =>
        prev || (dp && config.providers[dp] ? dp : Object.keys(config.providers)[0] || ""),
      );
    });
    return () => { alive = false; };
  }, [config, refreshSignal, ctx.piSettings]);

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
  // 返回是否改名成功;失败(空串/撞名)时调用方回滚输入框,避免 UI 与持久数据不一致。
  // 保序重建:Object.fromEntries 按 entries 遍历序构造,改名不改位
  // (旧实现 { ...rest, [id]: cur } 会把 provider 沉到列表末端,Object.keys 插入序跳变)。
  const renameProvider = (oldId: string, newId: string): boolean => {
    const id = newId.trim();
    if (id === oldId) return true;
    if (!id || providers[id]) return false;
    const next = Object.fromEntries(
      Object.entries(providers).map(([k, v]) => (k === oldId ? [id, v] : [k, v])),
    );
    updateConfig({ ...config, providers: next });
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
    <>
    <SettingsSection title={t("settings.models")} description={t("settings.modelsDesc")} actions={
      <Button variant="secondary" style={{ marginLeft: "auto" }} onClick={() => setImportOpen(true)}>{t("models.import")}</Button>
    }>

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
          <Button variant="primary" onClick={addProvider} style={{ marginTop: "var(--spacing-sm)" }}>{t("models.addProvider")}</Button>
        </div>

        {/* 右:provider 详情 + model 列表。minWidth:0 必要——grid item 默认 min-width:auto,
            不能窄于内容固有宽度,不加则面板收窄时右栏被内容顶死、溢出 */}
        <div style={{ minWidth: 0 }}>
          {activeProvider ? (
            <ProviderDetail
               providerId={selectedProvider}
               provider={activeProvider}
               allProviders={providers}
               ctx={ctx}
               configDirty={configDirty ?? false}
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
    {importOpen && config && (
      <ImportModal
        config={config}
        onConfirm={(merged) => updateConfig(merged)}
        onClose={() => setImportOpen(false)}
      />
    )}
    </>
  );
}

function ProviderDetail({
  providerId, provider, allProviders, ctx, configDirty, onRename, onUpdate, onDelete, onCopyProvider, onAddModel, onDeleteModel, onCopyModel, onUpdateModel,
}: {
  providerId: string;
  provider: ProviderConfig;
  allProviders: Record<string, ProviderConfig>;
  ctx: PluginContext;
  configDirty: boolean;
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
  // 在测 key 集合(per-key 并发锁):不同模型可同时测——内核 test() 每次独立进程 key
  // (test:uuid),天然支持并发;旧实现用单值 testingId 全局锁,一个在测全部置灰,
  // 纯属 UI 层人为限制,已去除。
  const testingRef = useRef<Set<string>>(new Set());
  // 默认模型(defaultProvider/defaultModel 在底座 settings.json,经 piSettings 读写)
  const [defaultTarget, setDefaultTarget] = useState<{ provider?: string; modelId?: string }>({});
  useEffect(() => {
    let alive = true;
    void ctx.piSettings.get().then((s) => {
      if (!alive) return;
      setDefaultTarget({
        provider: typeof s.defaultProvider === "string" ? s.defaultProvider : undefined,
        modelId: typeof s.defaultModel === "string" ? s.defaultModel : undefined,
      });
    });
    return () => { alive = false; };
  }, [ctx]);

  // 测试=内核 session:testModel 隔离会话 ping,不碰用户激活会话(旧实现劫持
  // setContext/stop 会杀掉用户未落盘新会话并把测试消息流进主时间线,已迁内核)。
  // cwd 可空:main 侧兜底 homeDir,新装机未选目录也能测(连通性验证是配置第一步)。
  const testModel = async (modelId: string): Promise<void> => {
    // key 带 provider 前缀:不同 provider 可挂同名 modelId(如 gpt-4o),裸 id 会跨 provider 串显示
    const testKey = `${providerId}/${modelId}`;
    if (testingRef.current.has(testKey)) return;
    testingRef.current.add(testKey);
    setTestStates((prev) => ({ ...prev, [testKey]: { state: "testing" } }));
    try {
      const cwd = useUiStore.getState().currentCwd;
      const result = await ctx.models.test(cwd, providerId, modelId);
      setTestStates((prev) => ({ ...prev, [testKey]: { state: result.ok ? "success" : "error", error: result.error } }));
      if (result.ok) {
        setTimeout(() => {
          setTestStates((prev) => {
            if (prev[testKey]?.state === "success") {
              const next = { ...prev }; delete next[testKey]; return next;
            }
            return prev;
          });
        }, 3000);
      }
    } catch (err) {
      setTestStates((prev) => ({ ...prev, [testKey]: { state: "error", error: String(err) } }));
    } finally {
      testingRef.current.delete(testKey);
    }
  };

  // 写底座 settings.json 标准字段;改的是 settings 不是 models.json,不走 onChange/dirty。
  // 注意:改名/删除当前默认的 provider 或 model 不会回写 settings.json(陈旧引用由底座自兜底)。
  const setDefault = (modelId: string): void => {
    void ctx.piSettings.set({ defaultProvider: providerId, defaultModel: modelId }).then(() => {
      setDefaultTarget({ provider: providerId, modelId });
      // 广播默认已变:会话流把当前模型切到新默认(新会话即跟随),其他消费方自行决定如何使用。
      ctx.events.emit(channels[0], { provider: providerId, modelId });
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
      {/* Provider 字段 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)", borderBottom: "1px solid var(--color-border)", paddingBottom: "var(--spacing-md)" }}>
        <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("models.providerId")}</label>
          <input value={editId} onChange={(e) => setEditId(e.target.value)} onBlur={() => { if (!onRename(providerId, editId)) setEditId(providerId); }} style={inputStyle} />
          <Button variant="secondary" onClick={() => onCopyProvider(providerId)}>{t("models.copyProvider")}</Button>
          <Button variant="danger" onClick={() => onDelete(providerId)}>{t("models.deleteProvider")}</Button>
        </div>
        <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>baseUrl</label>
          <BaseUrlInput
            value={provider.baseUrl ?? ""}
            onChange={(v) => onUpdate(providerId, { baseUrl: v })}
            providers={allProviders}
            selfId={providerId}
            style={inputBaseStyle()}
          />
        </div>
        <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
          <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>api</label>
          <Select value={provider.api ?? "openai-completions"} onChange={(v) => onUpdate(providerId, { api: v })} style={{ flex: 1, minWidth: 0 }} ariaLabel="api">
            <option value="openai-completions">openai-completions</option>
            <option value="anthropic-messages">anthropic-messages</option>
            <option value="google-genai">google-genai</option>
            <option value="openai-responses">openai-responses</option>
          </Select>
        </div>
        <FieldInput label="apiKey" value={provider.apiKey ?? ""} onChange={(v) => onUpdate(providerId, { apiKey: v })} mono secret />
      </div>

      {/* Model 列表 */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--spacing-sm)" }}>
          <h3 style={{ margin: 0, fontSize: "var(--font-size-base)", fontWeight: 600 }}>{t("models.title", { count: provider.models?.length ?? 0 })}</h3>
          <Button variant="primary" onClick={() => onAddModel(providerId)}>{t("models.addModel")}</Button>
        </div>
        <AnimatePresence initial={false}>
        {(provider.models ?? []).map((m, idx) => (
          <ModelRow
            key={idx}
            model={m}
            idx={idx}
            providerId={providerId}
            defaultTarget={defaultTarget}
            testStates={testStates}
            configDirty={configDirty}
            onUpdateModel={onUpdateModel}
            setDefault={setDefault}
            testModel={testModel}
            onCopyModel={onCopyModel}
            onDeleteModel={onDeleteModel}
          />
        ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** 模型行:id 输入走本地 editId + onBlur 提交(根因修复,勿回退为直写 config)——m.id 是
 *  列表 key,直写 config 会让 key 变 → 整行重挂载 → 输入框失焦,且每击键触发 config 更新
 *  (dirty → 保存浮层弹出)。blur 一次性提交,击键零 config 影响;外部变更(导入合并/
 *  框架刷新)经 useEffect 同步。key 用 idx(稳定,id 可编辑)。 */
function ModelRow({
  model, idx, providerId, defaultTarget, testStates, configDirty,
  onUpdateModel, setDefault, testModel, onCopyModel, onDeleteModel,
}: {
  model: ModelConfig;
  idx: number;
  providerId: string;
  defaultTarget: { provider?: string; modelId?: string };
  testStates: Record<string, { state: TestState; error?: string }>;
  configDirty: boolean;
  onUpdateModel: (providerId: string, idx: number, patch: Partial<ModelConfig>) => void;
  setDefault: (modelId: string) => void;
  testModel: (modelId: string) => Promise<void>;
  onCopyModel: (providerId: string, idx: number) => void;
  onDeleteModel: (providerId: string, idx: number) => void;
}): React.ReactNode {
  const { t } = useTranslation();
  const [editId, setEditId] = useState(model.id);
  useEffect(() => { setEditId(model.id); }, [model.id]);
  const inputStyle: React.CSSProperties = inputBaseStyle();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      style={{ border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)", padding: "var(--spacing-sm) var(--spacing-md)", marginBottom: "var(--spacing-sm)", display: "grid", gridTemplateColumns: "80px minmax(0, 1fr)", columnGap: "var(--spacing-sm)", rowGap: "var(--spacing-xs)", alignItems: "center" }}
    >
      <label style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("models.modelId")}</label>
      {/* 内容列:minmax(0,1fr) 保卡片不溢出;按钮跟 id 输入框同一行,永不换行(空间不足缩输入框) */}
      <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center", minWidth: 0 }}>
        <input value={editId} onChange={(e) => setEditId(e.target.value)} onBlur={() => onUpdateModel(providerId, idx, { id: editId })} style={inputStyle} placeholder={t("models.modelId")} />
        {/* 默认模型标记/设置:写底座 settings.json 的 defaultProvider+defaultModel */}
        {defaultTarget.provider === providerId && defaultTarget.modelId === model.id ? (
          <Button
            variant="secondary"
            disabled
            title={`${defaultTarget.provider}/${defaultTarget.modelId}`}
            style={{ padding: "var(--spacing-xs) var(--spacing-sm)", borderColor: "var(--color-primary)", color: "var(--color-primary)", flexShrink: 0 }}
          >
            ★ {t("models.defaultBadge")}
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => setDefault(model.id)}
            style={{ padding: "var(--spacing-xs) var(--spacing-sm)", flexShrink: 0 }}
          >
            {t("models.setDefault")}
          </Button>
        )}
        <Button
           variant="secondary"
           onClick={() => testModel(model.id)}
           disabled={testStates[`${providerId}/${model.id}`]?.state === "testing" || configDirty}
           title={configDirty ? t("models.saveBeforeTest") : testStates[`${providerId}/${model.id}`]?.error}
          style={{
            padding: "var(--spacing-xs) var(--spacing-sm)",
            ...(testStates[`${providerId}/${model.id}`]?.state === "success" ? { borderColor: "var(--color-accent-success)", color: "var(--color-accent-success)" } : {}),
            ...(testStates[`${providerId}/${model.id}`]?.state === "error" ? { borderColor: "var(--color-accent-error)", color: "var(--color-accent-error)" } : {}),
          }}
        >
          {testStates[`${providerId}/${model.id}`]?.state === "testing" ? t("models.testing")
            : testStates[`${providerId}/${model.id}`]?.state === "success" ? "✓"
            : testStates[`${providerId}/${model.id}`]?.state === "error" ? "✗"
            : t("models.test")}
        </Button>
        <Button variant="secondary" onClick={() => onCopyModel(providerId, idx)} style={{ padding: "var(--spacing-xs)" }}>{t("models.copy")}</Button>
        <Button variant="danger" onClick={() => onDeleteModel(providerId, idx)} style={{ padding: "var(--spacing-xs)" }}>{t("models.delete")}</Button>
      </div>
      <label style={{ fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{t("models.name")}</label>
      <input value={model.name} onChange={(e) => onUpdateModel(providerId, idx, { name: e.target.value })} style={inputStyle} placeholder={t("models.modelName")} />
      <span />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-md)", rowGap: "var(--spacing-xs)", fontSize: "var(--font-size-sm)", alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", cursor: "pointer" }}>
          <input type="checkbox" checked={!!model.reasoning} onChange={(e) => onUpdateModel(providerId, idx, { reasoning: e.target.checked })} />
          reasoning
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", flexShrink: 0 }}>
          contextWindow
          <input type="number" value={model.contextWindow ?? 0} onChange={(e) => onUpdateModel(providerId, idx, { contextWindow: Number(e.target.value) })} style={{ ...inputStyle, width: "90px", minWidth: "90px", flexShrink: 0 }} />
          <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-family-mono)", whiteSpace: "nowrap" }}>≈ {Math.round((model.contextWindow ?? 0) / 1024)}K</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)", flexShrink: 0 }}>
          maxTokens
          <input type="number" value={model.maxTokens ?? 0} onChange={(e) => onUpdateModel(providerId, idx, { maxTokens: Number(e.target.value) })} style={{ ...inputStyle, width: "90px", minWidth: "90px", flexShrink: 0 }} />
          <span style={{ color: "var(--color-muted)", fontSize: "var(--font-size-sm)", fontFamily: "var(--font-family-mono)", whiteSpace: "nowrap" }}>≈ {Math.round((model.maxTokens ?? 0) / 1024)}K</span>
        </label>
      </div>
      {/* 失败原文直显(不只 tooltip):错误滞留到下次测试,不悬停也要看得见 */}
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

function FieldInput({ label, value, onChange, mono, secret }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; secret?: boolean }): React.ReactNode {
  const { t } = useTranslation();
  // 密码框默认星号隐藏;显示/隐藏切换按钮,显隐不丢值(受控 input)
  const [revealed, setRevealed] = useState(false);
  return (
    <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
      <label style={{ minWidth: "80px", fontSize: "var(--font-size-sm)", color: "var(--color-muted)" }}>{label}</label>
      <input
        type={secret && !revealed ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputBaseStyle(), fontFamily: mono ? "var(--font-family-mono)" : "var(--font-family-sans)" }}
      />
      {secret && (
        <Button variant="secondary" onClick={() => setRevealed((r) => !r)} style={{ padding: "var(--spacing-xs) var(--spacing-sm)", flexShrink: 0 }}>
          {revealed ? t("models.hideKey") : t("models.showKey")}
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
    // flex 行内 input 默认 min-width:auto(≈固有宽 20 字符)不收缩;归 0 让右栏可适配窄面板。
    // number 输入的覆盖处自带 minWidth:80px,不受影响。
    minWidth: 0,
    width: "100%", boxSizing: "border-box",
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
