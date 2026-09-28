// 步骤 99：内核旧命名会话文件的一次性中立层导入。
//
// 收编设计文档 §1.1.2 的动作 #15 后半（`assemble.ts:595-606`；session-single-source §4.3、
// §2.1 的显式例外——离线迁移工具不是会话流读路径）。
//
// 幂等：已有中立层记录的跳过。同步执行（文件量小、本地读）。失败只告警不阻断启动（degrade）。
// 有导入则广播刷新，让列表出现迁移进来的旧会话。
//
// **与 `95-kernel-reconcile` 分成两步**（设计文档第一版草稿曾合成一步 `post-boot`）：
// 两者的 `failure` 不同（background vs degrade），而 `failure` 是单值字段，合成一步就无法表达
// 两种策略——那个草稿缺陷正是本步骤独立存在的原因。
import type { BootStep } from "../types";
import { importLegacySessions } from "../../../application/sessions/legacy-import";
import { broadcastRefreshRequested } from "../../../routing/broadcast";

const step: BootStep = {
  id: "99-legacy-import",
  scope: "global",
  failure: "degrade",
  requires: ["20-kernel-surfaces", "50-wiring", "90-transport"],
  run(ctx) {
    const store = ctx.sessionStore!.neutralStoreRef;
    if (!store) return;
    const r = importLegacySessions(ctx.surfaces!.plugins, store);
    if (r.imported > 0) {
      console.log(`[legacy-import] 内核旧会话导入中立层: ${r.imported} 个(跳过 ${r.skipped},失败 ${r.failed}${r.failedKernels.length ? `,内核读取失败 ${r.failedKernels.join(",")}` : ""})`);
      broadcastRefreshRequested(ctx.gateway);
    }
  },
};

export default step;
