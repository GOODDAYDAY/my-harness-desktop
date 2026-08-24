// client/dsh —— dsh 内核原生配置的中性适配器(kernel 配置 TAB 用)。
//
// 把 dsh 的原生形状(~/.dsh/settings.yaml 的命名空间文档)翻译成中性 KernelConfigApi。
// settings.yaml 是「命名空间 → 分节」的文档,其中模型命名空间(llm-deepseek / llm-pi-ai /
// agent-default-model)已由模型 TAB(kernelModels.dsh)收编,本适配器只暴露**非模型**命名空间
// (ui-onboarding / agent-presets / permission 等),避免与模型 TAB 重复编辑。
//
// 关键语义:set 是「替换非模型命名空间、保留模型命名空间」——get 返回的是非模型子集,
// 若 set 整份写回会把模型命名空间抹掉(settings.yaml 是模型配置的家)。所以在适配器内做
// 非模型命名空间的 reconcile:删掉旧非模型段、并入新值、保留模型段,再整份落盘。
import type { KernelConfigApi, KernelConfigField, DshConfigApi } from "../../core/domain/context";

/** dsh settings.yaml 里由模型 TAB 收编的命名空间(本适配器不碰,避免双写)。 */
const DSH_MODEL_NAMESPACES = new Set(["llm-deepseek", "llm-pi-ai", "agent-default-model"]);

/** i18n key 派生(label/description/group 都是 key,文案由 dsh-manager 语言资源贡献)。 */
const labelKey = (key: string): string => `dsh.fields.${key}`;
const descKey = (key: string): string => `dsh.fieldDescs.${key}`;
const groupKey = (slug: string): string => `dsh.groups.${slug}`;

/** dsh 非模型命名空间的字段描述(仅列已知段;settings.yaml 里其它非模型段由表单兜底渲染为 JSON)。 */
const DSH_CONFIG_FIELDS: KernelConfigField[] = [
  {
    key: "ui-onboarding.welcomeNoticeVersion",
    type: "string",
    label: labelKey("ui-onboarding.welcomeNoticeVersion"),
    description: descKey("ui-onboarding.welcomeNoticeVersion"),
    group: groupKey("ui"),
  },
  {
    key: "agent-presets.default",
    type: "string",
    label: labelKey("agent-presets.default"),
    description: descKey("agent-presets.default"),
    group: groupKey("agent"),
  },
  {
    key: "permission.defaultPreset",
    type: "string",
    label: labelKey("permission.defaultPreset"),
    description: descKey("permission.defaultPreset"),
    group: groupKey("ui"),
  },
];

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
    schema: () => Promise.resolve(DSH_CONFIG_FIELDS),
  };
}
