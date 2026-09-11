// dsh 内核插件 · desktop 对接面 renderer ——「DSH 入口」的三个 TAB 组件 re-export。
//
// 与 pi 内核插件同级：dsh 是另一个内核（DeepSeek harness，Cordis 插件树 + JSON-RPC）。
// 经 manifest 的 contributes.settings[].tabs 声明，框架按 component 名自动匹配本入口的 exports（§7.4）。
// 三个 TAB 各一个文件（对齐 pi 内核插件的拆分）：kernel / extensions / models。
// **本插件不声明任何私有频道**（与 pi 侧同款）：默认模型变更走框架中性信号
// system:refreshRequested，插件之间不认彼此的 id/channel（§8.3）。
export { DshKernelPage } from "./kernel";
export { DshExtensionsPage } from "./extensions";
export { DshModelsPage } from "./models";
