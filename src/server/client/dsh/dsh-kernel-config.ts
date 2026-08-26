// client/dsh —— dsh 内核原生配置的中性适配器(kernel 配置 TAB 用)。
//
// 把 dsh 的原生形状(~/.dsh/settings.yaml 的命名空间文档)翻译成中性 KernelConfigApi。
// settings.yaml 是「命名空间 → 分节」的文档,其中模型命名空间(llm-deepseek / llm-pi-ai /
// agent-default-model)已由模型 TAB(kernelModels.dsh)收编,本适配器只暴露**非模型**命名空间。
//
// dsh 的字段 schema 在它的运行时(cordis 插件注册的 schemastery schema),不落文件、桌面读不到,
// 所以本适配器 fields() 返回空——壳表单退化成「按值推断类型的通用 JSON 编辑器」,不硬编码 dsh
// 的字段清单(那是 dsh 自己的信息,桌面不该复制)。
//
// 关键语义:set 是「替换非模型命名空间、保留模型命名空间」——get 返回的是非模型子集,
// 若 set 整份写回会把模型命名空间抹掉(settings.yaml 是模型配置的家)。所以在适配器内做
// 非模型命名空间的 reconcile:删掉旧非模型段、并入新值、保留模型段,再整份落盘。
import type { KernelConfigApi, DshConfigApi } from "@my-harness-desktop/shared";

/** dsh settings.yaml 里由模型 TAB 收编的命名空间(本适配器不碰,避免双写)。 */
const DSH_MODEL_NAMESPACES = new Set(["llm-deepseek", "llm-pi-ai", "agent-default-model"]);

/** 取 settings.yaml 的非模型子集(去掉模型命名空间)。 */
function nonModelSection(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (!DSH_MODEL_NAMESPACES.has(k)) out[k] = v;
  }
  return out;
}

/** dsh 配置 → 中性 KernelConfigApi。 */
export function createDshConfigApi(dshConfigSource: DshConfigApi): KernelConfigApi {
  return {
    get: () => Promise.resolve(nonModelSection(dshConfigSource.getSettings())),
    async set(obj) {
      const full = { ...dshConfigSource.getSettings() };
      // 删旧非模型段、并入新值(模型段原样保留)。
      for (const k of Object.keys(full)) {
        if (!DSH_MODEL_NAMESPACES.has(k)) delete full[k];
      }
      Object.assign(full, obj);
      await dshConfigSource.setSettings(full);
      return nonModelSection(dshConfigSource.getSettings());
    },
    // dsh schema 在运行时、桌面读不到 → 空字段清单,表单退化成通用 JSON 编辑器。
    fields: () => Promise.resolve([]),
  };
}
