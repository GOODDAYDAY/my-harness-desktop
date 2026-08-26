// 内核拓展管理基类 —— application 层用例编排(机制,不含具体内核)。
//
// pi/dsh 共用同一套「排序/标签派生/受保护/重启协调」机制,差异只在「数据从哪扫
// (scan)、开关怎么落盘(doEnable/doDisable)、装/卸怎么执行(doInstall/doUninstall)」。
// 基类只 import 圆心类型(extensions.ts),不 import 任何具体内核——数据源与行为差异
// 由子类(client/pi、client/dsh)填,组装在 bootstrap(docs/core/extension-management.md §0.4)。
//
// 关键纪律:
// - application 不 import electron/client(守"依赖只向内")。
// - 受保护名单注入(不写死),重启协调经 onConfigChanged 回调注入(不 import restart-coordinator 具体类)。

import type {
  KernelExtensionInfo,
  KernelExtensionSource,
  KernelExtensionCapabilities,
  KernelExtensionMutationResult,
} from "@my-harness-desktop/shared";

/** 基类构造参数。 */
export interface KernelExtensionManagerOptions {
  /** 受保护 id 集合(按 id 末段或全 id 匹配)。 */
  protectedIds?: ReadonlySet<string>;
  /** 配置变更回调(enable/disable/install/uninstall 完成后触发,bootstrap 接线 restartCoordinator)。 */
  onConfigChanged?: (reason: string) => void;
}

export abstract class KernelExtensionManager implements KernelExtensionSource {
  protected readonly protectedIds: ReadonlySet<string>;
  private readonly onConfigChanged?: (reason: string) => void;

  constructor(opts: KernelExtensionManagerOptions = {}) {
    this.protectedIds = opts.protectedIds ?? new Set<string>();
    this.onConfigChanged = opts.onConfigChanged;
  }

  // ===== 中性契约(模板方法:基类统一排序/守卫/通知) =====

  list(): KernelExtensionInfo[] {
    return this.sortList(this.scan());
  }

  async enable(id: string): Promise<void> {
    await this.doEnable(id);
    this.notifyConfigChanged("拓展启用");
  }

  async disable(id: string): Promise<void> {
    this.assertNotProtected(id, "禁用");
    await this.doDisable(id);
    this.notifyConfigChanged("拓展禁用");
  }

  async install(source: string, onProgress: (line: string) => void): Promise<KernelExtensionMutationResult> {
    const r = await this.doInstall(source, onProgress);
    if (r.ok) this.notifyConfigChanged("拓展安装");
    return r;
  }

  async uninstall(id: string, onProgress: (line: string) => void): Promise<KernelExtensionMutationResult> {
    this.assertNotProtected(id, "卸载");
    const r = await this.doUninstall(id, onProgress);
    if (r.ok) this.notifyConfigChanged("拓展卸载");
    return r;
  }

  abstract readonly capabilities: KernelExtensionCapabilities;

  // ===== 子类实现(内核专属:数据源 + 落盘机制) =====

  /** 扫描合并视图(启用 + 禁用),基类负责排序。 */
  protected abstract scan(): KernelExtensionInfo[];
  protected abstract doEnable(id: string): Promise<void>;
  protected abstract doDisable(id: string): Promise<void>;
  protected abstract doInstall(source: string, onProgress: (line: string) => void): Promise<KernelExtensionMutationResult>;
  protected abstract doUninstall(id: string, onProgress: (line: string) => void): Promise<KernelExtensionMutationResult>;

  // ===== 基类机制(helper) =====

  /** 派生 tags:sourceType + protected。 */
  protected deriveTags(sourceType: string, disallowOff?: boolean): string[] {
    return disallowOff ? [sourceType, "protected"] : [sourceType];
  }

  /** 受保护判定:按 id 末段或全 id 匹配保护名单(与 pi isProtected 同语义)。 */
  protected isProtected(id: string): boolean {
    const name = id.split("/").pop() ?? id;
    return this.protectedIds.has(name) || this.protectedIds.has(id);
  }

  /** 排序:disallowOff 优先 + name localeCompare。 */
  protected sortList(items: KernelExtensionInfo[]): KernelExtensionInfo[] {
    return [...items].sort((a, b) => {
      if (Boolean(a.disallowOff) !== Boolean(b.disallowOff)) return a.disallowOff ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  /** 配置变更通知(enable/disable/install/uninstall 完成后调用)。 */
  protected notifyConfigChanged(reason: string): void {
    this.onConfigChanged?.(reason);
  }

  /** 受保护守卫:受保护的拓展禁止 disable/uninstall。 */
  protected assertNotProtected(id: string, action: string): void {
    if (this.isProtected(id)) throw new Error(`拓展 ${id} 受保护,不可${action}`);
  }
}
