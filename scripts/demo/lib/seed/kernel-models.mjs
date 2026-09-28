// 内核模型配置播种（dsh / minimal）—— 让剧本能在隔离 HOME 里造出「该内核有模型」的真实状态。
//
// 为什么需要它：`setupBaseline` 只**复制**真实 `~/.dsh` 的三件套（settings.yaml / cordis.yml /
// .credentials.yaml），而真实配置里通常没有 provider ⇒ dsh 的模型页是**空的**。
// 空页面会让所有「某控件不存在」的断言恒真（r44 实踩：dsh/minimal 都报 devRole=false，
// 看着像验证通过，其实那两个页面根本没有模型行）。要验能力门控，必须先有模型数据。
//
// ⚠ YAML 形状不是手猜的：由 `DshConfigSource.setProvider()` 真实写出的产物派生
//   （`llm-pi-ai.providers.<id>` + `apiKeyEnv` 引用；明文 key 落 `<dshHome>/.credentials.yaml`
//   的 `refs`，settings.yaml 里**只存引用**）。改形状时请重新用真实写入方导一次。
//
// 用法：
//   import { seedDshModels } from "./lib/seed/dsh-models.mjs";
//   seedDshModels(home);                       // 默认一个 provider + 两个模型
//   seedDshModels(home, { models: [...] });    // 自定义
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

/** 默认播种内容：一个 provider、两个模型（够渲染出模型行与 per-model 控件即可）。 */
export const DEFAULT_DSH_MODELS = [
  { id: "seed-model-a", name: "Seed Model A", contextWindow: 64000, maxTokens: 4096 },
  { id: "seed-model-b", name: "Seed Model B", contextWindow: 32000 },
];

/**
 * 往 `<home>/.dsh/settings.yaml` 合并一个 provider，并把 apiKey 写进凭证库。
 * @returns {{ settingsPath: string, providerId: string, models: object[], mergedIntoExisting: boolean }}
 */
export function seedDshModels(home, { providerId = "audit-seed", displayName = "Audit Seed", api = "openai-completions", baseURL = "https://seed.invalid/v1", apiKey = "sk-seed-not-real", models = DEFAULT_DSH_MODELS } = {}) {
  const dshDir = join(home, ".dsh");
  mkdirSync(dshDir, { recursive: true });
  const settingsPath = join(dshDir, "settings.yaml");
  const credPath = join(dshDir, ".credentials.yaml");

  // 读现有内容（setupBaseline 可能已从真实 HOME 复制过来）——**合并**而不是覆盖，
  // 否则会毁掉用户真实配置里已有的其它命名空间。
  const existing = existsSync(settingsPath) ? (parse(readFileSync(settingsPath, "utf-8")) ?? {}) : {};
  const mergedIntoExisting = Object.keys(existing).length > 0;
  const apiKeyEnv = `${providerId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_API_KEY`;
  const next = {
    ...existing,
    "llm-pi-ai": {
      ...(existing["llm-pi-ai"] ?? {}),
      providers: {
        ...((existing["llm-pi-ai"] ?? {}).providers ?? {}),
        [providerId]: { apiKeyEnv, displayName, api, baseURL, models },
      },
    },
  };
  writeFileSync(settingsPath, stringify(next));

  const credExisting = existsSync(credPath) ? (parse(readFileSync(credPath, "utf-8")) ?? {}) : {};
  writeFileSync(credPath, stringify({
    version: credExisting.version ?? 1,
    refs: { ...(credExisting.refs ?? {}), [apiKeyEnv]: apiKey },
  }));

  return { settingsPath, providerId, models, mergedIntoExisting };
}

/** minimal 的默认播种内容（形状来自 `MinimalModelsDocument`：providers + default）。 */
export const DEFAULT_MINIMAL_MODELS = [
  { id: "seed-echo", name: "Seed Echo" },
  { id: "seed-echo-2", name: "Seed Echo 2" },
];

/**
 * 往 `<home>/.minimal/agent/models.json` 写一个 provider（minimal 自己的格式）。
 * ⚠ 形状不是手猜的：取自 `src/server/kernel/minimal/manager/minimal-config-source.ts`
 *   的 `MinimalModelsDocument`（`{ providers: [{id, baseURL, models:[{id,name?}]}], default }`），
 *   且 provider 记录**不含 apiKey**（密钥在 `.credentials.json`，播种不需要真密钥）。
 */
export function seedMinimalModels(home, { providerId = "audit-seed", baseURL = "https://seed.invalid/v1", models = DEFAULT_MINIMAL_MODELS } = {}) {
  const agentDir = join(home, ".minimal", "agent");
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = join(agentDir, "models.json");
  const doc = { providers: [{ id: providerId, baseURL, models }], default: null };
  writeFileSync(modelsPath, JSON.stringify(doc, null, 2));
  return { modelsPath, providerId, models };
}
