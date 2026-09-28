// 启动步骤表的**图属性守卫** —— 设计文档 §6.1.1 / §6.1.2 的六条断言。
//
// 为什么这些断言在阶段一就要落地（而不是等阶段二）：它们只依赖 `topoSort` 与步骤源码，
// 阶段一就有；若留到阶段二，阶段一的 `requires` 边写错就**没有任何机械保护**——而
// §6.3.2 的冷暖对称性测试抓不到"冷暖同错"（例如 `65-kernel-skills` 漏 requires
// `30-assets-mirror` 时，两侧会挂同一个错误目录，对称性照样成立）。
//
// 步骤清单用 `import.meta.glob` 从源码目录自动取，**不写手写清单**：加一个步骤文件自动纳入，
// 不会出现"新步骤没被守卫覆盖"的盲区。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { topoSort } from "./order";
import type { BootStep } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
const STEPS_SRC = join(HERE, "steps");

// 自动纳入 steps/ 下全部步骤（eager：同步拿到模块）。
const modules = import.meta.glob<{ default: BootStep }>("./steps/*.ts", { eager: true });
const steps: BootStep[] = Object.values(modules).map((m) => m.default);
const plan = (): string[] => topoSort(steps).map((s) => s.id);
const byId = (id: string): BootStep => {
  const s = steps.find((x) => x.id === id);
  if (!s) throw new Error(`步骤 ${id} 不存在（现有：${steps.map((x) => x.id).join(", ")}）`);
  return s;
};

describe("启动步骤表：基本形状", () => {
  it("恰好 14 个步骤，id 唯一，且与源码文件名一一对应", () => {
    expect(steps.length).toBe(14);
    const ids = steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const files = readdirSync(STEPS_SRC).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));
    expect(files.map((f) => f.replace(/\.ts$/, "")).sort()).toEqual([...ids].sort());
    // id == 文件名（validateBootStep 规则 3 的同一约束，在源码侧也成立）
    for (const f of files) expect(ids, `${f} 的 id 与文件名不符`).toContain(f.replace(/\.ts$/, ""));
  });

  it("无环，且拓扑序 == id 前缀升序（「看目录列表 = 看执行顺序」这条性质可被断言）", () => {
    const order = plan();
    expect(order.length).toBe(steps.length);       // 无环（有环时 topoSort 抛，这里到不了）
    expect(order).toEqual([...order].sort());      // 前缀升序
  });

  it("两个入度为 0 的根：10-kernel-plugins 与 30-assets-mirror", () => {
    const roots = steps.filter((s) => (s.requires ?? []).length === 0).map((s) => s.id).sort();
    expect(roots).toEqual(["10-kernel-plugins", "30-assets-mirror"]);
  });
});

describe("§6.1.1 顺序约束是**边**，不是文件名字典序的巧合", () => {
  it("90-transport 显式 requires 扩展同步（约束写成数据，删边即红）", () => {
    const t = byId("90-transport");
    expect(t.requires).toContain("70-fit-extensions");
    expect(t.requires).toContain("75-plugin-boot");
  });

  it("剥掉数字前缀后重排，扩展同步仍先于 transport（证明顺序来自边而非命名）", () => {
    // 这条是这组守卫的核心：把 id 的 `NN-` 前缀剥掉，字典序 tie-break 就失去意义，
    // 顺序**只能**来自 requires。若约束只靠命名巧合，这里会红。
    const stripped = steps.map((s) => ({
      ...s,
      id: s.id.replace(/^\d+-/, ""),
      requires: (s.requires ?? []).map((r) => r.replace(/^\d+-/, "")),
    }));
    const order = topoSort(stripped).map((s) => s.id);
    const t = order.indexOf("transport");
    expect(order.indexOf("fit-extensions")).toBeLessThan(t);
    expect(order.indexOf("plugin-boot")).toBeLessThan(t);
  });

  it("主链顺序：kernel-plugins → kernel-surfaces → shell-plugins → wiring → plugin-boot", () => {
    const order = plan();
    const chain = ["10-kernel-plugins", "20-kernel-surfaces", "40-shell-plugins", "50-wiring", "75-plugin-boot"];
    const idx = chain.map((id) => order.indexOf(id));
    expect(idx.every((i) => i >= 0), `主链里有步骤不存在: ${chain.filter((c, i) => idx[i] < 0).join(",")}`).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);   // 严格递增
  });

  it("所有 per-entity 内核步骤都排在 50-wiring 之后（它们都要经 runOps 拿 KernelBootDeps）", () => {
    const order = plan();
    const w = order.indexOf("50-wiring");
    for (const s of steps) {
      if (s.scope !== "per-entity") continue;
      if (s.id === "75-plugin-boot") continue;   // 插件侧：也必须在 wiring 之后（取 lifecycleDeps）
      expect(order.indexOf(s.id), `${s.id} 应在 50-wiring 之后`).toBeGreaterThan(w);
    }
    expect(order.indexOf("75-plugin-boot")).toBeGreaterThan(w);
  });

  it("65-kernel-skills 依赖 30-assets-mirror（挂的是**镜像后**的目录）", () => {
    expect(byId("65-kernel-skills").requires).toContain("30-assets-mirror");
  });
});

describe("§6.1.2 ctx 读写对账：读某字段的步骤必须（传递闭包内）依赖写它的步骤", () => {
  /** 只读输入段：由 createBootContext 构造，任何步骤都可读，不需要 requires。 */
  const READONLY_INPUTS = new Set([
    "host", "isPackaged", "rendererDir", "paths", "prefsStore", "port",
    "remoteConfig", "auth", "gateway", "forceEnableKernels", "lateRefs",
  ]);

  /** 从步骤源码文本里抽 `ctx.<field>` 的写与读（写 = 赋值语句）。 */
  function scan(file: string): { writes: Set<string>; reads: Set<string> } {
    const src = readFileSync(join(STEPS_SRC, file), "utf-8");
    const writes = new Set<string>();
    const reads = new Set<string>();
    for (const m of src.matchAll(/ctx\.(\w+)\s*(=[^=]|!|\?\.|\.|\s*[;,)\]}])/g)) {
      const field = m[1];
      if (m[2].startsWith("=")) writes.add(field);
      else reads.add(field);
    }
    // 解构形态：const { a, b } = ctx;
    for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*ctx\b/g)) {
      for (const part of m[1].split(",")) {
        const name = part.split(":")[0].trim();
        if (name) reads.add(name);
      }
    }
    return { writes, reads };
  }

  const files = readdirSync(STEPS_SRC).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));
  const scanned = new Map(files.map((f) => [f.replace(/\.ts$/, ""), scan(f)]));

  /** 可见字段 = 只读输入段 + **自己写的** + 所有祖先写的。
   *
   *  "自己写的"必须算进来，因为存在一种合法形态：步骤在构造一个**惰性 getter** 时引用
   *  自己稍后才写入的字段。实测例子——`50-wiring` 构造 `kernelBootDeps` 时写
   *  `surfaces: () => ctx.kernelState!.surfaces`，而 `ctx.kernelState` 是同一步骤几行之后
   *  才赋值的。getter 只在**运行期**被调用（暖重载取活投影面），那时早已赋值，所以安全。
   *  把"自己的写"排除在外会让这条合法形态假红；反过来，"先读后写"这种真错误静态扫不出来
   *  （需要数据流分析），由 §6.2.1 的失败注入测试与 e2e 兜。 */
  function visibleFrom(id: string): Set<string> {
    const visible = new Set<string>(READONLY_INPUTS);
    for (const f of scanned.get(id)?.writes ?? []) visible.add(f);
    const seen = new Set<string>();
    const walk = (cur: string): void => {
      if (seen.has(cur)) return;
      seen.add(cur);
      for (const f of scanned.get(cur)?.writes ?? []) visible.add(f);
      for (const dep of byId(cur).requires ?? []) walk(dep);
    };
    for (const dep of byId(id).requires ?? []) walk(dep);
    return visible;
  }

  it("每个被读的字段都在该步骤的可见范围内（否则运行期就是 undefined）", () => {
    const problems: string[] = [];
    for (const [id, { reads }] of scanned) {
      const visible = visibleFrom(id);
      for (const field of reads) {
        if (visible.has(field)) continue;
        problems.push(`${id} 读 ctx.${field}，但它的 requires 传递闭包里没人写它`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("每个字段的赋值点唯一（「每字段只写一次」契约，静态扫描版）", () => {
    const writers = new Map<string, string[]>();
    for (const [id, { writes }] of scanned) {
      for (const f of writes) writers.set(f, [...(writers.get(f) ?? []), id]);
    }
    const dupes = [...writers.entries()].filter(([, ids]) => ids.length > 1);
    expect(dupes.map(([f, ids]) => `ctx.${f} 被 ${ids.join(" 与 ")} 同时赋值`), "赋值点必须唯一").toEqual([]);
  });

  it("extensionActiveIds 只在 50-wiring 赋值一次（此后经 kernelBootDeps 的引用 mutate，不是对 ctx 赋值）", () => {
    const writers = [...scanned.entries()].filter(([, v]) => v.writes.has("extensionActiveIds")).map(([id]) => id);
    expect(writers).toEqual(["50-wiring"]);
  });

  it("steps/ 目录里没有测试文件与 helper（每个文件都是一个步骤，故扫目录 == 扫全部步骤）", () => {
    const all = readdirSync(STEPS_SRC);
    expect(all.filter((n) => n.endsWith(".test.ts")), "steps/ 里不该有测试文件").toEqual([]);
    expect(all.every((n) => n.endsWith(".ts")), "steps/ 里只应有 .ts 步骤文件").toBe(true);
    expect(all.length).toBe(steps.length);
  });
});
