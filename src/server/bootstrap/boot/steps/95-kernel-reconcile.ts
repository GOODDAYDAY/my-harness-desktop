// 步骤 95：内核冷启动对账（缺失则自动补装）。**唯一的 background 步骤。**
//
// 收编设计文档 §1.1.2 的动作 #15 前半（`assemble.ts:579-590`）。
// 依据 design-principles「内核安装不该靠手动」：启动后异步扫已装状态，缺失则按 dist-tag
// 最新版自动补装。
//
// **background 与 degrade 的区别必须钉死**（两者都不阻断启动，语义不同）：
// degrade **await 完成**（失败已知、留痕已写、后续步骤可以依赖它的产物）；
// background **不 await**（结果稍后到达、靠回调广播，后续步骤不能依赖它）。
// 本步骤是 background 因为 npm install 可能几十秒；扩展同步是 degrade 因为它必须在下一次
// 内核 spawn 之前完成。
//
// **双重兜底**：① 内部链自己 `.catch()`——否则是未捕获拒绝，会杀主进程
// （`assemble.ts:547-548` 记着这个教训）；② `run` 的同步部分被 `runColdBoot` 的步骤级 catch 兜住。
import type { BootStep } from "../types";
import { reconcileMissingKernels } from "../../../kernel/core/kernel-reconcile";
import { broadcastRefreshRequested } from "../../../routing/broadcast";

const step: BootStep = {
  id: "95-kernel-reconcile",
  scope: "global",
  failure: "background",
  requires: ["20-kernel-surfaces", "90-transport"],
  run(ctx) {
    const { surfaces, gateway } = ctx;
    // 进度不进 UI（后台静默），装完广播 refresh 让「未安装」只读条消失。
    void reconcileMissingKernels(
      surfaces!.plugins.map((p) => ({ kernel: p.id, versionApi: p.createVersionApi() })),
      (_kernel, _line) => { /* 后台静默，进度仅日志（不打扰用户） */ },
      (result) => {
        if (result.outcome === "installed") {
          console.log(`[kernel-reconcile] ${result.kernel} 内核已自动补装`);
          broadcastRefreshRequested(gateway);
        } else if (result.outcome === "failed") {
          console.warn(`[kernel-reconcile] ${result.kernel} 自动补装失败: ${result.error}`);
        }
      },
    ).catch((e) => console.error("[kernel-reconcile] 启动对账失败:", e));
  },
};

export default step;
