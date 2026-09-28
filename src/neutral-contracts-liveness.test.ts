// 其余中立契约的活性对账：`SessionCatalog` / `KernelModelSource` / `BackendCapabilities` / `HostLifecycle`。
//
// r129（BackendCreateOptions）、r130（KernelSpec）、r131（BaseBackend）已各自成守卫；
// 本轮把剩下四个一次做完，判据同族但有三个**形态差别**，都值得记：
//
// ① **能力轴的消费方在插件里，且读的是投影后的名字**。
//    `BackendCapabilities.steering` 这类轴，壳侧是被 `projectCapabilityFlags` 用
//    `Object.entries(caps)` **泛化消费**的（所以按轴名搜壳侧永远搜不到），
//    真正按名字读的是 renderer 插件：`capabilities.faces.retry`、`opts.faces.thinking`。
//    ⇒ 调用方语料必须含 `src/plugins/**`，且判据要同时认 `caps.<axis>` 与 `faces.<axis>`。
//    （r108 的教训第三次应验：语料少一个根，就批量假阳性。）
// ② **`HostLifecycle.onReady` 是"文档要求但未接线"**，进账本而不是判死：
//    设计文档 web-service-architecture.md §20.1 明确要求它（能力映射表 + 接口清单 + 语义），
//    按 r102 的纪律不能单方面删；而它确实没有调用方（四处引用全是声明/实现）。
//    已在契约里写明状态、取证与两条出路（接上 / 双删）。
// ③ **方法契约的活性 = 有调用方 且 有实现侧**（r131 定的定义），可选成员同样要求有调用方。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CALL_ROOTS = ["src/server/application", "src/server/controllers", "src/server/bootstrap",
  "src/web", "src/plugins", "packages/react/src"];
const IMPL_ROOTS = ["src/server/kernel", "src/server/host", "src/server/client",
  "src/plugins/kernels", "test-plugins/kernels"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (name !== "node_modules" && !name.startsWith(".") && name !== "locales") walk(full, out); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}
function strip(s0: string): string {
  const s = s0.replace(/\/\*[\s\S]*?\*\//g, "");
  return s.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
}
function corpus(roots: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of roots) for (const f of walk(join(ROOT, r))) out.set(relative(ROOT, f), strip(readFileSync(f, "utf-8")));
  return out;
}
function ifaceMembers(file: string, iface: string): { name: string; optional: boolean }[] {
  const s = readFileSync(join(ROOT, file), "utf-8");
  const i = s.indexOf(`export interface ${iface}`);
  if (i < 0) return [];
  const body = s.slice(i, s.indexOf("\n}", i));
  return body.split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .map((l) => { const m = /^ {2}(\w+)(\??)\s*[:(]/.exec(l); return m ? { name: m[1], optional: m[2] === "?" } : null; })
    .filter((x): x is { name: string; optional: boolean } => !!x);
}

/** 已知的"文档要求但未接线"成员：进账本、不判死（每条写明取证与出路）。 */
const LEDGER: { iface: string; member: string; why: string; next: string }[] = [
  // r133 起为空：曾登记 HostLifecycle.onReady（文档 §20.1 要求但无调用方），
  // 本轮把它接上了（assemble 开头 await host.lifecycle.onReady），账本卫生检查随即要求删条目——
  // 这正是那条检查的用途：接线之后账本不许留着，否则下一个人会以为它仍未接线。
];

describe("其余中立契约：成员活性对账（SessionCatalog / KernelModelSource / BackendCapabilities / HostLifecycle）", () => {
  const B = "packages/shared/src/domain/backend.ts";
  const H = "packages/shared/src/domain/host.ts";
  const specs = [
    { iface: "SessionCatalog", file: B, callForm: (n: string) => `\\.\\s*${n}\\s*\\(` },
    { iface: "KernelModelSource", file: B, callForm: (n: string) => `\\.\\s*${n}\\s*\\(` },
    // 能力轴：壳侧泛化消费（Object.entries），按名字读的是 renderer 的 faces.<axis>
    // 能力轴有**三种**消费形态（r132 实测，少认一种就批量假阳性）：
    //   ① 壳侧泛化消费：projectCapabilityFlags 用 Object.entries(caps) 投影 ⇒ 按轴名搜不到；
    //   ② renderer 按投影后的名字读：capabilities.faces.retry / opts.faces.thinking；
    //   ③ **轴名作为字符串实参**：viaFace("modelCycle", …) / faceOf(proc, "toolExec", …)
    //      （r49 那套按轴取面的助手）。首版只认 ①②，于是 compaction/modelCycle/toolExec
    //      三个**活轴**被误报成"无读取方"。按轴取面的机制天然会把轴名变成字符串数据，
    //      所以"按名字搜消费方"的判据必须把"名字当字符串传"算进去
    //      （与 r106 第七类"键作变量传递"、r107 第八类"manifest 任意含点字符串值"同族）。
    { iface: "BackendCapabilities", file: B, callForm: (n: string) => `(?:caps|capabilities)\\s*\\??\\.\\s*${n}\\b|faces\\s*\\??\\.\\s*${n}\\b|(?:viaFace|faceOf)\\s*\\([^)]*["']${n}["']` },
    { iface: "HostLifecycle", file: H, callForm: (n: string) => `\\.\\s*${n}\\s*[?(<]` },
  ] as const;
  const callers = corpus(CALL_ROOTS);
  const impls = corpus(IMPL_ROOTS);

  it("判据不空转：四个契约都解析到成员，两侧语料非空且含插件与 test-plugins", () => {
    for (const sp of specs) {
      expect(ifaceMembers(sp.file, sp.iface).length, `${sp.iface} 解析出 0 个成员 ⇒ 名字或文件错了`).toBeGreaterThan(0);
    }
    expect(ifaceMembers(B, "SessionCatalog").length, "SessionCatalog 成员数（r132 实测 15）").toBeGreaterThanOrEqual(12);
    expect(ifaceMembers(B, "BackendCapabilities").length, "能力轴数（r132 实测 12）").toBeGreaterThanOrEqual(11);
    expect(callers.size).toBeGreaterThan(150);
    expect(impls.size).toBeGreaterThan(30);
    expect([...callers.keys()].some((p) => p.startsWith("src/plugins/")),
      "调用方语料必须含 src/plugins —— 能力轴是按 faces.<axis> 在插件里读的（漏了它就批量假阳性）").toBe(true);
    expect([...impls.keys()].some((p) => p.startsWith("test-plugins/")),
      "实现侧语料必须含 test-plugins（minimal/probe4 同级内核，r108）").toBe(true);
  });

  it("① 每个成员都有调用方/读取方（账本内的除外）", () => {
    const ledgered = new Set(LEDGER.map((l) => `${l.iface}.${l.member}`));
    const dead: string[] = [];
    for (const sp of specs) {
      for (const m of ifaceMembers(sp.file, sp.iface)) {
        if (ledgered.has(`${sp.iface}.${m.name}`)) continue;
        const re = new RegExp(sp.callForm(m.name));
        if (![...callers].some(([, t]) => re.test(t))) dead.push(`${sp.iface}.${m.name}`);
      }
    }
    expect(dead, [
      `${dead.length} 个契约成员没有任何调用方/读取方：${dead.join(", ")}`,
      "      方法契约无调用方 = 死契约成员（r72 删 resume? 的先例）；",
      "      能力轴无读取方 = 那条降级路径从没被 renderer 用过（轴存在但没人据此置灰）。",
      "      处置：接上调用方，或从契约删除并留退役说明（四条取证）；",
      "      若是『文档要求但未接线』，写进本文件的 LEDGER 并在契约里注明状态与出路。",
    ].join("\n")).toEqual([]);
  });

  it("② 每个成员都有实现侧/声明侧", () => {
    const dead: string[] = [];
    for (const sp of specs) {
      for (const m of ifaceMembers(sp.file, sp.iface)) {
        const re = new RegExp(`\\b(?:async\\s+)?${m.name}\\s*[:(]`);
        if (![...impls].some(([, t]) => re.test(t))) dead.push(`${sp.iface}.${m.name}`);
      }
    }
    expect(dead, [
      `${dead.length} 个契约成员在实现侧语料里找不到：${dead.join(", ")}`,
      "      可能是真没实现（运行时会炸），也可能是实现在语料外的目录 ⇒ 先确认语料范围再下结论。",
    ].join("\n")).toEqual([]);
  });

  it("③ 账本卫生：条目必须写清取证与出路，且不许已经接线了还留着", () => {
    for (const l of LEDGER) {
      expect(l.why.length, `${l.iface}.${l.member} 的取证写得太短`).toBeGreaterThan(40);
      expect(l.next.length, `${l.iface}.${l.member} 没写下一步出路`).toBeGreaterThan(20);
      const sp = specs.find((x) => x.iface === l.iface)!;
      const re = new RegExp(sp.callForm(l.member));
      const nowCalled = [...callers].some(([, t]) => re.test(t));
      expect(nowCalled,
        `${l.iface}.${l.member} 已经有调用方了 ⇒ 从 LEDGER 删掉，并同步更新契约里那段状态注释`).toBe(false);
    }
  });

  it("④ 自检：已知的活成员两侧都要命中（样本来自 r132 实测）", () => {
    const samples: [string, string][] = [
      ["SessionCatalog", "getTree"], ["SessionCatalog", "appendToolResult"],
      ["KernelModelSource", "listModels"], ["BackendCapabilities", "retry"],
      ["BackendCapabilities", "thinking"], ["HostLifecycle", "quit"],
    ];
    for (const [iface, name] of samples) {
      const sp = specs.find((x) => x.iface === iface)!;
      expect(ifaceMembers(sp.file, iface).map((m) => m.name), `${iface}.${name} 应在契约里`).toContain(name);
      expect(new RegExp(sp.callForm(name)).test([...callers].map(([, t]) => t).join("\n")),
        `${iface}.${name} 应有调用方/读取方`).toBe(true);
    }
  });
});
