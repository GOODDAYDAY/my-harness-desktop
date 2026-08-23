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
import type { ModelsConfig } from "./models-config";
import { withDirLock } from "../../core/application/config/config-file";
// re-export:既有调用方(application 内部)从本模块拿类型也行,但契约单源在 client/pi。
export type { ModelsConfig, ProviderConfig, ModelConfig } from "./models-config";

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
    await withDirLock(this.agentDir, () => writeFile(file, JSON.stringify(config, null, 2), "utf-8"));
  }
}
