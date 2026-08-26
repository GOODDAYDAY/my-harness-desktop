// NeutralSessionStore 单测:中立会话树的持久化读写(纯存储,不依赖内核)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NeutralSessionStore } from "./neutral-session-store";
import type { NeutralSession } from "@my-harness-desktop/shared";

describe("NeutralSessionStore", () => {
  let dir: string;
  let store: NeutralSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "neutral-session-"));
    store = new NeutralSessionStore(join(dir, "sessions"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const makeSession = (id: string): NeutralSession => ({
    neutralSessionId: id,
    header: { kernel: "pi", cwd: "/proj", createdAt: new Date().toISOString() },
    lineages: [{
      lineageId: "root",
      fork: null,
      entries: [
        { neutralEntryId: "root:0", message: { role: "user", content: "你好", id: "m1" } },
      ],
    }],
  });

  it("put 后 get 读回完整树", () => {
    const s = makeSession("ns-1");
    store.put(s);
    expect(store.get("ns-1")).toEqual(s);
  });

  it("get 不存在返回 null", () => {
    expect(store.get("nope")).toBeNull();
  });

  it("delete 后 get 返回 null", () => {
    store.put(makeSession("ns-1"));
    store.delete("ns-1");
    expect(store.get("ns-1")).toBeNull();
  });

  it("损坏文件返回 null 不抛", () => {
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", "bad.json"), "{ not valid json", "utf-8");
    expect(store.get("bad")).toBeNull();
  });

  it("listByCwd 按 header.cwd 过滤,损坏文件跳过", () => {
    const a = makeSession("ns-a");
    a.header.cwd = "/proj";
    const b = makeSession("ns-b");
    b.header.cwd = "/other";
    store.put(a);
    store.put(b);
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", "bad.json"), "{ not valid json", "utf-8");

    const list = store.listByCwd("/proj");
    expect(list.map((s) => s.neutralSessionId)).toEqual(["ns-a"]);
  });

  it("listByCwd 目录不存在返回空数组", () => {
    expect(store.listByCwd("/proj")).toEqual([]);
  });
});
