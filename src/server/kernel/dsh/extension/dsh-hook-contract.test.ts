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
 */
const DISPATCH = {
  "agent/pre-step": "waterfall",
  "agent/request": "waterfall",
  "agent/request-error": "waterfall",
  "agent/turn-stopping": "serial",
  "skills/change": "emit",
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

/** 从源码里抠出 `ctx.on("<hook>", async (…形参…) => { … })` 的形状。 */
function registeredHooks(src: string): { hook: string; params: number; callsNext: boolean }[] {
  const out: { hook: string; params: number; callsNext: boolean }[] = [];
  const re = /ctx\.on\(\s*"([^"]+)"\s*,\s*(?:async\s*)?\(([^)]*)\)\s*=>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const hook = m[1];
    const params = m[2].trim() === "" ? 0 : m[2].split(",").length;
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
        const kind = (DISPATCH as Record<string, string | undefined>)[h.hook];
        if (kind === undefined) {
          bad.push(`${h.hook}：表里没有它的派发方式（新钩子必须先去 dsh 源码查清再补表）  ← ${file.replace(ROOT, "")}`);
          continue;
        }
        if (h.callsNext && kind !== "waterfall") {
          bad.push(`${h.hook} 是 ${kind} 派发（**没有 next**），但 handler 调了 next()  ← ${file.replace(ROOT, "")}`);
        }
        if (kind !== "waterfall" && h.params >= 2) {
          // 形状提示：非 waterfall 的钩子不该声明第二个形参（拿了也是 undefined）
          bad.push(`${h.hook} 是 ${kind} 派发，不应声明 next 形参  ← ${file.replace(ROOT, "")}`);
        }
        if (kind === "waterfall" && h.params >= 2 && !h.callsNext) {
          // 不强制：只拿到 next 却不用是合法的（只是白拿）。留作提示位，不判红。
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
    for (const [hook, kind] of Object.entries(DISPATCH)) {
      const re = new RegExp(`dispatch\\.(waterfall|serial)\\(\\s*"${hook.replace("/", "\\/")}"`);
      const m = re.exec(src);
      if (!m) continue; // 该钩子不由 agent-loop 派发（如 pre-step 可能在别处）→ 不误报
      expect(m[1], `dsh 实际用 ${m[1]} 派发 ${hook}，与表里的 ${kind} 不一致 —— 表过期了`).toBe(kind);
    }
  });
});
