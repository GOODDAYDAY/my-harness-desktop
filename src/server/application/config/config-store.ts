// 插件配置存储 —— application 层,统一项目级配置通道(docs/design/unified-project-config.md)。
//
// 默认姿态:一切插件配置 = 项目级 diff + 全局兜底。
// - 路径约定:一个插件一个文件 —— 项目级 <cwd>/.my-harness-desktop/config/{pluginId}.json,
//   全局层 {userDir}/{pluginId}.json(即 ~/.my-harness-desktop/config/)。
// - 读:顶层 key 浅合并 {...全局, ...项目级};项目级文件只存 diff,全局更新未覆盖的 key 项目自动享受。
// - 写:默认写项目级(无项目时全局层是唯一的家);写全局必须显式 scope:"global"。
// - getScope:读单层原始快照(并集型数据如 notes 需要区分层,覆盖型配置用 all 即可)。
//
// 关键纪律:
// - application 不 import electron:userDir/getProjectDir 由 bootstrap 注入
//   (getProjectDir 动态解析当前项目,切项目不用清缓存——缓存 key 含 projectDir 维度)。
// - 内置插件与第三方插件完全平等:同一 ConfigStore、同一目录规则,无 if(builtin) 分支。
// - pluginId 白名单校验:防 `..`/绝对路径逃逸(路径由框架按 pluginId 推导,插件不碰路径)。
// - 写盘失败抛错,不吞错;写用 withDirLock 目录锁串行化 + per-file 写队列(防 ELOCKED + 读脏)。
// - 懒迁移:旧路径 {userDir}/plugins-data/{id}/config.json 存在且新路径不存在时,首次读搬到新位置。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginConfigApi } from "@my-harness-desktop/shared";
import { withDirLock } from "../config/config-file";

/** pluginId 白名单:只允许字母/数字/连字符/下划线/点,防路径逃逸。 */
const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function assertValidPluginId(pluginId: string): void {
  if (!PLUGIN_ID_RE.test(pluginId) || pluginId.includes("..")) {
    throw new Error(`非法 pluginId: ${pluginId}`);
  }
}

/** 配置写目标层:project = 项目级 diff 层(默认),global = 全局兜底层。 */
export type ConfigScope = "project" | "global";

/** 单插件两层配置内存缓存entry:两层各自从磁盘读的原始快照。 */
interface PluginConfigEntry {
  /** 全局层({userDir}/{pluginId}.json) */
  user: Record<string, unknown>;
  /** 项目级(<cwd>/.my-harness-desktop/config/{pluginId}.json,无项目时为空) */
  project: Record<string, unknown>;
}

/**
 * 统一项目级配置通道。get/all 同步(从内存态读),set 异步(写盘 + 更新内存态)。
 * 项目级目录经 getProjectDir 动态解析——当前项目切换时下一次读写自动落新项目的层,
 * 缓存按 projectDir 分 key,不同项目的 entry 自然隔离、不用清。
 */
export class ConfigStore {
  private userDir: string;
  private getProjectDir: () => string | null;
  private cache = new Map<string, PluginConfigEntry>();
  /** per-file 写队列:串行化同目标文件的写,避免 proper-lockfile ELOCKED 冲突 + 读脏。 */
  private writeQueues = new Map<string, Promise<void>>();

  constructor(opts: { userDir: string; getProjectDir: () => string | null }) {
    this.userDir = opts.userDir;
    this.getProjectDir = opts.getProjectDir;
  }

  /** 读单插件合并后的配置(项目级覆盖全局层,顶层 key 浅合并)。 */
  get<T>(pluginId: string, key: string): T | undefined {
    assertValidPluginId(pluginId);
    const merged = this.all(pluginId);
    return merged[key] as T | undefined;
  }

  /** 读单插件合并后的全部配置(项目级覆盖全局层)。 */
  all(pluginId: string): Record<string, unknown> {
    assertValidPluginId(pluginId);
    const entry = this.loadEntry(pluginId);
    return { ...entry.user, ...entry.project };
  }

  /** 读单插件某一层的原始快照(不合并——并集型数据需要区分层时用)。 */
  getScope(pluginId: string, scope: ConfigScope): Record<string, unknown> {
    assertValidPluginId(pluginId);
    const entry = this.loadEntry(pluginId);
    return scope === "project" ? { ...entry.project } : { ...entry.user };
  }

  /**
   * 写单插件配置。默认写项目级(无项目时落全局——全局层此时是唯一的家);
   * scope:"global" 显式写全局(天然全局的数据用,如 recentCwds)。
   * value === undefined 时从目标层移除该 key(该 key 回落另一层/消失)。
   * 写盘失败抛错。
   */
  async set<T>(pluginId: string, key: string, value: T, opts?: { scope?: ConfigScope }): Promise<void> {
    assertValidPluginId(pluginId);
    const projectDir = this.getProjectDir();
    const targetDir = opts?.scope === "global" ? this.userDir : (projectDir ?? this.userDir);
    const scopeKey: ConfigScope = targetDir === this.userDir ? "global" : "project";
    // 入队:同目标文件串行写(队列 key 含目标目录——同插件跨层写不互斥)
    const queueKey = `${targetDir}:${pluginId}`;
    const prev = this.writeQueues.get(queueKey) ?? Promise.resolve();
    const next = prev.then(async () => {
      const entry = this.loadEntry(pluginId);
      const layer = scopeKey === "project" ? entry.project : entry.user;
      if (value === undefined) delete layer[key];
      else layer[key] = value;
      await this.persist(pluginId, targetDir, layer);
    });
    // 失败链不断裂(下次写能继续),但错误冒给调用方
    this.writeQueues.set(queueKey, next.then(() => undefined, () => undefined));
    await next;
  }

  /**
   * 删单插件全部配置(两层文件都删 + 失效缓存)。
   * 预留"卸载并清除配置":默认保留,只在"卸载并清除"显式调。
   */
  delete(pluginId: string): void {
    assertValidPluginId(pluginId);
    for (const dir of [this.userDir, this.getProjectDir()]) {
      if (!dir) continue;
      const file = join(dir, `${pluginId}.json`);
      if (existsSync(file)) unlinkSync(file);
    }
    for (const key of [...this.cache.keys()]) {
      if (key.endsWith(`:${pluginId}`)) this.cache.delete(key);
    }
  }

  /** 绑定到单插件的 PluginConfigApi(对齐圆心契约;get/all 经 IPC 异步,内存读包装为 Promise)。 */
  bindPluginConfig(pluginId: string): PluginConfigApi {
    return {
      get: <T>(key: string): Promise<T | undefined> => Promise.resolve(this.get<T>(pluginId, key)),
      set: <T>(key: string, value: T, opts?: { scope?: ConfigScope }): Promise<void> =>
        this.set<T>(pluginId, key, value, opts),
      all: (): Promise<Record<string, unknown>> => Promise.resolve(this.all(pluginId)),
      getScope: (scope: ConfigScope): Promise<Record<string, unknown>> =>
        Promise.resolve(this.getScope(pluginId, scope)),
    };
  }

  /** 加载(或从缓存取)单插件 entry。缓存 key 含当前 projectDir——切项目自然隔离。 */
  private loadEntry(pluginId: string): PluginConfigEntry {
    const projectDir = this.getProjectDir();
    const cacheKey = `${projectDir ?? "<global>"}:${pluginId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    this.migrateLegacy(pluginId);
    const entry: PluginConfigEntry = {
      user: this.readSync(this.userDir, pluginId),
      project: projectDir ? this.readSync(projectDir, pluginId) : {},
    };
    this.cache.set(cacheKey, entry);
    return entry;
  }

  /**
   * 懒迁移(一次性):旧约定 {userDir}/plugins-data/{id}/config.json 存在且新路径
   * {userDir}/{id}.json 不存在时,整体搬到新位置(旧数据本来就是全局语义)。
   * 搬迁失败不阻塞——保留旧文件,记 warn,按空配置继续(下次 set 在新位置重建)。
   */
  private migrateLegacy(pluginId: string): void {
    const legacyFile = join(this.userDir, "plugins-data", pluginId, "config.json");
    const newFile = join(this.userDir, `${pluginId}.json`);
    if (!existsSync(legacyFile) || existsSync(newFile)) return;
    try {
      renameSync(legacyFile, newFile);
      // 旧目录空了则顺手拆掉(plugins-data/{id}/ → plugins-data/ 逐级清,非空目录留着)
      rmSync(join(this.userDir, "plugins-data", pluginId), { recursive: true, force: true });
    } catch (err) {
      console.warn(`[my-harness-desktop] 配置懒迁移失败,保留旧文件:${legacyFile}`, err);
    }
  }

  /** 从某根目录读单插件 {pluginId}.json,不存在返回空对象。损坏记 console.warn 返回空。 */
  private readSync(rootDir: string, pluginId: string): Record<string, unknown> {
    const file = join(rootDir, `${pluginId}.json`);
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch (err) {
      console.warn(`[my-harness-desktop] config 损坏已忽略并回退默认:${file}`, err);
      return {};
    }
  }

  /** 写某根目录下单插件的 {pluginId}.json。目录锁串行化(withDirLock),失败抛错。 */
  private async persist(pluginId: string, rootDir: string, scope: Record<string, unknown>): Promise<void> {
    const dir = rootDir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, `${pluginId}.json`);
    await withDirLock(dir, () => writeFile(file, JSON.stringify(scope, null, 2), "utf-8"));
  }
}
