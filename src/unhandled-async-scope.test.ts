// 未处理异步的**作用域级**普查（棘轮 + 反假阳性锚，r85）。
//
// ## 为什么 r84 交不出守卫，而 r85 能
//
// r84 用"往上 N 行找 `try {`"的**行窗口启发式**扫 `await window.kernel.*`，得到 29 处，
// 抽查即崩：`settings-page.tsx` 的保存路径其实是完整的 `try/catch/finally`（r80 的正确形态），
// `remote-access` 的 6 处全走集中包装器 `run()`。所以按 r77 的纪律**没有交那条守卫**
// （判据没把握就不交，硬交会产出 29 处假阳性，逼人加豁免，豁免一加守卫就废）。
//
// 本轮把判据升级成**作用域级**，三个要素：
//   ① **花括号配对**的 try 范围（不是行窗口）；
//   ② 语句级 `.catch(`；
//   ④ **链式保护**（r98 新增）：`.then(async …)` 的回调体内抛错会让整条链 reject，
//      所以链尾有 `.catch(` 时，回调体内的 await 也算已保护。
//      首版没有这一条，于是 r97 给 settings-page 加载链补了链尾 .catch 之后棘轮计数**没降**
//      （判据漏了一种保护形态）。识别办法：花括号配对取回调体 + 检查体后是否紧跟 `.catch(`。
//   ③ **集中包装器识别**：文件内形如
//      `const run = async (fn: () => Promise<unknown>) => { … try { await fn(); } catch … }`
//      的函数——凡在它调用点范围内的 await 都算已保护。
//      ⚠ 参数表要用**括号配对**取，不能用 `[^)]*`：参数类型 `fn: () => Promise<unknown>`
//      里就含 `)`，正则会在它面前截断（r73 那条教训的第三次应验）。
//      实测识别到 3 个包装器：`run`（remote-access）、`runOp`（plugin-manager，r80）、
//      `mutate`（stickers，r83）——**正是最近三轮建的那三个收敛点**，
//      这本身就是对判据的一次交叉验证：它认得出"正确的形态"长什么样。
//
// ## 本轮交什么、不交什么（如实）
//
// 交：**度量 + 棘轮 + 反假阳性锚**。实测真正未保护的 await 共 **54** 处。
// 不交：**逐处分类账本**。因为分类要按"层职责"判断（`stickers-store.ts` 10 处、
// `general-config.ts` 3 处都是 **store 层**，把错误抛给调用方是**正确设计**——r83/r84 的结论；
// `settings-page.tsx` 11 处要逐个看是读路径还是用户动作），一轮做不完，
// 而半分类的账本比没有账本更糟（它给人一种"已经审过了"的错觉）。
// 所以本轮用棘轮钉住"不许增长"，用反假阳性锚钉住"判据不许退化"，分类留给后续轮次消化。
//
// > 通则：**判据升级到位、但分类工作量超出一轮时，交"棘轮 + 锚"而不是"半个账本"**。
// > 棘轮保证债务不增长，锚保证判据不退化，两者合起来让后续每一轮都能安全地往下消化。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CORPUS = ["src/plugins", "src/web", "packages/react/src"];
/** r85 实测基线。只许减少；每消化一批就下调。 */
const CEILING = 42;   // r85 基线 54 → r86 修 5 处 → 49 → r98 认得链式保护 → 46 → r103 修 doClearProject/doReset → 42（只许继续减少）

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

/** 从 openIdx（指向开括号）返回配对闭括号的下标。 */
function matchDelim(s: string, openIdx: number, o = "{", c = "}"): number {
  let d = 0;
  for (let j = openIdx; j < s.length; j += 1) {
    if (s[j] === o) d += 1;
    else if (s[j] === c) { d -= 1; if (d === 0) return j; }
  }
  return s.length;
}

interface Site { file: string; line: number; api: string; code: string }

function analyze(rel: string, s0: string): { sites: Site[]; wrappers: string[] } {
  const s = s0.replace(/\/\*[\s\S]*?\*\//g, "");
  const tries: [number, number][] = [];
  for (const m of s.matchAll(/\btry\s*\{/g)) {
    const o = m.index! + m[0].length - 1;
    tries.push([o, matchDelim(s, o)]);
  }
  const wrapRanges: [number, number][] = [];
  // ④ **链式保护**（r98）：`void p.then(async (…) => { …await X… }).catch(…)` 这种形状里，
  //   回调体内的 await 既不在 try{} 里、也没有语句级 .catch，但**语义上是被保护的**——
  //   async 回调里抛错 ⇒ 整条链 reject ⇒ 链尾 .catch 接住。r97 给 settings-page 的
  //   加载链补了链尾 .catch，棘轮计数却没降，就是这个原因（判据漏了一种保护形态）。
  //   识别办法：定位每个 `.then(`，用**花括号配对**取出回调体范围，再看体结束后
  //   紧跟的少量字符里有没有 `.catch(`（允许 `)` 与空白）。
  const chainRanges: [number, number][] = [];
  for (const m of s.matchAll(/\.then\s*\(/g)) {
    const bodyOpen = s.indexOf("{", m.index! + m[0].length);
    if (bodyOpen < 0 || bodyOpen - (m.index! + m[0].length) > 120) continue; // 不是内联回调
    const bodyEnd = matchDelim(s, bodyOpen);
    const tail = s.slice(bodyEnd, bodyEnd + 40);
    if (/^[)\s]*(?:\}\s*)?\)?[\s)]*\.catch\s*\(/.test(tail) || tail.includes(".catch(")) {
      chainRanges.push([bodyOpen, bodyEnd]);
    }
  }
  const wrappers: string[] = [];
  for (const m of s.matchAll(/(?:const|let)\s+(\w+)\s*=\s*async\s*\(/g)) {
    const name = m[1];
    const po = m.index! + m[0].length - 1;
    const pe = matchDelim(s, po, "(", ")");
    const pm = /^\s*(\w+)\s*:/.exec(s.slice(po + 1, pe));
    if (!pm) continue;
    const param = pm[1];
    const bo = s.indexOf("{", pe);
    if (bo < 0) continue;
    const body = s.slice(bo, matchDelim(s, bo));
    if (new RegExp(`try\\s*\\{[\\s\\S]*?await\\s+${param}\\s*\\(`).test(body) && body.includes("catch")) {
      wrappers.push(name);
      for (const c of s.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))) {
        wrapRanges.push([c.index! + c[0].length, Math.min(s.length, c.index! + c[0].length + 1200)]);
      }
    }
  }
  const sites: Site[] = [];
  const lines = s.split("\n");
  for (const m of s.matchAll(/\bawait\s+(window\.kernel\.[\w.$[\]]+|ctx\.[\w.]+)\s*\(/g)) {
    const pos = m.index!;
    if (tries.some(([a, b]) => a <= pos && pos <= b)) continue;
    if (wrapRanges.some(([a, b]) => a <= pos && pos <= b)) continue;
    if (chainRanges.some(([a, b]) => a <= pos && pos <= b)) continue;   // 链尾有 .catch ⇒ 已保护
    const semi = s.indexOf(";", pos);
    if (s.slice(pos, semi > 0 ? semi : pos + 240).includes(".catch(")) continue;
    const line = s.slice(0, pos).split("\n").length;
    const code = (lines[line - 1] ?? "").trim();
    if (code.startsWith("//") || code.startsWith("*")) continue;
    sites.push({ file: rel, line, api: m[1], code: code.slice(0, 90) });
  }
  return { sites, wrappers };
}

describe("未处理异步（作用域级判据）：棘轮 + 反假阳性锚", () => {
  const files = CORPUS.flatMap((r) => walk(join(ROOT, r)));
  const perFile = files.map((f) => ({ rel: relative(ROOT, f), ...analyze(relative(ROOT, f), readFileSync(f, "utf-8")) }));
  const sites = perFile.flatMap((p) => p.sites);
  const wrappers = perFile.flatMap((p) => p.wrappers.map((w) => `${p.rel.split("/").pop()}:${w}`));

  it("判据不空转：语料规模正常，且**认得出集中包装器**（否则会把已保护的算成未保护）", () => {
    // r85 实测 229 个（语料是 src/plugins + src/web + packages/react/src，**不含 src/server**——
    //   服务端不走 window.kernel/ctx，判据对它无意义。首版凭 r77 的 407 写了 >300，那是含服务端的语料）
    expect(files.length, `语料只有 ${files.length} 个文件（r85 实测 229）⇒ 路径判据可能坏了`).toBeGreaterThan(200);
    // ⚠ 反假阳性锚①：r80/r83/r84 建的三个收敛点必须被识别成包装器
    for (const w of ["runOp", "mutate", "run"]) {
      expect(wrappers.some((x) => x.endsWith(`:${w}`)),
        `自检失败：集中包装器 ${w} 没被识别 ⇒ 它保护的调用点会被误报（r84 首版就是这样，因为参数表用了 [^)]* 正则）`).toBe(true);
    }
  });

  it("① 反假阳性锚：已知**已保护**的调用点不得出现在未保护名单里", () => {
    // 这三处是 r84 行窗口启发式的假阳性来源，必须确认作用域判据不再误报
    const fp = sites.filter((s) =>
      (s.file.endsWith("remote-access/renderer/index.tsx") && s.api.startsWith("window.kernel.remote.")) ||
      (s.file.endsWith("settings-page.tsx") && s.code.includes("configFile.set(activeConfigFile")) ||
      (s.file.endsWith("plugin-manager/renderer/index.tsx") && s.api === "ctx.plugins.list"));
    expect(fp.map((s) => `${s.file}:${s.line} ${s.api}`), [
      `${fp.length} 处已保护的调用点被误报：`,
      "      判据退化了（try 范围没配对成功？包装器没识别？），先修判据再看数字。",
    ].join("\n")).toEqual([]);
  });

  it("② 棘轮：作用域级未保护的 await 总数只许减少（r85 基线 54）", () => {
    expect(sites.length, [
      `未保护的 await 从 ${CEILING} 涨到了 ${sites.length}。`,
      "      判据是作用域级的（花括号配对的 try 范围 + 语句级 .catch + 集中包装器识别），",
      "      所以新增的大概率是真的没兜底：服务端抛错时 transport 会 reject，",
      "      用户侧表现为「什么都没发生」（§7.6 禁止的静默失败）。",
      "      修法按**层职责**选：",
      "        · 用户动作层（handler / 组件回调）⇒ 接住并给用户可见反馈（参考 r80 的 runOp、r83 的 mutate）；",
      "        · store / 工具层 ⇒ **该抛**（让调用方决定），此时把该文件登记进下面的分层账本而不是加 try。",
    ].join("\n")).toBeLessThanOrEqual(CEILING);
  });

  it("③ 分层事实：store/工具层的未保护点是**设计如此**，其数量要被钉住（防止被误当成待修）", () => {
    // r83/r84 的结论：store 层把错误抛给调用方是正确的（缺兜底的应在最外层用户动作层）。
    // 这几个文件的未保护点属于"设计如此"，单独钉住数量，避免它们被混进"待修"里反复重审。
    const STORE_LAYER = ["stickers-store.ts", "general-config.ts", "squad-runner.ts", "stt-engine.ts"];
    const counts = new Map<string, number>();
    for (const s of sites) {
      const base = s.file.split("/").pop()!;
      if (STORE_LAYER.includes(base)) counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    // r85 实测：stickers-store 10 / general-config 3 / squad-runner 2 / stt-engine 2
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total, `store/工具层的未保护点数量变了（r85 实测 17）：${JSON.stringify([...counts])}`).toBeLessThanOrEqual(17);
  });
});
