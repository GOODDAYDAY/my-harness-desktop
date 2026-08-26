// 圆心:内核拓展管理类型契约 —— domain,零依赖。
//
// 依据 docs/core/extension-management.md §0(多内核统一)。
// 内核只提供 5 个基础能力(list/enable/disable/install/uninstall);
// 展示(排序/标签/受保护/重启协调/UI)是 application 基类 + 共享 UI 的机制。
// 零外部依赖:不 import react/electron/pi/dsh(圆心纯度纪律)。

/** 内核拓展在列表中的呈现信息——两个内核产出完全相同的形状。 */
export interface KernelExtensionInfo {
  /** 内核内唯一标识:pi = source,dsh = cordis id。 */
  id: string;
  /** 展示名(pi 读 package.json name,dsh 用 cordis id / 包名)。 */
  name: string;
  /** 版本号(读 package.json;缺失不填)。 */
  version?: string;
  /** 描述(读 package.json description;缺失不填)。 */
  description?: string;
  /** 唯一功能态轴:启用/禁用。 */
  enabled: boolean;
  /** 受保护(不可关/不可卸),如 read-claude-md、sdk-jsonrpc-server。 */
  disallowOff?: boolean;
  /** 分类标签:由基类从 sourceType 派生(如 ["npm", "protected"])。 */
  tags: string[];
}

/** 内核拓展能力缝:哪些可选能力被支持(两个内核都先报 false)。 */
export interface KernelExtensionCapabilities {
  update: boolean;
  reorder: boolean;
}

/** 安装/卸载结果。 */
export interface KernelExtensionMutationResult {
  ok: boolean;
  error?: string;
}

/**
 * 内核拓展源:内核只需提供的 5 个基础能力 + 能力缝。
 * 圆心契约——application(基类)与共享 UI 依赖本接口,client 实现本接口(依赖倒置)。
 * 加第三个内核 = 加一个 KernelExtensionSource 实现,基类/UI 一行不改(与 KernelModelSource 同构)。
 */
export interface KernelExtensionSource {
  /** 合并视图:启用 + 禁用,不再拆 list/listAvailable/listDisabled 三份。 */
  list(): KernelExtensionInfo[];
  enable(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  install(source: string, onProgress: (line: string) => void): Promise<KernelExtensionMutationResult>;
  uninstall(id: string, onProgress: (line: string) => void): Promise<KernelExtensionMutationResult>;
  /** 能力缝:update/reorder 是否支持。 */
  readonly capabilities: KernelExtensionCapabilities;
}
