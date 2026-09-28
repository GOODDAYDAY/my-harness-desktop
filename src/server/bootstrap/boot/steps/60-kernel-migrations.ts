// 步骤 60：内核历史状态的一次性迁移（per-entity over kernels）。
//
// 收编设计文档 §1.1.2 的动作 #3（`runKernelStartupMigrations`）。今天它是 `assemble.ts` 里
// 第 3 个执行的动作，步骤化之后降到第 6 位——后移的**必要性**是它要经 `runOps` 传入
// `KernelBootDeps`（由 50-wiring 构造）；后移的**安全性**论证见设计文档 §4.2.3：
// `migrateLegacyState` 写的是内核凭证库，而位次 3–5 的三步都不读它，且启动期不 spawn 任何
// 内核进程（唯一消费者是内核子进程里读凭证库的插件）。
//
// **为什么 cold-only**：迁移是一次性数据修复（把 prefs 里的明文 key 搬进凭证库），只在
// "从旧版本升级后的第一次启动"有事可做，之后每次调用都是零次循环（实现方幂等：
// 迁完就 `prefs.remove(...)` 清掉旧键）。给一个永远无事可做的动作声明暖时机就是死字段。
import type { BootStep } from "../types";
import { runOps } from "../../../application/lifecycle/boot-ops";
import { KERNEL_MIGRATE_OPS } from "../ops";

const step: BootStep = {
  id: "60-kernel-migrations",
  scope: "per-entity",
  failure: "degrade",
  requires: ["50-wiring"],
  async run(ctx) {
    await runOps(KERNEL_MIGRATE_OPS, "cold", ctx.kernelRegistry!.all(), ctx.kernelBootDeps!, (k) => k.id);
  },
};

export default step;
