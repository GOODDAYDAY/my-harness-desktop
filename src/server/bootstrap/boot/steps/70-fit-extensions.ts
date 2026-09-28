// 步骤 70：随壳分发的**适配扩展**启动同步（per-entity over kernels）。
//
// 收编设计文档 §1.1.2 的动作 #12（`assemble.ts:510-513` 的 syncFit 循环）。
// 适配扩展不是壳插件携带的，是壳自带、由各内核自己解析资产路径并同步进内核扩展位的
// （`createPluginExtensionSync().syncFit()` 不接参数——"我们的适配扩展放在哪"是内核私有知识）。
// 操作把返回的注册 id 投进 `deps.extensionActiveIds` 收集器，供 `80-extension-reconcile` 对账。
//
// **必须早于 `90-transport`**：内核的 loader 只在 spawn 时扫一次扩展目录，而 transport 起来之后
// renderer 才能连上、才能发送、才会触发 spawn。这条约束今天只活在 `assemble.ts:503` 的注释里
// （"放在任何内核 spawn 之前"），步骤化之后变成 `90-transport.requires` 的一条边（§4.2.1）。
import type { BootStep } from "../types";
import { runOps } from "../../../application/lifecycle/boot-ops";
import { KERNEL_FIT_OPS } from "../ops";

const step: BootStep = {
  id: "70-fit-extensions",
  scope: "per-entity",
  failure: "degrade",
  requires: ["20-kernel-surfaces", "50-wiring"],
  async run(ctx) {
    await runOps(KERNEL_FIT_OPS, "cold", ctx.kernelRegistry!.all(), ctx.kernelBootDeps!, (k) => k.id);
  },
};

export default step;
