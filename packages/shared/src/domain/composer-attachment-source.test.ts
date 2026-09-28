// `resolveAttachmentSource` 的三种情形（r145；从 timeline 的 doSend 内联三元式抽出）。
//
// 抽出动机与 r144 的 partitionReferenceFiles 同：这段逻辑承载一条容易搞错的**回落语义**，
// 却内联在 1400 行组件里 ⇒ 没法单测。它没有任何外层依赖（纯数据择一 + 一次字段覆盖），
// 按 §4.5 本该在圆心。
//
// ⚠ 按 r141/r143/r144 的纪律覆盖**全部三种**情形（少一种就会被"总是取活篮子"或
//   "总是取快照"的实现骗过），其中③（两者都空）与②里的 sessionKey 重绑最容易漏。

import { describe, it, expect } from "vitest";
import { resolveAttachmentSource } from "./contributions";

type P = { sessionKey: string; items: Array<{ id: string }>; promptFragment?: string };

const live: P = { sessionKey: "old-live", items: [{ id: "a" }], promptFragment: "活篮子片段" };
const snapshot: P = { sessionKey: "old-snap", items: [{ id: "s" }], promptFragment: "快照片段" };

describe("resolveAttachmentSource：发送时择一附件来源", () => {
  it("① 活篮子有货 ⇒ 用活篮子（排队后用户可能增删了评论，以当前为准）", () => {
    const r = resolveAttachmentSource(live, snapshot, "cur");
    expect(r).toBe(live);                       // 是同一个对象，不是副本
    expect((r as P | null)?.promptFragment).toBe("活篮子片段");
  });

  it("② 活篮子空了、有入队快照 ⇒ 回落快照，且 **sessionKey 重绑到当前会话**", () => {
    const emptyLive: P = { ...live, items: [] };
    const r = resolveAttachmentSource(emptyLive, snapshot, "cur");
    expect((r as P | null)?.promptFragment, "上次发送消费掉活篮子后，队列里的附件不能丢").toBe("快照片段");
    expect((r as P).sessionKey,
      "快照可能是在别的会话入队的（切会话后队列仍在）；沿用旧 key 会把附件挂到错的会话上").toBe("cur");
    expect((r as P).items).toEqual(snapshot.items);   // 其余字段原样带过来
  });

  it("③ 两者都空 ⇒ null（没附件就是没附件，不该造一个空 payload）", () => {
    expect(resolveAttachmentSource({ ...live, items: [] }, null, "cur")).toBeNull();
    expect(resolveAttachmentSource(null, undefined, "cur")).toBeNull();
  });

  it("④ live 为 null/undefined 时不该抛（doSend 里 matched 可能是 null）", () => {
    expect(() => resolveAttachmentSource(null, snapshot, "cur")).not.toThrow();
    expect((resolveAttachmentSource(undefined, snapshot, "cur") as P | null)?.promptFragment).toBe("快照片段");
  });

  it("⑤ 反证：不是『总是取活篮子』也不是『总是取快照』", () => {
    // 若实现退化成 `return live ?? snapshot`，②会失败；退化成 `return snapshot`，①会失败。
    expect(resolveAttachmentSource(live, null, "cur")).toBe(live);
    expect(resolveAttachmentSource({ ...live, items: [] }, snapshot, "cur")).not.toBe(snapshot);
  });
});
