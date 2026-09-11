// @vitest-environment jsdom
// SubAgentDialog 的 DOM 断言 —— 该组件把状态全放在 dialog-state.ts(本测试 mock 那一层),
// 自身只做"读快照渲染 + 输入/发送/关闭"。钉住的契约:
//   ① 未打开/无目标 → 空态提示
//   ② 目标名**回落 addr**(`st.target.name ?? st.target.addr`)
//   ③ busy / error / 无消息 三种状态各自出对应提示
//   ④ **空输入不发送**(`if (!input.trim()) return`)
//   ⑤ **Enter 发送、Shift+Enter 不发送**(换行)
//   ⑥ 发送后**清空输入框**
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

type Msg = { id: string; role: string; text: string; streaming?: boolean };
const h = vi.hoisted(() => ({
  st: {} as Record<string, unknown>,
  sent: [] as string[],
  closed: 0,
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@my-harness-desktop/react", () => ({ usePluginContext: () => ({ __ctx: true }) }));
vi.mock("./dialog-state", () => ({
  subscribeDialog: () => () => {},
  getDialogState: () => h.st,
  sendDialogMessage: async (_c: unknown, text: string) => { h.sent.push(text); },
  closeDialog: async () => { h.closed += 1; },
}));

import { SubAgentDialog } from "./dialog";

const openWith = (over: Record<string, unknown> = {}): void => {
  h.st = { open: true, target: { addr: "sub-1", name: "分析师", sessionPath: "/s" }, messages: [], busy: false, ...over };
};
const box = (): HTMLInputElement => screen.getByPlaceholderText("sub-agent.dialog.placeholder") as HTMLInputElement;

beforeEach(() => { h.st = { open: false, target: null, messages: [] }; h.sent = []; h.closed = 0; });

describe("SubAgentDialog(与子会话对话的面板)", () => {
  it("未打开/无目标 → 只出空态提示", () => {
    render(<SubAgentDialog />);
    expect(screen.getByText("sub-agent.dialog.empty")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("sub-agent.dialog.placeholder")).toBeNull();
  });

  it("目标名缺失时**回落 addr**", () => {
    openWith({ target: { addr: "sub-9" } });
    render(<SubAgentDialog />);
    expect(screen.getByText("sub-9")).toBeInTheDocument();
  });

  it("busy / error / 无消息 三种状态各自出提示", () => {
    openWith({ busy: true });
    const { unmount } = render(<SubAgentDialog />);
    expect(screen.getByText("sub-agent.dialog.thinking")).toBeInTheDocument();
    expect(screen.getByText("sub-agent.dialog.hint")).toBeInTheDocument();
    unmount();

    // 错误码**拼进 i18n key**(`t(`sub-agent.dialog.${st.error}`)`)——钉这个模板本身:
    // t() 在测试里返回 key,所以断言 key 里带着那个错误码。
    openWith({ error: "timeout" });
    render(<SubAgentDialog />);
    expect(screen.getByText("sub-agent.dialog.timeout"), "错误码没有被拼进 i18n key").toBeInTheDocument();
  });

  it("消息按角色渲染;streaming 且无正文时显示 …", () => {
    openWith({ messages: [
      { id: "1", role: "user", text: "你好" },
      { id: "2", role: "assistant", text: "在" },
      { id: "3", role: "assistant", text: "", streaming: true },
    ] as Msg[] });
    render(<SubAgentDialog />);
    expect(screen.getByText("你好")).toBeInTheDocument();
    expect(screen.getByText("在")).toBeInTheDocument();
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("**空输入不发送**(含纯空白)", () => {
    openWith();
    render(<SubAgentDialog />);
    fireEvent.click(screen.getByText("sub-agent.dialog.send"));
    expect(h.sent, "空输入被发送了").toEqual([]);

    fireEvent.change(box(), { target: { value: "   " } });
    fireEvent.click(screen.getByText("sub-agent.dialog.send"));
    expect(h.sent, "纯空白输入被发送了").toEqual([]);
  });

  it("**Enter 发送并清空输入框;Shift+Enter 不发送**(换行)", () => {
    openWith();
    render(<SubAgentDialog />);
    fireEvent.change(box(), { target: { value: "发这条" } });

    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(h.sent, "Shift+Enter 触发了发送(应当是换行)").toEqual([]);

    fireEvent.keyDown(box(), { key: "Enter" });
    expect(h.sent).toEqual(["发这条"]);
    expect(box().value, "发送后输入框没清空").toBe("");
  });

  it("点关闭 → closeDialog", () => {
    openWith();
    render(<SubAgentDialog />);
    fireEvent.click(screen.getByText("sub-agent.dialog.close"));
    expect(h.closed).toBe(1);
  });
});
