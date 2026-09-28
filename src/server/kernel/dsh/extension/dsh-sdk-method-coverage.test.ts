// **dsh SDK 方法面覆盖度守卫** —— 桌面 TS 侧每调一个 dsh 方法，补面表必须有它。
//
// 为什么单独建这条（本次事故的原形）：桌面的 `DshBackend` / `DshSessionCatalog` 按上游 master
// 的 18+ 方法面写代码，而 npm 发布的 `dsh-sdk-jsonrpc-server` 只有 3 个 request 方法
// （`initialize` / `session/prompt` / `shutdown`）——**0.1.1-rc.2 到 0.1.5-rc.2 一直是这 3 个**。
// 缺口在运行时才现形，症状是 goal 续跑失败 +「dsh 内核版本过旧,缺少 session/seed(请升级 dsh 内核)」，
// 而这条建议是死的（升级装到的还是只有 3 个方法的版本）。
//
// 补面（sdk-methods.mjs）把方法面从上游发版节奏里解耦。但没有守卫，下次加一个
// `DSH_METHODS.x` 的调用却忘了补，就会**以完全相同的方式复发**。所以本文件做静态对账：
// 扫桌面 TS 侧实际调用的 DSH_METHODS 成员 ∪ dsh-methods.ts 的方法表，与补面表对比。
//
// 判据用「桌面是否真的调用」而不是「dsh-methods.ts 是否声明」——后者含通知名与保留名，
// 会把守卫逼成一堆豁免。调用点扫描口径见 CALLED_SITES。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DSH_METHODS } from "../protocol/dsh-methods";
import { SDK_METHOD_SUPPLEMENT } from "./dsh-extension/sdk-methods.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DSH_ROOT = resolve(HERE, ".."); // src/server/kernel/dsh
const EXTENSION_DIR = join(HERE, "dsh-extension");

/** index.mjs 的强语义接管项（setModel / thinkingLevel）——与补缺表合成一张表后一起 patch。 */
const TAKEOVER_METHODS = ["session/setModel", "session/getThinkingLevels", "session/setThinkingLevel"];

/** 不是 request 方法的成员：通知名 + 事件类型名，不参与覆盖度对账。 */
const NON_REQUEST: Set<string> = new Set([DSH_METHODS.llmRetry, DSH_METHODS.sessionTitle]);

/** 桌面已决定不接的方法（有明确替代路径，不是缺口）。 */
const DELIBERATELY_NOT_CALLED: Set<string> = new Set([
  DSH_METHODS.sessionContinue, // 壳用"中立层内容灌给内核"替代（session-store.ts materializeActiveLineage）
  DSH_METHODS.sessionFork,     // fork 归壳，内核是单线执行器（CLAUDE.md §7）；resume 内部用 sessions.fork 但不暴露 RPC
  DSH_METHODS.initialize,      // 原生有
  "shutdown",                  // 原生有
]);

/** 扫 dsh 目录下所有 .ts 生产代码，取出实际调用到的 DSH_METHODS 成员名。 */
function scanCalledMembers(): Set<string> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir).sort()) {
      const full = join(dir, e);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!full.endsWith(".ts")) continue;
      if (full.endsWith(".test.ts") || full.endsWith(".integration.test.ts")) continue;
      files.push(full);
    }
  };
  walk(DSH_ROOT);
  const called = new Set<string>();
  for (const file of files) {
    // 跳过方法名单源自身（它是定义，不是调用）。
    if (file.endsWith(join("protocol", "dsh-methods.ts"))) continue;
    // ⚠ 必须**剥离注释**再匹配（r72）：本仓的纪律是"退役符号可以留在代码里，但要带标注"
    //   （文档漂移审计正是按"有标注即合法"工作的），所以注释里提到 `DSH_METHODS.xxx`
    //   是合法且会反复出现的形态。首版不剥注释，于是 r72 删除 sessionResume 时写在
    //   dsh-backend.ts 的那段"此处曾有 …（走 DSH_METHODS.sessionResume）"退役说明
    //   被当成了**调用点**，报出"DSH_METHODS.sessionResume 在单源表里不存在"——
    //   看起来像我删错了，实际是扫描器把注释当代码。
    //   通则（与 audit:deps 检验⑬ 同一教训）：**按文件剥离块注释与行注释后再判**，
    //   否则退役说明、示例、TODO 都会变成假阳性。
    const src = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    for (const m of src.matchAll(/DSH_METHODS\.([A-Za-z]+)/g)) called.add(m[1]);
  }
  return called;
}

describe("dsh SDK 方法面覆盖度（桌面调的，补面表必须有）", () => {
  it("桌面实际调用的每个 request 方法都在补面表 ∪ 接管表 ∪ 原生表里", () => {
    const called = scanCalledMembers();
    expect(called.size, "扫描到 0 个调用点 = 扫描口径坏了，守卫失效（别把它改成空转）").toBeGreaterThan(5);

    const native = new Set(["initialize", "session/prompt", "shutdown"]); // npm 版原生方法面（实测）
    const covered = new Set([
      ...Object.keys(SDK_METHOD_SUPPLEMENT),
      ...TAKEOVER_METHODS,
      ...native,
    ]);

    const uncovered: string[] = [];
    for (const member of called) {
      const wire = (DSH_METHODS as Record<string, string>)[member];
      expect(wire, `DSH_METHODS.${member} 在单源表里不存在`).toBeTruthy();
      if (NON_REQUEST.has(wire) || DELIBERATELY_NOT_CALLED.has(wire)) continue;
      if (!covered.has(wire)) uncovered.push(`${member} → ${wire}`);
    }
    expect(uncovered, `这些方法桌面会调，但 dsh 运行时没有、补面表也没有（会以「缺少 X 方法」在运行时炸）：${uncovered.join(", ")}`).toEqual([]);
  });

  it("单源方法表里的每个 request 方法要么被覆盖、要么显式记在豁免表里（不许悄悄漏）", () => {
    // 反向对账：DSH_METHODS 是线协议单源，新增一个成员必须同时决定它归谁管。
    // 没有这条，"桌面暂时没调、将来会调"的方法就是个静默缺口。
    const native = new Set(["initialize", "session/prompt", "shutdown"]);
    const covered = new Set([...Object.keys(SDK_METHOD_SUPPLEMENT), ...TAKEOVER_METHODS, ...native]);
    const unaccounted: string[] = [];
    for (const wire of Object.values(DSH_METHODS)) {
      if (NON_REQUEST.has(wire) || DELIBERATELY_NOT_CALLED.has(wire)) continue;
      if (!covered.has(wire)) unaccounted.push(wire);
    }
    expect(unaccounted, `方法名单源里有、但没人负责兑现（补面表 / 接管表 / 原生 / 豁免表四选一，必须显式表态）：${unaccounted.join(", ")}`).toEqual([]);
  });

  it("补面表里没有原生已提供的重复项（避免无谓接管原生语义）", () => {
    // session/prompt 是例外：它带 preferNativeWhen（仅带图片时接管），语义上是"条件接管"。
    const native = new Set(["initialize", "shutdown"]);
    const duplicated = Object.entries(SDK_METHOD_SUPPLEMENT)
      .filter(([method, def]) => native.has(method) && !(def as { preferNativeWhen?: unknown }).preferNativeWhen)
      .map(([method]) => method);
    expect(duplicated, `这些方法原生已有，补面不该无条件接管（会让上游修复失效）：${duplicated.join(", ")}`).toEqual([]);
  });

  it("补缺类方法声明 preferNative 让位上游，或明确不声明（接管类）——两者不许混", () => {
    // 退役条件（设计文档 §4.6）：补缺类若上游哪天真发了同方法，应让位原生。
    // 本表当前全部是"上游没发过"的方法，故都不带 preferNative（原生根本没有，让位无从谈起）；
    // 这条守的是"别在没想清楚的时候乱加 preferNative"——加了就等于原生一有就静默改语义。
    const withPrefer = Object.entries(SDK_METHOD_SUPPLEMENT)
      .filter(([, def]) => (def as { preferNative?: boolean }).preferNative === true)
      .map(([method]) => method);
    // 若将来给某方法加 preferNative，必须在本文件写明理由并更新这条断言。
    expect(withPrefer).toEqual([]);
  });

  it("扩展目录里只有单一 patch 点（不许出现第二个 handleRequest patcher）", () => {
    // 两个 patcher 互相包裹 → 顺序依赖 + 错误归属难查（设计文档 §4.2）。
    for (const file of readdirSync(EXTENSION_DIR).filter((f) => f.endsWith(".mjs"))) {
      const src = readFileSync(join(EXTENSION_DIR, file), "utf8");
      const patches = [...src.matchAll(/\.prototype\.handleRequest\s*=/g)];
      if (file === "sdk-methods.mjs") {
        expect(patches.length, "sdk-methods.mjs 应恰好有一处 patch（单一 patch 点）").toBe(1);
      } else {
        expect(patches.length, `${file} 不该自己 patch handleRequest，应经 installSdkMethodSupplement 注册进同一张表`).toBe(0);
      }
    }
  });

  it("index.mjs 经 installSdkMethodSupplement 注册接管项（不散装 patch）", () => {
    const src = readFileSync(join(EXTENSION_DIR, "index.mjs"), "utf8");
    expect(src).toContain("installSdkMethodSupplement");
    expect(src).toContain("TAKEOVER_METHODS");
    // 补面安装必须在 apply 里 await（模块顶层裸跑有竞态：首批请求可能在 patch 完成前到达）
    expect(src).toMatch(/await installSupplement\(\)/);
  });
});
