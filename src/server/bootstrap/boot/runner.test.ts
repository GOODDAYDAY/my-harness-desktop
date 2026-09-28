// `runColdBoot` 的失败策略分派守卫 —— 设计文档 §6.2.1。
//
// **断言必须在 runner 级做，不能在步骤级做**：文档第一版写错过（要求"degrade 步骤的 run
// 不抛出、且自己 console.error"），而 §4.3.1/§4.3.2 规定的恰恰相反——degrade 步骤**可以**抛出，
// 由 `runColdBoot` 捕获并打 `[boot:<step.id>]`。按草稿写的守卫会把符合正文的步骤判红。
//
// 三种策略的真实差别是「**后续步骤还跑不跑**」，所以每条断言都带一个记录执行顺序的探针步骤：
//   · fatal      → runColdBoot 抛出，后续步骤**未执行**
//   · degrade    → 不抛出，console.error 含 `[boot:<id>]`，后续步骤**照常执行**
//   · background → 不抛出且**不 await**，内部链的失败被步骤自己 `.catch` 兜住，无未捕获拒绝
//
// 步骤产物是测试**真实写出的 `.js` 模块**（不是内存替身）：走完整的
// scanBootSteps → validateBootStep → topoSort → runColdBoot 链路，所以顺带覆盖了
// "计划构建失败"与"空计划即抛"两条路径。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBootContext } from "./context";
import { runColdBoot } from "./runner";
import { createNodeHost } from "../../host/node-host";
import type { BootContext } from "./types";

let root: string;
let stepsDir: string;
let probe: string[];

/** 跨模块探针的持有者。步骤产物是测试写出的独立 `.js` 模块，它们与测试不共享词法作用域，
 *  所以执行顺序只能经一个全局数组传递——这是"被测代码是真实模块"的必要代价，
 *  比用 vi.mock 掉整条 scan→sort→run 链路诚实得多。 */
function probeHolder(): { __BOOT_PROBE__?: string[] } {
  return globalThis as unknown as { __BOOT_PROBE__?: string[] };
}

/** 写出一个步骤产物。`body` 是 run 的函数体源码。 */
function writeStep(id: string, opts: { scope?: string; failure: string; requires?: string[]; body: string }): void {
  const src = `
const step = {
  id: ${JSON.stringify(id)},
  scope: ${JSON.stringify(opts.scope ?? "global")},
  failure: ${JSON.stringify(opts.failure)},
  ${opts.requires ? `requires: ${JSON.stringify(opts.requires)},` : ""}
  run(ctx) { ${opts.body} },
};
module.exports = step;
`;
  writeFileSync(join(stepsDir, `${id}.js`), src, "utf-8");
}

/** 记录执行顺序的探针步骤（写到全局数组，跨模块可见）。 */
function probeBody(label: string): string {
  return `globalThis.__BOOT_PROBE__.push(${JSON.stringify(label)});`;
}

function makeCtx(): BootContext {
  return createBootContext(createNodeHost(), join(root, "renderer"), {
    isPackaged: false,
    homeDir: root,
    cwd: root,                       // → bootStepsRoot = <root>/out/main/boot/steps
    resourcesPath: "",
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cold-boot-"));
  stepsDir = join(root, "out", "main", "boot", "steps");
  mkdirSync(stepsDir, { recursive: true });
  probe = [];
  probeHolder().__BOOT_PROBE__ = probe;
});

afterEach(() => {
  delete probeHolder().__BOOT_PROBE__;
  rmSync(root, { recursive: true, force: true });
});

describe("runColdBoot：三级失败中的计划级", () => {
  it("空步骤目录 → 抛（不静默启动一台什么都没装的壳）", async () => {
    await expect(runColdBoot(makeCtx())).rejects.toThrow(/启动步骤目录为空或不可读/);
    expect(probe).toEqual([]);
  });

  it("步骤缺 run → 校验抛（validateBootStep 规则 6），且发生在执行任何步骤之前", async () => {
    writeStep("10-ok", { failure: "fatal", body: probeBody("10-ok") });
    writeFileSync(join(stepsDir, "20-bad.js"), "module.exports = { id: '20-bad', scope: 'global', failure: 'fatal' };", "utf-8");
    await expect(runColdBoot(makeCtx())).rejects.toThrow(/run 不是函数/);
    expect(probe, "计划构建失败时不该执行任何步骤").toEqual([]);
  });

  it("requires 指向不存在的步骤 → 校验抛（规则 7），不静默忽略后以错误顺序执行", async () => {
    writeStep("10-ok", { failure: "fatal", requires: ["99-ghost"], body: probeBody("10-ok") });
    await expect(runColdBoot(makeCtx())).rejects.toThrow(/requires 了不存在的步骤 "99-ghost"/);
    expect(probe).toEqual([]);
  });

  it("成环 → 拓扑排序抛，消息说清涉及哪些步骤", async () => {
    writeStep("10-a", { failure: "fatal", requires: ["20-b"], body: probeBody("a") });
    writeStep("20-b", { failure: "fatal", requires: ["10-a"], body: probeBody("b") });
    await expect(runColdBoot(makeCtx())).rejects.toThrow(/循环依赖/);
    expect(probe).toEqual([]);
  });
});

describe("runColdBoot：步骤级 fatal", () => {
  it("fatal 步骤抛出 → runColdBoot 冒泡，且后续步骤未执行", async () => {
    writeStep("10-ok", { failure: "fatal", body: probeBody("10-ok") });
    writeStep("20-boom", { failure: "fatal", requires: ["10-ok"], body: `throw new Error("结构性失败");` });
    writeStep("30-after", { failure: "fatal", requires: ["20-boom"], body: probeBody("30-after") });

    await expect(runColdBoot(makeCtx())).rejects.toThrow(/结构性失败/);
    expect(probe).toEqual(["10-ok"]);           // 30-after 未执行
  });

  it("fatal 步骤抛出时不打降级留痕（它是致命失败，不该被记成「已降级」）", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeStep("10-boom", { failure: "fatal", body: `throw new Error("x");` });
    await expect(runColdBoot(makeCtx())).rejects.toThrow(/x/);
    expect(err.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("[boot:10-boom]");
    err.mockRestore();
  });
});

describe("runColdBoot：步骤级 degrade", () => {
  it("degrade 步骤抛出 → 不冒泡、留痕含 [boot:<step.id>]、后续步骤照常执行", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeStep("10-ok", { failure: "fatal", body: probeBody("10-ok") });
    writeStep("20-soft", { failure: "degrade", requires: ["10-ok"], body: `throw new Error("可降级失败");` });
    writeStep("30-after", { failure: "fatal", requires: ["20-soft"], body: probeBody("30-after") });

    const ctx = await runColdBoot(makeCtx());     // 不抛
    expect(ctx).toBeTruthy();
    const logged = err.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).toContain("[boot:20-soft]");
    expect(logged).toContain("可降级失败");
    expect(probe, "degrade 失败不该阻断后续步骤").toEqual(["10-ok", "30-after"]);
    err.mockRestore();
  });

  it("degrade 的异步 run 拒绝同样被兜住（不只兜同步抛出）", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeStep("10-async-soft", { failure: "degrade", body: `return Promise.reject(new Error("异步可降级"));` });
    writeStep("20-after", { failure: "fatal", requires: ["10-async-soft"], body: probeBody("20-after") });
    await runColdBoot(makeCtx());
    expect(err.mock.calls.map((c) => c.map(String).join(" ")).join("\n")).toContain("[boot:10-async-soft]");
    expect(probe).toEqual(["20-after"]);
    err.mockRestore();
  });
});

describe("runColdBoot：步骤级 background", () => {
  it("background 步骤不被 await（后续步骤先跑完），且其内部链的拒绝不成为未捕获拒绝", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      writeStep("10-bg", {
        failure: "background",
        // 与真实的 95-kernel-reconcile 同形状：void 掉内部异步链并各带 .catch
        body: `void Promise.resolve().then(() => { globalThis.__BOOT_PROBE__.push("bg-later"); })
                 .catch((e) => console.error("[bg]", e));
               globalThis.__BOOT_PROBE__.push("10-bg-sync");`,
      });
      writeStep("20-after", { failure: "fatal", requires: ["10-bg"], body: probeBody("20-after") });

      await runColdBoot(makeCtx());
      // run 的同步部分已执行；后续步骤也跑完了。异步尾巴可能还没落，故只断言前两项的相对顺序。
      expect(probe[0]).toBe("10-bg-sync");
      expect(probe).toContain("20-after");
      expect(probe.indexOf("10-bg-sync")).toBeLessThan(probe.indexOf("20-after"));
      await new Promise((r) => setTimeout(r, 30));
      expect(probe, "background 的异步尾巴最终仍会执行（只是不被 await）").toContain("bg-later");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", unhandled);
      err.mockRestore();
    }
  });

  it("background 步骤的 run **同步**抛出仍被步骤级 catch 兜住（否则 background 语义被破坏）", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    writeStep("10-bg-boom", { failure: "background", body: `throw new Error("同步炸");` });
    writeStep("20-after", { failure: "fatal", requires: ["10-bg-boom"], body: probeBody("20-after") });
    await runColdBoot(makeCtx());               // 不抛
    expect(err.mock.calls.map((c) => c.map(String).join(" ")).join("\n")).toContain("[boot:10-bg-boom]");
    expect(probe).toEqual(["20-after"]);
    err.mockRestore();
  });
});

describe("runColdBoot：执行顺序与返回值", () => {
  it("按拓扑序执行（requires 决定，不是文件名顺序）", async () => {
    writeStep("90-late", { failure: "fatal", requires: ["10-early"], body: probeBody("90-late") });
    writeStep("10-early", { failure: "fatal", body: probeBody("10-early") });
    await runColdBoot(makeCtx());
    // 文件名序 10 < 90 恰好也是拓扑序，所以再加一个反向命名的用例才真的证明是边在决定
    expect(probe).toEqual(["10-early", "90-late"]);
  });

  it("剥掉前缀后仍按 requires 执行（顺序来自边而非命名）", async () => {
    writeStep("20-second", { failure: "fatal", requires: ["80-first"], body: probeBody("second") });
    writeStep("80-first", { failure: "fatal", body: probeBody("first") });
    await runColdBoot(makeCtx());
    expect(probe).toEqual(["first", "second"]);
  });

  it("返回同一个 ctx 对象（步骤写入的字段可被组装根读回）", async () => {
    writeStep("10-write", { failure: "fatal", body: `ctx.localToken = "written-by-step";` });
    const ctx = makeCtx();
    const out = await runColdBoot(ctx);
    expect(out).toBe(ctx);
    expect(out.localToken).toBe("written-by-step");
  });
});
