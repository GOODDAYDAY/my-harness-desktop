// 冷启动驱动器 —— 全文唯一的启动编排入口。
//
// 依据 docs/design/boot-surface.md §4.3。**命名统一为 `runColdBoot`**（设计文档第一版草稿曾同时
// 出现 `runner.run("cold")` / `runBoot(phase, ctx)` / `runColdBoot` 三个名字，已收敛）。
//
// 为什么没有 `runWarmBoot`：暖启动**不跑步骤表**。它是"对单个实体装/卸启动面"，直接调
// `runOps(<表>, "warm", [该实体], deps, nameOf)`——没有排序、没有 DAG、没有步骤级失败策略
// （实体级失败一律降级）。给暖启动造一个"跑一遍步骤表"的入口，就是 §2.2.3 批评的
// "按温度分文件夹会把今天的重复制度化"的另一种形态。
import type { BootContext } from "./types";
import { buildBootPlan } from "./scan";

/**
 * 冷启动：建计划 → 按拓扑序执行 → 按 `failure` 分派异常。返回同一个 `ctx` 供组装根读回产物。
 *
 * 三级失败各管一层（§4.3.2），留痕格式互不相同，便于按前缀定位：
 *   · **计划级**（扫描/校验/排序抛出）：无捕获，直接冒泡。此时还没执行任何步骤，无需收尾。
 *   · **步骤级**（`run` 抛出）：本函数按 `failure` 分派，留痕 `[boot:<step.id>]`。
 *   · **实体级**（单个插件/内核失败）：`runOps` 内部逐实体 try/catch，留痕 `[boot-op:<op.id>] <实体 id>`。
 *     per-entity 步骤必经 `runOps`（§6.2.2 有守卫），所以实体级异常永远到不了步骤级。
 */
export async function runColdBoot(ctx: BootContext): Promise<BootContext> {
  // 计划构建在 per-step try/catch **之外**：产物缺失 / 七条校验任一违反 / 成环 / 空计划，
  // 一律 fatal 冒泡（§4.3.4 的收尾表为此单列一行——此时无需收尾，因为还没执行任何步骤）。
  const plan = buildBootPlan(ctx.paths.bootStepsRoot);

  for (const step of plan.steps) {
    try {
      const r = step.run(ctx);
      // background：不 await，直接进下一步。它的 run 必须自己 void 掉内部异步链并各带 .catch
      // （§4.3.3）——否则是未捕获拒绝，会杀主进程（`assemble.ts:547-548` 记着这个教训：
      // "重绑路径上任何未捕获异常都会杀掉主进程"）。
      // 注意 run 的**同步**抛出仍会被下面同一个 catch 兜住，所以 background 语义不被破坏。
      if (step.failure === "background") { void r; continue; }
      if (r instanceof Promise) await r;
    } catch (e) {
      // fatal：冒泡，中止后续步骤。由入口负责呈现与退出（§4.3.4：Electron 弹框 + app.exit(1)，
      // server 打日志 + process.exitCode = 1）。
      if (step.failure === "fatal") throw e;
      // degrade：留痕点名到步骤 id，继续下一步。后续步骤仍可依赖它的产物——
      // degrade 的语义是"已完成（可能部分失败并留痕）"，不是"没跑"。
      console.error(
        `[boot:${step.id}] 启动步骤失败（已降级，不阻断启动）:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return ctx;
}
