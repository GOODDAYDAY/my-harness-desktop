// i18n translator —— application 层,持 i18next 单例 + 检测 + 查文案。
//
// 依据 docs/plugins/05-plugin-i18n §6.2(init 配置)+ §4(fallback 链)+ §5.1(locale 检测)。
// main 端持单例(init 一次);renderer 端经 react-i18next 自己 init 一份(shell/renderer 侧)。
// detectLocale 是纯函数,两边共用。
//
// 偏离文档 05 §2.1:locale 接受地理区域码(zh-CN/zh-TW),检测层做 navigator.language 归约映射。
import i18next from "i18next";
import type { I18nResource } from "./merge";

/** 内置默认 locale(无偏好时的兜底)。 */
export const DEFAULT_LOCALE = "zh-CN";

/** fallback 链末端(05 §4.1):当前 locale → en → manifest 字面值 → key 本身。 */
export const FALLBACK_LOCALE = "en";

/**
 * 把 navigator.language(或任意 BCP 47)归约到支持的 locale 之一(05 §5.1,偏离区域码限制)。
 * zh-TW/HK/MO → zh-TW;其余 zh-* → zh-CN;en-* → en;de-* → de;匹配不到 → FALLBACK(en)。
 */
export function detectLocale(navigatorLanguage: string | undefined, supported: string[]): string {
  const lang = (navigatorLanguage ?? "").toLowerCase();
  if (!lang) return FALLBACK_LOCALE;
  // 精确匹配(大小写不敏感)
  const exact = supported.find((s) => s.toLowerCase() === lang);
  if (exact) return exact;
  // 主语言/区域归约:zh-XX
  if (lang.startsWith("zh")) {
    if (["zh-tw", "zh-hk", "zh-mo", "zh-hant"].includes(lang) || lang.startsWith("zh-tw") || lang.startsWith("zh-hk") || lang.startsWith("zh-mo")) {
      return supported.includes("zh-TW") ? "zh-TW" : FALLBACK_LOCALE;
    }
    return supported.includes("zh-CN") ? "zh-CN" : FALLBACK_LOCALE;
  }
  if (lang.startsWith("en")) return supported.includes("en") ? "en" : FALLBACK_LOCALE;
  if (lang.startsWith("de")) return supported.includes("de") ? "de" : FALLBACK_LOCALE;
  return FALLBACK_LOCALE;
}

/** i18next 是否已 init(防重复 init)。 */
let initialized = false;

/**
 * 初始化 i18next 单例(main 端启动时调一次)。
 * resources:合并器产出的字典;lng:当前 locale;ns/supportedLngs:收集器产出。
 * 05 §6.2 配置:fallbackLng=en、defaultNS=common、escapeValue=false(React 自带转义)。
 * keySeparator '.':merge 侧资源已按 '.' 嵌套存放,查找路径按 '.' 分层解析。
 * 缺 key 时优先 defaultValue(manifest 字面值兜底链),否则 i18next 默认返回完整 key。
 */
export async function initTranslator(opts: {
  resources: I18nResource;
  lng: string;
  ns: string[];
  supportedLngs: string[];
}): Promise<typeof i18next> {
  if (initialized) return i18next;
  await i18next.init({
    resources: opts.resources,
    lng: opts.lng,
    fallbackLng: FALLBACK_LOCALE,
    defaultNS: "common",
    ns: opts.ns,
    supportedLngs: opts.supportedLngs,
    nsSeparator: ".",
    keySeparator: ".", // ns 内按 '.' 分层;merge 侧资源已按 '.' 嵌套存放
    interpolation: { escapeValue: false, prefix: "{{", suffix: "}}" },
    returnEmptyString: false, // 空串当缺失
    returnNull: false,
    // 不配 parseMissingKeyHandler:缺 key 时优先 defaultValue(manifest 字面值兜底),
    // 无 defaultValue 时 i18next 默认返回完整 key(可读,不会拼出乱码)。
  });
  initialized = true;
  return i18next;
}

/** 切语言(05 §5.3):i18next.changeLanguage + 调用方可同步 document.documentElement.lang。 */
export async function changeLocale(locale: string): Promise<void> {
  if (!initialized) return;
  await i18next.changeLanguage(locale);
}

/** 取当前 locale。 */
export function currentLocale(): string {
  return i18next.language || DEFAULT_LOCALE;
}

/** 查文案(05 §4 fallback 链):i18next.t + 缺失时优先调用方传的 defaultValue(manifest 字面值兜底),
 *  无 defaultValue 时 i18next 默认返回完整 key(可读,不会拼出乱码)。 */
export function t(key: string, vars?: Record<string, unknown>): string {
  if (!initialized) return key;
  return i18next.t(key, vars as Record<string, unknown>);
}

/** i18next 实例(供 react-i18next 等 use)。 */
export { i18next };
