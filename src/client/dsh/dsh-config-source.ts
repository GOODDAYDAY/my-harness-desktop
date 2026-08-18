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
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, parseDocument, stringify } from "yaml";
import type { ModelInfo } from "../../core/domain/events/session-state";

/** 某 provider 路由下的一条模型(dsh 侧字段:id/name/contextWindow/maxTokens,无 pi 的 reasoning)。 */
export interface DshModelSpec {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** 一个 dsh provider 路由 + 它的连接事实(apiKeyEnv/api/baseURL)+ 模型列表。
 *  dsh 的「provider」= LLM 适配器路由:llm-deepseek 注册 deepseek-official;llm-pi-ai 注册
 *  providers 字典(每键一条路由)。apiKeyEnv 是凭据引用(变量名,非字面密钥),等价 pi 的 apiKey;
 *  api/baseURL 只对 llm-pi-ai 的自定义路由有意义(deepseek-official 的端点/协议由适配器定)。 */
export interface DshProviderModels {
  provider: string;
  apiKeyEnv?: string;
  api?: string;
  baseURL?: string;
  models: DshModelSpec[];
}

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

/** dsh 默认模型选择(agent-default-model 命名空间)。 */
export interface DshDefaultModel {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

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

/** 取字符串字段(字面量 or `!!js` 表达式的兜底字面量)。apiKeyEnv/api/baseURL 用它读。 */
function strField(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (isJsExpr(v) && v.__js) return jsFallback(v.__js);
  return undefined;
}

/** DshConfigSource:dsh 原生配置(cordis.yml + settings.yaml)读写,供 model-catalog 合流 + DSH 设置页。
 *  installDir 是 dsh 内核 npm 安装目录(~/.my-harness-desktop/dsh),用于列「可用插件」(node_modules)。 */
export class DshConfigSource {
  constructor(
    private readonly cordisPath: string | undefined,
    private readonly settingsPath?: string,
    private readonly installDir?: string,
  ) {}

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

  /** 列所有 provider 路由的模型 + 连接事实(apiKeyEnv/api/baseURL)。
   *  用户 settings.yaml 覆盖 base;无覆盖回落 cordis.yml base。 */
  listProviders(): DshProviderModels[] {
    const settings = this.readSettings();
    const base = this.readCordisPlugins();
    const basePlugin = (id: string): Record<string, unknown> | null => {
      const p = base.find((x) => x !== null && typeof x === "object" && (x as { id?: unknown }).id === id);
      return (p && typeof p === "object") ? p as Record<string, unknown> : null;
    };
    const out: DshProviderModels[] = [];

    // llm-deepseek → 单路由 deepseek-official(apiKeyEnv 来自 llm-deepseek 命名空间/base)
    const deepseekNs = settings["llm-deepseek"] as Record<string, unknown> | undefined;
    const deepseekBaseP = basePlugin("llm-deepseek");
    const deepseekBaseNs = ((deepseekBaseP?.config ?? {}) as Record<string, unknown>);
    const deepseekUser = deepseekNs?.models;
    const deepseekBase = deepseekBaseNs.models;
    const deepseekModels = parseModels(deepseekUser ?? deepseekBase);
    if (deepseekModels.length > 0 || deepseekUser !== undefined || deepseekBase !== undefined) {
      out.push({
        provider: "deepseek-official",
        apiKeyEnv: strField(deepseekNs?.apiKeyEnv) ?? strField(deepseekBaseNs.apiKeyEnv),
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
        api: strField(uCfg?.api) ?? strField(bCfg?.api),
        baseURL: strField(uCfg?.baseURL) ?? strField(bCfg?.baseURL),
        models: parseModels(uCfg?.models ?? bCfg?.models),
      });
    }
    return out;
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
  async setProvider(provider: string, detail: { apiKeyEnv?: string; api?: string; baseURL?: string; models: DshModelSpec[] }): Promise<void> {
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
    if (provider === "deepseek-official") {
      const ns = (settings["llm-deepseek"] ?? {}) as Record<string, unknown>;
      setStr(ns, "apiKeyEnv", detail.apiKeyEnv);
      ns.models = writeModels;
      settings["llm-deepseek"] = ns;
    } else {
      const ns = (settings["llm-pi-ai"] ?? {}) as Record<string, unknown>;
      const providers = (ns.providers ?? {}) as Record<string, unknown>;
      const route = (providers[provider] ?? {}) as Record<string, unknown>;
      setStr(route, "apiKeyEnv", detail.apiKeyEnv);
      setStr(route, "api", detail.api);
      setStr(route, "baseURL", detail.baseURL);
      route.models = writeModels;
      providers[provider] = route;
      ns.providers = providers;
      settings["llm-pi-ai"] = ns;
    }
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

  /** 列「可用插件」:dsh 内核 node_modules 里的 @deepseek-ai/dsh-* 包(已装但未必在 cordis.yml 启用)。 */
  listAvailablePlugins(): { name: string }[] {
    const dir = this.installDir ? join(this.installDir, "node_modules", "@deepseek-ai") : undefined;
    if (!dir || !existsSync(dir)) return [];
    try {
      return readdirSync(dir).filter((n) => n.startsWith("dsh-")).map((n) => ({ name: `@deepseek-ai/${n}` }));
    } catch {
      return [];
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
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(`- id: ${id}`, `  name: '${pkgName}'`);
    writeFileSync(file, lines.join("\n") + "\n", "utf-8");
    return id;
  }
}
