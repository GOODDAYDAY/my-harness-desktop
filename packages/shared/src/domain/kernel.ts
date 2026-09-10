// 圆心:内核身份单源 —— kernel.ts 只放「内核标识」这个零依赖原子。
//
// 依据 docs/design/kernel-plugin.md。内核身份已去字面量化(§kernel-plugin §1):KernelId 是
// 不透明 string,内核 id 由各内核插件在 plugin.json/工厂里自行声明,核心不硬编码任何具体内核名。
// 内核清单由 KernelRegistry 运行时驱动(替代已删除的 KERNEL_IDS 字面量数组)。加内核 = 写插件
// + 注册,本文件零改动——「全仓唯一能出现 pi|dsh 字面量」的历史纪律已随插件化废止。
//
// 本文件零依赖:不 import 任何 domain 内外的类型,是圆心最内层的原子。

/** 内核标识(不透明字符串)——内核 id 由内核插件声明,核心不硬编码任何具体内核名。
 *  会话头、模型清单、后端工厂、跨内核切换共用这一份。加内核 = 写插件 + 注册,此处零改动。 */
export type KernelId = string;

/** 内核身份标(logo)的序列化形态——每个内核在自己的适配器(client/{kernel})声明这份
 *  SVG 数据,壳只做通用渲染,不硬编码任何内核的 logo path(机制与内容分离)。
 *  用数据而非 React 组件:client 层不 import react,logo 经 IPC 传到 renderer 再画。 */
export interface KernelLogo {
  /** SVG viewBox(如 "0 0 24 24")。 */
  viewBox: string;
  /** aria-label(可访问性)。 */
  label: string;
  /** 若干条 path,统一 currentColor 填充;fillRule 缺省 nonzero。 */
  paths: { d: string; fillRule?: "evenodd" | "nonzero" }[];
}
