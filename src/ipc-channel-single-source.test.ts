// IPC 频道名单源：传输调用点上不得使用裸字面量（r75）。
//
// ## 被守的缺陷
//
// `packages/shared/src/channel/channel-contract.ts` 的 `IPC` 表是频道名**单源**（§1.3）：
// 210 条 `IPC.<组>.<名> = "<wire 字符串>"`。单源的意义是"改一处、所有引用同时变"，
// 而这个意义**只有在所有调用点都走常量时才成立**。
//
// r75 实测有 **34 处**传输调用点用裸字面量（分布在 5 个文件），其中包括最核心的会话推送：
// `gateway.broadcast("session:event", event)`、`transport.on("session:event", …)`、
// `broadcast("settings:changed")`、`"skills:changed"`、`"window:maximizedChanged"` 等。
// 已全部改成走 `IPC.*` 常量。
//
// 为什么这是缺陷而不只是风格问题——两种失败模式都**静默**：
//   ① 改表里的 wire 字符串 ⇒ 走常量的调用点跟着变、走字面量的**留在旧名字上**，
//      于是推送方与接收方名字不再一致：**消息发出去没人收**，不报错、不警告；
//   ② 字面量拼错一个字符 ⇒ 同上，而且 tsc 完全不报（字符串字面量没有类型约束）。
// 反过来，走常量时这两种情况都变成**编译期错误**（`IPC.session.evet` 不存在）。
//
// ⚠ 这条守卫之所以必要：字面量与常量**都能编译通过、都能跑**，
//   所以没有任何其它机制会拦住回潮——只有这条静态对账能。
//
// ## 判据
//
// 在传输调用点（`.register(` / `.broadcast(` / `.invoke(` / `.on(` / `.off(`）的**第一个实参**上，
// 若出现字符串字面量且该字面量等于 IPC 表里某个 wire 值 ⇒ 违规。
// 表里的 wire 值从源码解析（不另抄一份）。
//
// 边界：只判传输调用点的第一个实参，不判任意字符串——
// 因为 wire 值也可能合法地出现在别处（日志文案、测试断言、文档）。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CONTRACT = "packages/shared/src/channel/channel-contract.ts";
const CORPUS_ROOTS = ["src/server", "src/web", "packages/react/src", "src/plugins"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(full, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !full.includes("/locales/")) out.push(full);
  }
  return out;
}

/** 从 IPC 表解析全部 wire 字符串（嵌套结构，按深度跟踪前缀）。 */
function wireValues(): Set<string> {
  const src = readFileSync(join(ROOT, CONTRACT), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
  const m = /export const IPC = \{/.exec(src);
  expect(m, "找不到 IPC 表（判据会空转）").toBeTruthy();
  let i = m!.index + m![0].length - 1;
  let depth = 0;
  const buf: string[] = [];
  while (i < src.length) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) break; }
    buf.push(c);
    i += 1;
  }
  const out = new Set<string>();
  for (const wm of buf.join("").matchAll(/:\s*"([^"]+)"/g)) out.add(wm[1]);
  return out;
}

/** 传输调用点上的裸字面量。 */
// ⚠ 不要给 `\.` 加左边界（首版写了 `(?:^|[^\w$])`）：真实形态是 `gateway.broadcast("…")`，
//   `.` 前面是 `y`（属 \w），于是**所有正常调用点都匹配不上**——症状是自检报
//   "一个走 IPC 常量的调用点都没扫到"与"裸字面量没被抓到"。`\.` 本身已经要求一个点，
//   左边界既多余又有害。
const CALL_WITH_LITERAL = /\.\s*(register|broadcast|invoke|on|off)\s*(?:<[^;(]*>)?\s*\(\s*"([^"]+)"/g;

describe("IPC 频道名单源：传输调用点不得用裸字面量", () => {
  const wires = wireValues();
  const files = CORPUS_ROOTS.flatMap((r) => walk(join(ROOT, r))).map((f) => ({
    file: relative(ROOT, f),
    src: readFileSync(f, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"),
  }));

  it("判据不空转：解析到了 IPC 表，且语料里确实有走常量的调用点", () => {
    // r75 实测：208 个 wire 值（表里 210 条，其中少数是嵌套组名）
    expect(wires.size, `只解析到 ${wires.size} 个 wire 值（r75 实测 200+）⇒ 表解析可能坏了`).toBeGreaterThan(180);
    expect(files.length, `语料只有 ${files.length} 个文件`).toBeGreaterThan(300);
    // 自检：已知走常量的调用点必须存在（否则"0 处字面量"可能只是因为语料没扫到调用点）
    const constCalls = files.filter((f) => /\.\s*(?:register|broadcast|invoke|on)\s*(?:<[^;(]*>)?\s*\(\s*IPC\./.test(f.src));
    // r75 实测正好 20 个文件里有走常量的调用点（阈值按实测钉，不凭想象写 >20）
    expect(constCalls.length, "走 IPC 常量的传输调用点一个都没扫到 ⇒ 语料或判据坏了（那会让①恒真）").toBeGreaterThanOrEqual(20);
    // 自检：已知的 wire 值必须在表里
    for (const w of ["session:event", "session:question", "settings:changed", "skills:changed"]) {
      expect(wires.has(w), `自检失败：已知 wire 值 ${w} 没被解析出来`).toBe(true);
    }
  });

  it("① 传输调用点上不得出现与 IPC 表重复的裸字面量（改表会静默断线、拼错 tsc 不报）", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (f.file.endsWith("channel-contract.ts")) continue; // 表自身就是字面量
      CALL_WITH_LITERAL.lastIndex = 0;
      for (const m of f.src.matchAll(CALL_WITH_LITERAL)) {
        if (wires.has(m[2])) {
          const line = f.src.slice(0, m.index!).split("\n").length;
          bad.push(`${f.file}:${line}  .${m[1]}("${m[2]}")`);
        }
      }
    }
    expect(bad, [
      `${bad.length} 处传输调用点用了裸字面量（应走 IPC 常量）：`,
      ...bad.slice(0, 14).map((x) => `      ${x}`),
      `      后果（两种都静默）：① 改表里的 wire 字符串 ⇒ 走常量的调用点跟着变、`,
      `        走字面量的留在旧名字上 ⇒ **推送方与接收方名字不一致，消息发出去没人收**；`,
      `        ② 字面量拼错一个字符 ⇒ 同上，且 tsc 完全不报。`,
      `      修法：改成 IPC.<组>.<名>（缺 import 就补 import { IPC } from "@my-harness-desktop/shared"）。`,
      `      ⚠ 若这个字面量**不在** IPC 表里，本条不会报——那说明它是个未登记的频道，`,
      `        应当先加进表（表是单源），再引用常量。`,
    ].join("\n")).toEqual([]);
  });

  it("② 自检：判据抓得到**故意写回字面量**的调用点（否则①恒真）", () => {
    const probe = (code: string): string[] => {
      CALL_WITH_LITERAL.lastIndex = 0;
      const out: string[] = [];
      for (const m of code.matchAll(CALL_WITH_LITERAL)) if (wires.has(m[2])) out.push(m[2]);
      return out;
    };
    expect(probe('gateway.broadcast("session:event", event);'), "自检失败：broadcast 的裸字面量没被抓到").toEqual(["session:event"]);
    expect(probe('transport.on("skills:changed", listener);'), "自检失败：on 的裸字面量没被抓到").toEqual(["skills:changed"]);
    expect(probe('gateway.register("settings:changed", h);'), "自检失败：register 的裸字面量没被抓到").toEqual(["settings:changed"]);
    // 正例：走常量的不得被判违规
    expect(probe("gateway.broadcast(IPC.session.event, event);"), "自检失败：走常量的调用被误判").toEqual([]);
    // 反例：不在表里的字面量不由本条管（避免把日志文案、测试夹具都算进来）
    expect(probe('transport.on("some:unregistered", h);'), "自检失败：表外的字面量被算进来了").toEqual([]);
  });
});
