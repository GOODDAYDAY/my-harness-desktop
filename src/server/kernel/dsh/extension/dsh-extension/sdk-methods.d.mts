// sdk-methods.mjs 的类型声明 —— 该文件是给 dsh 内核（cordis）跑的纯 JS 插件代码，
// 不能改成 .ts（内核侧不编译 TS）；这份 .d.mts 只为让**壳侧测试**能带类型地 import 它。
//
// 随 cpSync 同步进 ~/.dsh/.my-harness-desktop-plugins/ 时它是惰性的（node 不加载 .d.mts），
// 对内核运行零影响。

/** 中立条目（seed 输入的最小形状）。 */
export interface SeedEntryLike {
  neutralEntryId?: string;
  message?: { role?: string; content?: unknown } | null;
}

/** dsh 会话对象的最小形状（只声明补面用到的面）。 */
export interface SessionLike {
  events?: Array<{ type: string; data?: { meta?: unknown } }>;
}

/** 原生 handleRequest（用于无副作用地静态读出方法面）。 */
export type NativeHandleRequest = (method: string, params?: unknown) => unknown;

/** 中立 content → dsh content blocks。 */
export function contentToBlocks(content: unknown): unknown[];

/** 中立条目序列 → turn 封闭的 dsh seed 事件序列（纯函数，与上游 entriesToSeedEvents 同口径）。 */
export function entriesToSeedEvents(
  entries: SeedEntryLike[] | undefined,
  makeUser: (input: { content: unknown }) => unknown,
  makeAssistant: (input: { content: unknown; source?: unknown }) => unknown,
  source: { provider: string; model: string },
): unknown[];

/** 折叠 session/meta 事件成一份元数据（merge 语义，后写的同名键胜出）。 */
export function latestMeta(session: SessionLike): Record<string, unknown>;

/** 无副作用地读出原生 handleRequest 实际支持的方法名集合（静态读 switch 源码，不试调）。 */
export function nativeMethodSet(nativeHandleRequest: unknown): Set<string>;

/** 补面方法表的一项。 */
export interface SupplementMethodDef {
  handler: (this: unknown, params: any, deps: { helpers: Record<string, any>; native: NativeHandleRequest }) => unknown;
  /** 仅在特定参数形态下接管，其余让位原生（如 session/prompt 只在带 images 时接管）。 */
  preferNativeWhen?: (params: any) => boolean;
  /** 原生已提供该方法时让位原生（补缺类的退役开关）。 */
  preferNative?: boolean;
}

/** 桌面所需的 dsh session/* 方法补面表。 */
export const SDK_METHOD_SUPPLEMENT: Record<string, SupplementMethodDef>;

/** 解析 dsh 包在 CLI 运行时闭包里的那份副本（双副本陷阱的正解）。 */
export function resolveRuntimeModule(pkg: string): Promise<{ url: string; ns: Record<string, any> } | null>;

/** 取出所有需要 patch 的 HarnessSdkJsonRpcServer 类（去重后的全部副本）。 */
export function resolveServerClasses(): Promise<unknown[]>;

/** 取运行时闭包里的纯工厂/常量。 */
export function resolveRuntimeHelpers(): Promise<Record<string, any>>;

/** 把补面方法表装到所有 HarnessSdkJsonRpcServer 副本上（幂等）。返回实际 patch 的副本数。 */
export function installSdkMethodSupplement(extra?: Record<string, SupplementMethodDef>): Promise<number>;

/** session/meta 事件类型补面（幂等，用运行时闭包那份集合）。 */
export function supplementKnownSessionEventTypes(): Promise<boolean>;
