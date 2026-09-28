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
  // ⚠ 此处曾另有 `update` / `reorder` 两轴（三个内核都声明 false），r46 全仓核实
  //   **零消费者**（UI 与 controller 都不读）——那是死契约面，而且有害：
  //   读到 `{update:false, reorder:false}` 的人会以为 UI 据此做了降级，实际什么也没发生
  //   （与 r25 查出的"声明了没人读的能力轴"同型）。已删除。
  //   要重新加时的纪律：**轴与它的消费者同一批落地**，不加"为将来准备"的轴。
  /** 该内核**能否安装**扩展（r46 新增）。
   *
   *  为什么必须有这一轴：共享的 `KernelExtensionsPage` 对三个内核都渲染「安装扩展」区块，
   *  而 minimal 的内核插件系统第一版根本没落地（`MinimalExtensionSource.install()` 直接
   *  返回 `{ok:false, error:"…不支持安装拓展"}`）。此前 UI 无从得知，用户要填完来源、
   *  点安装、等一轮，才在**事后**看到失败——§7.6 要求的"显式降级（隐藏/置灰 + 说明）"没做到。
   *  更糟的是 `minimal-extension.ts` 的文件头注释还写着「壳据此置灰入口」，
   *  而壳从来没读过 capabilities：**注释描述了一个不存在的行为**。
   *
   *  ⚠ 设为**必填**（不是可选）：可选会让"忘了声明"静默等同于 undefined（判假），
   *  于是新内核接入时默默失去安装入口却没人报错。必填 ⇒ 漏声明 = TS2739 编译错，
   *  必须当场表态（与 r38 分页 label、r44 developerRole 同一手法）。 */
  install: boolean;
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
