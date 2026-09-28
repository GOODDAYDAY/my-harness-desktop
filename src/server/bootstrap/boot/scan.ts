// 启动步骤的扫描与计划构建 —— 真扫描（与内核插件工厂同一套机制）。
//
// 依据 docs/design/boot-surface.md §3.2.1。**为什么步骤真扫描而操作不真扫描**（§3.3.1）：
// 真扫描的价值来自"第三方可投递"——壳插件与内核插件要支持用户往目录里丢东西，所以必须扫盘。
// 步骤不是这个形状：它是壳自己的编排，第三方不该能新增一个启动步骤（那等于让内容层改机制层）。
// 但步骤**仍然**真扫描，理由是另一条：与内核插件工厂**同构**（同一套"目录即清单"心智），
// 且加一个步骤 = 加一个文件，不需要回来改一张手写清单（手写清单会漂，`CLAUDE.md` §3.7 的
// Tailwind `@source` 与 `audit:docs` 退役表都是这个教训）。代价是三笔（§3.4）：
// 每个 step 一行 rollup input、step 文件必须自包含、失去编译期顺序校验（由本文件的启动期校验兜）。
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { BootPlan, BootStep, ScannedStep } from "./types";
import { topoSort, validateBootStep } from "./order";

/** cjs 动态 require（相对本模块位置），加载编译产物 `<id>.js`。
 *  与 `kernel-plugin-loader.ts:28` 同一做法：main 构建产物是 cjs。 */
const dynamicRequire = createRequire(import.meta.url);

/** 步骤产物模块的形状。rollup 的 CJS 输出有**两种**形态，取决于源文件的导出组合：
 *  · 只有 `export default` → `module.exports = step`（default-only 优化，产物本体即步骤）；
 *  · default + 具名导出 → `exports.default = step`。
 *  步骤文件属前者，内核插件属后者（它同时具名导出工厂）。两种都要认——这与
 *  `loadKernelPlugin` 的 `module.default ?? module[`${id}KernelPlugin`]` 是同一个处置。
 *  但**必须配形状校验**（见 `asBootStep`），否则"认两种形态"会退化成"任何模块都当步骤"。 */
interface BootStepModule {
  default?: BootStep;
}

/** 从两种 CJS 形态里取出步骤对象。
 *
 *  **本函数只回答"这模块里有没有一个步骤对象"，不校验字段**——字段有效性归
 *  `validateBootStep`（它有精确的规则编号与消息）。此前这里也检查了 `id`/`run`，
 *  于是 `validateBootStep` 规则 6（"run 不是函数"）对 `run` 的检查**永不可达**：
 *  一个不可达的检查就是 §2.2.1 说的坏味道，而且它的错误消息还不如规则 6 精确
 *  （规则 6 会说"哪个文件的 run 不是函数"，这里只能说"不是一个 BootStep"）。
 *
 *  取不到对象即抛（不跳过、不猜测）：静默跳过会让"少了一个步骤"变成无法察觉的缺面
 *  （§1.5 唯一明禁的状态）。 */
function asBootStep(mod: unknown, file: string): BootStep {
  const m = mod as BootStepModule;
  const candidate = (m?.default ?? m) as unknown;
  if (!candidate || typeof candidate !== "object") {
    throw new Error(
      `启动步骤产物 ${file} 既没有 default 导出、本身也不是对象。` +
      `steps/ 目录只允许放步骤文件，每个文件 default 导出一个 BootStep；` +
      `共享 helper 请放父目录 bootstrap/boot/`,
    );
  }
  return candidate as BootStep;
}

/**
 * 枚举步骤产物目录，逐个 require，返回 `{ file, step }` 二元组。
 *
 * **保留文件名**是 §3.2.2 规则 3（`id` 等于产物文件名去 `.js`）能被判定的前提——设计文档
 * 第一版草稿的 `scanBootSteps` 直接 `push(mod.default)`、把局部变量 `name` 丢了，于是那条规则
 * 被声明了三次却无法实现。
 *
 * 三个实现要点：
 *   · `readdirSync().sort()` 给出稳定的默认序，文件名前缀因此成为可读的默认顺序；
 *     但**默认序不是权威序**——权威序由 `requires` 拓扑排序决定，前缀只在打平时当 tie-break。
 *   · **只收 `.js`**：dev 态扫的也是 `out/main/boot/steps/`（构建产物），不是 `src/`——
 *     与内核插件工厂扫 `out/main/server/kernel/<id>/plugin.js` 一致。源码态的 `.ts` 不进结果。
 *   · **缺 `default` 导出即抛**，不跳过：静默跳过会让"少了一个步骤"变成无法察觉的缺面
 *     （§1.5 唯一明禁的状态），而抛错直接点名是哪个文件。
 */
export function scanBootSteps(stepsDir: string): ScannedStep[] {
  if (!existsSync(stepsDir)) return [];
  const out: ScannedStep[] = [];
  for (const name of readdirSync(stepsDir).sort()) {
    if (!name.endsWith(".js")) continue;
    const full = join(stepsDir, name);
    out.push({ file: name, step: asBootStep(dynamicRequire(full), full) });
  }
  return out;
}

/**
 * 扫描 → 校验 → 拓扑排序，产出一份可执行计划。
 *
 * **空计划即抛**（REV-17）：否则 rollup input 漏配（§3.4.1）或打包态 asar 内 `readdirSync`
 * 不可用时，`scanBootSteps` 会静默返回 `[]`、`runColdBoot` 什么都不做——症状是"壳起来了
 * 但什么都没装"，要等到 `assemble` 返回 `ctx.mainContext!`（非空断言在运行期只是 cast，不检查）
 * 才在别处炸开，极难定位。响亮失败优于静默空启动。
 */
export function buildBootPlan(stepsDir: string): BootPlan {
  const scanned = scanBootSteps(stepsDir);
  if (scanned.length === 0) {
    throw new Error(
      `启动步骤目录为空或不可读: ${stepsDir}` +
      `（构建未产出步骤产物？检查 electron.vite.config.ts 的 flatInputs；` +
      `打包态还需确认 asar 内 readdirSync 可用，见 docs/design/boot-surface.md §6.4.1 验收）`,
    );
  }
  for (const candidate of scanned) validateBootStep(candidate, scanned);
  return { steps: topoSort(scanned.map((s) => s.step)) };
}
