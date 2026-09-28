// 步骤 85：提问桥常驻监听（per-entity over kernels）。
//
// 收编设计文档 §1.1.2 的动作 #7（`assemble.ts:324-336`）。提问桥是启动期唯一"跑起来并持续
// 运行"的内核侧组件：它**不是**内核子进程，而是壳侧的目录监听器，把内核落盘的问句文件翻译成
// 中性提问事件，经 `sessionStore.injectQuestion` 汇入统一通道。
//
// **相对今天后移**（今天在 wiring 之前，靠 `let sessionStore!: SessionStore` 的延迟闭包引用
// 后赋值的字段）。后移的**必要性**：`BootContext` 的字段是显式的、由前序步骤写入的，
// 不允许延迟绑定。后移的**风险**是监听启动时刻变晚、理论上漏掉窗口内落盘的问句文件——
// 已实证排除：`DshQuestionBridge.start()` 是 `mkdirSync` → `scan()`（全量扫描既存文件）→
// `watch(...)`，**先扫后听**且幂等（`dsh-question-bridge.ts:45-52`）。
import type { BootStep } from "../types";
import { runOps } from "../../../application/lifecycle/boot-ops";
import { KERNEL_BRIDGE_OPS } from "../ops";

const step: BootStep = {
  id: "85-question-bridges",
  scope: "per-entity",
  failure: "degrade",
  requires: ["10-kernel-plugins", "50-wiring"],
  async run(ctx) {
    await runOps(KERNEL_BRIDGE_OPS, "cold", ctx.kernelRegistry!.all(), ctx.kernelBootDeps!, (k) => k.id);
  },
};

export default step;
