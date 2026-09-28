// 步骤 65：内置技能的旧命名迁移 + 按偏好挂摘（per-entity over kernels）。
//
// 收编设计文档 §1.1.2 的动作 #10（`assemble.ts:477-479` 的 migrateSkills + `482-484` 的
// ensureBundledSkills）。**必须 requires `30-assets-mirror`**：挂的是**镜像后**的目录
// （`ensureBundledSkillsEntry` 的 `targetDir` 取 `KernelPluginContext.builtinSkillsDir`，
// 即 `<数据根>/skills`）。今天的行序（L475 mirror → L477 migrate → L482 ensure）已满足，
// 步骤化之后这个约束从"行序偶然"变成"可断言的边"（§6.1.1）。
//
// 两个操作的 phases 不同（`kernel-skills-migrate` 是 cold-only、`kernel-bundled-skills` 是
// cold+warm），理由见 ../ops.ts 里各自的注释。本步骤传 `"cold"`，两个都跑。
import type { BootStep } from "../types";
import { runOps } from "../../../application/lifecycle/boot-ops";
import { KERNEL_SKILL_OPS } from "../ops";

const step: BootStep = {
  id: "65-kernel-skills",
  scope: "per-entity",
  failure: "degrade",
  requires: ["20-kernel-surfaces", "30-assets-mirror", "50-wiring"],
  async run(ctx) {
    await runOps(KERNEL_SKILL_OPS, "cold", ctx.kernelRegistry!.all(), ctx.kernelBootDeps!, (k) => k.id);
  },
};

export default step;
