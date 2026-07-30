// renderer i18next + react-i18next 初始化(05-plugin-i18n §6.2.3)。
//
// main 合并好 resources 经 IPC 给 renderer;renderer 端 init 自己的 i18next 实例 + react-i18next。
// 跨堆:main 与 renderer 各持 i18next 实例(查询语义一致,实例独立)。
// init 在 createRoot 前 await(和 hydrate 并行 race),保证 useTranslation 首帧可用。
// 失败不阻塞 render(超时兜底,i18next 未 init 时 t 返回完整 key)。
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { useUiStore } from "./ui-store";

let inited = false;

/** 初始化 renderer i18next:拿 main 合并的 resources + 当前 locale,init react-i18next。 */
export async function initI18n(): Promise<void> {
  if (inited) return;
  inited = true;
  try {
    const { resources, ns, supportedLngs } = await window.pi.i18n.resources();
    const store = useUiStore.getState();
    // 检测:navigator.language → 支持 locale;若 prefs 已有 currentLocale 优先用之
    let lng = store.currentLocale;
    if (!lng) {
      lng = await window.pi.i18n.detect(navigator.language);
      store.setCurrentLocale(lng);
    }
    await i18next.use(initReactI18next).init({
      resources,
      lng,
      fallbackLng: "en",
      defaultNS: "common",
      ns,
      supportedLngs,
      nsSeparator: ".",
      keySeparator: ".", // merge 侧资源按 '.' 嵌套存放,查找路径按 '.' 分层解析
      interpolation: { escapeValue: false, prefix: "{{", suffix: "}}" },
      returnEmptyString: false,
      returnNull: false,
      // 不配 parseMissingKeyHandler:缺 key 时优先 defaultValue(manifest 字面值兜底),
      // 无 defaultValue 时 i18next 默认返回完整 key(可读,不会拼出乱码)。
    });
    document.documentElement.lang = lng;
  } catch (err) {
    console.error("[i18n] renderer init 失败,t 将返回 key:", err);
  }
}

/** 切 locale:ui-store 落 prefs + i18next.changeLanguage + 同步 document.lang(05 §5.3/§5.4)。 */
export async function changeLocale(locale: string): Promise<void> {
  useUiStore.getState().setCurrentLocale(locale);
  await i18next.changeLanguage(locale);
  document.documentElement.lang = locale;
}

/** 订阅 ui-store currentLocale 变化 → i18next.changeLanguage + document.lang 同步。
 *  renderer 入口挂一次:插件/设置页只调 setCurrentLocale,locale 切换自动生效(守插件式边界)。
 *  返回取消订阅函数。 */
export function subscribeLocaleChange(): () => void {
  let prev = useUiStore.getState().currentLocale;
  return useUiStore.subscribe((state) => {
    if (state.currentLocale !== prev) {
      prev = state.currentLocale;
      const locale = state.currentLocale;
      if (i18next.isInitialized && i18next.language !== locale) {
        void i18next.changeLanguage(locale);
      }
      document.documentElement.lang = locale;
    }
  });
}

/** i18next 实例(供直接 use,一般经 useTranslation)。 */
export { i18next };
