// minimal 模型面 —— KernelModelSource(合流清单) + KernelModelsApi(设置页模型 TAB)。
//
// 依据 docs/design/minimal-kernel.md §4.9 / §7.6。ModelSource 从 minimal 自己的模型配置
// (models.json)读清单,与 CLI 的模型客户端(minimal-model.mjs)同源——模型下拉和内核本体
// 不脱节(曾漂移:ModelSource 交写死的固定模型,CLI 却读真配置)。ModelsApi 第一版仍是诚实桩
// (设置页 CRUD 暂不接真存储),readConfig/list/getDefault 读真配置,set/remove/rename 显式降级。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { KernelModelSource, KernelModelsApi, ModelInfo, NeutralProvider, NeutralDefaultModel, KernelModelConfig } from "@my-harness-desktop/shared";

/** minimal 模型配置(models.json,§4.9.1):providers + default。读取失败/缺失返回 null。 */
function readModelsConfig(agentDir: string): { providers: { id: string; models: { id: string; name?: string }[] }[]; default: { provider: string; model: string } | null } | null {
  const p = join(agentDir, "models.json");
  if (!existsSync(p)) return null;
  try {
    const cfg = JSON.parse(readFileSync(p, "utf-8"));
    return { providers: Array.isArray(cfg.providers) ? cfg.providers : [], default: cfg.default ?? null };
  } catch {
    return null;
  }
}

/** minimal 的模型源:会话流模型下拉合流用,读真 models.json;未配置时回落 echo 占位模型。 */
export class MinimalModelSource implements KernelModelSource {
  constructor(private readonly agentDir: string) {}

  listModels(): ModelInfo[] {
    const config = readModelsConfig(this.agentDir);
    if (!config) {
      return [{ kernel: "minimal", provider: "minimal", id: "echo", name: "Minimal Echo" }];
    }
    return config.providers.flatMap((p) => p.models.map((m) => ({
      kernel: "minimal" as const, provider: p.id, id: m.id, name: m.name ?? m.id,
    })));
  }
}

/** minimal 的模型配置 API(设置页模型 TAB)。read 面读真配置,写面诚实桩(显式降级)。 */
export class MinimalModelsApi implements KernelModelsApi {
  constructor(private readonly agentDir: string) {}

  list(): Promise<NeutralProvider[]> {
    const config = readModelsConfig(this.agentDir);
    return Promise.resolve(config?.providers.map((p) => ({
      id: p.id,
      models: p.models.map((m) => ({ id: m.id, name: m.name ?? m.id })),
    })) ?? []);
  }

  set(_provider: string, _detail: Omit<NeutralProvider, "id">): Promise<NeutralProvider[]> {
    return Promise.resolve([]);
  }

  remove(_provider: string): Promise<NeutralProvider[]> {
    return Promise.resolve([]);
  }

  rename(_oldId: string, _newId: string): Promise<NeutralProvider[]> {
    return Promise.resolve([]);
  }

  getDefault(): Promise<NeutralDefaultModel | null> {
    const config = readModelsConfig(this.agentDir);
    return Promise.resolve(config?.default ?? null);
  }

  setDefault(_sel: NeutralDefaultModel): Promise<NeutralDefaultModel | null> {
    return Promise.resolve(null);
  }

  test(_cwd: string, _provider: string, _modelId: string): Promise<{ ok: boolean; error?: string }> {
    return Promise.resolve({ ok: false, error: "minimal 内核暂不支持模型连通性测试" });
  }

  readConfig(): Promise<KernelModelConfig> {
    const config = readModelsConfig(this.agentDir);
    return Promise.resolve({
      providers: config?.providers.map((p) => ({ id: p.id, models: p.models.map((m) => ({ id: m.id, name: m.name ?? m.id })) })) ?? [],
      default: config?.default ?? null,
    });
  }

  saveConfig(_config: KernelModelConfig): Promise<KernelModelConfig> {
    return Promise.resolve({ providers: [], default: null });
  }
}
