import type { ComponentType } from "react";
import type {
  Theme, PluginListItem, ExtensionInfo, SkillInfo, SettingsItem,
  SessionInfo, SessionEvent, SyncSnapshot, KernelEvent,
  NeutralMessage,
} from "@pi-desktop/core";

export interface PiApi {
  config: {
    get: <T>(pluginId: string, key: string) => Promise<T | undefined>;
    set: (pluginId: string, key: string, value: unknown) => Promise<void>;
    all: (pluginId: string) => Promise<Record<string, unknown>>;
  };
  prefs: {
    get: <T>(key: string) => Promise<T>;
    set: (key: string, value: unknown) => Promise<void>;
  };
  themes: {
    list: () => Promise<{ id: string; name: string }[]>;
    build: (themeId: string, fontScale: number, fontMono: string, fontSans: string) => Promise<Theme>;
  };
  settings: {
    list: () => Promise<SettingsItem[]>;
  };
  slots: {
    sidePanel: () => Promise<{ id: string; label: string; icon: string; component: string; pluginId: string }[]>;
    sidebar: () => Promise<{ id: string; title: string; component: string; pluginId: string }[]>;
    mainView: () => Promise<{ id: string; component: string; pluginId: string }[]>;
    titlebar: () => Promise<{ id: string; component: string; pluginId: string }[]>;
  };
  kernel: {
    status: () => Promise<{ currentVersion: string | null; available: boolean; error: string | null }>;
    listVersions: (forceRefresh?: boolean) => Promise<{ versions: string[]; latest: string | null }>;
    install: (
      version: string,
      onProgress: (line: string) => void,
      onDone: (r: { ok: boolean; error: string | null }) => void,
    ) => Promise<{ ok: boolean; error: string | null }>;
  };
  piSettings: {
    get: () => Promise<Record<string, unknown>>;
    set: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
    schema: () => Promise<{ key: string; type: string }[]>;
  };
  models: {
    get: <T>() => Promise<T>;
    set: <T>(config: T) => Promise<T>;
  };
  i18n: {
    resources: () => Promise<{
      resources: Record<string, Record<string, Record<string, string>>>;
      ns: string[];
      supportedLngs: string[];
    }>;
    list: () => Promise<{ id: string; name: string }[]>;
    detect: (navigatorLanguage: string) => Promise<string>;
  };
  openFile: (path: string) => Promise<void>;
  configFile: {
    get: (path: string) => Promise<Record<string, unknown>>;
    set: (path: string, data: Record<string, unknown>, mergeMode: "deep" | "replace") => Promise<Record<string, unknown>>;
    getLayered: (cwd: string, relPath: string) => Promise<Record<string, unknown> | null>;
    setProject: (cwd: string, relPath: string, data: Record<string, unknown>, mode: "deep" | "replace") => Promise<Record<string, unknown>>;
    clearProject: (cwd: string, relPath: string) => Promise<void>;
  };
  sessions: {
    start: (cwd: string, sessionPath?: string) => Promise<{ ok: boolean }>;
    stop: (sessionPath?: string | null) => Promise<{ ok: boolean }>;
    setContext: (cwd: string, sessionPath: string | null) => Promise<void>;
    getSnapshot: () => Promise<unknown>;
    sync: () => Promise<unknown>;
    openSession: (sessionPath: string) => Promise<unknown>;
    readToolConfig: (sessionPath: string) => Promise<{ mode: "all" | "custom"; enabledGroupIds?: string[] } | null>;
    renameSession: (sessionPath: string, name: string) => Promise<{ ok: boolean }>;
    updateHeader: (sessionPath: string, patch: { name?: string; pinned?: boolean; archived?: boolean; toolConfig?: { mode: "all" | "custom"; enabledGroupIds?: string[] } | null }) => Promise<{ ok: boolean }>;
    list: (cwd: string) => Promise<SessionInfo[]>;
    recentSettings: (cwd: string) => Promise<{ provider?: string; modelId?: string; thinkingLevel?: string }>;
    onEvent: (cb: (event: SessionEvent) => void) => () => void;
    onKernelEvent: (cb: (event: KernelEvent) => void) => () => void;
    onExtensionUI: (cb: (req: { requestId: string; method: string; [k: string]: unknown }) => void) => () => void;
    replyExtensionUI: (requestId: string, response: { value?: string; confirmed?: boolean; cancelled?: true }) => Promise<void>;
    onSnapshot: (cb: (snapshot: SyncSnapshot) => void) => () => void;
    prompt: (text: string, images?: { data: string; mimeType: string; name?: string }[]) => Promise<void>;
    abort: () => Promise<void>;
    steer: (text: string, images?: { data: string; mimeType: string; name?: string }[]) => Promise<void>;
    followUp: (text: string, images?: { data: string; mimeType: string; name?: string }[]) => Promise<void>;
    abortRetry: () => Promise<void>;
    getModels: () => Promise<unknown[]>;
    setModel: (provider: string, modelId: string) => Promise<void>;
    cycleModel: () => Promise<void>;
    getThinkingLevels: () => Promise<string[]>;
    setThinkingLevel: (level: string) => Promise<void>;
    cycleThinkingLevel: () => Promise<void>;
    fork: (entryId: string) => Promise<void>;
    clone: () => Promise<void>;
    getForkMessages: (entryId: string) => Promise<unknown[]>;
    copySession: (srcPath: string, targetPath: string) => Promise<void>;
    compact: (customInstructions?: string) => Promise<void>;
    setAutoCompaction: (enabled: boolean) => Promise<void>;
    setAutoRetry: (enabled: boolean) => Promise<void>;
    exportHtml: (outputPath?: string) => Promise<string>;
    getLastAssistantText: () => Promise<string>;
    getStats: () => Promise<unknown>;
    setSteeringMode: (mode: "all" | "one-at-a-time") => Promise<void>;
    setFollowUpMode: (mode: "all" | "one-at-a-time") => Promise<void>;
    runBash: (command: string, excludeFromContext?: boolean) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    abortBash: () => Promise<void>;
  };
  fs: {
    listDir: (pluginId: string, cwd: string) => Promise<{ name: string; isDir: boolean }[]>;
    removePath: (pluginId: string, path: string) => Promise<void>;
  };
  git: {
    status: (pluginId: string, cwd: string) => Promise<{ isRepo: boolean; files: { path: string; status: string }[] }>;
    fileDiff: (pluginId: string, cwd: string, path: string) => Promise<string>;
    fileContent: (pluginId: string, cwd: string, path: string) => Promise<string>;
  };
  dialog: {
    openDirectory: () => Promise<string | null>;
    openImages: () => Promise<{ name: string; data: string; mimeType: string }[]>;
  };
  plugins: {
    list: () => Promise<PluginListItem[]>;
    enable: (pluginId: string) => Promise<{ ok: boolean; error: string | null }>;
    disable: (pluginId: string) => Promise<{ ok: boolean; error: string | null }>;
    uninstall: (pluginId: string) => Promise<{ ok: boolean; error: string | null; errorArgs?: string[] }>;
    reload: (pluginId: string) => Promise<{ ok: boolean; error: string | null }>;
    install: (source: { type: "url" | "local"; location: string }) => Promise<{ ok: boolean; error: string | null }>;
    onUnloaded: (cb: (pluginId: string, components: string[]) => void) => () => void;
    onPluginsChanged: (cb: (nonce: number) => void) => () => void;
  };
  onSettingsChanged: (cb: () => void) => () => void;
  extension: {
    list: () => Promise<ExtensionInfo[]>;
    enable: (source: string) => Promise<void>;
    disable: (source: string) => Promise<void>;
    reorder: (sources: string[]) => Promise<void>;
    install: (source: string, onProgress: (line: string) => void) => Promise<{ ok: boolean; error: string | null }>;
    update: (source: string, onProgress: (line: string) => void) => Promise<{ ok: boolean; error: string | null }>;
    remove: (source: string, onProgress: (line: string) => void) => Promise<{ ok: boolean; error: string | null }>;
  };
  restart: {
    pendingSessions: () => Promise<{ sessionKey: string; state: unknown }[]>;
    restart: (sessionKey: string) => Promise<void>;
    restartAllIdle: () => Promise<void>;
    onStateChange: (cb: (sessionKey: string, state: unknown) => void) => () => void;
  };
  skills: {
    list: (cwd: string) => Promise<SkillInfo[]>;
    toggle: (opts: {
      filePath: string; sourcePath: string; enabled: boolean; scope: "user" | "project"; cwd: string;
    }) => Promise<void>;
    addPath: (opts: { path: string; scope: "user" | "project"; cwd: string }) => Promise<void>;
    removePath: (opts: { path: string; scope: "user" | "project"; cwd: string }) => Promise<void>;
    getSourcePaths: (cwd: string) => Promise<{ user: string[]; project: string[] }>;
    toggleForce: (opts: { filePath: string; force: boolean }) => Promise<void>;
    watch: (cwd: string, onChanged: () => void) => () => void;
  };
}

declare global {
  interface Window {
    pi: PiApi;
  }
}

export type {
  SessionInfo, ImageInput, SessionEvent, SyncSnapshot, TreeNode,
  MessageEntry, SessionState, ModelInfo, CommandItem, NeutralMessage,
  PluginContext, PluginConfigApi,
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi, BashApi,
  FsReadApi, GitReadApi, DialogApi,
  HeaderPatch, SessionToolConfig, BashResult,
  ModelsConfig, ProviderConfig, ModelConfig, SessionStats, TokenUsage, ContextUsage,
  KernelEvent, SessionMessageEvent, ExtensionUIRequestEvent, ProcessExitEvent, RpcErrorEvent, ExtensionUIResponse,
  PluginListItem, PluginState, PluginTier,
  ExtensionInfo, SkillInfo, SettingsItem,
  MessageRendererContribution,
} from "@pi-desktop/core";

export * from "./ui-store";
export { useSessionStore, initSessionStore } from "./session-store";
export { PluginIdContext, usePluginId } from "./plugin-id-context";
export { eventBus } from "./event-bus";
export { MONO_CHOICES, SANS_TONES } from "./font-presets";
export { SIDEBAR_STYLES, SIDEBAR_STYLE_MAP, type SidebarStyle, type SidebarStylePreset } from "./sidebar-styles";
export { SIDEPANEL_STYLES, SIDEPANEL_STYLE_MAP, type SidepanelStyle, type SidepanelStylePreset } from "./panel-styles";
export {
  PanelRow, type PanelRowProps,
  PanelToolbar, type PanelToolbarProps,
  PanelIconButton, type PanelIconButtonProps,
  PanelSearchInput, type PanelSearchInputProps,
  PanelStatRow, type PanelStatRowProps,
  PanelCard, type PanelCardProps,
  PanelSectionTitle, type PanelSectionTitleProps,
  PanelTabs, type PanelTabsProps,
} from "./panel";
export { SettingsSection, type SettingsSectionProps } from "./settings-section";
export { ListItem, type ListItemProps } from "./list-item";
export { Section, type SectionProps } from "./widgets/section";
export { Button, type ButtonProps, type ButtonVariant } from "./widgets/button";
export { Select, type SelectProps } from "./widgets/select";
export { EmptyState, type EmptyStateProps } from "./widgets/empty-state";
export { Toast, type ToastProps } from "./widgets/toast";
export { FileTree } from "./widgets/file-tree";
export { PluginIcon } from "./widgets/plugin-icon";
export { GENERAL_CONFIG_PATH } from "./paths";

export * from "./plugin-context";

export interface SettingsComponentProps {
  refreshSignal: number;
  config: Record<string, unknown> | null;
  onChange: (config: Record<string, unknown>) => void;
}

export interface MessageRendererProps {
  message: NeutralMessage;
  streaming: boolean;
}

const messageRendererComponents = new Map<string, ComponentType<MessageRendererProps>>();

export function registerMessageRenderer(role: string, comp: ComponentType<MessageRendererProps>): void {
  messageRendererComponents.set(role, comp);
}

export function getMessageRenderer(role: string): ComponentType<MessageRendererProps> | undefined {
  return messageRendererComponents.get(role);
}

export function unregisterMessageRenderer(role: string): void {
  messageRendererComponents.delete(role);
}

export function registerPluginMessageRenderers(
  module: Record<string, unknown>,
  contributes: { messageRenderers?: { role: string; component: string }[] },
): void {
  if (!contributes.messageRenderers) return;
  for (const item of contributes.messageRenderers) {
    const comp = module[item.component];
    if (comp && typeof comp === "function") {
      messageRendererComponents.set(item.role, comp as ComponentType<MessageRendererProps>);
    } else {
      console.warn(`[registerPluginMessageRenderers] 组件 ${item.component} 未在 module exports 中找到 (role=${item.role})`);
    }
  }
}

export function unregisterPluginMessageRenderers(
  contributes: { messageRenderers?: { role: string; component: string }[] },
): void {
  if (!contributes.messageRenderers) return;
  for (const item of contributes.messageRenderers) {
    messageRendererComponents.delete(item.role);
  }
}

const settingsComponents = new Map<string, ComponentType<SettingsComponentProps>>();
const sidePanelComponents = new Map<string, ComponentType<{ isActive: boolean }>>();
const sidebarComponents = new Map<string, ComponentType>();
const mainViewComponents = new Map<string, ComponentType>();
const titlebarComponents = new Map<string, ComponentType>();

export function getSettingsComponent(name: string): ComponentType<SettingsComponentProps> | undefined {
  return settingsComponents.get(name);
}
export function getSidePanelComponent(name: string): ComponentType<{ isActive: boolean }> | undefined {
  return sidePanelComponents.get(name);
}
export function getSidebarComponent(name: string): ComponentType | undefined {
  return sidebarComponents.get(name);
}
export function getMainViewComponent(name: string): ComponentType | undefined {
  return mainViewComponents.get(name);
}
export function getTitlebarComponent(name: string): ComponentType | undefined {
  return titlebarComponents.get(name);
}

const componentRegistries: Record<string, Map<string, ComponentType<any>>> = {
  settings: settingsComponents as Map<string, ComponentType<any>>,
  sidePanel: sidePanelComponents as Map<string, ComponentType<any>>,
  sidebar: sidebarComponents as Map<string, ComponentType<any>>,
  mainView: mainViewComponents,
  titlebar: titlebarComponents,
};

type SlotWithComponents = "settings" | "sidePanel" | "sidebar" | "mainView" | "titlebar";

interface ContributesLike {
  settings?: { component: string }[];
  sidePanel?: { component: string }[];
  sidebar?: { component: string }[];
  mainView?: { component: string }[];
  titlebar?: { component: string }[];
  messageRenderers?: { role: string; component: string }[];
}

export function registerPluginComponents(
  module: Record<string, unknown>,
  contributes: ContributesLike,
): void {
  for (const slot of ["settings", "sidePanel", "sidebar", "mainView", "titlebar"] as const) {
    const items = contributes[slot as SlotWithComponents];
    if (!items) continue;
    const registry = componentRegistries[slot];
    for (const item of items) {
      const comp = module[item.component];
      if (comp && typeof comp === "function") {
        registry.set(item.component, comp as ComponentType);
      } else {
        console.warn(`[registerPluginComponents] 组件 ${item.component} 未在 module exports 中找到 (slot=${slot})`);
      }
    }
  }
}

export function unregisterPluginComponents(contributes: ContributesLike): void {
  for (const slot of ["settings", "sidePanel", "sidebar", "mainView", "titlebar"] as const) {
    const items = contributes[slot as SlotWithComponents];
    if (!items) continue;
    const registry = componentRegistries[slot];
    for (const item of items) {
      registry.delete(item.component);
    }
  }
}
