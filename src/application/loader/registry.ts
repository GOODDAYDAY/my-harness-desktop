// 插件注册表 —— application 层,聚合 discover 结果供渲染层查询。
//
// 依据 structure/16 §3.2.2(SlotRegistry:按槽位分的 Map)。
// 本次最小集:只填 themes/settings 两槽 + 按 id 查 manifest。
// 后续补完整八槽 + 优先级仲裁(resolveByPriority)+ 热重载回退。
import type {
  PluginManifest,
  ThemeContribution,
  SettingsContribution,
  SidePanelContribution,
  SidebarContribution,
  LanguageContribution,
} from "../../domain/contributions";
import type { DiscoveredPlugin } from "./discover";

/** 插件注册表:聚合发现结果,提供按槽/按 id 查询。 */
export class PluginRegistry {
  /** 按 id 聚合的 manifest(含 source/path) */
  private byId = new Map<string, DiscoveredPlugin>();
  /** themes 槽:id → 贡献项 */
  private themes = new Map<string, ThemeContribution>();
  /** settings 槽:id → 贡献项(含来源 pluginId/component) */
  private settings: { contribution: SettingsContribution; pluginId: string }[] = [];
  /** sidePanel 槽(右侧板 Tab) */
  private sidePanel: { contribution: SidePanelContribution; pluginId: string }[] = [];
  /** sidebar 槽(左栏分组) */
  private sidebar: { contribution: SidebarContribution; pluginId: string }[] = [];
  /** languages 槽:语言包贡献项(含来源 pluginId + source,合并器按 source priority 仲裁) */
  private languages: { contribution: LanguageContribution; pluginId: string; source: DiscoveredPlugin["source"]; pluginPath: string }[] = [];

  /** 收集一批发现结果进注册表。 */
  registerAll(plugins: DiscoveredPlugin[]): void {
    for (const p of plugins) this.registerOne(p);
  }

  /** 注册单个插件（registerAll 的单步提取，热加载 registerOne 复用同一逻辑）。 */
  registerOne(p: DiscoveredPlugin): void {
    this.byId.set(p.manifest.id, p);
    for (const t of p.manifest.contributes?.themes ?? []) {
      this.themes.set(t.id, t);
    }
    for (const s of p.manifest.contributes?.settings ?? []) {
      this.settings.push({ contribution: s, pluginId: p.manifest.id });
    }
    for (const sp of p.manifest.contributes?.sidePanel ?? []) {
      this.sidePanel.push({ contribution: sp, pluginId: p.manifest.id });
    }
    for (const sb of p.manifest.contributes?.sidebar ?? []) {
      this.sidebar.push({ contribution: sb, pluginId: p.manifest.id });
    }
    for (const l of p.manifest.contributes?.languages ?? []) {
      this.languages.push({ contribution: l, pluginId: p.manifest.id, source: p.source, pluginPath: p.path });
    }
  }

  /** 从注册表移除一个插件的所有贡献项（热加载 deactivate 用）。 */
  unregister(pluginId: string): void {
    const p = this.byId.get(pluginId);
    if (!p) return;
    this.byId.delete(pluginId);
    for (const [themeId, t] of this.themes) {
      if (p.manifest.contributes?.themes?.some((t2) => t2.id === t.id)) {
        this.themes.delete(themeId);
      }
    }
    this.settings = this.settings.filter((s) => s.pluginId !== pluginId);
    this.sidePanel = this.sidePanel.filter((s) => s.pluginId !== pluginId);
    this.sidebar = this.sidebar.filter((s) => s.pluginId !== pluginId);
    this.languages = this.languages.filter((l) => l.pluginId !== pluginId);
  }

  /** 遍历所有已注册插件（生命周期管理用）。 */
  allPlugins(): ReadonlyMap<string, DiscoveredPlugin> {
    return this.byId;
  }

  /** 取主题注册表(ThemeContribution id → 贡献项)。 */
  themesRegistry(): Record<string, ThemeContribution> {
    return Object.fromEntries(this.themes);
  }

  /** 列所有可选主题(供主题选择 UI),跳过 auto/__auto__ 动态 base。 */
  themeOptions(): { id: string; name: string }[] {
    return [...this.themes.values()]
      .filter((t) => t.id !== "auto")
      .map((t) => ({ id: t.id, name: t.name }));
  }

  /** 列 settings 槽所有贡献项(供设置页左列表,按 order 升序,缺省 100)。 */
  settingsItems(): { id: string; title: string; component: string; pluginId: string }[] {
    return this.settings
      .map((s) => ({
        id: s.contribution.id,
        title: s.contribution.title,
        component: s.contribution.component,
        pluginId: s.pluginId,
        configFile: s.contribution.configFile ?? null,
        configMerge: s.contribution.configMerge ?? "replace",
        saveMode: s.contribution.saveMode ?? "framework",
        order: s.contribution.order ?? 100,
      }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...rest }) => rest);
  }

  /** 列 sidePanel 槽所有贡献项(右面板 Tab 壳用,按 order 升序,缺省 100)。 */
  sidePanelItems(): { id: string; label: string; icon: string; component: string; pluginId: string }[] {
    return this.sidePanel
      .map((s) => ({
        id: s.contribution.id,
        label: s.contribution.label,
        icon: s.contribution.icon,
        component: s.contribution.component,
        pluginId: s.pluginId,
        order: s.contribution.order ?? 100,
      }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...rest }) => rest);
  }

  /** 列 sidebar 槽所有贡献项(左栏分组用,按 order 升序,缺省 100)。 */
  sidebarItems(): { id: string; title: string; component: string; pluginId: string }[] {
    return this.sidebar
      .map((s) => ({
        id: s.contribution.id,
        title: s.contribution.title,
        component: s.contribution.component,
        pluginId: s.pluginId,
        order: s.contribution.order ?? 100,
      }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...rest }) => rest);
  }

  /** 列 languages 槽所有贡献项(含 pluginId/source/pluginPath,供 i18n 合并器按优先级合并)。 */
  languageContributions(): { contribution: LanguageContribution; pluginId: string; source: DiscoveredPlugin["source"]; pluginPath: string }[] {
    return this.languages;
  }

  /** 插件是否声明了某权限(main IPC 边界门控用)。 */
  hasPermission(pluginId: string, permission: string): boolean {
    return (this.byId.get(pluginId)?.manifest.permissions ?? []).includes(permission);
  }

  /** 按 id 取 manifest(查插件信息用)。 */
  manifestOf(pluginId: string): PluginManifest | undefined {
    return this.byId.get(pluginId)?.manifest;
  }
}
