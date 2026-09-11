// minimal 事件面测试 —— §4.2.3「十种事件，一份常量，无省略号」的可执行版本。
//
// 为什么要有这一条：文档把十种事件写成规格（"没有省略号"），而实现里曾有**三种从没发过**
// （sessionStart / toolCallUpdate / entryAppended）——壳侧的透传白名单、插件可订阅清单、
// 上行同步分支全都列着它们，却永远不触发。这类"文档说有、代码没有"的漂移没有任何症状，
// 只表现为"某个能力用起来不对/没反应"，正是最难查的一种。
//
// 本文件钉三件事：
//   ① 常量清单 = 文档那十种（多一个少一个都算漂移）；
//   ② 一次带工具调用的完整回合，**十种事件全部实际发出来**（用真实子进程 + 本地 mock SSE）；
//   ③ 插件 `on()` 的订阅边界（未知事件 / 过程事件显式拒绝，不静默订阅一个永不触发的名字）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { createMinimalSubprocess } from "./subprocess-lifecycle";
import { MinimalTransport, type MinimalEvent } from "./minimal-transport";
// @ts-expect-error 内核侧 .mjs 无类型声明（与 dsh-extension 同款：纯 JS 进内核进程，不经 TS 构建）
import { EVENT_NAMES, EVENTS, SUBSCRIBABLE_EVENTS } from "../kernel/minimal-events.mjs";
// @ts-expect-error 同上
import { createPluginHost } from "../kernel/minimal-plugin.mjs";

const CLI_PATH = resolve(process.cwd(), "src/server/kernel/minimal/kernel/minimal-cli.mjs");

let agentDir: string;
let cwd: string;
let server: Server;

beforeEach(async () => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-events-"));
  cwd = mkdtempSync(join(tmpdir(), "minimal-events-proj-"));
  writeFileSync(join(cwd, "note.txt"), "内容", "utf-8");

  // mock 服务器：第一轮把 read 的参数**拆成两个分片**发（这正是 toolCallUpdate 的触发条件，
  // §4.8.2：id 首次到位发 toolCallStart、之后 arguments 继续到达发 toolCallUpdate）；
  // 第二轮（已带 tool 结果）返回最终文本。
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const hasTool = (parsed.messages ?? []).some((m: { role?: string }) => m.role === "tool");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (!hasTool) {
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}\n\n');
        // 第二个分片：同一个 index、没有 id/name，只有 arguments 追加（真实网关的分片就是这么长）
        res.write(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":${JSON.stringify(JSON.stringify(join(cwd, "note.txt")) + "}")}}}]}}]}\n\n`);
        res.write("data: [DONE]\n\n");
      } else {
        res.write('data: {"choices":[{"delta":{"content":"完成"}}]}\n\n');
        res.write("data: [DONE]\n\n");
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: [{ id: "mock", baseURL: `http://127.0.0.1:${port}/v1`, models: [{ id: "mock-model", name: "Mock" }] }],
    default: { provider: "mock", model: "mock-model" },
  }));
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("事件常量清单（§4.2.3 十种，无省略号）", () => {
  it("恰好十种，且与文档列举的一字不差", () => {
    const documented = [
      "sessionStart", "agentStart", "agentSettled",
      "messageStart", "messageUpdate", "messageEnd",
      "toolCallStart", "toolCallUpdate", "toolCallEnd",
      "entryAppended",
    ];
    expect([...EVENT_NAMES].sort()).toEqual([...documented].sort());
    expect(EVENT_NAMES).toHaveLength(10);
  });

  it("可订阅五个 / 不可订阅五个，两集互补且都属于十种", () => {
    expect([...SUBSCRIBABLE_EVENTS].sort()).toEqual(
      ["agentSettled", "agentStart", "messageEnd", "sessionStart", "toolCallEnd"].sort(),
    );
    const notSubscribable = EVENT_NAMES.filter((e: string) => !SUBSCRIBABLE_EVENTS.includes(e));
    expect(notSubscribable.sort()).toEqual(
      ["entryAppended", "messageStart", "messageUpdate", "toolCallStart", "toolCallUpdate"].sort(),
    );
    // 互补：两个集合的并集就是那十种，不重不漏
    expect(SUBSCRIBABLE_EVENTS.length + notSubscribable.length).toBe(EVENT_NAMES.length);
  });
});

describe("一次带工具调用的完整回合：十种事件全部实际发出", () => {
  it("事件集合 === 文档那十种（此前 sessionStart/toolCallUpdate/entryAppended 三种从未发出）", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-events" });
    const t = new MinimalTransport(handle);
    const seen = new Set<string>();
    const settled = new Promise<void>((resolve) => {
      t.onEvent((e) => {
        seen.add(e.type);
        if (e.type === "agentSettled") resolve();
      });
    });
    t.start();
    t.send({ type: "send", text: "读一下 note.txt" });
    await settled;
    await t.stop();

    const missing = EVENT_NAMES.filter((e: string) => !seen.has(e));
    expect(missing, `文档列了、实现没发的事件：${missing.join(", ")}`).toEqual([]);
    const extra = [...seen].filter((e) => !EVENT_NAMES.includes(e));
    expect(extra, `发了不在清单里的事件（清单该更新或实现该收敛）：${extra.join(", ")}`).toEqual([]);
  });

  it("toolCallUpdate 真的带分片参数（不是把 Start 复制一遍）", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-events2" });
    const t = new MinimalTransport(handle);
    const updates: { argsText?: string }[] = [];
    const settled = new Promise<void>((resolve) => {
      t.onEvent((e) => {
        if (e.type === "toolCallUpdate") updates.push(e as { argsText?: string });
        if (e.type === "agentSettled") resolve();
      });
    });
    t.start();
    t.send({ type: "send", text: "读一下 note.txt" });
    await settled;
    await t.stop();
    expect(updates.length, "只收到一个分片——mock 服务器发了两个，说明中间态没上报").toBeGreaterThanOrEqual(2);
    // 分片是**累积快照**（第一片 `{"path":` 是前缀，第二片更长）
    const [first, second] = updates.map((u) => u.argsText ?? "");
    expect(first).toBe('{"path":');
    expect(second.length).toBeGreaterThan(first.length);
    expect(second.startsWith(first), "第二片不是第一片的续写——说明不是累积快照，而是互相覆盖").toBe(true);
  });
});

describe("插件订阅边界（§6.2.3）", () => {
  it("未知事件名 → 显式抛错（不静默订阅一个永不触发的名字）", () => {
    const host = createPluginHost(agentDir, "probe");
    expect(() => host.on("agentSetled", () => {})).toThrow(/未知事件/);
  });

  it("流式过程事件 → 显式拒绝（这是能力边界，不是漏做）", () => {
    const host = createPluginHost(agentDir, "probe");
    for (const e of [EVENTS.messageUpdate, EVENTS.toolCallUpdate, EVENTS.entryAppended, EVENTS.messageStart, EVENTS.toolCallStart]) {
      expect(() => host.on(e, () => {}), `${e} 本应在高频路径上，不该可订阅`).toThrow(/不可订阅/);
    }
  });

  it("可订阅的那五个 → 正常挂上并返回退订函数", () => {
    const host = createPluginHost(agentDir, "probe");
    for (const e of SUBSCRIBABLE_EVENTS) {
      const off = host.on(e, () => {});
      expect(typeof off).toBe("function");
      off();
    }
  });
});
