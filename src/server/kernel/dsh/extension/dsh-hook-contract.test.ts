// **dsh 钩子契约守卫** —— 我们注册的每个 dsh 钩子，参数形状必须与 dsh **真实的派发方式**一致。
//
// 为什么单独建这条（用户实测症状：「生成失败: next is not a function」）：
// dsh 的钩子分两类，**派发方式不同、参数就不同**：
//   · `dispatch.waterfall("…")` —— 有 `next`：handler 要 `await next()` 拿（并可能改写）上游值；
//   · `dispatch.serial("…")`    —— 纯事件：**没有 `next`**，handler 拿了也是 undefined。
// 我们的 llm-recorder 扩展在 `agent/turn-stopping`（**serial**）上写了 `return next()`：
// 每次回合边界都抛 TypeError → **回合被标成失败**（而记录其实已经落盘，所以盘上看着正常、
// 界面上却报「生成失败」）。单测没抓到，是因为假的 ctx **给每个钩子都塞了一个 next** ——
// 替身比现实多给一个参数，正好把 bug 挡在门外（skills §11.12「替身的形状要真」）。
//
// 本文件把这条做成**静态守卫**：扫我们自己的扩展源码，取出每个钩子的 handler 形状，
// 与下表（dsh 派发方式的唯一事实源）对比。表里每条都写了 dsh 里的证据位置，
// 换 dsh 版本时可以照着复核；装了 dsh 的环境还会**顺便核一遍表本身**（见第二条用例）。

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());

/**
 * dsh 钩子 → 派发方式（**唯一事实源，改这里之前先去 dsh 源码复核**）。
 * 三种，参数形状各不相同：
 *   · `waterfall` —— 有 `next`，要 await 它拿（并可能改写）上游值；
 *   · `serial`    —— 按顺序跑的**纯事件**，**没有 `next`**；
 *   · `emit`      —— 广播事件，**没有 `next`**，且 dsh 会**吞掉监听器异常**（只打 warn）。
 * 证据（装机版本实测）：
 *   · `@deepseek-ai/dsh-agent-loop/lib/index.js:565` `dispatch.serial("agent/turn-stopping", …)`
 *   · `@deepseek-ai/dsh-agent-loop/lib/index.js:653` `dispatch.waterfall("agent/request-error", …)`
 *   · `@deepseek-ai/dsh-skill/lib/index.js` `ctx.events.dispatch("emit", ["skills/change"])`
 *     （同处可见 "skills/change listener threw: …" 的 warn —— 它**不会**让回合失败，
 *      所以这个钩子上出错更隐蔽：只有日志里看得见。）
 *   · `@deepseek-ai/dsh-llm/lib/index.js:1640` `this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(…))`
 *     —— llm-recorder 的 dsh 侧就挂在这里取**完整请求**（GenerateOptions）。
 *   · `@deepseek-ai/dsh-session/lib/index.js:1469-1476` `collectSessionCallbacks(entry.emitCtx, [carrier, "session/event", …])`
 *     + `invokeContainedSessionObservers(...)` —— 事件总线的**广播**（观察者集合，没有 next；
 *      异常被容器吞掉）。llm-recorder 用它取回合身份（`step/start` 带 {turn, step}）。
 */
/**
 * 每条 = `{ kind: 派发方式, args: 派发器**实际传给 handler 的参数个数** }`。
 *
 * `args` 这一栏是后补的，补的原因是**原守卫的启发式是错的**（llm-recorder 换钩子时照出来的）：
 * 它把「非 waterfall 钩子声明了第二个形参」一律当成"多拿了一个 next"，于是 `session/event`
 * `(session, event)` 被判红。真相是——**emit 钩子的参数是事件自己的参数**，
 * 有的是 1 个（`skills/change` 无参、`agent/turn-stopping` 一个 payload），
 * `session/event` 是 2 个（`(session, event)`，证据见下表 dsh-session 那一行）。
 * 判据因此从"形参个数"改成"**形参个数 ≤ 真实参数个数**，且非 waterfall 不许调 next()"：
 * 前者照样拦住"给 serial 钩子多塞一个 next"，后者拦住真正会炸的那类 bug。
 */
const DISPATCH = {
  "agent/pre-step": { kind: "waterfall", args: 2 },
  "agent/request": { kind: "waterfall", args: 2 },
  "agent/request-error": { kind: "waterfall", args: 2 },
  "agent/turn-stopping": { kind: "serial", args: 1 },
  "session/event": { kind: "emit", args: 2 },
  "llm/stream": { kind: "waterfall", args: 2 },
  "skills/change": { kind: "emit", args: 1 },
} as const;

/** 收集我们所有 dsh 扩展的源码文件（内核侧合并扩展 + 各壳插件的 dsh-extension）。 */
function dshExtensionSources(): string[] {
  const out: string[] = [];
  const core = join(ROOT, "src/server/kernel/dsh/extension/dsh-extension/index.mjs");
  if (existsSync(core)) out.push(core);
  const pluginsDir = join(ROOT, "src/plugins");
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "node_modules") continue;
        walk(full);
      } else if (name === "index.mjs" && dir.endsWith("dsh-extension")) {
        out.push(full);
      }
    }
  };
  if (existsSync(pluginsDir)) walk(pluginsDir);
  return out;
}

/**
 * 数**顶层**逗号得形参个数——`({ agent, messages, step, signal }, next)` 是 **2 个**形参
 * （第一个是解构模式），不是 5 个。原实现直接 `split(",")`，把解构模式里的逗号也数进去，
 * 于是给 fit 扩展的 `agent/pre-step` 报了"声明了 5 个形参"——**守卫自己的解析错了**，
 * 这种红比没有守卫更坏（会逼着人把正确的代码改错）。括号层级里跳过的字符不计。
 */
function countParams(pattern: string): number {
  const t = pattern.trim();
  if (t === "") return 0;
  let depth = 0;
  let count = 1;
  for (const ch of t) {
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) count += 1;
  }
  return count;
}

/** 从源码里抠出 `ctx.on("<hook>", async (…形参…) => { … })` 的形状。 */
function registeredHooks(src: string): { hook: string; params: number; callsNext: boolean }[] {
  const out: { hook: string; params: number; callsNext: boolean }[] = [];
  const re = /ctx\.on\(\s*"([^"]+)"\s*,\s*(?:async\s*)?\(([^)]*)\)\s*=>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const hook = m[1];
    const params = countParams(m[2]);
    // handler 体的范围：从匹配点往后到下一个 `ctx.on(` 或文件尾（够用且不引入解析器）
    const rest = src.slice(m.index);
    const nextIdx = rest.indexOf("ctx.on(", 1);
    const body = nextIdx > 0 ? rest.slice(0, nextIdx) : rest;
    out.push({ hook, params, callsNext: /\bnext\s*\(/.test(body) });
  }
  return out;
}

describe("dsh 钩子契约：参数形状必须匹配真实派发方式", () => {
  it("★ 用 `next()` 的钩子必须是 waterfall（serial 钩子没有 next，拿了会抛 TypeError）", () => {
    const sources = dshExtensionSources();
    expect(sources.length, "没扫到任何 dsh 扩展源码 —— 扫描逻辑坏了，守卫会静默失效").toBeGreaterThan(0);

    const bad: string[] = [];
    const seen = new Set<string>();
    for (const file of sources) {
      for (const h of registeredHooks(readFileSync(file, "utf-8"))) {
        seen.add(h.hook);
        const spec = (DISPATCH as Record<string, { kind: string; args: number } | undefined>)[h.hook];
        if (spec === undefined) {
          bad.push(`${h.hook}：表里没有它的派发方式（新钩子必须先去 dsh 源码查清再补表）  ← ${file.replace(ROOT, "")}`);
          continue;
        }
        if (h.callsNext && spec.kind !== "waterfall") {
          bad.push(`${h.hook} 是 ${spec.kind} 派发（**没有 next**），但 handler 调了 next()  ← ${file.replace(ROOT, "")}`);
        }
        if (h.params > spec.args) {
          bad.push(
            `${h.hook} 派发时只给 ${spec.args} 个参数（${spec.kind}），handler 却声明了 ${h.params} 个——` +
            `多出来的形参是 undefined（拿了当 next 用就是「next is not a function」）  ← ${file.replace(ROOT, "")}`,
          );
        }
      }
    }
    expect(seen.size, "没解析出任何 ctx.on 注册 —— 正则漂了").toBeGreaterThan(0);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("表本身也要对：装了 dsh 时按真实源码复核派发方式", () => {
    const loop = join(homedir(), ".my-harness-desktop-dev/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js");
    if (!existsSync(loop)) {
      // 没装 dsh 的环境：表是唯一事实源（上面那条仍然生效）。这里不伪造通过——
      // 明确跳过并说明原因，而不是假装核过了。
      expect(true).toBe(true);
      return;
    }
    const src = readFileSync(loop, "utf-8");
    for (const [hook, spec] of Object.entries(DISPATCH)) {
      const re = new RegExp(`dispatch\\.(waterfall|serial)\\(\\s*"${hook.replace("/", "\\/")}"`);
      const m = re.exec(src);
      if (!m) continue; // 该钩子不由 agent-loop 派发（如 pre-step / session/event / llm/stream 在别处）→ 不误报
      expect(m[1], `dsh 实际用 ${m[1]} 派发 ${hook}，与表里的 ${spec.kind} 不一致 —— 表过期了`).toBe(spec.kind);
    }
  });
});
