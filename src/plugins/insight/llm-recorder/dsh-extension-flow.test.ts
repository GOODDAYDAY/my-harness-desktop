import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// dsh 侧扩展是**纯 .mjs**（它被原样同步进 ~/.dsh/.my-harness-desktop-plugins/，不经 TS 构建，
// 与 pi 侧被 esbuild 打包成 .js 的路径不同），因此没有类型声明。用 ts-expect-error 精确收口
// 这一条，而不是给全仓放宽 allowJs —— 只此一处 import .mjs。
// @ts-expect-error 无类型声明的内核侧插件模块（见上）
import dshRecorderUntyped from "./dsh-extension/index.mjs";
const dshRecorder = dshRecorderUntyped as { apply: (ctx: unknown) => void };
import { pairRecords, parseLogText } from "./core/log-model";

/**
 * llm-recorder 的 **dsh 侧** 扩展流程测试 —— 与 pi 侧 extension-flow.test.ts 对称。
 *
 * 为什么必须补这条：dsh 写侧此前**根本不存在**（插件只有 piExtension，没有 dshExtension），
 * 症状是「dsh 内核执行时右侧请求记录恒空」。补了 dshExtension 之后，写侧只有**零测试**的
 * 实现支撑——读侧一行没改、配对契约靠肉眼对齐，一旦 hook 名或配对语义漂了，
 * 面板只会安静地空着，没有任何守卫能发现。本文件把 dsh 侧的数据面钉住。
 *
 * 同时钉住一条**与 pi 不同的时序不变量**（也是「记录停在未返回」的根因）：
 * dsh 的 response 行不在一次调用结束的瞬间写，而是等到**回合边界**
 * (`agent/turn-stopping`) 或下一次 `agent/request` 的 (turn,step) 变化才结算。
 * 读侧因此必须把增量刷新挂到**回合边界**（agentSettled）上，只挂 messageEnd 会永远读到
 * 「请求已发、响应未回」。
 *
 * 放插件根目录而非 dsh-extension/ 内：该目录整体同步到
 * ~/.dsh/.my-harness-desktop-plugins/llm-recorder/，测试文件不能混进去。
 */

type Handler = (payload: unknown, next?: () => unknown) => unknown;

/** 假 dsh ctx：只实现扩展真正用到的 `on(hook, handler)`（与其他内核扩展同款最小面）。 */
interface FakeDsh {
  on: (hook: string, handler: Handler) => void;
  /** 扩展的 handler 是 async(waterfall 里 await next()),所以 fire 必须 await —— 
   *  否则断言跑在写入之前,测试变成"永远看不到落盘"的假红，而不是真的验证了时序。 */
  fire: (hook: string, payload: unknown) => Promise<void>;
}

function makeFakeDsh(): FakeDsh {
  const handlers = new Map<string, Handler>();
  return {
    on(hook, handler) {
      handlers.set(hook, handler);
    },
    async fire(hook, payload) {
      // next() 在真实 dsh 里回传（可能被上游改写的）调用配置 —— 假体据此原样回传 payload.config，
      // 否则 request 行的 payload 会是 undefined，测试就验不到"原样记 LlmCallConfig"这条契约。
      await handlers.get(hook)?.(payload, () => (payload as { config?: unknown })?.config);
    },
  };
}

const origCwd = process.cwd();
let tmp: string;
/** 每个用例一个独立会话 id：扩展的 `sessions` Map 是模块级状态，同一 id 会把上一个用例的
 *  seq/shard 缓存带过来（实测：第二个用例读到 seq 5、6 而不是 1、2）。换 id 等价于
 *  "另一个会话/另一个 dsh 进程"，与真实场景一致，且不必引入模块重载这种脆弱手法。 */
let SID: string;
let sidSeq = 0;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llm-recorder-dsh-"));
  process.chdir(tmp);
  SID = `sid-${++sidSeq}`;
});

afterEach(() => {
  process.chdir(origCwd);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const logFilePath = (): string => join(tmp, ".my-harness-desktop", "llm-logs", `${SID}.jsonl`);

const lines = (): ReturnType<typeof parseLogText> => parseLogText(readFileSync(logFilePath(), "utf8"));

/** 一次 agent/request：dsh 给的 LlmCallConfig(provider/model/参数),原样记。 */
function fireRequest(dsh: FakeDsh, turn = 0, step = 0): Promise<void> {
  return dsh.fire("agent/request", {
    agent: { id: SID },
    turn,
    step,
    config: { provider: "bifrost", model: "deepseek-v4-pro", temperature: 0.3 },
  });
}

describe("llm-recorder dsh 侧数据面", () => {
  it("agent/request 落一条 request 行(seq 从 1 起,带 turn/step 与原始 config)", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    await fireRequest(dsh);
    const l = lines();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ kind: "request", seq: 1, turnIndex: 0, step: 0 });
    expect((l[0] as { payload?: unknown }).payload).toMatchObject({ provider: "bifrost", model: "deepseek-v4-pro" });
  });

  it("回合边界(agent/turn-stopping)才补 response 行 —— 这正是「记录停在未返回」的根源时序", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    await fireRequest(dsh);
    // 一次调用「结束」的那一刻（对 pi 就是 messageEnd 那一刻）——dsh 侧**还没有** response 行
    expect(lines().filter((x) => x.kind === "response")).toHaveLength(0);
    // 回合边界到了才结算
    await dsh.fire("agent/turn-stopping", { agent: { id: SID } });
    const responses = lines().filter((x) => x.kind === "response");
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ kind: "response", seq: 1 });
    // 配对可用（读侧 pairRecords 拿到的是一条"已返回"的记录，不是恒 pending）
    expect(pairRecords(lines())[0]).toMatchObject({ seq: 1 });
  });

  it("(turn,step) 变化即结算上一次成功(中途没有回合边界时的兜底)", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    await fireRequest(dsh, 0, 0);
    await fireRequest(dsh, 0, 1); // 下一步 → 上一步结算
    const responses = lines().filter((x) => x.kind === "response");
    expect(responses.map((r) => r.seq)).toEqual([1]);
    expect(lines().filter((r) => r.kind === "request").map((r) => r.seq)).toEqual([1, 2]);
  });

  it("agent/request-error 结算为失败行(带 error,不伪造 status)", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    await fireRequest(dsh);
    await dsh.fire("agent/request-error", { agent: { id: SID }, failure: { message: "boom" } });
    const r = lines().filter((x) => x.kind === "response");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "response", seq: 1 });
    expect((r[0] as { error?: unknown }).error).toBeTruthy();
    expect((r[0] as { status?: unknown }).status).toBeUndefined(); // 不编造状态码
  });

  it("进程重启(新扩展实例)后 seq 从磁盘续号,不归零碰撞", async () => {
    const d1 = makeFakeDsh();
    dshRecorder.apply(d1 as never);
    await fireRequest(d1, 0, 0);
    await d1.fire("agent/turn-stopping", { agent: { id: SID } });
    await fireRequest(d1, 0, 1);
    await d1.fire("agent/turn-stopping", { agent: { id: SID } });

    const d2 = makeFakeDsh();
    dshRecorder.apply(d2 as never);
    await fireRequest(d2, 0, 0);
    expect(lines().filter((x) => x.kind === "request").map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  it("无 agent.id 的载荷不写(不产出无主孤儿文件)", async () => {
    const dsh = makeFakeDsh();
    dshRecorder.apply(dsh as never);
    await dsh.fire("agent/request", { turn: 0, step: 0, config: {} });
    expect(() => readFileSync(logFilePath(), "utf8")).toThrow();
  });
});
