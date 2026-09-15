// session-colors 键口径迁移的纯函数单测(设计 docs/design/session-scope.md §3.3.2)。
// 覆盖两个新增 core 函数:migrateContentPinKeys(存量键迁移)与 uniqueSessionKeys(双键去重)。
// 纯函数、零依赖、不需要 mock——按 CLAUDE.md §4.5 判据是内层材料。
import { describe, it, expect } from "vitest";
import { migrateContentPinKeys, uniqueSessionKeys, type ContentPin } from "./pin";

const cp = (id: string, messageId: string): ContentPin =>
  ({ id, messageId, color: "#f38ba8", x: 50, y: 50, preview: `预览-${id}` });

// sessionInfos 的 path→ns 映射(生产里从 useSessionStore.sessionInfos 取 neutralSessionId)
interface FakeInfo { path: string; neutralSessionId?: string }
const infos: Record<string, FakeInfo> = {
  "/proj/sessions/ns-a.jsonl": { path: "/proj/sessions/ns-a.jsonl", neutralSessionId: "ns-a" },
  "/proj/sessions/ns-b.jsonl": { path: "/proj/sessions/ns-b.jsonl", neutralSessionId: "ns-b" },
};
const lookup = (key: string): string | undefined => infos[key]?.neutralSessionId;

describe("migrateContentPinKeys:存量键统一到 ns 优先口径", () => {
  it("投影路径键迁到 ns 键(键空间分裂 bug 的回归守卫)", () => {
    // 迁移前:钉入写 path 键、读取查 ns 键,同一会话被劈成两个键,钉进去读不到。
    // 迁移后:统一成 ns 键,读写同口径。
    const before = { "/proj/sessions/ns-a.jsonl": [cp("p1", "m1")] };
    const after = migrateContentPinKeys(before, lookup);
    expect(after).not.toBeNull();
    expect(Object.keys(after!)).toEqual(["ns-a"]);
    expect(after!["ns-a"].map((p) => p.id)).toEqual(["p1"]);
  });

  it("已是 ns 键:无需迁移,返回 null(调用方据此跳过写盘)", () => {
    expect(migrateContentPinKeys({ "ns-a": [cp("p1", "m1")] }, lookup)).toBeNull();
  });

  it("空对象:返回 null", () => {
    expect(migrateContentPinKeys({}, lookup)).toBeNull();
  });

  it("path 键与 ns 键并存(分裂态)→ 合并到 ns 键,不覆盖用户数据", () => {
    // 这正是分裂 bug 的存量形态:同一会话的钉散在两个键上。迁移必须合并,不能丢。
    const before = {
      "/proj/sessions/ns-a.jsonl": [cp("p1", "m1")],
      "ns-a": [cp("n1", "m2")],
    };
    const after = migrateContentPinKeys(before, lookup)!;
    expect(Object.keys(after)).toEqual(["ns-a"]);
    expect(after["ns-a"].map((p) => p.id).sort()).toEqual(["n1", "p1"]);
  });

  it("孤儿钉(反查不到 ns,会话已删)保留原键,不丢用户数据", () => {
    const before = { "/proj/sessions/已删.jsonl": [cp("orphan", "m1")] };
    const after = migrateContentPinKeys(before, lookup);
    // lookup 未命中 → to===key → 无变化 → null(保留原键)
    expect(after).toBeNull();
  });

  it("混合:能迁的迁、孤儿保留,changed=true", () => {
    const before = {
      "/proj/sessions/ns-a.jsonl": [cp("p1", "m1")],   // 能迁
      "/proj/sessions/已删.jsonl": [cp("orphan", "m9")], // 孤儿,保留
    };
    const after = migrateContentPinKeys(before, lookup)!;
    expect(after).not.toBeNull();
    expect(after["ns-a"].map((p) => p.id)).toEqual(["p1"]);
    expect(after["/proj/sessions/已删.jsonl"].map((p) => p.id)).toEqual(["orphan"]);
  });
});

describe("uniqueSessionKeys:sessionInfos 双键索引去重", () => {
  it("同一会话的 path 与 ns 两个键去重成一个(跨会话聚合列表不再重复)", () => {
    const double = {
      "/proj/sessions/ns-a.jsonl": { path: "/proj/sessions/ns-a.jsonl", neutralSessionId: "ns-a" },
      "ns-a": { path: "/proj/sessions/ns-a.jsonl", neutralSessionId: "ns-a" },
    };
    expect(uniqueSessionKeys(double)).toEqual(["ns-a"]);
  });

  it("无 ns 的会话回落 path 键", () => {
    const legacy = { "/proj/old.jsonl": { path: "/proj/old.jsonl" } };
    expect(uniqueSessionKeys(legacy)).toEqual(["/proj/old.jsonl"]);
  });

  it("多会话各出一个键,ns 优先", () => {
    const keys = uniqueSessionKeys(infos);
    expect(keys.sort()).toEqual(["ns-a", "ns-b"]);
  });
});
