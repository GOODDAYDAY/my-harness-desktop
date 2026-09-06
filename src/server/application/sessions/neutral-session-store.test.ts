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

  // ============ 灾难隔离守卫(r370 根因修复,候选十一)============
  // 形态:合法 JSON 但 lineages=null(断电半写)曾滑过 parse 守卫落进列表,
  // 在 neutralToSessionInfo 的 lineages.find 上炸掉整条 map——单坏文件拖垮全列表
  // (健康的邻居也消失)。守卫钉死:坏形状与坏 JSON 同等跳过,邻居健在。
  it("lineages=null(合法 JSON 但形状坏)被跳过,健康邻居健在(r370 守卫)", () => {
    store.put(makeSession("healthy-1"));
    // 手写形状坏文件:lineages = null
    writeFileSync(join((store as unknown as { dir: string }).dir, "corrupt-shape.json"), JSON.stringify({
      neutralSessionId: "corrupt",
      header: { kernel: "pi", cwd: "/proj", createdAt: "2024-01-01T00:00:00Z" },
      lineages: null,
    }));
    const list = store.listByCwd("/proj");
    expect(list.map((s) => s.neutralSessionId)).toEqual(["healthy-1"]); // 坏文件跳过,邻居在
  });

  it("JSON 半截(截断)被跳过,健康邻居健在", () => {
    store.put(makeSession("healthy-2"));
    writeFileSync(join((store as unknown as { dir: string }).dir, "truncated.json"), '{"neutralSessionId":"trunc","lineages":[');
    const list = store.listByCwd("/proj");
    expect(list.map((s) => s.neutralSessionId)).toEqual(["healthy-2"]);
  });

  it("get 的形状守卫(r370 姊妹口):lineages=null 返回 null 而非坏对象", () => {
    // 9 个调用方(openSession/写穿/树)全信任 get 返回——坏形状必须拦在源头
    mkdirSync((store as unknown as { dir: string }).dir, { recursive: true });  // 首个 put 前目录不存在
    writeFileSync(join((store as unknown as { dir: string }).dir, "bad-get.json"), JSON.stringify({
      neutralSessionId: "bad-get",
      header: { kernel: "pi", cwd: "/proj", createdAt: "2024-01-01T00:00:00Z" },
      lineages: null,
    }));
    expect(store.get("bad-get")).toBeNull(); // 形状坏 = 损坏,不滑过
  });

  it("lineages 非数组(字符串形态)也被形状守卫拒", () => {
    store.put(makeSession("healthy-3"));
    writeFileSync(join((store as unknown as { dir: string }).dir, "lineages-string.json"), JSON.stringify({
      neutralSessionId: "bad-type",
      header: { kernel: "pi", cwd: "/proj", createdAt: "2024-01-01T00:00:00Z" },
      lineages: "corrupted-string",
    }));
    const list = store.listByCwd("/proj");
    expect(list.map((s) => s.neutralSessionId)).toEqual(["healthy-3"]);
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
