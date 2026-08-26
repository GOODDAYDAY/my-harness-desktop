// IPC:外观三件套 —— i18n 资源/语言列表、主题构建(注册表 + 合并 + 对比度审计)、settings 槽清单。
import { BrowserWindow, nativeTheme } from "electron";
import type { Gateway } from "../routing/gateway";
import { buildCurrentTheme } from "../application/theme/merge";
import { auditThemeContrast } from "../application/theme/contrast";
import { detectLocale } from "../application/i18n/translator";
import { IPC } from "@my-harness-desktop/shared";
import type { MainContext } from "../application/context/main-context";

export function registerAppearance(gateway: Gateway, ctx: MainContext): void {
  const { registry, i18n } = ctx;

  // renderer 端 init i18next + react-i18next(跨堆各持实例);main 只提供合并好的 resources。
  gateway.register(IPC.i18n.resources, () => ({
    resources: i18n.resources,
    ns: i18n.namespaces,
    supportedLngs: i18n.supportedLngs,
  }));
  gateway.register(IPC.i18n.list, () => i18n.localeList);
  gateway.register(IPC.i18n.detect, (_e, navigatorLanguage: string) =>
    detectLocale(navigatorLanguage, i18n.supportedLngs),
  );

  gateway.register(IPC.themes.list, () => registry.themeOptions());
  gateway.register(
    IPC.themes.build,
    (_e, themeId: string, fontScale: number, fontMono: string, fontEnglish: string, fontChinese: string) => {
      const theme = buildCurrentTheme(
        themeId,
        registry.themesRegistry(),
        fontScale,
        fontMono,
        fontEnglish,
        fontChinese,
        registry.fontPresetsRegistry(),
        nativeTheme.shouldUseDarkColors,
      );
      // WCAG AA 对比度审计(06 §870):诊断不阻断,主进程日志上报告警,主题开发者可见。
      const audit = auditThemeContrast(theme);
      for (const d of audit.failed) {
        console.warn(
          `[theme] 对比度不足 ${themeId}: ${d.fg} on ${d.bg} = ${d.ratio.toFixed(2)}:1(需 ≥${d.required}:1)`,
        );
      }
      return theme;
    },
  );
  // 系统明暗变化 → 推 renderer 重 build(__auto__ 动态 base 的消费方在 renderer,事件驱动不轮询)。
  nativeTheme.on("updated", () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.themes.systemChanged);
  });

  // ---- IPC:设置页(读 settings 槽贡献项)----
  gateway.register(IPC.settings.list, () => registry.settingsItems());

  // ---- IPC:字体预设(读 fontPresets 槽贡献项,字体选择 UI 用)----
  gateway.register(IPC.fonts.list, () => registry.fontPresetsItems());
}
