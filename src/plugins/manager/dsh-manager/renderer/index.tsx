// dsh-manager 插件 renderer ——「DSH 入口」的三个 TAB 组件 re-export。
//
// 与 pi-manager 同级：dsh 是另一个内核（DeepSeek harness，Cordis 插件树 + JSON-RPC）。
// 经 manifest 的 contributes.settings[].tabs 声明，框架按 component 名自动匹配本入口的 exports（§7.4）。
// 三个 TAB 各一个文件（对齐 pi-manager 的拆分）：kernel / extensions / models。
// channels 也要 re-export：框架从入口 module 读 module.channels 注册事件总线，
// 默认模型变更频道在 models.tsx 里声明，不 re-export 则「未被任何插件注册」。
export { DshKernelPage } from "./kernel";
export { DshExtensionsPage } from "./extensions";
export { DshModelsPage, channels } from "./models";
