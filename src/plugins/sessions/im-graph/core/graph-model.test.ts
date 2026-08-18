// graph-model 单元测试 —— 基线快照折叠 + 帧增量(脉冲/成员/spawn 父子) + 竖向布局。
import { describe, it, expect } from "vitest";
import type { SessionBusMessage } from "@my-harness-desktop/contract";
import {
  applyFrame, applyStatus, edgesOf, emptyModel, layout, linkedRefs,
} from "./graph-model";

const NOW = 1_760_000_000_000;

function frame(kind: string, over: Partial<SessionBusMessage> = {}): SessionBusMessage {
  return {
    $bus: true, id: `f-${kind}-1`, from: "session:w1", to: "channel:ops",
    kind, payload: {}, timestamp: NOW, ...over,
  };
}

const STATUS = {
  sessions: [
    { key: "main", name: "盲审总指挥", busy: true, cwd: "/repo", sessionPath: "/s/1_main.jsonl", spawnedBy: undefined },
    { key: "w1", busy: false, cwd: "/repo", sessionPath: "/s/2_w1.jsonl", spawnedBy: "session:main" },
    { key: "w2", busy: false, cwd: "/repo", sessionPath: "/s/3_w2.jsonl", spawnedBy: "session:ghost" },
  ],
  channels: [
    { channel: "channel:ops", members: ["session:main", "session:w1", "plugin:im-graph"] },
  ],
};

describe("applyStatus:全景快照折叠", () => {
  it("建会话/房间节点;plugin 成员不进图;spawnedBy 保留", () => {
    const m = applyStatus(emptyModel(), STATUS);
    expect([...m.sessions.keys()]).toEqual(["main", "w1", "w2"]);
    expect(m.sessions.get("main")?.busy).toBe(true);
    expect(m.sessions.get("w1")?.spawnedBy).toBe("session:main");
    expect([...m.channels.keys()]).toEqual(["ops"]);
    expect([...(m.members.get("ops") ?? [])]).toEqual(["main", "w1"]);
  });

  it("label 优先会话名;无名退回 uuid 短码", () => {
    const m = applyStatus(emptyModel(), STATUS);
    expect(m.sessions.get("main")?.label).toBe("盲审总指挥");
    expect(m.sessions.get("w1")?.label).toBe("w1");
  });

  it("跨快照保留 settledAt 历史痕迹", () => {
    let m = applyStatus(emptyModel(), STATUS);
    const r = applyFrame(m, frame("tap_event", { from: "session:w1", payload: { eventType: "agentSettled" } }), NOW);
    m = applyStatus(r.model, STATUS);
    expect(m.sessions.get("w1")?.settledAt).toBe(NOW);
  });
});

describe("applyFrame:帧增量", () => {
  it("chat 扇出:from→房间 一条 + 房间→每个其他成员各一条", () => {
    const m = applyStatus(emptyModel(), STATUS);
    const r = applyFrame(m, frame("chat", { from: "session:main" }), NOW);
    expect(r.pulses.map((p) => p.path)).toEqual([
      ["s:main", "c:ops"],
      ["c:ops", "s:w1"],
    ]);
    expect(r.unknownSeen).toBe(false);
  });

  it("peer_joined/left 维护成员并发脉冲;未知会话置 unknownSeen", () => {
    const m = applyStatus(emptyModel(), STATUS);
    const joined = applyFrame(m, frame("peer_joined", {
      from: "desktop", payload: { member: "session:w9" },
    }), NOW);
    expect(joined.unknownSeen).toBe(true);
    expect([...(joined.model.members.get("ops") ?? [])]).toContain("w9");
    const left = applyFrame(joined.model, frame("peer_left", {
      id: "f-l", from: "desktop", payload: { member: "session:w1" },
    }), NOW);
    expect([...(left.model.members.get("ops") ?? [])]).not.toContain("w1");
    expect(left.pulses[0]?.kind).toBe("leave");
  });

  it("tap_event:agentStart 亮、agentSettled 灭并向 spawn 父发 done 脉冲", () => {
    const m = applyStatus(emptyModel(), STATUS);
    const started = applyFrame(m, frame("tap_event", { payload: { eventType: "agentStart" } }), NOW);
    expect(started.model.sessions.get("w1")?.busy).toBe(true);
    const settled = applyFrame(started.model, frame("tap_event", {
      id: "f-s", payload: { eventType: "agentSettled" },
    }), NOW);
    const node = settled.model.sessions.get("w1");
    expect(node?.busy).toBe(false);
    expect(node?.settledAt).toBe(NOW);
    expect(settled.pulses).toEqual([
      { id: "f-s:done", kind: "done", path: ["s:w1", "s:main"], status: undefined },
    ]);
  });

  it("spawn 父不在图时 settled 不发 done 脉冲(无目标)", () => {
    const m = applyStatus(emptyModel(), STATUS);
    const r = applyFrame(m, frame("tap_event", {
      from: "session:w2", payload: { eventType: "agentSettled" },
    }), NOW);
    expect(r.pulses).toEqual([]);
  });

  it("bus_throttled 记房间熔断时刻", () => {
    const m = applyStatus(emptyModel(), STATUS);
    const r = applyFrame(m, frame("bus_throttled", { from: "desktop" }), NOW);
    expect(r.model.channels.get("ops")?.throttledAt).toBe(NOW);
  });
});

describe("edgesOf / layout:边派生与左右两段布局", () => {
  it("spawn 边只在父在图时存在;member 边全量", () => {
    const m = applyStatus(emptyModel(), STATUS);
    const edges = edgesOf(m);
    expect(edges.spawn).toEqual([{ from: "s:main", to: "s:w1" }]);
    expect(edges.member).toHaveLength(2);
  });

  it("布局:根行序在前、子节点缩进;房间在右列、y 取成员均值", () => {
    const m = applyStatus(emptyModel(), STATUS);
    const v = layout(m);
    const main = v.nodes.find((n) => n.ref === "s:main");
    const w1 = v.nodes.find((n) => n.ref === "s:w1");
    const ops = v.nodes.find((n) => n.ref === "c:ops");
    expect(main?.depth).toBe(0);
    expect(w1?.depth).toBe(1);
    expect((w1?.y ?? 0) > (main?.y ?? 0)).toBe(true);
    expect((w1?.x ?? 0) > (main?.x ?? 0)).toBe(true);
    // ops 成员 main(中心19) + w1(中心49) → 均值34,chip y = 34 - 9 = 25
    expect(ops?.x).toBe(196);
    expect(ops?.y).toBe(25);
    expect(v.channelsHeader).not.toBeNull();
  });

  it("linkedRefs:聚焦保留 自身 + spawn 直系亲属 + 所在房间", () => {
    const m = applyStatus(emptyModel(), STATUS);
    expect([...linkedRefs(m, "w1")].sort()).toEqual(["c:ops", "s:main", "s:w1"]);
    expect([...linkedRefs(m, "main")].sort()).toEqual(["c:ops", "s:main", "s:w1"]);
    // w2 的 spawn 父(ghost)不在图且不在任何房间 → 只有自身
    expect([...linkedRefs(m, "w2")].sort()).toEqual(["s:w2"]);
  });
});
