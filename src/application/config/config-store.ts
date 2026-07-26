// 插件配置存储 —— application 层,Node 内置 fs 读写 plugins-data/{id}/config.json。
//
// 依据 DESIGN.md:783、docs/modules/04:988、docs/structure/16:753。
// 关键纪律:
// - application 不 import electron(守"application 不依赖 shell")。
//   路径由 shell 注入(构造接受 pluginsDataDir),不在此调 app.getPath。
// - 用 Node 内置 fs(标准库,不绑 shell,structure/16:753 允许)。
// - 内置插件与第三方插件完全平等:同一 ConfigStore、同一目录规则,
//   无 if(builtin) 分支(01-core:1447)。
// - pluginId 白名单校验:防 `..`/绝对路径逃逸(盲审 F2,对齐 04-module:1017 fs 防逃逸)。
// - 写盘失败抛错,不吞错(盲审 F5)。
// - 写用 proper-lockfile 文件锁串行化(防并发写撕裂,文档 12-plugin-commands:786 钉的库);
//   读保持同步(get/all 文档契约是 sync,单进程读安全)。
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";
import type { PluginConfigApi } from "../../domain/context";

/** pluginId 白名单:只允许字母/数字/连字符/下划线/点,防路径逃逸。 */
const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function assertValidPluginId(pluginId: string): void {
  if (!PLUGIN_ID_RE.test(pluginId) || pluginId.includes("..")) {
    throw new Error(`非法 pluginId: ${pluginId}`);
  }
}

/** 单插件配置内存缓存:id → 合并后的 config 快照。 */
interface PluginConfigEntry {
  /** 用户级 config(从 ~/.pi-desktop/plugins-data/{id}/config.json 读) */
  user: Record<string, unknown>;
  /** 项目级 config(从 <cwd>/.pi-desktop/plugins-data/{id}/config.json 读,可空) */
  project: Record<string, unknown>;
}

/**
 * 插件配置存储。构造时给定用户级与项目级根目录(由 shell 注入路径)
 * get/all 同步(从内存态读),set 异步(写盘 + 更新内存态)。
 */
export class ConfigStore {
  private userDir: string;
  private projectDir: string | null;
  private cache = new Map<string, PluginConfigEntry>();
  /** per-pluginId 写队列:串行化同插件的写,避免 proper-lockfile ELOCKED 冲突 + 读脏。 */
  private writeQueues = new Map<string, Promise<void>>();

  constructor(opts: { userDir: string; projectDir: string | null }) {
    this.userDir = opts.userDir;
    this.projectDir = opts.projectDir;
  }

  /** 读单插件合并后的配置(项目级覆盖用户级,同 settings 合并语义)。 */
  get<T>(pluginId: string, key: string): T | undefined {
    assertValidPluginId(pluginId);
    const merged = this.all(pluginId);
    return merged[key] as T | undefined;
  }

  /** 读单插件合并后的全部配置(项目级覆盖用户级)。 */
  all(pluginId: string): Record<string, unknown> {
    assertValidPluginId(pluginId);
    const entry = this.loadEntry(pluginId);
    return { ...entry.user, ...entry.project };
  }

  /** 写单插件配置(默认写用户级;projectScope=true 写项目级)。写盘失败抛错。 */
  async set<T>(pluginId: string, key: string, value: T, projectScope = false): Promise<void> {
    assertValidPluginId(pluginId);
    // 入队:同 pluginId 的写串行化(避免 proper-lockfile ELOCKED + 读脏),不同 pluginId 并行
    const prev = this.writeQueues.get(pluginId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const target = projectScope ? this.projectDir : this.userDir;
      if (!target) throw new Error("项目级配置目录未配置,无法写项目级 config");
      const entry = this.loadEntry(pluginId);
      const scope = projectScope ? entry.project : entry.user;
      scope[key] = value;
      await this.persist(pluginId, target, scope);
    });
    // 失败链不断裂(下次写能继续),但错误冒给调用方
    this.writeQueues.set(pluginId, next.then(() => undefined, () => undefined));
    await next;
  }

  /**
   * 删单插件配置(预留"卸载并清除配置",盲审 F6;文档 04-module:990/DESIGN:1458
   * 说默认保留,只在"卸载并清除"显式调)。删 {id} 整个目录 + 失效缓存。
   */
  delete(pluginId: string, projectScope = false): void {
    assertValidPluginId(pluginId);
    const target = projectScope ? this.projectDir : this.userDir;
    if (!target) return;
    const dir = join(target, pluginId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    this.cache.delete(pluginId);
  }

  /** 绑定到单插件的 PluginConfigApi(对齐圆心契约单参 key,盲审 M2)。 */
  bindPluginConfig(pluginId: string): PluginConfigApi {
    return {
      get: <T>(key: string): T | undefined => this.get<T>(pluginId, key),
      set: <T>(key: string, value: T): Promise<void> => this.set<T>(pluginId, key, value),
      all: (): Record<string, unknown> => this.all(pluginId),
    };
  }

  /** 加载(或从缓存取)单插件 entry。 */
  private loadEntry(pluginId: string): PluginConfigEntry {
    const cached = this.cache.get(pluginId);
    if (cached) return cached;
    const entry: PluginConfigEntry = {
      user: this.readSync(this.userDir, pluginId),
      project: this.projectDir ? this.readSync(this.projectDir, pluginId) : {},
    };
    this.cache.set(pluginId, entry);
    return entry;
  }

  /** 从某根目录读单插件 config.json,不存在返回空对象。损坏记 console.warn(盲审 F10)。 */
  private readSync(rootDir: string, pluginId: string): Record<string, unknown> {
    const file = join(rootDir, pluginId, "config.json");
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch (err) {
      console.warn(`[pi-desktop] config 损坏已忽略并回退默认:${file}`, err);
      return {};
    }
  }

  /** 写某根目录下单插件的 config.json。文件锁串行化(proper-lockfile),失败抛错。 */
  private async persist(pluginId: string, rootDir: string, scope: Record<string, unknown>): Promise<void> {
    const dir = join(rootDir, pluginId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.json");
    // 锁目录而非文件(config.json 首次写时不存在,lock 文件会 ENOENT;锁目录已 mkdir 存在)。
    // proper-lockfile 防多窗口/多写并发撕裂 config.json(文档 12-plugin-commands:786 同库)。
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(dir, { stale: 5000 });
      await writeFile(file, JSON.stringify(scope, null, 2), "utf-8");
    } finally {
      if (release) await release();
    }
  }
}
