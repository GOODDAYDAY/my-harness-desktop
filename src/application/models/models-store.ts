// pi 底座模型配置存储 —— application 层,Node fs 读写 ~/.pi/agent/models.json。
//
// ⚠ 偏离文档(标注):同 pi-settings-store,底座 models.json 是公开标准契约,
// 桌面端写标准字段不算重复领域知识。用户明确要管理 pi 模型配置。
//
// 关键纪律(同 pi-settings-store):
// - application 不 import electron(路径由 shell 注入)
// - Node 内置 fs + proper-lockfile 文件锁
// - 读整份 models.json、写整份替换(models.json 是完整树,不像 settings 深合并)
// - 路径 ~/.pi/agent/models.json(底座标准)
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";

/** pi 底座 models.json 结构(宽松,实际字段见底座 config.ts)。 */
export interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
}
export interface ProviderConfig {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: ModelConfig[];
}
export interface ModelConfig {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export class ModelsStore {
  private agentDir: string;
  private get filePath(): string {
    return join(this.agentDir, "models.json");
  }

  constructor(opts: { agentDir: string }) {
    this.agentDir = opts.agentDir;
  }

  /** 读整份 models.json。文件不存在/损坏返回空 providers。 */
  get(): ModelsConfig {
    const file = this.filePath;
    if (!existsSync(file)) return { providers: {} };
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8")) as ModelsConfig;
      return { providers: raw.providers ?? {} };
    } catch (err) {
      console.warn(`[models] models.json 损坏已忽略:${file}`, err);
      return { providers: {} };
    }
  }

  /** 整份写入(覆盖)。写盘失败抛错。 */
  async set(config: ModelsConfig): Promise<void> {
    const file = this.filePath;
    if (!existsSync(this.agentDir)) mkdirSync(this.agentDir, { recursive: true });
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(this.agentDir, { stale: 5000 });
      await writeFile(file, JSON.stringify(config, null, 2), "utf-8");
    } finally {
      if (release) await release();
    }
  }
}
