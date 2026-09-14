// dsh SDK 方法面补全的纯逻辑单测 —— entriesToSeedEvents / contentToBlocks / latestMeta / nativeMethodSet。
//
// 为什么这些能单测（§4.5 判据：不需 mock 外部环境）：它们都是"中立形状 → dsh 形状"的转录纯函数，
// 不碰进程、不碰文件系统、不碰 dsh 运行时。dsh 运行时那一侧的行为由
// `dsh-backend.integration.test.ts`（真机瘦版运行时）覆盖。
//
// 守卫意图（§3.7）：本次事故的根因是"桌面调 16 个方法、装上的 dsh 只有 3 个"，补面把方法面
// 从上游发版节奏里解耦。这些测试守的是补面的**转录正确性**——seed 重建出的事件序列必须
// turn 封闭、meta 折叠必须是 merge（不是 last-write-wins），否则补面装了也是错的。
import { describe, it, expect } from "vitest";
// 该 .mjs 只在函数内部动态 import dsh 包（顶层仅 node 内建），vitest node 环境可直接静态导入。
import {
  contentToBlocks,
  entriesToSeedEvents,
  latestMeta,
  nativeMethodSet,
  SDK_METHOD_SUPPLEMENT,
} from "./dsh-extension/sdk-methods.mjs";

/** 最小 dsh 消息工厂替身：只保留 id/role/content 的可辨识形状（真工厂在运行时闭包里取）。 */
const makeUser = ({ content }: { content: unknown }) => ({ id: "u", role: "user", content });
const makeAssistant = ({ content }: { content: unknown }) => ({ id: "a", role: "assistant", content });
const SOURCE = { provider: "p", model: "m" };

const entry = (i: number, role: string, text: string) => ({
  neutralEntryId: `e${i}`,
  message: { role, content: [{ type: "text", text }] },
});

describe("entriesToSeedEvents：中立条目 → turn 封闭的 dsh seed 事件", () => {
  it("一问一答重建出完整 turn（start→step→user→assistant→step/end→turn/end）", () => {
    const events = entriesToSeedEvents([entry(1, "user", "hi"), entry(2, "assistant", "yo")], makeUser, makeAssistant, SOURCE);
    expect(events.map((e: any) => e.type)).toEqual([
      "turn/start",
      "step/start",
      "user/message",
      "assistant/message",
      "step/end",
      "turn/end",
    ]);
  });

  it("seq 单调递增且从 0 起（dsh 日志校验要求连续 seq）", () => {
    const events = entriesToSeedEvents([entry(1, "user", "a"), entry(2, "assistant", "b"), entry(3, "user", "c")], makeUser, makeAssistant, SOURCE);
    expect(events.map((e: any) => e.seq)).toEqual(events.map((_: any, i: number) => i));
  });

  it("多轮对话：每对 user/assistant 各占一个 turn，turn 号递增", () => {
    const events = entriesToSeedEvents(
      [entry(1, "user", "a"), entry(2, "assistant", "b"), entry(3, "user", "c"), entry(4, "assistant", "d")],
      makeUser, makeAssistant, SOURCE,
    );
    const starts = events.filter((e: any) => e.type === "turn/start").map((e: any) => e.data.turn);
    expect(starts).toEqual([1, 2]);
    expect(events.filter((e: any) => e.type === "turn/end")).toHaveLength(2);
  });

  it("末尾未闭合的 turn 自动收尾：只有 user 没有 assistant 也要 turn/end", () => {
    const events = entriesToSeedEvents([entry(1, "user", "lonely")], makeUser, makeAssistant, SOURCE);
    // 不收尾的话 dsh 认为回合未结束，下一条 prompt 会被当成同回合 followup 而非新回合。
    expect(events.map((e: any) => e.type)).toEqual(["turn/start", "step/start", "user/message", "step/end", "turn/end"]);
  });

  it("连续两个 user：前一个 turn 先闭合再开新 turn（不产生嵌套 turn）", () => {
    const events = entriesToSeedEvents([entry(1, "user", "a"), entry(2, "user", "b")], makeUser, makeAssistant, SOURCE);
    const types = events.map((e: any) => e.type);
    expect(types.filter((t: string) => t === "turn/start")).toHaveLength(2);
    // 第一个 turn 必须在第二个 user 之前闭合
    expect(types.indexOf("turn/end")).toBeLessThan(types.lastIndexOf("turn/start"));
  });

  it("toolResult 跳过（与上游同口径：忠实工具环重建是 follow-up，不在本次范围）", () => {
    const events = entriesToSeedEvents(
      [entry(1, "user", "a"), { neutralEntryId: "e2", message: { role: "toolResult", content: [] } } as any, entry(3, "assistant", "b")],
      makeUser, makeAssistant, SOURCE,
    );
    expect(events.some((e: any) => e.type === "tool/result")).toBe(false);
    expect(events.filter((e: any) => e.type === "user/message")).toHaveLength(1);
  });

  it("assistant 出现在任何 user 之前时被忽略（open=false，不产生悬空 assistant）", () => {
    const events = entriesToSeedEvents([entry(1, "assistant", "orphan")], makeUser, makeAssistant, SOURCE);
    expect(events).toEqual([]);
  });

  it("surface 事件带 surfaceOp:append，boundary 事件不带（dsh 事件分类契约）", () => {
    const events = entriesToSeedEvents([entry(1, "user", "a"), entry(2, "assistant", "b")], makeUser, makeAssistant, SOURCE);
    for (const e of events as any[]) {
      if (e.type === "user/message" || e.type === "assistant/message") expect(e.surfaceOp).toBe("append");
      else expect(e.surfaceOp).toBeUndefined();
    }
  });

  it("assistant 事件携带 turn/step 上下文与来源标记（dsh 折叠 surface 需要）", () => {
    const events = entriesToSeedEvents([entry(1, "user", "a"), entry(2, "assistant", "b")], makeUser, makeAssistant, SOURCE);
    const am = events.find((e: any) => e.type === "assistant/message") as any;
    expect(am.data.turn).toBe(1);
    expect(am.data.step).toBe(1);
    expect(am.data.message.role).toBe("assistant");
  });

  it("空条目 / 非法入参不抛错（seed 空 lineage 是合法路径）", () => {
    expect(entriesToSeedEvents([], makeUser, makeAssistant, SOURCE)).toEqual([]);
    expect(entriesToSeedEvents(undefined as any, makeUser, makeAssistant, SOURCE)).toEqual([]);
    expect(entriesToSeedEvents([{} as any, { message: null } as any], makeUser, makeAssistant, SOURCE)).toEqual([]);
  });
});

describe("contentToBlocks：中立 content → dsh content blocks", () => {
  it("字符串 content 包成单个 text 块", () => {
    expect(contentToBlocks("hello")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("text / thinking / toolCall 三种块各自映射（thinking → reasoning）", () => {
    const blocks = contentToBlocks([
      { type: "text", text: "t" },
      { type: "thinking", thinking: "reason" },
      { type: "toolCall", id: "call-1", name: "bash", args: { cmd: "ls" } },
    ] as any);
    expect(blocks).toEqual([
      { type: "text", text: "t" },
      { type: "reasoning", text: "reason" },
      { type: "tool-call", id: "call-1", name: "bash", arguments: '{"cmd":"ls"}' },
    ]);
  });

  it("toolCall 缺 id/name 时兜底（不因上游数据不全而抛）", () => {
    const [b] = contentToBlocks([{ type: "toolCall" } as any]) as any[];
    expect(b.name).toBe("tool");
    expect(typeof b.id).toBe("string");
    expect(b.arguments).toBe("{}");
  });

  it("args 已是字符串则原样透传（不二次 JSON.stringify）", () => {
    const [b] = contentToBlocks([{ type: "toolCall", id: "x", args: '{"a":1}' } as any]) as any[];
    expect(b.arguments).toBe('{"a":1}');
  });

  it("非数组 / 含垃圾项时安全降级", () => {
    expect(contentToBlocks(undefined as any)).toEqual([]);
    expect(contentToBlocks(42 as any)).toEqual([]);
    expect(contentToBlocks([null, "x", { type: "unknown" }] as any)).toEqual([]);
  });
});

describe("latestMeta：session/meta 折叠必须 merge（不是 last-write-wins）", () => {
  // 桌面把元数据拆成两个写口：rename 只写 {name}、updateHeader 只写 {pinned, archived, custom}。
  // last-wins 下后一次写抹掉前一次的字段 —— 这正是本次实测抓到的 bug 形态。
  const metaEvents = (...metas: Record<string, unknown>[]) => ({
    events: [
      { type: "turn/start", data: {} },
      ...metas.map((meta) => ({ type: "session/meta", data: { meta } })),
    ],
  });

  it("rename 后再 updateHeader：两个字段都活下来", () => {
    expect(latestMeta(metaEvents({ name: "会话名" }, { pinned: true }) as any)).toEqual({ name: "会话名", pinned: true });
  });

  it("同名键后写胜出（部分更新语义）", () => {
    expect(latestMeta(metaEvents({ name: "旧" }, { name: "新" }) as any)).toEqual({ name: "新" });
  });

  it("忽略非对象 meta 与损坏事件（不抛）", () => {
    const session = { events: [{ type: "session/meta", data: { meta: null } }, { type: "session/meta", data: {} }, { type: "session/meta" }] } as any;
    expect(latestMeta(session)).toEqual({});
  });

  it("无 events 字段时返回空对象（防御：会话对象形状异常不炸目录页）", () => {
    expect(latestMeta({} as any)).toEqual({});
  });
});

describe("nativeMethodSet：无副作用地读出原生方法面", () => {
  // 为什么不用"试调原生看报不报 unknown-method"：试调有副作用（session/prompt 试调一次就真发了
  // 一条消息、session/delete 试调一次就真删了会话）。探测能力不能拿业务调用当探针。
  it("从 switch 源码文本读出 case 方法名（实测：npm 版 3 个、上游构建版 20 个）", () => {
    const thin = async function handleRequest(method: string) {
      switch (method) {
        case "initialize": return {};
        case "session/prompt": return {};
        case "shutdown": return {};
        default: throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`);
      }
    };
    expect([...nativeMethodSet(thin)].sort()).toEqual(["initialize", "session/prompt", "shutdown"]);
  });

  it("带 session/seed 的运行时被识别为原生支持（补面据此让位退役）", () => {
    const fat = async function handleRequest(method: string) {
      switch (method) {
        case "session/seed": return {};
        case "session/getTree": return {};
        default: throw new Error("unknown");
      }
    };
    const set = nativeMethodSet(fat);
    expect(set.has("session/seed")).toBe(true);
    expect(set.has("session/getTree")).toBe(true);
  });

  it("null / 非法入参返回空集（不抛）", () => {
    expect(nativeMethodSet(undefined).size).toBe(0);
  });
});

describe("补面表覆盖度：桌面调的方法必须在表里", () => {
  it("覆盖桌面实际调用的全部 session/* 方法（16 条，缺一即回归本次事故）", () => {
    // 与 src/server/kernel/dsh/backend/{dsh-backend,dsh-catalog}.ts 实际调用的方法一一对账。
    // setModel / getThinkingLevels / setThinkingLevel 三条是 index.mjs 的强语义接管项
    // （由 TAKEOVER_METHODS 合进同一张表），不在本表内。
    const required = [
      "session/seed", "session/getTree", "session/getEntries", "session/bookmark", "session/resume",
      "session/deleteBookmark", "session/abort", "session/rename", "session/updateHeader",
      "session/get", "session/list", "session/delete", "session/projectStats", "session/prompt",
    ];
    const missing = required.filter((m) => !(m in SDK_METHOD_SUPPLEMENT));
    expect(missing).toEqual([]);
  });

  it("每个表项都带 handler 函数（表结构契约）", () => {
    for (const [method, def] of Object.entries(SDK_METHOD_SUPPLEMENT)) {
      expect(typeof (def as any).handler, `${method} 缺 handler`).toBe("function");
    }
  });

  it("prompt 只在带图片时接管，纯文本让位原生（不吞原生语义）", () => {
    const def = SDK_METHOD_SUPPLEMENT["session/prompt"] as any;
    expect(def.preferNativeWhen({ contentBlocks: [{ type: "text", text: "hi" }] })).toBe(true);
    expect(def.preferNativeWhen({ contentBlocks: [], images: [] })).toBe(true);
    expect(def.preferNativeWhen({ contentBlocks: [], images: [{ data: "x" }] })).toBe(false);
  });
});
