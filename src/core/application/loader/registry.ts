// 插件注册表 —— application 层,聚合 discover 结果供渲染层查询。
//
// 依据 structure/16 §3.2.2(SlotRegistry:按槽位分的 Map)。
// 现状:八槽全填(themes/settings/sidePanel/sidebar/mainView/titlebar/fileActions/languages)
// + unregister + 热加载(registerOne/unregister 与 lifecycle.reload 配套)。
// 覆盖语义(无特权差异 01-core 检验方式二):Map 型槽(themes/byId)按 id 覆盖;
// 数组类槽 push 前按 contribution.id 清同 id 旧项(removeById)——bootstrap 注册序
// builtin → installed → user → project 保证后注册者(更高优先级 source)覆盖先注册者。
import type {
  PluginManifest,
  ThemeContribution,
  SettingsContribution,
  SidePanelContribution,
  SidebarContribution,
  MainViewContribution,
  TitlebarContribution,
  LanguageContribution,
  FileActionContribution,
  FileIconContribution,
  MessageActionContribution,
  BlockRendererContribution,
  SessionGroupingContribution,
  ComposerPolicyContribution,
  SettingsGroupContribution,
  SystemPromptContribution,
  SettingsItem,
} from "../../domain/contributions";
import { THEME_TOKEN_SCHEMA_VERSION } from "../../domain/slots/theme-tokens";
import { satisfies, coerce } from "semver";
import { resolve } from "node:path";
import type { DiscoveredPlugin } from "./discover";

/** tokenSchemaVersion 兼容判定(06 §4.1.2):manifest 声明的 range 须覆盖圆心 schema 版本。
 *  未声明视为兼容(向后兼容存量插件);声明了但 range 非法/不覆盖 → 不兼容。 */
function isTokenSchemaCompatible(declared: string | undefined): boolean {
  if (!declared) return true;
  const core = coerce(THEME_TOKEN_SCHEMA_VERSION);
  if (!core) return false;
  try {
    return satisfies(core, declared);
  } catch {
    return false;
  }
}

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
  /** 按 contribution.id 移除（覆盖语义）：后注册者 push 前先清同 id 旧项，
   *  实现"复制到高优先级目录即覆盖低优先级同名贡献"（无特权差异 01-core 检验方式二）。
   *  bootstrap 注册序 builtin → installed → user → project 保证后注册者高优先级。 */
  removeById(id: string): void {
    this.items = this.items.filter((s) => (s.contribution as { id?: string }).id !== id);
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
  private mainView = new ArraySlot<MainViewContribution>();
  private titlebar = new ArraySlot<TitlebarContribution>();
  private fileActions = new ArraySlot<FileActionContribution>();
  private fileIcons = new ArraySlot<FileIconContribution>();
  private messageActions = new ArraySlot<MessageActionContribution>();
  private blockRenderers = new ArraySlot<BlockRendererContribution>();
  private sessionGroupings = new ArraySlot<SessionGroupingContribution>();
  private composerPolicies = new ArraySlot<ComposerPolicyContribution>();
  private settingsGroups = new ArraySlot<SettingsGroupContribution>();
  private systemPrompts = new ArraySlot<SystemPromptContribution>();
  /** languages 槽:语言包贡献项(含来源 pluginId + source,合并器按 source priority 仲裁,特殊留数组) */
  private languages: { contribution: LanguageContribution; pluginId: string; source: DiscoveredPlugin["source"]; pluginPath: string }[] = [];

  /** 数组类槽位映射(SlotName → registry 字段);加新数组类槽在此加一行 + 加字段 + 查询方法。 */
  private readonly arraySlots: { slot: "settings" | "sidePanel" | "sidebar" | "mainView" | "titlebar" | "fileActions" | "fileIcons" | "messageActions" | "blockRenderers" | "sessionGroupings" | "composerPolicies" | "settingsGroups" | "systemPrompts"; reg: ArraySlot<unknown> }[] = [
    { slot: "settings", reg: this.settings as ArraySlot<unknown> },
    { slot: "sidePanel", reg: this.sidePanel as ArraySlot<unknown> },
    { slot: "sidebar", reg: this.sidebar as ArraySlot<unknown> },
    { slot: "mainView", reg: this.mainView as ArraySlot<unknown> },
    { slot: "titlebar", reg: this.titlebar as ArraySlot<unknown> },
    { slot: "fileActions", reg: this.fileActions as ArraySlot<unknown> },
    { slot: "fileIcons", reg: this.fileIcons as ArraySlot<unknown> },
    { slot: "messageActions", reg: this.messageActions as ArraySlot<unknown> },
    { slot: "blockRenderers", reg: this.blockRenderers as ArraySlot<unknown> },
    { slot: "sessionGroupings", reg: this.sessionGroupings as ArraySlot<unknown> },
    { slot: "composerPolicies", reg: this.composerPolicies as ArraySlot<unknown> },
    { slot: "settingsGroups", reg: this.settingsGroups as ArraySlot<unknown> },
    { slot: "systemPrompts", reg: this.systemPrompts as ArraySlot<unknown> },
  ];

  /** 收集一批发现结果进注册表。 */
  registerAll(plugins: DiscoveredPlugin[]): void {
    for (const p of plugins) this.registerOne(p);
  }

  /** 注册单个插件（registerAll 的单步提取，热加载 registerOne 复用同一逻辑）。 */
  registerOne(p: DiscoveredPlugin): void {
    this.byId.set(p.manifest.id, p);
    const themes = p.manifest.contributes?.themes ?? [];
    if (themes.length > 0 && !isTokenSchemaCompatible(p.manifest.tokenSchemaVersion)) {
      // 不拒整个插件:只跳过 themes 贡献,其余槽位照注册(主题回退默认值,不白屏)。
      console.warn(
        `[loader] 跳过 themes 注册: ${p.manifest.id} 声明 tokenSchemaVersion="${p.manifest.tokenSchemaVersion}",` +
          `与内核 schema ${THEME_TOKEN_SCHEMA_VERSION} 不兼容`,
      );
    } else {
      for (const t of themes) this.themes.set(t.id, t);
    }
    // 数组类槽通用注册(遍历 arraySlots 映射,不逐槽写 for)
    for (const { slot, reg } of this.arraySlots) {
      const items = p.manifest.contributes?.[slot] as unknown[] | undefined;
      if (items) for (const item of items) {
        // 覆盖语义:push 前先按 contribution.id 清同 id 旧项——bootstrap 注册序
        // builtin → installed → user → project 保证后注册者高优先级,
        // 内置件复制到高优先级目录即覆盖低优先级同名贡献(无特权差异 01-core 检验方式二)。
        const id = (item as { id?: string })?.id;
        if (typeof id === "string" && id.length > 0) reg.removeById(id);
        reg.push(item, p.manifest.id);
      }
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

  /** 列所有可选主题(供主题选择 UI)。含 auto(__auto__ 动态 base 已接 nativeTheme,
   *  系统明暗由 main 侧注入 build,此前恒 dark 故隐藏,现放开)。 */
  themeOptions(): { id: string; name: string }[] {
    return [...this.themes.values()].map((t) => ({ id: t.id, name: t.name }));
  }

  /** 列 settings 槽所有贡献项(供设置页左列表,按 order 升序,缺省 100)。返回完整 SettingsItem 契约。 */
  settingsItems(): SettingsItem[] {
    return this.settings.all()
      .map((s) => ({
        id: s.contribution.id,
        title: s.contribution.title,
        icon: s.contribution.icon ?? "settings",
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
  sidePanelItems(): { id: string; label: string; icon: string; component: string; pluginId: string; revealOn?: string }[] {
    return this.sidePanel.all()
      .map((s) => ({
        id: s.contribution.id,
        label: s.contribution.label,
        icon: s.contribution.icon,
        component: s.contribution.component,
        pluginId: s.pluginId,
        order: s.contribution.order ?? 100,
        ...(s.contribution.revealOn ? { revealOn: s.contribution.revealOn } : {}),
      }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...rest }) => rest);
  }

  /** 列 sidebar 槽所有贡献项(左栏分组用,按 order 升序,缺省 100)。 */
  sidebarItems(): { id: string; title: string; component: string; pluginId: string; group?: string }[] {
    return this.sidebar.all()
      .map((s) => ({
        id: s.contribution.id,
        title: s.contribution.title,
        component: s.contribution.component,
        pluginId: s.pluginId,
        order: s.contribution.order ?? 100,
        group: s.contribution.group,
      }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, group, ...rest }) => (group ? { ...rest, group } : rest));
  }

  /** 列 mainView 槽所有贡献项(按 order 升序选第一个,壳的中区渲染用)。 */
  mainViewItems(): { id: string; component: string; pluginId: string }[] {
    return this.mainView.all()
      .map((s) => ({
        id: s.contribution.id,
        component: s.contribution.component,
        pluginId: s.pluginId,
        order: s.contribution.order ?? 100,
      }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...rest }) => rest);
  }

  /** 列 titlebar 槽所有贡献项(按 order 升序,壳的标题栏渲染用)。 */
  titlebarItems(): { id: string; component: string; pluginId: string }[] {
    return this.titlebar.all()
      .map((s) => ({
        id: s.contribution.id,
        component: s.contribution.component,
        pluginId: s.pluginId,
        order: s.contribution.order ?? 100,
      }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...rest }) => rest);
  }

  /** 列 fileActions 槽所有贡献项(文件树等消费方渲染菜单用,按 order 升序,缺省 100)。 */
  fileActionItems(): (FileActionContribution & { pluginId: string })[] {
    return this.fileActions.all()
      .map((s) => ({ ...s.contribution, pluginId: s.pluginId, order: s.contribution.order ?? 100 }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...rest }) => rest);
  }

  /** 列 fileIcons 槽所有贡献项(文件树解析图标用,按 order 升序,缺省 100)。
   *  保注册序:同 order 时先注册(builtin)在前——消费侧按 key 合并时后注册者胜出。 */
  fileIconItems(): (FileIconContribution & { pluginId: string })[] {
    return this.fileIcons.all()
      .map((s) => ({ ...s.contribution, pluginId: s.pluginId, order: s.contribution.order ?? 100 }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...rest }) => rest);
  }

  messageActionItems(): (MessageActionContribution & { pluginId: string })[] {
    return this.messageActions.all()
      .map((s) => ({ ...s.contribution, pluginId: s.pluginId, order: s.contribution.order ?? 100 }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...rest }) => rest);
  }

  /** 列 blockRenderers 槽所有贡献项(timeline 消费,按 order 升序,缺省 100;保注册序——
   *  同 order 先注册(builtin)在前,消费侧解析时同 order 取后者=高优先级 source 胜出)。 */
  blockRendererItems(): (BlockRendererContribution & { pluginId: string })[] {
    return this.blockRenderers.all()
      .map((s) => ({ ...s.contribution, pluginId: s.pluginId, order: s.contribution.order ?? 100 }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...rest }) => rest);
  }

  sessionGroupingItems(): (SessionGroupingContribution & { pluginId: string })[] {
    return this.sessionGroupings.all()
      .map((s) => ({ ...s.contribution, pluginId: s.pluginId, order: s.contribution.order ?? 100 }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...rest }) => rest);
  }

  composerPolicyItems(): (ComposerPolicyContribution & { pluginId: string })[] {
    return this.composerPolicies.all()
      .map((s) => ({ ...s.contribution, pluginId: s.pluginId, order: s.contribution.order ?? 100 }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...rest }) => rest);
  }

  /** 列 settingsGroups 槽所有贡献项(通用设置页通用渲染器消费,按 order 升序,缺省 100)。 */
  settingsGroupItems(): (SettingsGroupContribution & { pluginId: string })[] {
    return this.settingsGroups.all()
      .map((s) => ({ ...s.contribution, pluginId: s.pluginId, order: s.contribution.order ?? 100 }))
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...rest }) => rest);
  }

  /** 收集 systemPrompts 槽所有贡献项,解析为绝对文件路径(供 SessionStore spawn 拼 --append-system-prompt)。
   *  按 order 升序;插件卸载 → 贡献从注册表移除 → 下次 spawn 不再收集(内容外挂机制)。 */
  systemPromptPaths(): string[] {
    return this.systemPrompts.all()
      .map((s) => {
        const plugin = this.byId.get(s.pluginId);
        if (!plugin?.path) return null;
        return { path: resolve(plugin.path, s.contribution.file), order: s.contribution.order ?? 100 };
      })
      .filter((s): s is { path: string; order: number } => s !== null)
      .sort((a, b) => a.order - b.order)
      .map((s) => s.path);
  }

  /** 列 languages 槽所有贡献项(含 pluginId/source/pluginPath,供 i18n 合并器按优先级合并)。 */
  languageContributions(): { contribution: LanguageContribution; pluginId: string; source: DiscoveredPlugin["source"]; pluginPath: string }[] {
    return this.languages;
  }

  /** 插件是否声明了某权限(main IPC 边界门控用)。 */
  hasPermission(pluginId: string, permission: string): boolean {
    return (this.byId.get(pluginId)?.manifest.permissions ?? []).includes(permission);
  }

  /** 权限门控(抛错版):未知插件或未声明权限即抛。各 IPC 域共用,不在 handler 文件各写一份。 */
  assertPermission(pluginId: string, permission: string): void {
    if (!this.manifestOf(pluginId)) throw new Error(`未知插件: ${pluginId}`);
    if (!this.hasPermission(pluginId, permission)) {
      throw new Error(`插件 ${pluginId} 未声明权限 ${permission}`);
    }
  }

  /** 按 id 取 manifest(查插件信息用)。 */
  manifestOf(pluginId: string): PluginManifest | undefined {
    return this.byId.get(pluginId)?.manifest;
  }
}
