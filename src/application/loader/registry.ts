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
  SettingsItem,
} from "../../domain/contributions";
import type { DiscoveredPlugin } from "./discover";

/** 数组类槽位通用容器(开闭,评估 P2):settings/sidePanel/sidebar 等结构相同的槽
 *  共用此容器,加新数组类槽只需加字段 + SlotName + 查询方法,register/unregister 经通用遍历。 */
class ArraySlot<T> {
  private items: { contribution: T; pluginId: string }[] = [];
  push(contribution: T, pluginId: string): void {
    this.items.push({ contribution, pluginId });
  }
  removeByPlugin(pluginId: string): void {
    this.items = this.items.filter((s) => s.pluginId !== pluginId);
  }
  all(): ReadonlyArray<{ contribution: T; pluginId: string }> {
    return this.items;
  }
}

/** 插件注册表:聚合发现结果,提供按槽/按 id 查询。 */
export class PluginRegistry {
  /** 按 id 聚合的 manifest(含 source/path) */
  private byId = new Map<string, DiscoveredPlugin>();
  /** themes 槽:id → 贡献项(按 id 去重,语义与数组槽不同,单独 Map) */
  private themes = new Map<string, ThemeContribution>();
  /** settings/sidePanel/sidebar 三个数组类槽:结构相同(contribution + pluginId),
   *  用通用 ArraySlot 容器,加新数组类槽只需加字段 + SlotName + 查询方法,
   *  registerOne/unregister 经通用遍历不改(开闭,评估 P2)。 */
  private settings = new ArraySlot<SettingsContribution>();
  private sidePanel = new ArraySlot<SidePanelContribution>();
  private sidebar = new ArraySlot<SidebarContribution>();
  /** languages 槽:语言包贡献项(含来源 pluginId + source,合并器按 source priority 仲裁,特殊留数组) */
  private languages: { contribution: LanguageContribution; pluginId: string; source: DiscoveredPlugin["source"]; pluginPath: string }[] = [];

  /** 数组类槽位映射(SlotName → registry 字段);加新数组类槽在此加一行 + 加字段 + 查询方法。 */
  private readonly arraySlots: { slot: "settings" | "sidePanel" | "sidebar"; reg: ArraySlot<unknown> }[] = [
    { slot: "settings", reg: this.settings as ArraySlot<unknown> },
    { slot: "sidePanel", reg: this.sidePanel as ArraySlot<unknown> },
    { slot: "sidebar", reg: this.sidebar as ArraySlot<unknown> },
  ];

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
    // 数组类槽通用注册(遍历 arraySlots 映射,不逐槽写 for)
    for (const { slot, reg } of this.arraySlots) {
      const items = p.manifest.contributes?.[slot] as unknown[] | undefined;
      if (items) for (const item of items) reg.push(item, p.manifest.id);
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
    // 数组类槽通用注销
    for (const { reg } of this.arraySlots) reg.removeByPlugin(pluginId);
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

  /** 列 settings 槽所有贡献项(供设置页左列表,按 order 升序,缺省 100)。返回完整 SettingsItem 契约。 */
  settingsItems(): SettingsItem[] {
    return this.settings.all()
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
    return this.sidePanel.all()
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
    return this.sidebar.all()
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
