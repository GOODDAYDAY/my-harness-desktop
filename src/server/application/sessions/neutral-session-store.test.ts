// NeutralSessionStore 单测:中立会话树的持久化读写(纯存储,不依赖内核)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
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

  // ============ header/entries 拆分(neutral-storage-split §2.1)============

  it("put 写拆分双文件(header+entries),无遗留整树文件,紧凑序列化", () => {
    store.put(makeSession("ns-split"));
    const dirPath = (store as unknown as { dir: string }).dir;
    const files = readdirSync(dirPath);
    expect(files.sort()).toEqual(["ns-split.entries.json", "ns-split.header.json"]);
    // 紧凑序列化(顺手刀):无美化缩进(文件不含换行)
    expect(readFileSync(join(dirPath, "ns-split.header.json"), "utf-8")).not.toContain("\n");
    expect(readFileSync(join(dirPath, "ns-split.entries.json"), "utf-8")).not.toContain("\n");
  });

  it("getHeader 返回摘要:带 rootLineageId,不带 lineages", () => {
    store.put(makeSession("ns-h"));
    const summary = store.getHeader("ns-h");
    expect(summary).toBeTruthy();
    expect(summary!.neutralSessionId).toBe("ns-h");
    expect(summary!.rootLineageId).toBe("root"); // makeSession 的根 lineageId
    expect(summary!.header.cwd).toBe("/proj");
    expect("lineages" in summary!).toBe(false);
  });

  it("listByCwd 返回摘要不带 lineages(类型层收窄:列表想拿 entries 写不出来)", () => {
    store.put(makeSession("ns-l"));
    const list = store.listByCwd("/proj");
    expect(list).toHaveLength(1);
    expect(list[0].neutralSessionId).toBe("ns-l");
    expect(list[0].rootLineageId).toBe("root");
    expect("lineages" in list[0]).toBe(false);
  });

  it("懒迁移:遗留整树文件读到即拆,顺手 heal 头字段,旧文件删除", () => {
    const dirPath = (store as unknown as { dir: string }).dir;
    mkdirSync(dirPath, { recursive: true });
    // pre-阶段-D 形态的遗留文件:header 缺 lastMessage/lastEntryId/updatedAt
    const legacy: NeutralSession = {
      neutralSessionId: "ns-legacy",
      header: { kernel: "pi", cwd: "/proj", createdAt: "2024-01-01T00:00:00.000Z" },
      lineages: [{
        lineageId: "ns-legacy",
        fork: null,
        entries: [{ neutralEntryId: "ns-legacy:0", message: { role: "user", content: "历史消息", timestamp: 1700000000000 } }],
      }],
    };
    writeFileSync(join(dirPath, "ns-legacy.json"), JSON.stringify(legacy));

    const list = store.listByCwd("/proj");
    expect(list).toHaveLength(1);
    // heal 落盘:lastMessage/updatedAt 从 entries 补齐
    expect(list[0].header.lastMessage).toBe("历史消息");
    expect(list[0].header.updatedAt).toBe("2023-11-14T22:13:20.000Z");
    expect(list[0].header.lastEntryId).toBe("ns-legacy:0");
    // 旧文件已删,拆分文件已建
    expect(existsSync(join(dirPath, "ns-legacy.json"))).toBe(false);
    expect(existsSync(join(dirPath, "ns-legacy.header.json"))).toBe(true);
    expect(existsSync(join(dirPath, "ns-legacy.entries.json"))).toBe(true);
    // 迁移后 get 能读回完整树
    expect(store.get("ns-legacy")?.lineages[0].entries).toHaveLength(1);
  });

  it("putHeader 只写 header 小文件,entries 原样不动", () => {
    store.put(makeSession("ns-ph"));
    const dirPath = (store as unknown as { dir: string }).dir;
    const entriesBefore = readFileSync(join(dirPath, "ns-ph.entries.json"), "utf-8");
    store.putHeader("ns-ph", { kernel: "pi", cwd: "/proj", createdAt: "2024-01-01T00:00:00Z", archived: true });
    expect(readFileSync(join(dirPath, "ns-ph.entries.json"), "utf-8")).toBe(entriesBefore);
    expect(store.getHeader("ns-ph")?.header.archived).toBe(true);
    // get 全量读回来,entries 没丢
    expect(store.get("ns-ph")?.lineages[0].entries).toHaveLength(1);
  });

  it("putHeader 保留 rootLineageId(header 文件重写不丢投影坐标)", () => {
    store.put(makeSession("ns-rl"));
    store.putHeader("ns-rl", { kernel: "pi", cwd: "/proj", createdAt: "2024-01-01T00:00:00Z", pinned: true });
    expect(store.getHeader("ns-rl")?.rootLineageId).toBe("root");
  });

  it("put 顺手删同 ns 遗留整树文件(防旧文件在迁移判定里诈尸)", () => {
    const dirPath = (store as unknown as { dir: string }).dir;
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(join(dirPath, "ns-z.json"), JSON.stringify(makeSession("ns-z")));
    store.put(makeSession("ns-z"));
    expect(existsSync(join(dirPath, "ns-z.json"))).toBe(false);
  });

  it("delete 清三个文件变体(header/entries/遗留整树)", () => {
    const dirPath = (store as unknown as { dir: string }).dir;
    mkdirSync(dirPath, { recursive: true });
    store.put(makeSession("ns-del"));
    writeFileSync(join(dirPath, "ns-del2.json"), JSON.stringify(makeSession("ns-del2")));
    store.delete("ns-del");
    store.delete("ns-del2");
    expect(readdirSync(dirPath)).toEqual([]);
  });
});
