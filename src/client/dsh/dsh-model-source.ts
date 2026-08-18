// client/dsh/dsh-model-source.ts —— 读 dsh 原生 cordis.yml 的 llm-deepseek.models。
//
// 依据设计 multi-kernel-settings-and-model-display.md §2.3/§3.3:dsh 模型配置在 cordis.yml
// 的 llm-deepseek 插件 config.models(不是 pi 的 models.json「provider 树」形状)。
// dsh 侧用 `!!js` 自定义 YAML tag(运行时求值 process.env 兜底);桌面 reader 不求值
// (安全 + 无 dsh 运行时),只取 `?? '字面量'` 里的兜底字面量,读不到就返回空清单。
//
// 依赖方向:本层 import domain(纯类型),是 client/dsh 的流出适配器(与 client/pi 对称)。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import type { ModelInfo } from "../../core/domain/events/session-state";

/** llm-deepseek.models 的单条(设计 §3.7 DshModelSpec)。 */
export interface DshModelSpec {
  id: string;
  contextWindow?: number;
}

/** `!!js` 求值标记(自定义 YAML tag resolve 的产物,不求值只存表达式)。 */
interface JsExpr {
  __js?: string;
}

/** `!!js` 自定义 tag(读=不求值存表达式;写=把表达式原样 stringify 回,round-trip 不丢)。 */
const JS_TAG = {
  tag: "tag:yaml.org,2002:js",
  resolve: (s: string): JsExpr => ({ __js: s }),
  stringify: (obj: unknown): string => (isJsExpr(obj) && obj.__js) ? obj.__js : "",
} as const;

function isJsExpr(v: unknown): v is JsExpr {
  return typeof v === "object" && v !== null && "__js" in (v as object);
}

/** 从 `!!js` 表达式取 `?? <字面量>` 的兜底(单/双引号字符串或数字);无兜底回 undefined。 */
function jsFallback(expr: string): string | undefined {
  const m = /\?\?\s*(['"]([^'"]*)['"]|(-?\d+(?:\.\d+)?))/.exec(expr);
  return m?.[2] ?? m?.[3];
}

/** 把 cordis.yml 里一条 model 形状(字符串 id 或 {id, contextWindow})归一成 DshModelSpec。 */
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
    const rawCw = o.contextWindow;
    const cw = typeof rawCw === "number" ? rawCw : isJsExpr(rawCw) && rawCw.__js ? Number(jsFallback(rawCw.__js)) : undefined;
    return { id, contextWindow: cw !== undefined && Number.isFinite(cw) ? cw : undefined };
  }
  return null;
}

/** DshModelSource:dsh 原生 cordis.yml 的模型清单读取(供 model-catalog 合流)。 */
export class DshModelSource {
  constructor(private readonly cordisPath: string | undefined) {}

  listModels(): ModelInfo[] {
    const file = this.cordisPath;
    if (!file || !existsSync(file)) return [];
    try {
      const src = readFileSync(file, "utf-8");
      const doc = parseDocument(src, { customTags: [JS_TAG] });
      const plugins = doc.toJS();
      if (!Array.isArray(plugins)) return [];
      const llm = plugins.find(
        (p) => p !== null && typeof p === "object" && (p as { id?: unknown }).id === "llm-deepseek",
      ) as { config?: { models?: unknown } } | undefined;
      const models = llm?.config?.models;
      if (!Array.isArray(models)) return [];
      const out: ModelInfo[] = [];
      for (const m of models) {
        const spec = toModelSpec(m);
        if (!spec) continue;
        out.push({
          kernel: "dsh",
          provider: "deepseek-official",
          id: spec.id,
          name: spec.id,
          contextWindow: spec.contextWindow,
        });
      }
      return out;
    } catch {
      // cordis.yml 缺失/非法/形状不符 → 空清单,不炸应用(dsh 未配置是显式态,§6.2)。
      return [];
    }
  }

  /** 列 cordis.yml 的 Cordis 插件树(id + name)。这是 dsh 的「拓展」——每个插件是一个 npm 包。 */
  listPlugins(): { id: string; name: string }[] {
    const file = this.cordisPath;
    if (!file || !existsSync(file)) return [];
    try {
      const doc = parseDocument(readFileSync(file, "utf-8"), { customTags: [JS_TAG] });
      const plugins = doc.toJS();
      if (!Array.isArray(plugins)) return [];
      return plugins
        .filter((p) => p !== null && typeof p === "object" && typeof (p as { id?: unknown }).id === "string")
        .map((p) => {
          const o = p as { id: string; name?: unknown };
          return { id: o.id, name: typeof o.name === "string" ? o.name : o.id };
        });
    } catch {
      return [];
    }
  }

  /** 侧车文件:被禁用的插件块原文(id → 完整 YAML seq item 文本),「启用」据此还原。
   *  存原文而非 toJS 对象——`!!js` 自定义 tag 经 toJS/JSON round-trip 会丢(JS_TAG 只
   *  覆盖 parseDocument 路径,不覆盖 createNode),文本块逐字保留最稳。 */
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

  /** 列被禁用的插件(从侧车文件)。 */
  listDisabledPlugins(): { id: string; name: string }[] {
    return Object.entries(this.readDisabled()).map(([id, text]) => {
      const nameM = /^\s*- name:\s*(.+)$/m.exec(text);
      const name = nameM ? nameM[1].trim().replace(/^['"]|['"]$/g, "") : id;
      return { id, name };
    });
  }

  /** 禁用插件:从 cordis.yml 移除该插件块,原文存入侧车文件供「启用」还原。 */
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

  /** 启用插件:从侧车文件取该插件块原文,追加回 cordis.yml 末尾。 */
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

  /** 写回 llm-deepseek.config.models(整段替换)。读-改-写经 yaml round-trip,!!js 表达式
   *  原样保留(JS_TAG.stringify);新模型写字面量(用户显式配置,不再走 env 兜底)。 */
  async setModels(models: DshModelSpec[]): Promise<void> {
    const file = this.cordisPath;
    if (!file || !existsSync(file)) throw new Error("cordis.yml 不存在");
    const src = readFileSync(file, "utf-8");
    const doc = parseDocument(src, { customTags: [JS_TAG] });
    const plugins = doc.toJS();
    if (!Array.isArray(plugins)) throw new Error("cordis.yml 顶层非插件数组");
    const idx = plugins.findIndex((p) => p !== null && typeof p === "object" && (p as { id?: unknown }).id === "llm-deepseek");
    if (idx < 0) throw new Error("cordis.yml 无 llm-deepseek 插件");
    doc.setIn([idx, "config", "models"], models.map((m) => ({
      id: m.id,
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
    })));
    await writeFile(file, doc.toString(), "utf-8");
  }
}
