// 会话级待执行意图单测(设计 docs/design/session-scope.md §5.1)。
//
// 本文件接替 ui-store.composer-drafts.test.ts:草稿的存储从 ui-store.composerDrafts
// (按 key 分组的 Record)迁到会话作用域容器的框架保留槽 composerDraft。
// **断言口径不变**——隔离、空文本即清、幂等清这三条行为在迁移前后必须一致,
// 测试绿了就证明搬迁没把行为弄丢(设计 §3.1.2 把这两个测列为批 2 的行为门)。
//
// 同时覆盖另外三份态(模型意图 / 排队消息 / 工具过滤偏好),它们此前散在 ui-store 的
// 四个字段 + 十个 action 里,现在统一经 session-pending 的派生层读写。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSessionScopeStore, setScopeKeyResolver, __resetScopesForTests } from "./session-scope";
import {
  readComposerDraft, writeComposerDraft, clearComposerDraft,
  readModelPending, writeModelPending, clearModelPending,
  readPendingQueue, enqueueMessage, removeFromQueue, clearQueue,
  markQueueFailed, markQueueItemFailed, clearQueueFailed, hasPendingUserSend,
  readPendingToolConfig, writePendingToolConfig,
} from "./session-pending";

/** 切当前作用域(模拟切会话)。 */
function activate(scopeKey: string | null): void {
  setScopeKeyResolver(() => scopeKey);
}

beforeEach(() => {
  __resetScopesForTests();
  activate("sess-a");
  vi.restoreAllMocks();
});

describe("草稿(composerDraft 槽):行为口径与迁移前一致", () => {
  it("写入某会话草稿", () => {
    writeComposerDraft("还没写完");
    expect(readComposerDraft()).toBe("还没写完");
  });

  it("不同会话草稿互不覆盖(隔离)", () => {
    writeComposerDraft("A 的草稿");
    activate("sess-b");
    writeComposerDraft("B 的草稿");
    expect(readComposerDraft("sess-a")).toBe("A 的草稿");
    expect(readComposerDraft("sess-b")).toBe("B 的草稿");
  });

  it("空文本等价清(不留空串滞留)", () => {
    writeComposerDraft("草稿");
    writeComposerDraft("");
    expect(readComposerDraft()).toBe("");
  });

  it("clearComposerDraft 清除指定会话草稿", () => {
    writeComposerDraft("草稿");
    clearComposerDraft();
    expect(readComposerDraft()).toBe("");
  });

  it("清除不存在的会话幂等(不抛错、不影响其它会话)", () => {
    writeComposerDraft("草稿");
    expect(() => clearComposerDraft("sess-nonexistent")).not.toThrow();
    expect(readComposerDraft()).toBe("草稿");
  });

  it("同值不重复写(幂等:避免每次按键都递增 nonce 触发全量重渲染)", () => {
    writeComposerDraft("草稿");
    const nonce = useSessionScopeStore.getState().nonce;
    writeComposerDraft("草稿");
    expect(useSessionScopeStore.getState().nonce).toBe(nonce);
  });
});

describe("模型意图(modelPending 槽)", () => {
  it("写入/读回,按会话隔离", () => {
    writeModelPending({ provider: "p", modelId: "m", thinkingLevel: "high", kernel: "pi" });
    expect(readModelPending()).toEqual({ provider: "p", modelId: "m", thinkingLevel: "high", kernel: "pi" });
    activate("sess-b");
    expect(readModelPending()).toBeUndefined();   // B 会话没有 A 的意图
  });

  it("clear 后读回 undefined(执行成功才消费意图)", () => {
    writeModelPending({ provider: "p", modelId: "m", thinkingLevel: "" });
    clearModelPending();
    expect(readModelPending()).toBeUndefined();
  });

  it("无激活会话时写丢弃、读 undefined(不炸)", () => {
    activate(null);
    expect(() => writeModelPending({ provider: "p", modelId: "m", thinkingLevel: "" })).not.toThrow();
    expect(readModelPending()).toBeUndefined();
  });
});

describe("排队消息(pendingQueue 槽)", () => {
  it("入队按会话隔离", () => {
    enqueueMessage("A 的待发消息");
    activate("sess-b");
    enqueueMessage("B 的待发消息");
    expect(readPendingQueue("sess-a").map((q) => q.text)).toEqual(["A 的待发消息"]);
    expect(readPendingQueue("sess-b").map((q) => q.text)).toEqual(["B 的待发消息"]);
  });

  it("入队条目自带 id", () => {
    enqueueMessage("x");
    expect(readPendingQueue()[0].id).toBeTruthy();
  });

  it("removeFromQueue 按 id 摘单条,其余保留", () => {
    enqueueMessage("1");
    enqueueMessage("2");
    const id = readPendingQueue()[0].id;
    removeFromQueue(id);
    expect(readPendingQueue().map((q) => q.text)).toEqual(["2"]);
  });

  it("clearQueue 清空", () => {
    enqueueMessage("1");
    clearQueue();
    expect(readPendingQueue()).toEqual([]);
  });

  it("markQueueFailed 整队标失败(保留全部条目,用户重试/逐条处置)", () => {
    enqueueMessage("1");
    enqueueMessage("2");
    markQueueFailed("发送失败");
    const q = readPendingQueue();
    expect(q).toHaveLength(2);
    expect(q.every((x) => x.failed === true && x.errMsg === "发送失败")).toBe(true);
  });

  it("markQueueItemFailed 只标单条", () => {
    enqueueMessage("1");
    enqueueMessage("2");
    markQueueItemFailed(readPendingQueue()[1].id, "这条失败");
    const q = readPendingQueue();
    expect(q[0].failed).toBeFalsy();
    expect(q[1].failed).toBe(true);
  });

  it("clearQueueFailed 清标记但不删条目", () => {
    enqueueMessage("1");
    markQueueFailed("x");
    clearQueueFailed();
    const q = readPendingQueue();
    expect(q).toHaveLength(1);
    expect(q[0].failed).toBe(false);
    expect(q[0].errMsg).toBeUndefined();
  });

  it("hasPendingUserSend 只看当前会话(设计 §2.4.5:跨会话队列不压住本会话续跑)", () => {
    activate("sess-a");
    enqueueMessage("A 排队中");
    expect(hasPendingUserSend()).toBe(true);
    activate("sess-b");
    // B 会话没有排队消息:A 的队列不该压住 B(此前实现扫全部会话,是跨会话泄漏)
    expect(hasPendingUserSend()).toBe(false);
  });
});

describe("工具过滤偏好(toolConfig 槽):key 由作用域承担,不再内嵌 sessionPath", () => {
  it("写入/读回,按会话隔离(A 的偏好落不进 B 的域)", () => {
    writePendingToolConfig({ config: { enabledGroupIds: ["g1"], enabledToolIds: ["t1"] }, flushed: false });
    expect(readPendingToolConfig()?.config?.enabledGroupIds).toEqual(["g1"]);
    activate("sess-b");
    expect(readPendingToolConfig()).toBeNull();
  });

  it("flushed 标记可更新(send 落盘后置 true,面板显示不跳变)", () => {
    writePendingToolConfig({ config: null, flushed: false });
    writePendingToolConfig({ config: null, flushed: true });
    expect(readPendingToolConfig()?.flushed).toBe(true);
  });

  it("config=null 表示切回全部工具(显式语义,不是缺省)", () => {
    writePendingToolConfig({ config: null, flushed: false });
    expect(readPendingToolConfig()).toEqual({ config: null, flushed: false });
  });
});

describe("物化搬迁:壳键 → 真身 ns(设计 §2.3.2/§3.1.2 行为门)", () => {
  it("草稿/模型意图随身份搬迁(move),排队消息追加(concat)", () => {
    activate("new:/proj");
    writeComposerDraft("还没写完");
    writeModelPending({ provider: "p", modelId: "m", thinkingLevel: "" });
    enqueueMessage("排队的消息");
    // 物化:壳键 → 真身 ns
    useSessionScopeStore.getState().carry("new:/proj", "ns-real");
    activate("ns-real");
    expect(readComposerDraft()).toBe("还没写完");
    expect(readModelPending()).toEqual({ provider: "p", modelId: "m", thinkingLevel: "" });
    expect(readPendingQueue().map((q) => q.text)).toEqual(["排队的消息"]);
    // 旧壳键域已摘除
    expect(useSessionScopeStore.getState().scopes.has("new:/proj")).toBe(false);
  });

  it("搬迁后旧壳键再读是空(不会复活已发送的文本)", () => {
    activate("new:/proj");
    writeComposerDraft("x");
    useSessionScopeStore.getState().carry("new:/proj", "ns-real");
    expect(readComposerDraft("new:/proj")).toBe("");
  });
});
