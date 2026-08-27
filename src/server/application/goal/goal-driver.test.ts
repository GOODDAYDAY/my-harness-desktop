import { describe, it, expect } from "vitest";
import type { SessionEvent } from "@my-harness-desktop/shared";
import { GoalDriver, SET_GOAL_TOOL, ACHIEVE_GOAL_TOOL, type GoalDriverHost } from "./goal-driver";

/** 让异步续跑(async maybeContinue)跑完 in-flight 护栏的微任务。 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** 假宿主:捕获事件回调 + 记录续跑提示,不碰任何内核。 */
function makeHost() {
  const prompts: string[] = [];
  let cb: ((event: SessionEvent) => void) | undefined;
  const host: GoalDriverHost = {
    onEvent(c) { cb = c; return () => { cb = undefined; }; },
    prompt(text: string) { prompts.push(text); return Promise.resolve(); },
  };
  return { host, emit: (e: SessionEvent) => cb?.(e), prompts };
}

function toolCallStart(name: string, args?: unknown): SessionEvent {
  return { type: "toolCallStart", toolName: name, args } as SessionEvent;
}

describe("GoalDriver(内核无关续跑驱动)", () => {
  it("set_goal 后回合收敛 → 注入续跑提示", async () => {
    const { host, emit, prompts } = makeHost();
    const driver = new GoalDriver(host);
    driver.install();

    emit(toolCallStart(SET_GOAL_TOOL, { objective: "写个 README" }));
    expect(driver.getState()?.phase).toBe("active");
    expect(driver.getState()?.objective).toBe("写个 README");

    emit({ type: "agentSettled" });
    await flush();
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("写个 README");
    expect(prompts[0]).toContain("<goal_round>");
  });

  it("achieve_goal 后回合收敛 → 不再续跑", async () => {
    const { host, emit, prompts } = makeHost();
    const driver = new GoalDriver(host);
    driver.install();

    emit(toolCallStart(SET_GOAL_TOOL, { objective: "x" }));
    emit(toolCallStart(ACHIEVE_GOAL_TOOL));
    expect(driver.getState()?.phase).toBe("achieved");

    emit({ type: "agentSettled" });
    await flush();
    expect(prompts.length).toBe(0);
  });

  it("无目标时回合收敛 → 不续跑", async () => {
    const { host, emit, prompts } = makeHost();
    const driver = new GoalDriver(host);
    driver.install();

    emit({ type: "agentSettled" });
    await flush();
    expect(prompts.length).toBe(0);
  });

  it("畸形 set_goal 入参被静默忽略", async () => {
    const { host, emit, prompts } = makeHost();
    const driver = new GoalDriver(host);
    driver.install();

    emit(toolCallStart(SET_GOAL_TOOL, { objective: "   " })); // 空 objective
    expect(driver.getState()).toBeUndefined();

    emit({ type: "agentSettled" });
    await flush();
    expect(prompts.length).toBe(0);
  });

  it("轮数上限:续跑到 maxRounds 后停止", async () => {
    const { host, emit, prompts } = makeHost();
    const driver = new GoalDriver(host);
    driver.install();

    emit(toolCallStart(SET_GOAL_TOOL, { objective: "x", max_rounds: 2 }));
    expect(driver.getState()?.maxRounds).toBe(2);

    // 第 1 轮
    emit({ type: "agentSettled" });
    await flush();
    expect(prompts.length).toBe(1);

    // 第 2 轮(达到上限)
    emit({ type: "agentSettled" });
    await flush();
    expect(prompts.length).toBe(2);

    // 第 3 轮:已超上限,不再续跑
    emit({ type: "agentSettled" });
    await flush();
    expect(prompts.length).toBe(2);
    expect(driver.getState()?.round).toBe(2);
  });

  it("achieve_goal 在没有目标时是 no-op(不崩)", () => {
    const { host, emit } = makeHost();
    const driver = new GoalDriver(host);
    driver.install();
    emit(toolCallStart(ACHIEVE_GOAL_TOOL));
    expect(driver.getState()).toBeUndefined();
  });

  it("uninstall 后不再响应事件", async () => {
    const { host, emit, prompts } = makeHost();
    const driver = new GoalDriver(host);
    const uninstall = driver.install();
    uninstall();

    emit(toolCallStart(SET_GOAL_TOOL, { objective: "x" }));
    expect(driver.getState()).toBeUndefined();
    emit({ type: "agentSettled" });
    await flush();
    expect(prompts.length).toBe(0);
  });

  it("pause 后回合收敛不再续跑;resume 后恢复续跑", async () => {
    const { host, emit, prompts } = makeHost();
    const driver = new GoalDriver(host);
    driver.install();

    emit(toolCallStart(SET_GOAL_TOOL, { objective: "x" }));
    driver.pause();
    expect(driver.getState()?.phase).toBe("paused");

    emit({ type: "agentSettled" });
    await flush();
    expect(prompts.length).toBe(0); // 暂停不续跑

    driver.resume();
    expect(driver.getState()?.phase).toBe("active");
    emit({ type: "agentSettled" });
    await flush();
    expect(prompts.length).toBe(1); // 恢复后继续
  });

  it("edit 改 objective(下次续跑生效)", async () => {
    const { host, emit, prompts } = makeHost();
    const driver = new GoalDriver(host);
    driver.install();

    emit(toolCallStart(SET_GOAL_TOOL, { objective: "旧目标" }));
    driver.edit("新目标");
    expect(driver.getState()?.objective).toBe("新目标");

    emit({ type: "agentSettled" });
    await flush();
    expect(prompts[0]).toContain("新目标");
  });

  it("clear 清空目标后不再续跑", async () => {
    const { host, emit, prompts } = makeHost();
    const driver = new GoalDriver(host);
    driver.install();

    emit(toolCallStart(SET_GOAL_TOOL, { objective: "x" }));
    driver.clear();
    expect(driver.getState()).toBeUndefined();

    emit({ type: "agentSettled" });
    await flush();
    expect(prompts.length).toBe(0);
  });

  it("onChange 在每次状态变更时触发(含清空为 undefined)", () => {
    const { host, emit } = makeHost();
    const driver = new GoalDriver(host);
    driver.install();
    const seen: (string | undefined)[] = [];
    driver.onChange((s) => seen.push(s?.objective));

    emit(toolCallStart(SET_GOAL_TOOL, { objective: "a" }));
    driver.edit("b");
    driver.pause();
    driver.clear();
    expect(seen).toEqual(["a", "b", "b", undefined]);
  });
});
