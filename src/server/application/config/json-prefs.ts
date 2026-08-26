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

  /** 原始对象快照(对齐 electron-store 的 store;注意不是 live proxy,改它需经 set)。 */
  get store(): T {
    return this.data;
  }
}
