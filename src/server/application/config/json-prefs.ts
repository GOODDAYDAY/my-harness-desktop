// 简单 JSON 键值偏好(web-service §5.2 #6)——替代 electron-store 的桌面偏好持久化。
// 依赖只向内:用 config-file 的 readJsonFile/writeJsonFile 原语,不 import electron。
// 这是「配置读写(旧)」原语之上的薄封装,get/set/store 形状对齐 electron-store,迁移零改动。

import { readJsonFile, writeJsonFile } from "./config-file";

/** 简单 JSON 键值偏好。defaults 兜底未写入的键,set 立即写盘(与 electron-store 同语义)。 */
export class JsonPrefsStore<T extends object> {
  private data: T;

  constructor(private readonly path: string, defaults: T) {
    const raw = readJsonFile(path) as Partial<T>;
    this.data = { ...defaults, ...raw };
  }

  get<K extends keyof T>(key: K): T[K] {
    return this.data[key];
  }

  set<K extends keyof T>(key: K, value: T[K]): void {
    this.data[key] = value;
    void writeJsonFile(this.path, this.data as unknown as Record<string, unknown>).catch((e) => console.error("[json-prefs] 写盘失败:", e));
  }

  /** 删一个键并立即写盘（一次性迁移用：迁完要把旧键**摘掉**，不是留一个空壳在盘上）。 */
  remove<K extends keyof T>(key: K): void {
    if (!(key in this.data)) return;
    delete this.data[key];
    void writeJsonFile(this.path, this.data as unknown as Record<string, unknown>).catch((e) => console.error("[json-prefs] 写盘失败:", e));
  }

  // ── 动态键（**不在 T 里枚举**的键）───────────────────────────────────────────
  //
  // 为什么需要：`KernelPluginContext.prefs` 的契约形状是 `get<T>(key: string)`（圆心
  // `kernel-plugin.ts`，注释写明「核心不硬编码 key 名，key 由插件自定」），而上面那组
  // `get<K extends keyof T>` 要求键必须在 T 里。两者对不上，装配点就只能 cast
  // （`key as keyof Prefs`）——于是内核自定义的键被迫**枚举进 application 层的 Prefs**，
  // 变成 `customCliDir` / `dshCustomCliDir` 这种按内核名分字段（§6.3 检验④ 禁的形态：
  // 加第四个内核就要改中层类型）。
  //
  // 动态键这组方法让"插件自定的键"有正式入口：不进 T、不需要 cast、照样持久化
  // （`data` 是 `{...defaults, ...raw}`，写盘整份 dump，未知键天然保留）。
  // 强类型那组仍然只服务**壳自己拥有**的偏好。
  /** 读一个不在 T 里的键（插件/内核自定）。未写入过返回 undefined。 */
  getDynamic(key: string): unknown {
    return (this.data as Record<string, unknown>)[key];
  }

  /** 写一个不在 T 里的键并立即落盘。 */
  setDynamic(key: string, value: unknown): void {
    (this.data as Record<string, unknown>)[key] = value;
    void writeJsonFile(this.path, this.data as unknown as Record<string, unknown>).catch((e) => console.error("[json-prefs] 写盘失败:", e));
  }

  /** 删一个不在 T 里的键并立即落盘（键不存在则不写盘）。 */
  removeDynamic(key: string): void {
    if (!(key in (this.data as Record<string, unknown>))) return;
    delete (this.data as Record<string, unknown>)[key];
    void writeJsonFile(this.path, this.data as unknown as Record<string, unknown>).catch((e) => console.error("[json-prefs] 写盘失败:", e));
  }

  /** 原始对象快照(对齐 electron-store 的 store;注意不是 live proxy,改它需经 set)。 */
  get store(): T {
    return this.data;
  }
}
