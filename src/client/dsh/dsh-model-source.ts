// client/dsh/dsh-model-source.ts —— 读 dsh 原生 cordis.yml 的 llm-deepseek.models。
//
// 依据设计 multi-kernel-settings-and-model-display.md §2.3/§3.3:dsh 模型配置在 cordis.yml
// 的 llm-deepseek 插件 config.models(不是 pi 的 models.json「provider 树」形状)。
// dsh 侧用 `!!js` 自定义 YAML tag(运行时求值 process.env 兜底);桌面 reader 不求值
// (安全 + 无 dsh 运行时),只取 `?? '字面量'` 里的兜底字面量,读不到就返回空清单。
//
// 依赖方向:本层 import domain(纯类型),是 client/dsh 的流出适配器(与 client/pi 对称)。
import { existsSync, readFileSync } from "node:fs";
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
      const doc = parseDocument(src, {
        customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (s: string) => ({ __js: s }) }],
      });
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
}
