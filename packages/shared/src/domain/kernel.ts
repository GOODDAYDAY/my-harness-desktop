// 圆心:内核身份单源 —— kernel.ts 只放「内核标识」这个零依赖原子。
//
// 依据 docs/design/kernel-layer.md §2.1。pi 和 dsh 是同级的两个内核(multi-kernel-shell.md),
// 内核身份是全仓唯一一处能出现 "pi" | "dsh" 字面量的地方。加第三个内核 = 这里加一个字面量,
// 编译器会逼着补全所有 switch(kernel) / KERNEL_IDS 消费处——这是字面量联合而非 string 的直接红利。
//
// 本文件零依赖:不 import 任何 domain 内外的类型,是圆心最内层的原子。

/** 内核标识(pi / dsh)。会话头、模型清单、后端工厂、跨内核切换共用这一份。 */
export type KernelId = "pi" | "dsh";

/** 全部已注册内核 id(运行时枚举;KernelSpec 注册 / 模型下拉分组 / 内核标渲染共用)。 */
export const KERNEL_IDS = ["pi", "dsh"] as const;

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
