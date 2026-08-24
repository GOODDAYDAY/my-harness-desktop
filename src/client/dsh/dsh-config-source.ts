// client/dsh/dsh-config-source.ts —— dsh 原生配置读写(cordis.yml + ~/.dsh/settings.yaml)。
//
// 依据设计 §2.3:dsh 有两处原生配置面。
// 1. cordis.yml = 插件组成 + 出厂 base(哪些插件在跑、默认 config)。
// 2. ~/.dsh/settings.yaml = 用户覆盖(namespace 分节;解析链 = schema 默认 → cordis base → 用户分节)。
//
// 分层语义:模型 / 默认模型 / 配置的「用户可编辑面」在 settings.yaml;cordis.yml 是 base(读作兜底)。
// dsh 侧用 `!!js` 自定义 YAML tag(仅 cordis.yml base);settings.yaml 是纯字面量用户文档。
//
// 依赖方向:本层 import domain(纯类型),是 client/dsh 的流出适配器(与 client/pi 对称)。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse, parseDocument, stringify } from "yaml";
import type { ModelInfo } from "../../core/domain/events/session-state";
import type { KernelModelSource } from "../../core/domain/backend";
import { DSH_OFFICIAL_PROVIDER } from "../../core/domain/context";
import type { DshModelSpec, DshProvider, DshDefaultModel, DshConfigApi } from "../../core/domain/context";

export { DSH_OFFICIAL_PROVIDER };

/** cordis 包名 → cordis 逻辑 id 映射(标准 dsh 插件的已知集;id 在插件代码里声明、
 *  不由包名派生)。未知包回落「剥 @deepseek-ai/dsh- 前缀」。 */
const PLUGIN_ID_MAP: Record<string, string> = {
  "@deepseek-ai/dsh-agent-spine-demo": "agent-spine",
  "@deepseek-ai/dsh-bash-local": "bash",
  "@deepseek-ai/dsh-compaction-basic": "compaction-basic",
  "@deepseek-ai/dsh-fs-local": "fs-local",
  "@deepseek-ai/dsh-fs-observation-policy": "fs-observation-policy",
  "@deepseek-ai/dsh-llm-deepseek": "llm-deepseek",
  "@deepseek-ai/dsh-llm-pi-ai": "llm-pi-ai",
  "@deepseek-ai/dsh-sandbox-local": "sandbox",
  "@deepseek-ai/dsh-sandbox-policy": "sandbox-policy",
  "@deepseek-ai/dsh-sdk-jsonrpc-server": "sdk-jsonrpc-server",
  "@deepseek-ai/dsh-session-checkpoint-policy": "session-checkpoints",
  "@deepseek-ai/dsh-session-persistence-jsonl": "sessions",
  "@deepseek-ai/dsh-subagent": "subagent",
  "@deepseek-ai/dsh-subagent-spawn-in-process": "subagent-spawn-in-process",
  "@deepseek-ai/dsh-subprocess-local": "subprocess",
  "@deepseek-ai/dsh-terminal": "pty",
  "@deepseek-ai/dsh-terminal-bash": "terminal-bash",
  "@deepseek-ai/dsh-token-meter": "token-meter",
  "@deepseek-ai/dsh-tool-bash-persistent": "persistent-bash",
  "@deepseek-ai/dsh-tool-fs": "tool-fs",
  "@deepseek-ai/dsh-tool-str-replace-editor": "str-replace-editor",
  "@deepseek-ai/dsh-tool-subagent": "tool-subagent",
  "@deepseek-ai/dsh-tool-todo": "tool-todo",
};

/** dsh JSON-RPC 运行时默认组合(对齐 python/sdk-runtime 的 bundled 默认;首次运行写入)。
 *  sdk-jsonrpc-server 是 stdio JSON-RPC 服务条目,缺了它 agent 没有对外通道。 */
const DEFAULT_CORDIS_YAML = [
  "# dsh JSON-RPC 运行时默认组合(桌面端首次运行写入;对齐 python/sdk-runtime 的 bundled 默认)。",
  "- id: sdk-jsonrpc-server",
  "  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'",
  "- id: agent-core",
  "  name: '@deepseek-ai/dsh-agent-spine-demo'",
  "  config:",
  "    workspaceContext:",
  "      maxBytes: 65536",
  "- id: llm-deepseek",
  "  name: '@deepseek-ai/dsh-llm-deepseek'",
  "- id: settings-file",
  "  name: '@deepseek-ai/dsh-settings-file'",
  "- id: llm-pi-ai",
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  "- id: sessions",
  "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
  "  config:",
  "    root: !!js process.env.DSH_SESSION_ROOT ?? './.sessions'",
  "- id: session-checkpoints",
  "  name: '@deepseek-ai/dsh-session-checkpoint-policy'",
  "- id: subprocess",
  "  name: '@deepseek-ai/dsh-subprocess-local'",
  "- id: bash",
  "  name: '@deepseek-ai/dsh-bash-local'",
  "  config:",
  "    cwd: !!js process.env.DSH_CWD ?? process.cwd()",
  "- id: fs-local",
  "  name: '@deepseek-ai/dsh-fs-local'",
  "  config:",
  "    cwd: !!js process.env.DSH_CWD ?? process.cwd()",
  "",
].join("\n");

/** `!!js` 求值标记(自定义 YAML tag resolve 的产物,不求值只存表达式)。 */
interface JsExpr { __js?: string; }

function isJsExpr(v: unknown): v is JsExpr {
  return typeof v === "object" && v !== null && "__js" in (v as object);
}

/** `!!js` 自定义 tag(读=不求值存表达式;写=把表达式原样 stringify 回,round-trip 不丢)。 */
const JS_TAG = {
  tag: "tag:yaml.org,2002:js",
  resolve: (s: string): JsExpr => ({ __js: s }),
  stringify: (obj: unknown): string => (isJsExpr(obj) && obj.__js) ? obj.__js : "",
} as const;

/** 从 `!!js` 表达式取 `?? <字面量>` 的兜底(单/双引号字符串或数字);无兜底回 undefined。 */
function jsFallback(expr: string): string | undefined {
  const m = /\?\?\s*(['"]([^'"]*)['"]|(-?\d+(?:\.\d+)?))/.exec(expr);
  return m?.[2] ?? m?.[3];
}

/** 把一条 model 形状(字符串 id 或 {id,name,contextWindow,maxTokens})归一成 DshModelSpec。 */
function toModelSpec(v: unknown): DshModelSpec | null {
  if (typeof v === "string") return { id: v };
  if (isJsExpr(v) && v.__js) {
    const fallback = jsFallback(v.__js);
    return fallback ? { id: fallback } : null;
  }
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const rawId = o.id;
    const id = typeof rawId === "string" ? rawId : isJsExpr(rawId) && rawId.__js ? jsFallback(rawId.__js) : undefined;
    if (!id) return null;
    const str = (k: string): string | undefined => (typeof o[k] === "string" ? (o[k] as string) : isJsExpr(o[k]) && (o[k] as JsExpr).__js ? jsFallback((o[k] as JsExpr).__js!) : undefined);
    const num = (k: string): number | undefined => {
      const raw = o[k];
      const n = typeof raw === "number" ? raw : isJsExpr(raw) && raw.__js ? Number(jsFallback(raw.__js)) : NaN;
      return Number.isFinite(n) ? n : undefined;
    };
    return { id, name: str("name"), contextWindow: num("contextWindow"), maxTokens: num("maxTokens") };
  }
  return null;
}

function parseModels(v: unknown): DshModelSpec[] {
  if (!Array.isArray(v)) return [];
  const out: DshModelSpec[] = [];
  for (const m of v) {
    const spec = toModelSpec(m);
    if (spec) out.push(spec);
  }
  return out;
}

/** 取字符串字段(字面量 or `!!js` 表达式的兜底字面量)。api/baseURL 用它读。 */
function strField(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (isJsExpr(v) && v.__js) return jsFallback(v.__js);
  return undefined;
}

/** 校验一个 llm-pi-ai 手写路由「确定不可服务」。dsh 运行时按「整段 llm-pi-ai 全有或全无」注册:
 *  一个空路由(models 空)会让 resolveProfiles 抛 "resolves no models" → 整段被拒 → 连带其它
 *  合法路由(含正在测的 provider)一起失效,症状是 initialize 报 "no adapter registered for provider …"。
 *  只拦「空 models」这一确定性毒源:缺 baseURL 是否毒化取决于该路由在 pi-ai catalog 里有无兜底,
 *  桌面端无从得知,故不在此拦(避免误杀 catalog 路由的「空串清覆盖」语义)。
 *  deepseek-official 走 llm-deepseek 自带 catalog,models 可空,不在校验范围。 */
export function assertPiAiRouteServiceable(
  provider: string,
  route: { models: ReadonlyArray<{ id: string }> },
): void {
  if (provider === DSH_OFFICIAL_PROVIDER) return;
  if (route.models.length === 0) {
    throw new Error(
      `dsh 路由「${provider}」没有模型:至少添加一个模型,或删除该路由——空路由会让 dsh 运行时拒绝整个 llm-pi-ai 段,连带其它 provider 全部失效`,
    );
  }
  for (const m of route.models) {
    if (!m.id || m.id.trim() === "") {
      throw new Error(`dsh 路由「${provider}」存在空 model id:补全或删除该模型`);
    }
  }
}

/** DshConfigSource:dsh 原生配置(cordis.yml + settings.yaml)读写,供 model-catalog 合流 + DSH 设置页。
 *  installDir 是 dsh 内核 npm 安装目录(~/.my-harness-desktop/dsh),用于列「可用插件」(node_modules)。 */
export class DshConfigSource implements KernelModelSource, DshConfigApi {
  constructor(
    private readonly cordisPath: string | undefined,
    private readonly settingsPath?: string,
    private readonly installDir?: string,
  ) {}

  /** 首次运行:缺 cordis.yml 时写一份默认 JSON-RPC 组合(否则 dsh-jsonrpc-agent 报 usage 退出)。 */
  ensureDefaultCordis(): void {
    const file = this.cordisPath;
    if (!file || existsSync(file)) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, DEFAULT_CORDIS_YAML, "utf-8");
    } catch {
      // 目录无写权限等 → 不炸应用,spawn 时报 usage 给清晰错误。
    }
  }

  // ===== settings.yaml(用户覆盖层,纯字面量 YAML) =====

  private readSettings(): Record<string, unknown> {
    const file = this.settingsPath;
    if (!file || !existsSync(file)) return {};
    try {
      const doc = parse(readFileSync(file, "utf-8"));
      return doc && typeof doc === "object" && !Array.isArray(doc) ? doc as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private async writeSettings(obj: Record<string, unknown>): Promise<void> {
    const file = this.settingsPath;
    if (!file) throw new Error("settings.yaml 路径未配置");
    await writeFile(file, stringify(obj), "utf-8");
  }

  /** 读 cordis.yml 的插件数组(!!js 不求值,存表达式)。缺失/非法返回 []。 */
  private readCordisPlugins(): unknown[] {
    const file = this.cordisPath;
    if (!file || !existsSync(file)) return [];
    try {
      const doc = parseDocument(readFileSync(file, "utf-8"), { customTags: [JS_TAG] });
      const plugins = doc.toJS();
      return Array.isArray(plugins) ? plugins : [];
    } catch {
      return [];
    }
  }

  // ===== 模型(settings.yaml 用户覆盖,cordis.yml base 兜底) =====

  /** 列所有 provider 路由的模型 + 连接事实(apiKeyEnv/api/baseURL)。用户 settings.yaml 覆盖 base。 */
  listProviders(): DshProvider[] {
    const settings = this.readSettings();
    const base = this.readCordisPlugins();
    const basePlugin = (id: string): Record<string, unknown> | null => {
      const p = base.find((x) => x !== null && typeof x === "object" && (x as { id?: unknown }).id === id);
      return (p && typeof p === "object") ? p as Record<string, unknown> : null;
    };
    const out: DshProvider[] = [];

    // llm-deepseek → 单路由 deepseek-official(apiKeyEnv 缺省 DEEPSEEK_API_KEY)
    const deepseekNs = settings["llm-deepseek"] as Record<string, unknown> | undefined;
    const deepseekBaseP = basePlugin("llm-deepseek");
    const deepseekBaseNs = ((deepseekBaseP?.config ?? {}) as Record<string, unknown>);
    const deepseekUser = deepseekNs?.models;
    const deepseekBase = deepseekBaseNs.models;
    const deepseekModels = parseModels(deepseekUser ?? deepseekBase);
    if (deepseekModels.length > 0 || deepseekUser !== undefined || deepseekBase !== undefined) {
      out.push({
        provider: DSH_OFFICIAL_PROVIDER,
        displayName: "DeepSeek",
        apiKeyEnv: strField(deepseekNs?.apiKeyEnv) ?? strField(deepseekBaseNs.apiKeyEnv) ?? "DEEPSEEK_API_KEY",
        models: deepseekModels,
      });
    }

    // llm-pi-ai → providers 字典(用户按 route 覆盖 base;apiKeyEnv/api/baseURL 逐字段合并)
    const piAiUser = (settings["llm-pi-ai"] as { providers?: unknown } | undefined)?.providers;
    const piAiBaseP = basePlugin("llm-pi-ai");
    const piAiBase = piAiBaseP ? (piAiBaseP.config as { providers?: unknown } | undefined)?.providers : undefined;
    const userRoutes = (piAiUser && typeof piAiUser === "object" && !Array.isArray(piAiUser)) ? piAiUser as Record<string, unknown> : {};
    const baseRoutes = (piAiBase && typeof piAiBase === "object" && !Array.isArray(piAiBase)) ? piAiBase as Record<string, unknown> : {};
    const routes = new Set([...Object.keys(baseRoutes), ...Object.keys(userRoutes)]);
    for (const route of routes) {
      const uCfg = userRoutes[route] as Record<string, unknown> | undefined;
      const bCfg = baseRoutes[route] as Record<string, unknown> | undefined;
      out.push({
        provider: route,
        apiKeyEnv: strField(uCfg?.apiKeyEnv) ?? strField(bCfg?.apiKeyEnv),
        displayName: strField(uCfg?.displayName) ?? strField(bCfg?.displayName) ?? route,
        api: strField(uCfg?.api) ?? strField(bCfg?.api),
        baseURL: strField(uCfg?.baseURL) ?? strField(bCfg?.baseURL),
        models: parseModels(uCfg?.models ?? bCfg?.models),
      });
    }
    return out;
  }

  /** 某 provider 的密钥环境变量名(如 us-new → US_NEW_API_KEY;deepseek-official → DEEPSEEK_API_KEY)。
   *  用于 spawn 时把「API Key」字面值注入到正确的 env 变量名下。 */
  apiKeyEnvFor(provider: string): string {
    return this.listProviders().find((p) => p.provider === provider)?.apiKeyEnv ?? "DEEPSEEK_API_KEY";
  }

  /** 合流成 ModelInfo[](供 model-catalog 的会话流模型下拉)。多 provider 各带各的 provider 字段。 */
  listModels(): ModelInfo[] {
    return this.listProviders().flatMap(({ provider, models }) =>
      models.map((m) => ({
        kernel: "dsh" as const,
        provider,
        id: m.id,
        name: m.name ?? m.id,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      })),
    );
  }

  /** 写回某 provider 路由的连接事实 + models 到 settings.yaml(用户覆盖层)。
   *  空串字段视为「清掉覆盖」(落回 base/默认);undefined 表示不动该字段。 */
  async setProvider(provider: string, detail: Omit<DshProvider, "provider">): Promise<void> {
    assertPiAiRouteServiceable(provider, detail);
    const settings = this.readSettings();
    const writeModels = detail.models.map((m) => ({
      id: m.id,
      ...(m.name !== undefined ? { name: m.name } : {}),
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
    }));
    const setStr = (target: Record<string, unknown>, key: string, v: string | undefined): void => {
      if (v === undefined) return;
      if (v === "") delete target[key];
      else target[key] = v;
    };
    if (provider === DSH_OFFICIAL_PROVIDER) {
      const ns = (settings["llm-deepseek"] ?? {}) as Record<string, unknown>;
      setStr(ns, "baseURL", detail.baseURL);
      ns.models = writeModels;
      settings["llm-deepseek"] = ns;
    } else {
      const ns = (settings["llm-pi-ai"] ?? {}) as Record<string, unknown>;
      const providers = (ns.providers ?? {}) as Record<string, unknown>;
      const route = (providers[provider] ?? {}) as Record<string, unknown>;
      setStr(route, "apiKeyEnv", detail.apiKeyEnv);
      setStr(route, "displayName", detail.displayName);
      setStr(route, "api", detail.api);
      setStr(route, "baseURL", detail.baseURL);
      route.models = writeModels;
      providers[provider] = route;
      ns.providers = providers;
      settings["llm-pi-ai"] = ns;
    }
    await this.writeSettings(settings);
  }

  /** 改一个 llm-pi-ai 路由名(deepseek-official 是固定路由不可改)。 */
  async renameProvider(oldId: string, newId: string): Promise<void> {
    if (oldId === DSH_OFFICIAL_PROVIDER) throw new Error(`${DSH_OFFICIAL_PROVIDER} 是固定路由,不可改名`);
    const settings = this.readSettings();
    const ns = (settings["llm-pi-ai"] ?? {}) as Record<string, unknown>;
    const providers = (ns.providers ?? {}) as Record<string, unknown>;
    if (!(oldId in providers)) throw new Error(`路由 ${oldId} 不存在`);
    if (newId in providers) throw new Error(`路由 ${newId} 已存在`);
    providers[newId] = providers[oldId];
    delete providers[oldId];
    ns.providers = providers;
    settings["llm-pi-ai"] = ns;
    await this.writeSettings(settings);
  }

  /** 删除一个 llm-pi-ai 路由(deepseek-official 是固定路由不可删)。 */
  async removeProvider(provider: string): Promise<void> {
    if (provider === DSH_OFFICIAL_PROVIDER) throw new Error(`${DSH_OFFICIAL_PROVIDER} 是固定路由,不可删除`);
    const settings = this.readSettings();
    const ns = (settings["llm-pi-ai"] ?? {}) as Record<string, unknown>;
    const providers = (ns.providers ?? {}) as Record<string, unknown>;
    delete providers[provider];
    ns.providers = providers;
    settings["llm-pi-ai"] = ns;
    await this.writeSettings(settings);
  }

  // ===== 默认模型(agent-default-model 命名空间) =====

  getDefaultModel(): DshDefaultModel | null {
    const ns = this.readSettings()["agent-default-model"] as DshDefaultModel | undefined;
    if (!ns || typeof ns.provider !== "string" || typeof ns.model !== "string") return null;
    return { provider: ns.provider, model: ns.model, reasoningEffort: ns.reasoningEffort };
  }

  async setDefaultModel(sel: DshDefaultModel): Promise<void> {
    const settings = this.readSettings();
    settings["agent-default-model"] = {
      provider: sel.provider,
      model: sel.model,
      ...(sel.reasoningEffort !== undefined ? { reasoningEffort: sel.reasoningEffort } : {}),
    };
    await this.writeSettings(settings);
  }

  /** 清掉 agent-default-model(删除 default provider 时调用,避免悬空指向已删路由)。 */
  async clearDefaultModel(): Promise<void> {
    const settings = this.readSettings();
    delete settings["agent-default-model"];
    await this.writeSettings(settings);
  }

  // ===== 配置编辑器(整份 settings.yaml) =====

  getSettings(): Record<string, unknown> {
    return this.readSettings();
  }

  async setSettings(obj: Record<string, unknown>): Promise<void> {
    await this.writeSettings(obj);
  }

  // ===== 插件(cordis.yml,禁=移出块、启=还原) =====

  listPlugins(): { id: string; name: string }[] {
    return this.readCordisPlugins()
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object" && typeof (p as { id?: unknown }).id === "string")
      .map((p) => ({ id: p.id as string, name: typeof p.name === "string" ? p.name : (p.id as string) }));
  }

  /** 把一个 cordis 条目 name 解析为绝对路径。相对路径（如 ./.my-harness-desktop-plugins/<id>/index.mjs）
   *  相对 cordis.yml 所在目录解析（与 dsh loader 的 baseUrl 同基准）；绝对/包名原样返回。 */
  resolveEntryPath(name: string): string {
    if (name.startsWith(".")) {
      const base = this.cordisPath ? dirname(this.cordisPath) : "";
      return resolve(base, name);
    }
    return name;
  }

  /** 列「可用插件」:dsh 内核 node_modules 里的 @deepseek-ai/dsh-* 包(已装但未必在 cordis.yml 启用)。
   *  只列「真插件」= PLUGIN_ID_MAP 已知插件 ∪ 内核 package.json 直接依赖(桌面/用户显式安装)。
   *  传递依赖里的抽象服务定义(裸 dsh-subprocess/dsh-subagent 等「Subclass me」基类)不是插件,
   *  必须排除——否则 enable 会把它们追加成 cordis 块,要么撞同 id(duplicate loader entry id),
   *  要么注册一个无实现的抽象服务。 */
  listAvailablePlugins(): { name: string }[] {
    const dir = this.installDir ? join(this.installDir, "node_modules", "@deepseek-ai") : undefined;
    if (!dir || !existsSync(dir)) return [];
    try {
      const direct = this.directDependencyNames();
      return readdirSync(dir)
        .filter((n) => n.startsWith("dsh-"))
        .map((n) => `@deepseek-ai/${n}`)
        .filter((pkg) => pkg in PLUGIN_ID_MAP || direct.has(pkg))
        .map((name) => ({ name }));
    } catch {
      return [];
    }
  }

  /** 内核 package.json 的直接依赖名集合(桌面/用户显式安装的插件集;不含传递依赖)。 */
  private directDependencyNames(): Set<string> {
    if (!this.installDir) return new Set();
    try {
      const pkg = JSON.parse(readFileSync(join(this.installDir, "package.json"), "utf-8")) as Record<string, unknown>;
      const deps = pkg.dependencies;
      if (!deps || typeof deps !== "object" || Array.isArray(deps)) return new Set();
      return new Set(Object.keys(deps as Record<string, unknown>));
    } catch {
      return new Set();
    }
  }

  private get disabledPath(): string { return `${this.cordisPath ?? ""}.disabled.json`; }

  private readDisabled(): Record<string, string> {
    try {
      if (!this.cordisPath || !existsSync(this.disabledPath)) return {};
      const raw = JSON.parse(readFileSync(this.disabledPath, "utf-8")) as Record<string, string>;
      return raw && typeof raw === "object" ? raw : {};
    } catch { return {}; }
  }

  private writeDisabled(map: Record<string, string>): void {
    if (!this.cordisPath) return;
    writeFileSync(this.disabledPath, JSON.stringify(map, null, 2), "utf-8");
  }

  listDisabledPlugins(): { id: string; name: string }[] {
    return Object.entries(this.readDisabled()).map(([id, text]) => {
      const nameM = /^\s*- name:\s*(.+)$/m.exec(text);
      return { id, name: nameM ? nameM[1].trim().replace(/^['"]|['"]$/g, "") : id };
    });
  }

  /** 在 cordis.yml 文本里按 id 定位插件块起止行(块 = `- id: <id>` 行到下一个 `- id:` 行)。 */
  private findBlock(lines: string[], id: string): { start: number; end: number } | null {
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*- id:\s*(\S+)/.exec(lines[i]);
      if (m && m[1] === id) {
        let end = lines.length;
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s*- id:\s*/.test(lines[j])) { end = j; break; }
        }
        return { start: i, end };
      }
    }
    return null;
  }

  disablePlugin(id: string): void {
    const file = this.cordisPath;
    if (!file || !existsSync(file)) throw new Error("cordis.yml 不存在");
    const lines = readFileSync(file, "utf-8").split("\n");
    const block = this.findBlock(lines, id);
    if (!block) throw new Error(`插件 ${id} 不在 cordis.yml`);
    const text = lines.slice(block.start, block.end).join("\n");
    const remaining = [...lines.slice(0, block.start), ...lines.slice(block.end)];
    const disabled = this.readDisabled();
    disabled[id] = text;
    this.writeDisabled(disabled);
    writeFileSync(file, remaining.join("\n"), "utf-8");
  }

  enablePlugin(id: string): void {
    const file = this.cordisPath;
    if (!file || !existsSync(file)) throw new Error("cordis.yml 不存在");
    const disabled = this.readDisabled();
    const text = disabled[id];
    if (!text) throw new Error(`插件 ${id} 无禁用记录`);
    const lines = readFileSync(file, "utf-8").split("\n");
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(text);
    delete disabled[id];
    this.writeDisabled(disabled);
    writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  }

  /** 包名 → cordis 逻辑 id。已知标准插件走映射表;未知包回落「剥 @deepseek-ai/dsh- 前缀」。 */
  resolvePluginId(pkgName: string): string {
    return PLUGIN_ID_MAP[pkgName] ?? pkgName.replace(/^@deepseek-ai\/dsh-/, "");
  }

  /** 安装插件:把 `- id: <id>\n  name: <pkgName>` 追加进 cordis.yml(npm install 由外层完成)。
   *  已存在同 id/同 name 的块时跳过(幂等),避免重复追加。 */
  addPlugin(pkgName: string): string {
    const file = this.cordisPath;
    if (!file || !existsSync(file)) throw new Error("cordis.yml 不存在");
    const id = this.resolvePluginId(pkgName);
    const lines = readFileSync(file, "utf-8").split("\n");
    // 幂等:已有该 name 的块就跳过
    if (lines.some((l) => l.trim() === `name: ${JSON.stringify(pkgName)}` || l.trim() === `name: '${pkgName}'` || l.trim() === `name: "${pkgName}"`)) {
      return id;
    }
    // id 冲突防护:同 id 已被别的包占用 → 追加会生成重复 loader entry id,dsh 内核启动即崩
    // (duplicate loader entry id)。典型:@deepseek-ai/dsh-subprocess 与 dsh-subprocess-local 都
    // 回落 id「subprocess」。这里拒绝写盘、报清晰错误,而不是静默污染 cordis.yml。
    const occupied = this.listPlugins().find((p) => p.id === id);
    if (occupied) {
      throw new Error(
        `cordis 插件 id「${id}」已被「${occupied.name}」占用,不能再挂载「${pkgName}」(同名 id 会让 dsh 内核启动崩溃)`,
      );
    }
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(`- id: ${id}`, `  name: '${pkgName}'`);
    writeFileSync(file, lines.join("\n") + "\n", "utf-8");
    return id;
  }

  /** 追加/替换一个 cordis.yml 插件块（显式 id + name）。同 id 存在则替换其 name 行（幂等），
   *  不存在则追加。供 dsh 内核插件随附通道挂载相对路径插件（name 形如 `./xxx/index.mjs`）。 */
  addPluginBlock(id: string, name: string): void {
    const file = this.cordisPath;
    if (!file || !existsSync(file)) throw new Error("cordis.yml 不存在");
    const lines = readFileSync(file, "utf-8").split("\n");
    const quote = (s: string): string => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);
    const block = this.findBlock(lines, id);
    if (block) {
      for (let i = block.start; i < block.end; i++) {
        if (/^\s*name:/.test(lines[i])) lines[i] = `  name: ${quote(name)}`;
      }
    } else {
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      lines.push(`- id: ${id}`, `  name: ${quote(name)}`);
    }
    writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  }

  /** 彻底删除一个 cordis.yml 插件块（按 id；不存在则 no-op）。区别于 disablePlugin（移出到
   *  disabled.json 可还原），此处是随附通道的摘除语义——随壳插件卸载即彻底移除。 */
  removePluginBlock(id: string): void {
    const file = this.cordisPath;
    if (!file || !existsSync(file)) return;
    const lines = readFileSync(file, "utf-8").split("\n");
    const block = this.findBlock(lines, id);
    if (!block) return;
    const remaining = [...lines.slice(0, block.start), ...lines.slice(block.end)];
    writeFileSync(file, remaining.join("\n"), "utf-8");
  }
}
