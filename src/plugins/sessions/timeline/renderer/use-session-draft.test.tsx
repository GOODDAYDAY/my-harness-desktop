// @vitest-environment jsdom
// useSessionDraft DOM 交互测 —— 输入框草稿按会话隔离:切走保存、切回恢复、发送清空。
// 真实 hook 渲染 + 真实键入 + 真实会话切换,覆盖「每个 session 的输入框内容不是通用的」。
//
// 迁移说明(设计 docs/design/session-scope.md §2.6):草稿存储从 ui-store.composerDrafts
// (按 key 分组的 Record)迁到会话作用域槽 composerDraft;切会话不再由本 hook 收 draftKey 参数,
// 而是 hook 内部经 useCurrentScopeKey() 读身份——所以测试的切换手法从「换 props」改成
// 「改 ui-store 的身份字段」,这与生产路径(sessions-list.select / openSession 写身份字段)一致。
// 断言口径不变:隔离、切回恢复、空文本即清。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { useSessionDraft } from "./use-session-draft";
import { useUiStore, readComposerDraft } from "@my-harness-desktop/react";
import { __resetScopesForTests } from "../../../../web/stores/session-scope";

/** 最小外壳:一个受控 textarea 绑到 useSessionDraft(key 由 hook 内部经身份解析)。 */
function DraftHarness(): React.ReactNode {
  const [input, setInput] = useSessionDraft();
  return (
    <div>
      <textarea data-testid="composer" value={input} onChange={(e) => setInput(e.target.value)} />
    </div>
  );
}

const composer = (): HTMLTextAreaElement =>
  document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement;

/** 切会话:写身份字段(生产路径同款),scopeKey 随之变,hook 换档。 */
function switchSession(ns: string): void {
  act(() => { useUiStore.setState({ currentNeutralSessionId: ns, currentCwd: "/proj" }); });
}

describe("useSessionDraft: 草稿按会话隔离", () => {
  beforeEach(() => {
    __resetScopesForTests();
    useUiStore.setState({ currentNeutralSessionId: "sess-a", currentCwd: "/proj" });
  });

  it("切走保存草稿 A → 新会话为空 → 切回恢复草稿 A", () => {
    render(<DraftHarness />);
    fireEvent.change(composer(), { target: { value: "草稿A" } });
    expect(composer().value).toBe("草稿A");

    // 切到 B:草稿 A 被保存,B 无草稿 → 空
    switchSession("sess-b");
    expect(composer().value).toBe("");
    // 草稿 A 仍在作用域槽里
    expect(readComposerDraft("sess-a")).toBe("草稿A");

    // 在 B 写草稿 B
    fireEvent.change(composer(), { target: { value: "草稿B" } });

    // 切回 A:应恢复草稿 A
    switchSession("sess-a");
    expect(composer().value).toBe("草稿A");
    // 草稿 B 也保留
    expect(readComposerDraft("sess-b")).toBe("草稿B");
  });

  it("两个会话来回切,各自草稿互不串", () => {
    render(<DraftHarness />);
    fireEvent.change(composer(), { target: { value: "A 的内容" } });
    switchSession("sess-b");
    fireEvent.change(composer(), { target: { value: "B 的内容" } });

    // A → B → A → B 往返
    switchSession("sess-a");
    expect(composer().value).toBe("A 的内容");
    switchSession("sess-b");
    expect(composer().value).toBe("B 的内容");
  });

  it("发送成功 setInput('') 清空草稿(不留空串滞留)", () => {
    function SendHarness(): React.ReactNode {
      const [input, setInput] = useSessionDraft();
      return (
        <div>
          <textarea data-testid="composer" value={input} onChange={(e) => setInput(e.target.value)} />
          <button data-testid="send" onClick={() => setInput("")}>send</button>
        </div>
      );
    }
    render(<SendHarness />);
    fireEvent.change(composer(), { target: { value: "要发送的内容" } });
    expect(readComposerDraft("sess-a")).toBe("要发送的内容");

    act(() => { fireEvent.click(document.querySelector('[data-testid="send"]')!); });
    expect(composer().value).toBe("");
    expect(readComposerDraft("sess-a")).toBe("");
  });
});
