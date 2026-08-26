// client/pi —— pi 内核原生配置的中性适配器(kernel 配置 TAB 用)。
//
// 字段名 + 类型从内核来:parseSettingsSchema 解析 pi 自己的 settings-manager.d.ts(含 import
// 的外部类型别名),把 Settings 接口展平成字段清单 + 通用数据型 + 枚举值。适配器不硬编码
// 字段清单——pi 升级加字段,自动跟着 .d.ts 变。
// label/description/group/选项文案 是**壳的本地化 i18n key**,由共享表单 t() 解析;适配器只
// 从字段名派生 key,不写死文案。
// 依赖只向内:client 只 import core/domain(契约)+ 同层 pi-settings-store。
import { join } from "node:path";
import type { KernelConfigApi, KernelConfigField, PiSettingsApi } from "@my-harness-desktop/shared";
import { parseSettingsSchema, type SchemaField } from "../model/pi-settings-store";

/** i18n key 派生(文案由 pi-manager 语言资源贡献)。 */
const labelKey = (key: string): string => `kernel.fields.${key}`;
const descKey = (key: string): string => `kernel.fieldDescs.${key}`;
const groupKey = (top: string): string => `kernel.groups.${top}`;
const optionKey = (field: string, value: string): string => `kernel.options.${field}.${value}`;

/** 内核 .d.ts 的 SchemaField → 中性 KernelConfigField(补壳 i18n key)。 */
function toField(f: SchemaField): KernelConfigField {
  const top = f.key.split(".")[0];
  return {
    key: f.key,
    type: f.type,
    label: labelKey(f.key),
    description: descKey(f.key),
    options: f.enumValues?.map((v) => ({ value: v, label: optionKey(f.key, v) })),
    group: f.key.includes(".") ? groupKey(top) : groupKey("general"),
  };
}

/** pi 配置 → 中性 KernelConfigApi。 */
export function createPiConfigApi(
  piSettings: PiSettingsApi,
  opts: { installDir: string | null; homeDir: string },
): KernelConfigApi {
  const resolvePaths = [
    process.cwd(),
    join(opts.homeDir, ".npm-global"),
    "/usr/local/lib",
  ];

  return {
    get: () => Promise.resolve(piSettings.get()),
    async set(obj) {
      await piSettings.replace(obj);
      return piSettings.get();
    },
    fields: () => Promise.resolve(parseSettingsSchema(opts.installDir, resolvePaths).map(toField)),
  };
}
