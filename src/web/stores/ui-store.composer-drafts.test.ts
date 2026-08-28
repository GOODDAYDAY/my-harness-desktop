// composerDrafts 草稿 store 单测:按会话 key 隔离 + 空文本即清 + 幂等清。
// 草稿是内存态(与 sessionModelPending/pendingQueue 同款),不触 window.kernel,
// 纯 zustand action 直测。
import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./ui-store";

describe("ui-store.composerDrafts", () => {
  beforeEach(() => {
    useUiStore.setState({ composerDrafts: {} });
  });

  it("setComposerDraft 写入某会话草稿", () => {
    useUiStore.getState().setComposerDraft("sess-a", "还没写完");
    expect(useUiStore.getState().composerDrafts["sess-a"]).toBe("还没写完");
  });

  it("不同会话草稿互不覆盖(隔离)", () => {
    useUiStore.getState().setComposerDraft("sess-a", "A 的草稿");
    useUiStore.getState().setComposerDraft("sess-b", "B 的草稿");
    expect(useUiStore.getState().composerDrafts).toEqual({
      "sess-a": "A 的草稿",
      "sess-b": "B 的草稿",
    });
  });

  it("setComposerDraft 空文本等价清(不留空串滞留)", () => {
    useUiStore.getState().setComposerDraft("sess-a", "草稿");
    useUiStore.getState().setComposerDraft("sess-a", "");
    expect(useUiStore.getState().composerDrafts["sess-a"]).toBeUndefined();
  });

  it("clearComposerDraft 清除指定会话草稿", () => {
    useUiStore.getState().setComposerDraft("sess-a", "草稿");
    useUiStore.getState().clearComposerDraft("sess-a");
    expect(useUiStore.getState().composerDrafts).toEqual({});
  });

  it("clearComposerDraft 缺键幂等(不抛错、状态不变)", () => {
    useUiStore.getState().setComposerDraft("sess-a", "草稿");
    useUiStore.getState().clearComposerDraft("sess-nonexistent");
    expect(useUiStore.getState().composerDrafts).toEqual({ "sess-a": "草稿" });
  });
});
