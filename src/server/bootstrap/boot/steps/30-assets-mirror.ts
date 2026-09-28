// 步骤 30：镜像随壳分发的资产到数据根（内置技能 + 内置贴纸）。
//
// 收编设计文档 §1.1.2 的动作 #9。今天这两处镜像被技能挂摘隔开（`assemble.ts:475` 与 `481`，
// 中间夹着 L477-479 的 `migrateSkills`），纯属行序偶然；合成一步之后依赖变成显式的
// `requires`——`65-kernel-skills` 依赖本步骤，因为技能挂摘挂的是**镜像后**的目录。
//
// **为什么 degrade 而不是 fatal**：镜像失败（源目录缺失、目标不可写）不该让壳起不来——
// 内置技能/贴纸缺失是功能降级，不是结构性失败。留痕后继续。
import { mirrorBundledSkills } from "../../../application/skills/bundled-skills";
import { mirrorManagedDir } from "../../../application/bundled/mirror";
import type { BootStep } from "../types";

const step: BootStep = {
  id: "30-assets-mirror",
  scope: "global",
  failure: "degrade",
  run(ctx) {
    const { paths } = ctx;
    // 内置技能：仓库顶级 .claude/skills 随壳分发（打包态 resources/my-harness-desktop-skills），
    // 镜像到 <数据根>/skills（强制覆盖，受管目录）。放在启动序列而非等 IPC：
    // "用 my-harness-desktop 就有"不依赖用户先打开设置页。
    mirrorBundledSkills(paths.bundledSkillsSource, paths.bundledSkillsDir);
    // 内置贴纸：assets/stickers 随壳分发，镜像到 <数据根>/stickers/bundled。
    // stickers 插件按只读 builtin 层读它——纯 UI 内容，不进模型上下文，无 ensure* 开关。
    mirrorManagedDir(paths.bundledStickersSource, paths.bundledStickersDir);
  },
};

export default step;
