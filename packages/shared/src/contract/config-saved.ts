// `system:configFileSaved` 的 payload 形状与**语义派生**（契约单源）。
//
// ## 为什么要有这个模块
//
// 设置页保存一个配置文件后会广播 `system:configFileSaved`，消费方据此"保存即生效"地重读。
// 此前 payload 只有 `{ path }`，于是消费方要自己判断"这个路径是不是我关心的那个文件"——
// `timeline` 的写法是 `payload.path === MODELS_CONFIG_PATH`，而那个常量是
// `"~/.pi/agent/models.json"`：**发布面里写死了某个内核的私有路径**，通用插件靠它做判断。
// 后果是加内核时"保存模型配置后刷新模型清单"这条链对新内核**静默失效**
// （路径不匹配 → 不刷新 → 用户改了模型配置却看不到清单变化，要重启才行），
// 而且没有任何报错提示这件事。
//
// 正确做法：**语义由声明方给出**。设置页手里就有被保存项的贡献声明
// （`kernelModels` / `kernelConfig` / 都不是），它知道"这次保存的是内核模型配置"，
// 不需要消费方拿路径反推。于是 payload 带上 `kind`，消费方只认 `kind`。
//
// 派生函数放在这里（而不是各自写一遍）是为了 §1.3 契约单源：发送方与消费方共用同一份判定，
// 语义不可能漂移；且它是**纯函数**（声明进、kind 出，无 IO），按 §4.5 属内层材料，可裸单测。

/** 被保存的配置属于哪一类。 */
export type ConfigSavedKind =
  /** 内核的模型配置源（manifest 声明 `kernelModels: <kernelId>`）——模型清单要重探。 */
  | "kernelModels"
  /** 内核的原生配置（manifest 声明 `kernelConfig: <kernelId>`）。 */
  | "kernelConfig"
  /** 普通插件配置（壳的分层配置空间里的那些）。 */
  | "pluginConfig";

/** `system:configFileSaved` 的 payload。 */
export interface ConfigSavedPayload {
  /** 被保存的文件路径（保留：日志/调试与"按路径精确匹配"的老消费方仍可用）。 */
  path: string;
  /** 语义分类，由**声明**派生，消费方据此决定要不要重读，不再比对路径字面量。 */
  kind: ConfigSavedKind;
}

/** 从设置项的贡献声明派生 `kind`。
 *
 *  只认**中性契约字段**（`kernelModels` / `kernelConfig`，二者类型都是 `KernelId`），
 *  不认任何内核名、也不认任何路径前缀——所以加第 N 个内核时这里一行都不用改。 */
export function configSavedKind(item: { kernelModels?: string; kernelConfig?: string } | null | undefined): ConfigSavedKind {
  if (!item) return "pluginConfig";
  if (item.kernelModels) return "kernelModels";
  if (item.kernelConfig) return "kernelConfig";
  return "pluginConfig";
}

/** 组装 payload（发送方用；与 `configSavedKind` 同源，避免两处各拼一遍）。 */
export function configSavedPayload(
  path: string,
  item: { kernelModels?: string; kernelConfig?: string } | null | undefined,
): ConfigSavedPayload {
  return { path, kind: configSavedKind(item) };
}
