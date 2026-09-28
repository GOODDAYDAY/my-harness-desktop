// 提问桥「先扫后听」守卫 —— 守 `85-question-bridges` 步骤**后移**的安全性依据。
//
// 背景（设计文档 §4.2.3 位次 11 / §5.3.3）：步骤化之后提问桥从 `assemble.ts:324`（wiring 之前，
// 靠 `let sessionStore!: SessionStore` 的延迟闭包引用后赋值的字段）移到 `50-wiring` **之后**，
// 因为 `BootContext` 的字段是显式的、由前序步骤写入的，不允许延迟绑定。后移的唯一风险是
// **监听启动时刻变晚，理论上会漏掉窗口内落盘的问句文件**。
//
// 该风险已被源码论证排除（`start()` = `mkdirSync` → `scan()` 全量扫描既存文件 → `watch`，
// 且 `if (this.watcher) return` 使其幂等），但论证不等于守卫：将来谁重写 `start()` 把
// "先扫"那一步丢掉，症状是"偶发漏投提问"——极难归因。本测试把它钉住。
//
// 同时钉住第二条硬约束的**理由**：新建桥实例的 `emitted` 去重集合是空的，会把目录里既存的
// 问句全部重投（用户会看到已回答的提问卡片复活）。所以暖重载只能对**变动的**内核跑
// `kernel-question-bridge` 操作（设计文档 §3.6.2），不能无差别重跑。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

let home: string;
let questionsDir: string;

/** 写一个问句文件（dsh 的 ask 扩展落盘的形状：`<requestId>.json`）。 */
function writeQuestion(requestId: string, sessionId = "s-1"): void {
  writeFileSync(
    join(questionsDir, `${requestId}.json`),
    JSON.stringify({
      requestId,
      sessionId,
      questions: [{ id: "q1", question: "选一个", options: [{ label: "A" }, { label: "B" }] }],
    }),
    "utf8",
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dsh-bridge-home-"));
  // DSH_QUESTIONS_DIR 在**模块加载时**由 homedir() 算出，所以必须先把 HOME 指到临时目录，
  // 再 resetModules + 动态 import，模块才会用临时目录。
  questionsDir = join(home, ".pi", "agent", ".my-harness-desktop-questions");
  mkdirSync(questionsDir, { recursive: true });
  process.env.HOME = home;
  // Windows 读 USERPROFILE（与 scripts/demo/lib/app.mjs 的隔离做法同款）。
  process.env.USERPROFILE = home;
});

afterEach(() => {
  process.env.HOME = homedir();
  rmSync(home, { recursive: true, force: true });
});

/** 每次取一份**全新**的模块实例（DSH_QUESTIONS_DIR 是模块级常量，必须重新求值）。 */
async function freshBridgeModule() {
  vi.resetModules();
  return import("./dsh-question-bridge");
}

describe("DshQuestionBridge：先扫后听（监听启动晚于文件落盘也不漏投）", () => {
  it("start() 之前就存在的问句文件，start() 后立刻被投递", async () => {
    writeQuestion("req-pre-1");
    writeQuestion("req-pre-2");
    const mod = await freshBridgeModule();
    // 前置断言：模块确实读到了临时 HOME（否则本测试是在测真实 profile，属假绿）
    expect(mod.DSH_QUESTIONS_DIR).toBe(questionsDir);

    const bridge = new mod.DshQuestionBridge();
    const got: string[] = [];
    bridge.onQuestion((req) => got.push(req.requestId));
    bridge.start();

    expect(got.sort(), "既存问句必须在 start() 内被全量扫描投递，不等文件系统事件").toEqual(["req-pre-1", "req-pre-2"]);
    bridge.stop?.();
  });

  it("start() 幂等：重复调用不重复投递、不挂第二个 watcher", async () => {
    writeQuestion("req-idem");
    const mod = await freshBridgeModule();
    const bridge = new mod.DshQuestionBridge();
    const got: string[] = [];
    bridge.onQuestion((req) => got.push(req.requestId));
    bridge.start();
    bridge.start();
    bridge.start();
    expect(got).toEqual(["req-idem"]);
    bridge.stop?.();
  });

  it("桥**不按答案文件过滤**：去重职责在 SessionStore.injectQuestion 的账本，不在桥（职责划分守卫）", async () => {
    // 这条断言的是**职责边界**，不是"桥应该过滤"。实测：桥对已写答案的问句照样投递，
    // 由 `SessionStore.injectQuestion` 按账本状态吸收（`session-store.ts:2001-2002`：
    // `if (existing && existing.status !== "pending") return;`，注释写明"dsh 桥重启全量重扫
    // 会重投旧问句文件,含 abort 孤儿"）。
    // 为什么这样分是对的：账本（哪些提问已结算）是壳的持久状态，桥只是文件侧车的搬运工；
    // 让桥也读账本就要把壳状态漏进内核目录，反向依赖。
    // ⚠ 若将来有人"顺手"在桥里加答案文件过滤，这条会红——那不是改进，是把去重做成两份
    //   （桥一份、账本一份），两者不一致时症状是"提问偶发丢失"，极难归因。
    writeQuestion("req-answered");
    writeFileSync(join(questionsDir, "req-answered.answer.json"), JSON.stringify({ requestId: "req-answered", answers: [] }), "utf8");
    writeQuestion("req-pending");
    const mod = await freshBridgeModule();
    const bridge = new mod.DshQuestionBridge();
    const got: string[] = [];
    bridge.onQuestion((req) => got.push(req.requestId));
    bridge.start();
    expect(got.sort()).toEqual(["req-answered", "req-pending"]);
    bridge.stop?.();
  });
});

describe("DshQuestionBridge：新实例会重投既存问句（故暖重载只对变动内核跑）", () => {
  it("同一目录下第二个桥实例把既存问句**全部重投**（emitted 去重集合是实例级的）", async () => {
    writeQuestion("req-shared");
    const mod = await freshBridgeModule();

    const first = new mod.DshQuestionBridge();
    const firstGot: string[] = [];
    first.onQuestion((r) => firstGot.push(r.requestId));
    first.start();
    expect(firstGot).toEqual(["req-shared"]);

    // 这就是设计文档 §3.6.2「暖操作只对变动内核跑」的实证依据：
    // 若暖重载无差别地对所有内核重跑 kernel-question-bridge，每个内核都会新建一个桥实例，
    // 于是用户已经回答过的提问卡片会全部复活。
    const second = new mod.DshQuestionBridge();
    const secondGot: string[] = [];
    second.onQuestion((r) => secondGot.push(r.requestId));
    second.start();
    expect(secondGot, "新实例的去重集合是空的，既存问句会被重投").toEqual(["req-shared"]);

    first.stop?.();
    second.stop?.();
  });

  it("目录里只有答案文件、没有问句文件时不投递（不误报）", async () => {
    writeFileSync(join(questionsDir, "orphan.answer.json"), JSON.stringify({ requestId: "orphan", answers: [] }), "utf8");
    const mod = await freshBridgeModule();
    const bridge = new mod.DshQuestionBridge();
    const got: string[] = [];
    bridge.onQuestion((r) => got.push(r.requestId));
    bridge.start();
    expect(got).toEqual([]);
    expect(readdirSync(questionsDir)).toEqual(["orphan.answer.json"]);
    bridge.stop?.();
  });
});
