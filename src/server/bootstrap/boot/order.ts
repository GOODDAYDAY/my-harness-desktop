// 启动步骤的校验与拓扑排序 —— 纯函数，可裸单测（§4.5 判据：不碰 IO/环境/状态）。
//
// 依据 docs/design/boot-surface.md §3.2.2 / §3.2.3。
//
// **为什么需要启动期校验**：真扫描换掉了编译期校验——`import { step70 } from "./70-…"` 那种
// 写法下，`requires` 指向不存在的步骤会编译错；改成扫描后，id 是运行期才知道的字符串，
// 写错只会静默变成"某个 ctx 字段是 undefined"。这是 `docs/design/kernel-plugin.md:138`
// 已经付过一次的代价（内核插件化后补 `validateKernelPlugin`），此处同一处置。
import type { BootStep, FailurePolicy, ScannedStep } from "./types";

const SCOPES = new Set(["global", "per-entity"]);
const FAILURES = new Set<FailurePolicy>(["fatal", "degrade", "background"]);

/**
 * 七条规则，任一违反即 throw（不是跳过）。
 *
 * 全部在 `buildBootPlan` 内执行，而 `buildBootPlan` 在 `runColdBoot` 的 per-step try/catch
 * **之外**（§4.3.1），所以任何一条违反都是 fatal：壳起不来，异常冒泡到入口。这是有意的——
 * 计划构建失败意味着"启动编排本身坏了"，降级继续只会得到一台半装的壳。
 */
export function validateBootStep(candidate: ScannedStep, all: readonly ScannedStep[]): void {
  const { step, file } = candidate;
  const where = `启动步骤 ${file}`;

  // ① id 非空字符串：requires 靠 id 引用，空 id 无法被依赖。
  if (typeof step?.id !== "string" || step.id.length === 0) {
    throw new Error(`${where} 缺少非空的 id`);
  }
  // ② id 在扫描结果内唯一：与 KernelRegistry.register 同规则（kernel-registry.ts:15-17）。
  const dupes = all.filter((s) => s.step?.id === step.id);
  if (dupes.length > 1) {
    throw new Error(`${where} 的 id "${step.id}" 与 ${dupes.map((d) => d.file).join(", ")} 重复`);
  }
  // ③ id 等于产物文件名去掉 .js：让"目录列表的可读顺序"与"tie-break 用的 id 序"是同一个东西。
  //    判据来自 ScannedStep.file —— 这正是 scanBootSteps 必须保留文件名的原因。
  const expected = file.replace(/\.js$/, "");
  if (step.id !== expected) {
    throw new Error(`${where} 的 id "${step.id}" 与产物文件名不符（应为 "${expected}"）`);
  }
  // ④ scope 取值合法：守卫据此判断该断言哪种留痕形状（§6.2.2）。
  if (!SCOPES.has(step.scope)) {
    throw new Error(`${where} 的 scope "${String(step.scope)}" 非法（应为 global | per-entity）`);
  }
  // ⑤ failure 取值合法：缺省值会让"未声明"与"声明 degrade"不可区分。
  if (!FAILURES.has(step.failure)) {
    throw new Error(`${where} 的 failure "${String(step.failure)}" 非法（应为 fatal | degrade | background）`);
  }
  // ⑥ run 是函数：与 validateKernelPlugin 检查 7 个 create* 同理。
  if (typeof step.run !== "function") {
    throw new Error(`${where} 的 run 不是函数`);
  }
  // ⑦ requires 里的每个 id 都在扫描结果内。**这条尤其重要**：未知 requires 若被静默忽略，
  //    步骤会以错误的顺序执行，症状是"某个 ctx 字段是 undefined"——比直接抛错难查一个量级。
  const known = new Set(all.map((s) => s.step?.id));
  for (const dep of step.requires ?? []) {
    if (!known.has(dep)) {
      throw new Error(`${where} requires 了不存在的步骤 "${dep}"`);
    }
    if (dep === step.id) {
      throw new Error(`${where} requires 了自己`);
    }
  }
}

/**
 * Kahn 拓扑排序 + 环检测。
 *
 * **tie-break 按 id 字典序**，理由要写准（设计文档第一版草稿写错过）：草稿说"否则同一份步骤表
 * 在不同 `Map` 迭代顺序下可能产出不同执行序"——那个论据不成立，JS 的 `Map` 迭代顺序由规范固定为
 * 插入序。真正的理由是：没有 tie-break 时拓扑序取决于邻接表的构建顺序与队列实现细节，
 * **换一种等价算法实现就会得到不同的序**。tie-break 把"序"从算法实现细节变成 id 的函数，
 * 于是重排算法、换数据结构都不会改变执行序——这对 §6.1.1 的守卫（断言相对位置）是必要的稳定性。
 *
 * ⚠ tie-break 有一条**它不能承担的职责**：语义约束不能只靠它成立。例如
 * `70-fit-extensions` < `75-plugin-boot` < `90-transport` 的字典序恰好让扩展同步排在传输之前，
 * 但那是巧合——把 `90-transport` 改名成 `68-transport` 就翻转了。所以约束必须写成 `requires` 边，
 * 守卫也必须断言**边存在**而不只是断言顺序（§6.1.1）。
 *
 * 排序按 **id** 比较，不读文件名：两者在一个 id 是另一个 id 的前缀时会分岔
 * （`70-fit.js` vs `70-fit-extensions.js`：按文件名 `-`(0x2D) < `.`(0x2E) 故 extensions 排前面，
 * 按 id 则相反）。本文的命名约定（两位数字前缀 + 互不为前缀的名字）让分岔不会出现。
 */
export function topoSort(steps: readonly BootStep[]): BootStep[] {
  const byId = new Map<string, BootStep>();
  for (const s of steps) byId.set(s.id, s);

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of steps) {
    indegree.set(s.id, 0);
    dependents.set(s.id, []);
  }
  for (const s of steps) {
    for (const dep of s.requires ?? []) {
      // validateBootStep 已保证 dep 存在；这里再防一手，避免 undefined 污染计数。
      if (!byId.has(dep)) continue;
      indegree.set(s.id, (indegree.get(s.id) ?? 0) + 1);
      dependents.get(dep)!.push(s.id);
    }
  }

  // 就绪队列按 id 排序（tie-break）。用数组 + 每次插入后排序：步骤数是十几个，
  // O(n²) 完全够，且比引入优先队列更少代码、更少出错面。
  const ready = steps.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id).sort();
  const emitted: BootStep[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    emitted.push(byId.get(id)!);
    for (const next of dependents.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }

  if (emitted.length !== steps.length) {
    // 剩余节点 = 环上的成员 **加上环的下游**（下游入度永远减不到 0）。
    // 错误信息要这么说，不能只说"环上的成员"——否则读者会去找一个不存在的环成员。
    const rest = steps.filter((s) => !emitted.some((e) => e.id === s.id)).map((s) => s.id);
    throw new Error(
      `启动步骤存在循环依赖，无法排序。涉及步骤（环上成员 + 环的下游）: ${rest.join(" → ")}`,
    );
  }
  return emitted;
}
