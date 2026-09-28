// pi 内核 settings.json 的内部契约 —— `PiSettingsApi` + `SchemaField`。
//
// **为什么住在 pi 自己的目录里，而不是圆心**（根因，勿回退）：
// 这两个类型此前声明在 `packages/shared/src/domain/context.ts`，即**圆心里定义了 pi 专属形状**。
// 实测它们的真实消费者**全部在 `src/server/kernel/pi/` 内部**：
//   · `model/pi-settings-store.ts` 解析 pi 的 `settings.json` 与其 `.d.ts`，产出 `SchemaField[]`；
//   · `manager/pi-kernel-config.ts` 把 `SchemaField` 翻成**中性** `KernelConfigField`，
//     再包成中性 `KernelConfigApi`（`get`/`set`/`fields()`）交给壳；
//   · `plugin.ts` 构造 `PiSettingsApi` 实现。
// 壳侧唯一的 import（`application/context/main-context.ts`）经核实是**死 import**（零使用）。
//
// 关键区分：`SchemaField` 是 **pi 的内部表示**（"解析内核 .d.ts 得到的字段"——dsh 不解析 .d.ts），
// `KernelConfigField` 才是**中性契约**（圆心定义、三个内核各自实现 `KernelConfigApi.fields()`
// 时产出）。把内部表示放圆心，等于让圆心认识"某个内核怎么解析自己的配置文件"，
// 违反 §4.2「圆心 = 拿掉所有会变的东西之后还剩什么」：换掉 pi，这两个类型就该消失。
//
// 依赖方向：本文件零 import（纯类型），只被同内核的文件引用。

/** pi settings schema 字段（解析 pi 的 `.d.ts` 得到）。
 *  形状是"key + 通用数据型 + 枚举值"——通用数据型而非 UI 控件型，
 *  翻译成中性 `KernelConfigField` 时由壳补 label/description/group 的 i18n key。 */
export interface SchemaField {
  key: string;
  /** 通用数据型（不是 UI 控件型）：boolean/number/string/string[]/enum/object。 */
  type: "boolean" | "number" | "string" | "string[]" | "enum" | "object";
  /** enum 型的枚举字面值（从 .d.ts 的字面量联合/外部类型别名解析）。 */
  enumValues?: string[];
  /** 与 `enumValues` **同序**的值种类；缺省（不声明）= 全部按 `"string"` 处理。
   *  只在**混合字面量联合**（如 `boolean | "auto"`）时才声明——纯字符串联合不写它，
   *  保持既有形状，也就不影响任何既有消费方。语义与用途见圆心 `KernelConfigField.options.kind`。 */
  enumValueKinds?: ("string" | "boolean" | "number")[];
}

/** pi 内核 settings.json 的读写面（pi 专属存储）。
 *  get 同步读整份、set 深合并写、schema 解析 pi 的 .d.ts 拿字段清单。
 *  壳不 import 本接口——壳只认中性 `KernelConfigApi`（见 `pi-kernel-config.ts` 的翻译）。 */
export interface PiSettingsApi {
  get(): Record<string, unknown>;
  set(patch: Record<string, unknown>): Promise<void>;
  /** 全量替换写回（删除字段随之消失；配置表单 set 用，深合并会保留已删字段）。 */
  replace(obj: Record<string, unknown>): Promise<void>;
  schema(): Promise<SchemaField[]>;
}
