import { describe, it, expect } from "vitest";
import { filterSessions } from "./search";
import type { SessionInfo } from "@my-harness-desktop/react";

const s = (over: Partial<SessionInfo>): SessionInfo => ({
  path: "/p/s.jsonl",
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  cwd: "/p",
  created: "2026-08-27T08:00:00.000Z",
  modified: "2026-08-27T08:00:00.000Z",
  ...over,
});

describe("filterSessions 搜索过滤", () => {
  const sessions = [
    s({ name: "修 bug", id: "aaaa1111-0000-0000-0000-000000000001", neutralSessionId: "aaaa1111-0000-0000-0000-000000000001" }),
    s({ name: undefined, id: "bbbb2222-0000-0000-0000-000000000002", neutralSessionId: "bbbb2222-0000-0000-0000-000000000002" }),
    s({ name: "写文档", id: "cccc3333-0000-0000-0000-000000000003" }),
  ];

  it("空 query 原样返回", () => {
    expect(filterSessions(sessions, "")).toBe(sessions);
  });

  it("按 name 命中", () => {
    expect(filterSessions(sessions, "bug").map((x) => x.id)).toEqual(["aaaa1111-0000-0000-0000-000000000001"]);
  });

  it("按 created 命中", () => {
    expect(filterSessions(sessions, "2026-08-27").length).toBe(3);
  });

  it("按 id 前缀命中(未命名会话,D9)", () => {
    expect(filterSessions(sessions, "bbbb2222").map((x) => x.id)).toEqual(["bbbb2222-0000-0000-0000-000000000002"]);
  });

  it("按 neutralSessionId 命中(未命名会话,D9)", () => {
    expect(filterSessions(sessions, "2222-0000").map((x) => x.id)).toEqual(["bbbb2222-0000-0000-0000-000000000002"]);
  });

  it("不命中返回空数组", () => {
    expect(filterSessions(sessions, "不存在的词")).toEqual([]);
  });
});
