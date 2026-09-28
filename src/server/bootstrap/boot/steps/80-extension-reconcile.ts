// 步骤 80：内核扩展的孤儿对账（per-entity over kernels）。
//
// 收编设计文档 §1.1.2 的动作 #13 后半（`assemble.ts:526` 的 reconcile）。
// 各内核摘除自己目录下带 marker（`.my-harness-desktop-plugin`）但已不在 `active` 集合里的扩展。
//
// **requires `70` 与 `75`**：`active` 集合 = 适配扩展 id（70 投进收集器）∪ 声明了内核扩展的
// 插件 id（由 `deps.reconcileActive()` 现算，见 ../ops.ts 的 `reconcileActiveSet`）。
// 两者都到位之后对账才可靠。
//
// **cold-only**：全量对账需要完整的 active 集合，暖启动每次只动一个实体、拿不到全集。
// 孤儿因此要等下次冷启动才被清掉——可接受，因为孤儿只可能来自"直接从磁盘删掉插件目录、
// 没走 uninstall API"（正常卸载路径走 detach 操作逐个摘除，不产生孤儿）。
import type { BootStep } from "../types";
import { runOps } from "../../../application/lifecycle/boot-ops";
import { KERNEL_RECONCILE_OPS } from "../ops";

const step: BootStep = {
  id: "80-extension-reconcile",
  scope: "per-entity",
  failure: "degrade",
  requires: ["50-wiring", "70-fit-extensions", "75-plugin-boot"],
  async run(ctx) {
    await runOps(KERNEL_RECONCILE_OPS, "cold", ctx.kernelRegistry!.all(), ctx.kernelBootDeps!, (k) => k.id);
  },
};

export default step;
