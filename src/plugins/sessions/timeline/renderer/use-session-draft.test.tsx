// @vitest-environment jsdom
// useSessionDraft DOM e2e —— 输入框草稿按会话隔离:切走保存、切回恢复、发送清空。
// 真实 hook 渲染 + 真实键入 + 真实会话 key 切换,覆盖「每个 session 的输入框内容不是通用的」。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach } from "vitest";
import { useState } from "react";
import { render, fireEvent, act } from "@testing-library/react";
import { useSessionDraft } from "./use-session-draft";
import { useUiStore } from "@my-harness-desktop/react";

/** 最小外壳:一个会话 key(可切换)+ 一个受控 textarea 绑到 useSessionDraft。 */
function DraftHarness({ initialKey }: { initialKey: string }): React.ReactNode {
  const [key, setKey] = useState(initialKey);
  const [input, setInput] = useSessionDraft(key);
  return (
    <div>
      <textarea data-testid="composer" value={input} onChange={(e) => setInput(e.target.value)} />
      <button data-testid="switch-a" onClick={() => setKey("sess-a")}>to A</button>
      <button data-testid="switch-b" onClick={() => setKey("sess-b")}>to B</button>
    </div>
  );
}

const composer = (): HTMLTextAreaElement =>
  document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement;

describe("useSessionDraft: 草稿按会话隔离", () => {
  beforeEach(() => {
    useUiStore.setState({ composerDrafts: {} });
  });

  it("切走保存草稿 A → 新会话为空 → 切回恢复草稿 A", () => {
    render(<DraftHarness initialKey="sess-a" />);
    const ta = composer();
    fireEvent.change(ta, { target: { value: "草稿A" } });
    expect(ta.value).toBe("草稿A");

    // 切到 B:草稿 A 被保存,B 无草稿 → 空
    fireEvent.click(document.querySelector('[data-testid="switch-b"]')!);
    expect(composer().value).toBe("");
    // 草稿 A 仍在 store
    expect(useUiStore.getState().composerDrafts["sess-a"]).toBe("草稿A");

    // 在 B 写草稿 B
    fireEvent.change(composer(), { target: { value: "草稿B" } });

    // 切回 A:应恢复草稿 A
    fireEvent.click(document.querySelector('[data-testid="switch-a"]')!);
    expect(composer().value).toBe("草稿A");
    // 草稿 B 也保留在 store
    expect(useUiStore.getState().composerDrafts["sess-b"]).toBe("草稿B");
  });

  it("两个会话来回切,各自草稿互不串", () => {
    render(<DraftHarness initialKey="sess-a" />);
    fireEvent.change(composer(), { target: { value: "A 的内容" } });
    fireEvent.click(document.querySelector('[data-testid="switch-b"]')!);
    fireEvent.change(composer(), { target: { value: "B 的内容" } });

    // A → B → A → B 往返
    fireEvent.click(document.querySelector('[data-testid="switch-a"]')!);
    expect(composer().value).toBe("A 的内容");
    fireEvent.click(document.querySelector('[data-testid="switch-b"]')!);
    expect(composer().value).toBe("B 的内容");
  });

  it("发送成功 setInput('') 清空草稿(不留空串滞留)", () => {
    function SendHarness(): React.ReactNode {
      const [input, setInput] = useSessionDraft("sess-a");
      return (
        <div>
          <textarea data-testid="composer" value={input} onChange={(e) => setInput(e.target.value)} />
          <button data-testid="send" onClick={() => setInput("")}>send</button>
        </div>
      );
    }
    render(<SendHarness />);
    fireEvent.change(composer(), { target: { value: "要发送的内容" } });
    expect(useUiStore.getState().composerDrafts["sess-a"]).toBe("要发送的内容");

    act(() => { fireEvent.click(document.querySelector('[data-testid="send"]')!); });
    expect(composer().value).toBe("");
    expect(useUiStore.getState().composerDrafts["sess-a"]).toBeUndefined();
  });
});
