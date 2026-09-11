// Session Bus 路由器的守卫 —— 这个文件此前**不存在**，而它的缺席已经害过一次：
// 源码里 `broadcastToChannel` 上方写着「根因修复(勿回退)…**此前无 session-bus 测试,此 bug 一直潜伏**」
// —— 房间 fan-out 把 `to` 留成 channel 地址，`deliver` 按 `to` 路由时投不出去，房间消息从未真正送达。
// 所以本文件的第一条纪律就是把**路由与投递**钉死，而不是只测几个 op 的返回值。
//
// 测试用替身 SessionStore（只实现 bus 真正调用的那几个方法），但**不 mock 路由逻辑本身**——
// 被测的就是它。每条断言都对应源码里一句可指认的承诺。

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBus } from "./session-bus";
import { sessionAddress, channelAddress, pluginAddress, type SessionBusMessage, type SessionEvent } from "@my-harness-desktop/shared";

/** 记录型 store 替身：只实现 bus 调用的面，并记录投递（spawn 参数/streamingBehavior）。 */
function makeStore(opts: { sessionRoots?: string[]; lastText?: string; sessionPath?: string | null } = {}) {
  const prompts: { key: string; text: string; behavior: string }[] = [];
  const stops: string[] = [];
  const store = {
    sessionRoots: opts.sessionRoots ?? ["/kernels/pi/sessions"],
    getRunningSessionKeys: () => ["s1", "s2"],
    getCwdAndSessionPath: (key: string) => ({ cwd: `/proj/${key}`, sessionPath: opts.sessionPath === undefined ? `/kernels/pi/sessions/${key}.jsonl` : opts.sessionPath }),
    isBusy: () => false,
    sendPromptTo: (key: string, text: string, behavior: string) => { prompts.push({ key, text, behavior }); return Promise.resolve(); },
    stop: (key: string) => { stops.push(key); return Promise.resolve(); },
    spawnSession: (cwd: string) => Promise.resolve({ key: "spawned1", sessionPath: `${cwd}/spawned1.jsonl` }),
    reopenSession: (cwd: string, sessionPath: string) => Promise.resolve({ key: "reopened1", sessionPath }),
    getAdapter: () => null,
    getBackend: () => null,
    updateHeader: () => Promise.resolve(),
    getLastAssistantTextFor: (key: string) => Promise.resolve(opts.lastText ?? `output-of-${key}`),
  };
  return { store, prompts, stops };
}

function makeSink() {
  const broadcast: SessionBusMessage[] = [];
  return { sink: { broadcast: (m: SessionBusMessage) => { broadcast.push(m); } }, broadcast };
}

/** 一发上行帧（模拟 pi 侧 $bus）。 */
function frame(from: string, to: string, kind: string, payload?: unknown): Record<string, unknown> {
  return { $bus: true, to, kind, payload, from };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ── 投递模型（写这些断言时实测纠正过一次，先记住再写断言）──
// · **session 目标**的帧走 `store.sendPromptTo`（把帧序列化后注入那个会话）——
//   它**不经过** renderer sink。所以"房间消息投给会话成员"要在 prompts 里找，不在 sink 里找。
// · **plugin 目标**的帧才 `sink.broadcast`（给 desktop 界面）。
// 第一版断言全写在 sink 上，于是十条全红——错的不是代码，是我对投递面的假设。
const framesOf = (prompts: { key: string; text: string }[], key?: string): SessionBusMessage[] =>
  prompts.filter((p) => !key || p.key === key).map((p) => JSON.parse(p.text) as SessionBusMessage);
const chatsOf = (prompts: { key: string; text: string }[]): string[] =>
  framesOf(prompts).filter((m) => m.kind === "chat").map((m) => (m.payload as { text: string }).text);

// 假时钟必须在 each 之后复位：只在用例末尾 useRealTimers()，一旦断言先抛，
// 假时钟就留在全局，之后每个 await settle() 都永远不 resolve —— 一整片用例集体超时，
// 而现场看起来像"这些用例本身坏了"（本轮实测：13 个用例被这一条拖红）。
afterEach(() => { vi.useRealTimers(); });

describe("SessionBus:进线认证与路由", () => {
  it("from 一律覆写为到达管道绑定的地址（自报值丢弃，§3.2 安全模型）", async () => {
    const { store, prompts } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    // 自报 from 是别人 —— 必须被丢弃，否则可以冒充任意成员发消息
    await bus.handleFrame("s1", frame("session:s2", sessionAddress("s2"), "chat", { text: "hi" }));
    await settle();
    expect(prompts).toHaveLength(1);
    const delivered = JSON.parse(prompts[0].text) as SessionBusMessage;
    expect(delivered.from, "自报 from 没被覆写 —— 可以冒充别的会话").toBe(sessionAddress("s1"));
  });

  it("非 $bus 帧 / 缺 to / 缺 kind：直接忽略（不进路由，不报错）", async () => {
    const { store, prompts } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    await bus.handleFrame("s1", { to: sessionAddress("s2"), kind: "chat" }); // 缺 $bus
    await bus.handleFrame("s1", { $bus: true, kind: "chat" }); // 缺 to
    await bus.handleFrame("s1", { $bus: true, to: sessionAddress("s2") }); // 缺 kind
    await settle();
    expect(prompts).toEqual([]);
  });

  it("四类地址各走各的：session 投递 / channel 广播 / plugin 到 sink / desktop 执行 op", async () => {
    const { store, prompts } = makeStore();
    const { sink, broadcast } = makeSink();
    const bus = new SessionBus(store as never, sink);

    await bus.handleFrame("s1", frame("session:s1", sessionAddress("s2"), "chat", { text: "to-session" }));
    bus.opChannelJoin("room", pluginAddress("p1")); // 房间里有 plugin 成员，publish 才有落点
    await bus.handleFrame("s1", frame("session:s1", channelAddress("room"), "chat", { text: "to-channel" }));
    await bus.handleFrame("s1", frame("session:s1", pluginAddress("p1"), "chat", { text: "to-plugin" }));
    await bus.handleFrame("s1", frame("session:s1", "desktop", "ping"));
    await settle();

    expect(prompts.map((p) => p.key), "session 地址应投给目标会话").toContain("s2");
    expect(broadcast.some((m) => m.kind === "chat" && (m.payload as { text?: string }).text === "to-channel"), "channel 地址应 fan-out 到成员").toBe(true);
    expect(broadcast.some((m) => m.kind === "chat" && (m.payload as { text?: string }).text === "to-plugin"), "plugin 地址应直接给 renderer sink").toBe(true);
    expect(prompts.some((p) => p.text.includes('"pong"')), "desktop op 的响应要回到发起方").toBe(true);
  });

  it("未知地址形态 → 把错误当响应回给发起方（不静默丢）", async () => {
    const { store, prompts } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    await bus.handleFrame("s1", frame("session:s1", "garbage-address", "chat"));
    await settle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].text).toContain("undeliverable");
  });

  it("投递的 streamingBehavior 是**固定策略**：响应帧插队(steer)，事件帧排队(followUp)", async () => {
    const { store, prompts } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    await bus.handleFrame("s1", frame("session:s1", sessionAddress("s2"), "bus_response", {}));
    await bus.handleFrame("s1", frame("session:s1", sessionAddress("s2"), "bus_event", {}));
    await settle();
    expect(prompts.map((p) => `${p.key}:${p.behavior}`)).toEqual(["s2:steer", "s2:followUp"]);
  });
});

describe("SessionBus:房间 fan-out（源码里点名的根因修复）", () => {
  it("投给 session 成员时 `to` 必须改写成**成员地址**（留 channel 地址则 deliver 空转）", async () => {
    const { store, prompts } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    bus.opChannelJoin("room", sessionAddress("s2"));
    await bus.handleFrame("s1", frame("session:s1", channelAddress("room"), "chat", { text: "hello room" }));
    await settle();
    const toS2 = framesOf(prompts, "s2").filter((m) => m.kind === "chat" && (m.payload as { text: string }).text === "hello room");
    expect(toS2, "房间消息没投到 session 成员 —— fan-out 又退回成空转").toHaveLength(1);
    expect(toS2[0].to, "to 没改写成成员地址（留 channel 地址则 deliver 空转）").toBe(sessionAddress("s2"));
  });

  it("发送者被排除（不回声给自己）", async () => {
    const { store, prompts } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    bus.opChannelJoin("room", sessionAddress("s1"));
    bus.opChannelJoin("room", sessionAddress("s2"));
    await bus.handleFrame("s1", frame("session:s1", channelAddress("room"), "chat", { text: "x" }));
    await settle();
    expect(chatsOf(prompts)).toEqual(["x"]);
    expect(framesOf(prompts, "s1").filter((m) => m.kind === "chat"), "发送者不该收到自己的房间消息").toEqual([]);
  });

  it("进房/离房：新成员才广播 peer_joined；空房间自动删除", () => {
    const { store } = makeStore();
    const promptsStore = makeStore();
    const { sink, broadcast } = makeSink();
    const bus = new SessionBus(promptsStore.store as never, sink);
    bus.opChannelJoin("room", sessionAddress("s1"));
    bus.opChannelJoin("room", sessionAddress("s1")); // 重复加入不再广播
    // session 成员收到 peer_joined 是 bus 帧（经 sendPromptTo）；plugin 成员才走 renderer sink
    expect(framesOf(promptsStore.prompts).filter((m) => m.kind === "peer_joined"), "session 成员收到 peer_joined 是 bus 帧").toHaveLength(1);
    expect((bus.opBusStatus(sessionAddress("s1")) as { channels: { members: string[] }[] }).channels[0].members).toEqual([sessionAddress("s1")]);
    // plugin 成员走 renderer sink（与 session 成员不同面）
    bus.opChannelJoin("room", pluginAddress("p1"));
    expect(broadcast.filter((m) => m.kind === "peer_joined"), "plugin 成员应经 renderer sink 收到").toHaveLength(1);
    bus.opChannelJoin("solo", sessionAddress("s2"));
    bus.opChannelLeave("solo", sessionAddress("s2"));
    const names = (bus.opBusStatus(pluginAddress("p1")) as { channels: { channel: string }[] }).channels.map((c) => c.channel);
    expect(names, "空房间应被删除（不留空壳）").not.toContain("solo");
    expect(names, "还有成员（plugin:p1）的房间不该被删").toContain("room");
  });
});

describe("SessionBus:自动 fan 与防回声", () => {
  const msgEnd = (text: string, role = "assistant"): SessionEvent =>
    ({ type: "messageEnd", message: { role, content: [{ type: "text", text }] } }) as unknown as SessionEvent;

  it("成员会话的 messageEnd 自动 fan 到它所在的每个房间", () => {
    const { store, prompts } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    bus.opChannelJoin("room", sessionAddress("s2")); // 房间里有**别的**成员，fan 才有落点
    bus.onSessionEvent(msgEnd("大家好"), "s2");
    expect(chatsOf(prompts), "会话 s2 自己不在收件侧（发送者被排除），fan 应落到房间其它成员").toEqual([]);
    bus.opChannelJoin("room", sessionAddress("s1"));
    bus.onSessionEvent(msgEnd("大家好"), "s2");
    expect(chatsOf(prompts)).toEqual(["大家好"]);
  });

  it("**bus 注入帧不再外 fan**（防回声：断转发再转发，不断正常回复）", () => {
    const { store, prompts } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    bus.opChannelJoin("room", sessionAddress("s1")); // 收件侧
    bus.opChannelJoin("room", sessionAddress("s2")); // 发言侧（fan 会排除发送者自己）
    bus.onSessionEvent(msgEnd(JSON.stringify({ $bus: true, to: "channel:room", kind: "chat", payload: { text: "loop" } })), "s2");
    expect(chatsOf(prompts), "bus 帧被 fan 回去了 —— 会形成两个会话互相转发的无限回环").toEqual([]);
    // 正常回复不受影响
    bus.onSessionEvent(msgEnd("正常回复"), "s2");
    expect(chatsOf(prompts)).toEqual(["正常回复"]);
  });

  it("非 assistant/user 的 messageEnd、或空文本：不 fan", () => {
    const { store, prompts } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    bus.opChannelJoin("room", sessionAddress("s2"));
    bus.onSessionEvent(msgEnd("x", "system"), "s2");
    bus.onSessionEvent(msgEnd("   "), "s2");
    expect(chatsOf(prompts)).toEqual([]);
  });

  it("令牌桶：每房间 20 条/分钟；超限丢弃 + bus_throttled 只提示一次", () => {
    vi.useFakeTimers();
    const { store, prompts } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    bus.opChannelJoin("room", sessionAddress("s1")); // 收件侧
    bus.opChannelJoin("room", sessionAddress("s2")); // 发言侧
    for (let i = 0; i < 25; i++) bus.onSessionEvent(msgEnd(`第 ${i} 条`), "s2");
    expect(chatsOf(prompts), "熔断没生效：超过 20 条仍在 fan").toHaveLength(20);
    // "不刷屏"的正确判据是**每个成员各收到一条**：
    // · 不能数总帧数——一张提示要投给房间每个成员（两个成员 = 两帧）；
    // · 也不能按 id 去重——`broadcastToChannel` 给每次投递**重新生成 id**（`id: randomUUID()`），
    //   同一条逻辑提示在两个成员处是两个不同 id。
    // （这两个坑都是写这条断言时实测撞出来的；判据写错了会得出"刷屏了"的假结论。）
    for (const member of ["s1", "s2"]) {
      expect(framesOf(prompts, member).filter((m) => m.kind === "bus_throttled"), `${member} 在冷却窗口内收到多条熔断提示（刷屏）`).toHaveLength(1);
    }
    // 窗口过后额度恢复
    vi.advanceTimersByTime(61_000);
    bus.onSessionEvent(msgEnd("窗口后"), "s2");
    expect(chatsOf(prompts)).toHaveLength(21);
  });
});

describe("SessionBus:tap 闸门与完成通知", () => {
  it("stream 过滤 + session 目标 → 降级 lifecycle 并显式告知（不静默改行为）", () => {
    const { store, prompts } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    const r = bus.opTapStart(sessionAddress("s1"), { session: sessionAddress("s2"), filter: "stream", deliverTo: sessionAddress("s1") }) as { filter: string };
    expect(r.filter).toBe("lifecycle");
    expect(framesOf(prompts, "s1").some((m) => m.kind === "tap_degraded"), "降级了却不告知 = 静默改行为").toBe(true);
  });

  it("watcher 在会话收敛时收到 session_done（含完整输出与会话文件路径）", async () => {
    const { store, prompts } = makeStore({ lastText: "最终答案全文", sessionPath: "/kernels/pi/sessions/s1.jsonl" });
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    // 用 session_create 的 watch 建立 watcher
    await bus.opSessionCreate(sessionAddress("s1"), { cwd: "/proj/x", watch: true });
    bus.onSessionEvent({ type: "agentSettled", reason: "completed" } as unknown as SessionEvent, "spawned1");
    await settle();
    const done = framesOf(prompts, "s1").find((m) => m.kind === "session_done");
    expect(done, "watcher 没收到完成通知").toBeTruthy();
    const p = done!.payload as { output: string; status: string; sessionPath?: string };
    expect(p.output).toBe("最终答案全文");
    expect(p.status).toBe("done");
    expect(p.sessionPath).toBe("/kernels/pi/sessions/s1.jsonl");
  });

  it("没有 watcher/tap 的会话收敛时不产生任何通知（不无差别广播）", async () => {
    const { store, prompts } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    bus.onSessionEvent({ type: "agentSettled", reason: "completed" } as unknown as SessionEvent, "nobody-watches");
    await settle();
    expect(framesOf(prompts).filter((m) => m.kind === "session_done")).toEqual([]);
  });

  it("进程已死时完成通知回退读会话文件末条 assistant 文本（不丢最终输出）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bus-file-"));
    const sessionPath = join(dir, "s.jsonl");
    writeFileSync(sessionPath, [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "旧答案" }] } }),
      "{ 坏行",
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "最终答案" }] } }),
    ].join("\n") + "\n");
    const { store, prompts } = makeStore({ lastText: "", sessionPath });
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    await bus.opSessionCreate(sessionAddress("s1"), { cwd: "/proj/x", watch: true });
    bus.onSessionEvent({ type: "agentSettled", reason: "completed" } as unknown as SessionEvent, "spawned1");
    await settle();
    const done = framesOf(prompts, "s1").find((m) => m.kind === "session_done");
    expect(done, "进程已死时也应交付最终输出").toBeTruthy();
    expect((done!.payload as { output: string }).output).toBe("最终答案");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("SessionBus:op 语义与清理", () => {
  it("session_reopen 的路径圈禁：只放行**任一内核会话根**内的文件", async () => {
    const { store } = makeStore({ sessionRoots: ["/kernels/pi/sessions", "/kernels/dsh/sessions"] });
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    const ok = await bus.opSessionReopen(sessionAddress("s1"), { cwd: "/p", sessionPath: "/kernels/dsh/sessions/x.jsonl" });
    expect((ok as { key: string }).key).toBe("reopened1");
    await expect(bus.opSessionReopen(sessionAddress("s1"), { cwd: "/p", sessionPath: "/etc/passwd" })).rejects.toThrow(/越界/);
    await expect(bus.opSessionReopen(sessionAddress("s1"), { cwd: "/p" })).rejects.toThrow(/缺 cwd\/sessionPath/);
  });

  it("desktop op 的请求去重：同 id 二次到达复用缓存响应，**不重执行**（spawn 非幂等）", async () => {
    const { store } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    let created = 0;
    const origSpawn = store.spawnSession;
    store.spawnSession = (cwd: string) => { created += 1; return origSpawn(cwd); };

    await bus.opSessionCreate(sessionAddress("s1"), { cwd: "/p" });
    const before = created;
    // 同一条请求帧（同 id）再次到达
    const raw = { $bus: true, id: "fixed-id", to: "desktop", kind: "session_create", payload: { cwd: "/p" } };
    await bus.handleFrame("s1", raw);
    await bus.handleFrame("s1", raw);
    await settle();
    expect(created - before, "重复请求被重复执行了 —— spawn 非幂等，会多出一个会话进程").toBe(1);
  });

  it("onProcessExit：结算 + 广播 peer_left + 删空房间 + 清 tap/watcher/spawnedBy", async () => {
    const { store, prompts } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    bus.opChannelJoin("room", sessionAddress("s1"));
    bus.opChannelJoin("room", sessionAddress("s2")); // 留一个还在房间里的观察者
    const tap = bus.opTapStart(sessionAddress("s2"), { session: sessionAddress("s1"), filter: "lifecycle" }) as { tapId: string };
    bus.onProcessExit("s1", true);
    await settle();
    expect(framesOf(prompts, "s2").some((m) => m.kind === "peer_left"), "死会话离开要告知同房间其它成员").toBe(true);
    // s2 还在房间里，所以房间不该被删；再用只有 s1 的房间验"空房间删除"
    bus.opChannelJoin("solo", sessionAddress("s1"));
    bus.onProcessExit("s1", true);
    await settle();
    // 注意：opBusStatus 的 `channel` 是**裸名**，不是 `channel:` 地址（别按地址断言）
    const names = (bus.opBusStatus(sessionAddress("s2")) as { channels: { channel: string }[] }).channels.map((c) => c.channel);
    expect(names, "死会话离开后空房间应删除").not.toContain("solo");
    expect(names).toContain("room");
    expect((bus.opWhoami(sessionAddress("s2")) as { taps: { tapId: string }[] }).taps.map((t) => t.tapId), "死会话的 tap 应被清理").not.toContain(tap.tapId);
  });

  it("session_abort：目标必须是 session 地址（否则显式抛，不静默）", async () => {
    const { store, stops } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    await bus.opSessionAbort(sessionAddress("s1"), sessionAddress("s2"));
    expect(stops).toEqual(["s2"]);
    await expect(bus.opSessionAbort(sessionAddress("s1"), "channel:room")).rejects.toThrow(/session 地址/);
  });

  it("未知 desktop op → 把错误当响应回给发起方", async () => {
    const { store, prompts } = makeStore();
    const { sink } = makeSink();
    const bus = new SessionBus(store as never, sink);
    await bus.handleFrame("s1", frame("session:s1", "desktop", "no_such_op"));
    await settle();
    expect(prompts[0].text).toContain("未知 desktop op");
  });
});
