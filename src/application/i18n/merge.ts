// 语言槽合并 —— application 层,把各插件 languages 贡献项合并成 i18next resources。
//
// 依据 docs/plugins/05-plugin-i18n §6.1(mergeLanguageContributions)+ §2.5(key 级合并)+
// §2.6.1(source priority 数值表)+ §3.4(外部 JSON 拆分)+ §6.2.2(collectNamespaces/SupportedLngs)。
//
// key 级合并不复用通用 resolveByPriority(那是贡献项级二选一);语言槽是字典 union,
// 不冲突 key 全保留,冲突 key 按来源插件优先级取高(高值胜),同优先级先处理者胜。
// application 不 import electron:外部 JSON 路径相对插件目录,用 Node 内置 fs 读。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageContribution } from "../../domain/contributions";

/** 加载器解析后的语言贡献项:resources 已从字符串路径解析成对象(05 §3.2.2 步骤⑤)。 */
export interface ResolvedLanguageContribution {
  id: string;
  locale: string;
  resources: Record<string, string>;
}

/** 来源 → 优先级数值(05 §2.6.1 钉死:高值胜;builtin 最低,可被任何更高来源覆盖)。 */
const SOURCE_PRIORITY: Record<string, number> = {
  builtin: 1,
  installed: 2,
  user: 3,
  project: 4,
};

/** ns 内 key 树:叶子是文案字符串,中间按 '.' 分层嵌套(与 i18next ResourceKey 兼容)。 */
export type I18nResourceKey = string | { [key: string]: I18nResourceKey };

/** i18next Resource 形态:{ locale: { namespace: 嵌套 key 树 } }。
 *  ns 内按 '.' 分层嵌套(keySeparator '.'),见 mergeLanguageContributions step 2。 */
export type I18nResource = Record<string, Record<string, I18nResourceKey>>;

export interface LanguageContributionWithMeta {
  contribution: LanguageContribution;
  pluginId: string;
  source: "project" | "user" | "installed" | "builtin";
  pluginPath: string;
}

/**
 * 解析单个贡献项的 resources:字符串路径 → 读 JSON 对象;对象原样返回。
 * 字符串路径解析失败(文件不存在/JSON 错/顶层非对象)记 error 并返回 null(贡献项跳过,05 §3.2.1)。
 */
export function resolveLanguageResources(
  item: LanguageContribution,
  pluginPath: string,
): Record<string, string> | null {
  const r = item.resources;
  if (typeof r === "string") {
    const file = join(pluginPath, r);
    if (!existsSync(file)) {
      console.error(`[i18n] 语言贡献项 ${item.id}(${item.locale}):resources 文件不存在 ${file}`);
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        console.error(`[i18n] 语言贡献项 ${item.id}(${item.locale}):${file} 顶层非对象`);
        return null;
      }
      return parsed as Record<string, string>;
    } catch (err) {
      console.error(`[i18n] 语言贡献项 ${item.id}(${item.locale}):解析 ${file} 失败`, err);
      return null;
    }
  }
  return r;
}

/**
 * 合并所有 languages 贡献项成 i18next resources(05 §6.1)。
 * key 级合并:不冲突 key 全保留,冲突按 source priority 取高(高值胜),同优先级先处理者胜。
 * dot 解析:第一个 dot 前是 namespace,无 dot 走 defaultNS=common。
 */
export function mergeLanguageContributions(
  contributions: LanguageContributionWithMeta[],
): I18nResource {
  // 1. 按 locale 分组,组内按 `${ns}:${key}` 做 key 级 union(带 priority)
  // byLocale: locale → Map<nsKey, { value, priority }>
  const byLocale = new Map<string, Map<string, { value: string; priority: number }>>();
  for (const { contribution, source, pluginPath } of contributions) {
    const resolved = resolveLanguageResources(contribution, pluginPath);
    if (!resolved) continue; // 解析失败已记 error,跳过该贡献项
    const priority = SOURCE_PRIORITY[source] ?? 1;
    const locale = contribution.locale;
    if (!byLocale.has(locale)) byLocale.set(locale, new Map());
    const bucket = byLocale.get(locale)!;
    for (const [key, value] of Object.entries(resolved)) {
      // dot 解析:第一个 dot 前当 ns,无 dot 走 common(05 §2.2)
      const dotIdx = key.indexOf(".");
      const ns = dotIdx === -1 ? "common" : key.slice(0, dotIdx);
      const k = dotIdx === -1 ? key : key.slice(dotIdx + 1);
      const nsKey = `${ns}:${k}`;
      const existing = bucket.get(nsKey);
      // key 级合并:无 existing 直接放;有 existing 时,新进 priority 更高才覆盖(高值胜);
      // 等优先级(existing.priority === priority)不覆盖 → 先处理者胜(05 §2.6.1)
      if (!existing || existing.priority < priority) {
        bucket.set(nsKey, { value, priority });
      }
    }
  }

  // 2. 聚合成 i18next Resource 形态:ns 内按 key 剩余点号嵌套(keySeparator '.')
  // 扁平存放带点 key(如 "plugin.pi-manager.displayName" 拆 ns 后剩 "pi-manager.displayName")
  // i18next 查找路径按 '.' 分层解析会 miss,必须把剩余点号也拆成嵌套对象。
  const resources: I18nResource = {};
  for (const [locale, bucket] of byLocale) {
    resources[locale] = {};
    for (const [nsKey, { value }] of bucket) {
      const sep = nsKey.indexOf(":");
      const ns = nsKey.slice(0, sep);
      const k = nsKey.slice(sep + 1);
      const parts = k.split(".");
      let node = (resources[locale][ns] ??= {}) as { [key: string]: I18nResourceKey };
      for (let i = 0; i < parts.length - 1; i++) {
        node = (node[parts[i]] ??= {}) as { [key: string]: I18nResourceKey };
      }
      node[parts[parts.length - 1]] = value;
    }
  }
  return resources;
}

/** 收集 resources 里出现的所有 namespace 名(动态,不写死内置清单)。
 *  评估 P3:此前硬编码 8 个内置 namespace 兜底,写死 builtin 结构知识。改为纯动态收集。 */
export function collectNamespaces(resources: I18nResource): string[] {
  const set = new Set<string>();
  for (const lng of Object.keys(resources)) {
    for (const ns of Object.keys(resources[lng] || {})) set.add(ns);
  }
  return [...set];
}

/** 收集所有贡献项的 locale 去重(动态,不写死内置兜底)。
 *  评估 P3:此前硬编码 ["zh-CN","zh-TW","en","de"] 兜底。改为纯动态从贡献项收集。 */
export function collectSupportedLngs(contributions: LanguageContributionWithMeta[]): string[] {
  const set = new Set<string>();
  for (const { contribution } of contributions) set.add(contribution.locale);
  return [...set];
}

/** 收集 locale → 展示名映射(供设置页语言列表)。
 *  展示名从合并后的 resources 查 common.locale.{code}(各语言用自己表达其它语言名),
 *  缺失回退 locale code 本身。评估 P3:此前硬编码四语言固定展示名,第三方 locale
 *  不进列表;改为动态从 supportedLngs 生成,任何贡献的 locale 都进列表。 */
export function collectLocaleList(
  supportedLngs: string[],
  resources: I18nResource,
): { id: string; name: string }[] {
  return supportedLngs.map((id) => {
    // ns common 下已按 '.' 嵌套:{ locale: { [code]: 展示名 } }
    const commonNs = (resources[id]?.common ?? {}) as { locale?: Record<string, I18nResourceKey> };
    const name = commonNs.locale?.[id] ?? id;
    return { id, name: typeof name === "string" ? name : id };
  });
}
