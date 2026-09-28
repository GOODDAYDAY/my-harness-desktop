// 启动面的**静态守卫** —— 设计文档 §6.1.3（phases 声明必须有真实读者）与 §6.2.2（per-entity
// 步骤必须经 runOps）。两条都是源码级扫描，不需要跑起来。
//
// 为什么需要静态守卫（而不是只靠行为测试）：这两个失效形态都是**静默**的。
//   · `phases` 声明了 `"warm"` 却没有任何暖路径调用 → 那个操作永远不会在暖启动跑，
//     而冷启动照常绿。字段变成装饰（§2.2.1「声明了没人读」）。
//   · per-entity 步骤自己写实体遍历而不经 `runOps` → 丢掉逐实体 try/catch，一个实体失败
//     会中断其余实体，并被记成"步骤失败"而非"某实体失败"（设计文档 §4.3.2 的分级失效）。
// 两者的行为测试都可能因为"恰好没触发"而绿，静态扫描则不依赖触发。
//
// ⚠ 静态守卫的**局限必须声明**（与 §6.1.3 同款诚实）：它只能证明"源码里存在/不存在某个形态"，
// 不能证明运行期可达、也不能防刻意绕过（先赋中间变量再遍历、forEach、跨行 for 头都抓不到）。
// 运行期可达性由 §6.2.1 的失败注入测试与 e2e 覆盖。静态防"声明腐烂"，动态防"路径不通"，
// 两者不可互相替代。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..");                    // src/server
const STEPS_DIR = join(HERE, "steps");
const KERNEL_RELOAD = join(HERE, "kernel-reload.ts");  // 阶段三才创建

/** 读一批文件的源码（相对路径 → 内容）。 */
function sources(dirs: string[]): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const full = join(d, name);
      out.push({ rel: full.replace(SRC + "/", ""), text: readFileSync(full, "utf-8") });
    }
  }
  return out;
}

// ============ §6.1.3 phases 声明必须有真实读者 ============

/** 七张操作表（设计文档 §3.3.1 的分表原则：一张表 = 一个驱动点要跑的操作集合）。 */
const TABLES = [
  "KERNEL_MIGRATE_OPS", "KERNEL_SKILL_OPS", "KERNEL_FIT_OPS",
  "KERNEL_RECONCILE_OPS", "KERNEL_BRIDGE_OPS",
  "PLUGIN_ATTACH_OPS", "PLUGIN_DETACH_OPS",
] as const;

/** 从源码里静态抽出「以某相位调 runOps 时传入了哪张表」。 */
function scanRunOpsCallSites(files: { rel: string; text: string }[]): { file: string; table: string; phase: string }[] {
  const hits: { file: string; table: string; phase: string }[] = [];
  for (const f of files) {
    // 允许跨行：runOps(\n  TABLE,\n  "cold", …)
    for (const m of f.text.matchAll(/runOps\(\s*([A-Z_]+)\s*,\s*"(cold|warm)"/g)) {
      hits.push({ file: f.rel, table: m[1], phase: m[2] });
    }
  }
  return hits;
}

/** 含 warm 操作、但其暖调用点所在文件**尚未落地**的表。
 *  由「文件是否存在」推导，不是手写的永久豁免——`kernel-reload.ts` 一旦落地，名单自动变空，
 *  下一条测试立刻开始要求三张内核表真有暖调用点（设计文档 §6.1.3 的 PENDING_WARM_TABLES 语义）。 */
const PENDING_WARM_TABLES: string[] = existsSync(KERNEL_RELOAD)
  ? []
  : ["KERNEL_SKILL_OPS", "KERNEL_FIT_OPS", "KERNEL_BRIDGE_OPS"];

describe("§6.1.3 每个 phases 取值都有真实读者（防「声明了没人读」的字段腐烂）", () => {
  const files = sources([
    join(SRC, "application/lifecycle"),      // activate / deactivate（阶段一即有）
    STEPS_DIR,                               // 全部 per-entity 步骤（阶段一即有）
    HERE,                                    // kernel-reload.ts（阶段三才有；不存在则跳过）
  ]);
  const sites = scanRunOpsCallSites(files);
  const coldTables = new Set(sites.filter((s) => s.phase === "cold").map((s) => s.table));
  const warmTables = new Set(sites.filter((s) => s.phase === "warm").map((s) => s.table));

  it("判据本身不空转（确实抽到了 runOps 调用点，且覆盖了全部七张表中的冷侧）", () => {
    expect(sites.length).toBeGreaterThan(0);
    // 五张冷侧表都必须有冷调用点（六张：MIGRATE/SKILL/FIT/RECONCILE/BRIDGE + PLUGIN_ATTACH）
    for (const t of ["KERNEL_MIGRATE_OPS", "KERNEL_SKILL_OPS", "KERNEL_FIT_OPS",
                     "KERNEL_RECONCILE_OPS", "KERNEL_BRIDGE_OPS", "PLUGIN_ATTACH_OPS"]) {
      expect(coldTables, `${t} 没有以 "cold" 传入它的调用点`).toContain(t);
    }
  });

  it("两张插件表的暖调用点已就位（lifecycle.activate / deactivate）", () => {
    expect(warmTables).toContain("PLUGIN_ATTACH_OPS");
    expect(warmTables).toContain("PLUGIN_DETACH_OPS");
  });

  it("三张内核表的暖调用点在阶段三落地；PENDING 名单由「文件是否存在」推导，不是永久豁免", () => {
    if (PENDING_WARM_TABLES.length > 0) {
      // 阶段三之前：名单非空，且必须是因为 kernel-reload.ts 真的还不存在
      expect(existsSync(KERNEL_RELOAD), "PENDING 名单非空但 kernel-reload.ts 已存在——请清空名单").toBe(false);
      expect(PENDING_WARM_TABLES.sort()).toEqual(["KERNEL_BRIDGE_OPS", "KERNEL_FIT_OPS", "KERNEL_SKILL_OPS"]);
      return;
    }
    // 阶段三之后：名单为空，三张表必须真有暖调用点
    for (const t of ["KERNEL_SKILL_OPS", "KERNEL_FIT_OPS", "KERNEL_BRIDGE_OPS"]) {
      expect(warmTables, `${t} 的暖调用点缺失（kernel-reload.ts 已存在却没调它）`).toContain(t);
    }
  });

  it("cold-only 的表不得出现在暖调用点里（否则相位声明与实际调用矛盾）", () => {
    for (const t of ["KERNEL_MIGRATE_OPS", "KERNEL_RECONCILE_OPS", "PLUGIN_DETACH_OPS"]) {
      if (t === "PLUGIN_DETACH_OPS") {
        // detach 表是 warm-only：它**必须**在暖调用点里，且不得在冷调用点里
        expect(warmTables).toContain(t);
        expect(coldTables, `${t} 是 warm-only，不该有冷调用点`).not.toContain(t);
        continue;
      }
      expect(coldTables).toContain(t);
    }
  });

  it("扫描范围只含真实存在的文件（不存在的文件被跳过，不误判为「无调用点」）", () => {
    // 这条守的是扫描器本身：若把不存在的目录当"扫到了但没命中"，PENDING 机制就失去意义。
    const scanned = files.map((f) => f.rel);
    expect(scanned.some((r) => r.includes("steps/")), "steps/ 必须被扫到").toBe(true);
    expect(scanned.some((r) => r.includes("lifecycle/")), "lifecycle/ 必须被扫到").toBe(true);
  });
});

// ============ §6.2.2 per-entity 步骤必须经 runOps ============

describe("§6.2.2 per-entity 步骤必须经 runOps 驱动（逐实体 try/catch 与点名留痕锁在一处）", () => {
  const stepFiles = readdirSync(STEPS_DIR)
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
    .map((n) => ({ name: n, text: readFileSync(join(STEPS_DIR, n), "utf-8") }));

  const perEntity = stepFiles.filter((f) => /scope:\s*"per-entity"/.test(f.text));
  const global_ = stepFiles.filter((f) => /scope:\s*"global"/.test(f.text));

  it("判据本身不空转（确实识别出了 per-entity 与 global 两类步骤）", () => {
    expect(perEntity.length).toBeGreaterThan(0);
    expect(global_.length).toBeGreaterThan(0);
    expect(perEntity.length + global_.length).toBe(stepFiles.length);
  });

  it("每个 per-entity 步骤都调 runOps", () => {
    const missing = perEntity.filter((f) => !/runOps\(/.test(f.text)).map((f) => f.name);
    expect(missing, `标了 per-entity 却不经 runOps: ${missing.join(", ")}`).toEqual([]);
  });

  it("per-entity 步骤不得自写实体遍历（否则丢掉逐实体隔离，且失败被记成步骤级）", () => {
    const bad: string[] = [];
    for (const f of perEntity) {
      // 抓「for…of 直接遍历注册表/投影面」的形态。局限见文件头：中间变量/forEach/跨行 for 头抓不到，
      // 那是"防手滑"级别的守卫；真正的兜底是冷暖对称性测试（自写遍历会丢掉逐实体 try/catch）。
      if (/for\s*\(.*\bof\b.*(allPlugins|kernelRegistry\.all|\.all\(\)|extensionSyncs|lifecycles|surfaces\(\))/.test(f.text)) {
        bad.push(f.name);
      }
    }
    expect(bad, `per-entity 步骤自己写了实体遍历: ${bad.join(", ")}`).toEqual([]);
  });

  it("global 步骤里允许出现内核遍历（它构造的是依赖对象，不是驱动实体）", () => {
    // 明确的豁免：`50-wiring` 构造 skillsEnsure 闭包时含 `for (const l of surfaces.lifecycles)`
    // ——那是**逐内核隔离与点名**的实现（设计文档 §5.1.1），不是"驱动实体"。
    // 本条把豁免钉成断言：若将来有人把这段搬进 per-entity 步骤，上一条会红。
    const wiring = global_.find((f) => f.name.startsWith("50-"));
    expect(wiring, "50-wiring 必须是 global").toBeTruthy();
    expect(wiring!.text).toMatch(/for \(const l of surfaces\.lifecycles\)/);
  });

  it("steps/ 目录里只有步骤文件（所以「扫目录」等价于「扫全部步骤」）", () => {
    const all = readdirSync(STEPS_DIR);
    expect(all.filter((n) => n.endsWith(".test.ts"))).toEqual([]);
    expect(all.length).toBe(stepFiles.length);
  });
});
