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
