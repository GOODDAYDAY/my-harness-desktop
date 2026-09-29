// @vitest-environment jsdom
// llm-recorder 记录页的**装载三态**断言（r226；钉住 r225 那次改动）。
//
// ## 钉的性质（r143/r222 的空态分语义 + r225 的"能区分就必须区分"）
//
// ① 真读失败（readFile 抛 / listDir 抛）⇒ 渲染 panel.loadFailed，**不**渲染 panel.empty；
// ② 从未记录（listDir 返回 []，服务端把"目录不存在"折成空数组）⇒ 渲染 panel.empty，
//    **不**渲染 panel.loadFailed（不能把"没有记录"谎报成失败）；
// ③ 目录里只有非分片文件 ⇒ 仍是空态（shardNumber 过滤掉不匹配的文件名）。
//
// 每条都同时断言"另外两态没出现"（r223：N 态展示要配 N 条断言，且每条断言另外几态没出现
// ——三态渲染最常见的退化是两个分支同时命中）。
//
// ⚠ 夹具按真实契约给（r223 的教训）：ctx.fs 只有 listDir/readFile 等；
//   useUiStore 是**选择器式** hook（useUiStore((s) => s.currentCwd)），mock 要支持传选择器；
//   分片名要满足 shardNumber(fileName, base)：base 取 sessionPath 末段，`<base>.jsonl` ⇒ n=1。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const state = { currentCwd: "/proj", currentSessionPath: "/proj/sessions/sess-a.jsonl" };

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "zh-CN" } }),
}));

const fsMock = {
  listDir: vi.fn(),
  readFile: vi.fn(),
};

vi.mock("@my-harness-desktop/react", () => ({
  // ctx 还要有 events（组件订阅增量事件）；给不做事的桩（本轮只测装载三态，不测增量）
  usePluginContext: () => ({
    fs: fsMock,
    events: { onEvent: () => () => {}, on: () => () => {}, emit: () => {}, invoke: async () => undefined },
    sessions: { onEvent: () => () => {} },   // :306 订阅会话事件流（本轮不测增量，给不做事的桩）
    config: { get: async () => null, set: async () => undefined },
  }),
  useUiStore: (sel: (s: typeof state) => unknown) => sel(state),
  EmptyState: (p: { title?: string; description?: string; icon?: ReactNode }) => (
    <div data-testid="empty-state">
      <h2>{p.title}</h2>
      {p.description ? <p>{p.description}</p> : null}
    </div>
  ),
  SettingsSection: (p: { title?: string; children?: ReactNode }) => <section>{p.children}</section>,
  Button: (p: { children?: ReactNode; onClick?: () => void }) => <button onClick={p.onClick}>{p.children}</button>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  fsMock.listDir.mockReset();
  fsMock.readFile.mockReset();
});

async function load() {
  const { RecordsTab } = await import("./index");
  return render(<RecordsTab isActive />);
}

describe("llm-recorder：装载三态可区分（失败 ≠ 没有记录）", () => {
  it("① 分片读取失败 ⇒ 显示 panel.loadFailed，且**不**显示 panel.empty", async () => {
    fsMock.listDir.mockResolvedValue([{ name: "sess-a.jsonl", isDir: false }]);
    fsMock.readFile.mockRejectedValue(new Error("disk gone"));
    await load();
    await waitFor(() => expect(screen.getByText("panel.loadFailed")).toBeTruthy());
    expect(screen.queryByText("panel.empty"),
      "读失败时不该伪装成『没有记录』（r225：能区分就必须区分）").toBeNull();
    expect(screen.getByText("panel.loadFailedHint"), "要给出重试方式/排查方向（可行动，§7.6）").toBeTruthy();
  });

  it("② listDir 本身失败（传输层 reject）⇒ 同样是失败态，不是空态", async () => {
    fsMock.listDir.mockRejectedValue(new Error("transport gone"));
    await load();
    await waitFor(() => expect(screen.getByText("panel.loadFailed")).toBeTruthy());
    expect(screen.queryByText("panel.empty")).toBeNull();
  });

  it("③ 从未记录（listDir 返回空）⇒ 显示 panel.empty，且**不**谎报失败", async () => {
    fsMock.listDir.mockResolvedValue([]);
    await load();
    await waitFor(() => expect(screen.getByText("panel.empty")).toBeTruthy());
    expect(screen.queryByText("panel.loadFailed"),
      "『目录不存在』在服务端已折成空数组（成功路径），不该被报成失败（r224：不谎报）").toBeNull();
  });

  it("④ 目录里只有非分片文件 ⇒ 仍是空态（shardNumber 过滤），不是失败态", async () => {
    fsMock.listDir.mockResolvedValue([{ name: "notes.txt", isDir: false }, { name: "sess-a.jsonl.bak", isDir: false }]);
    await load();
    await waitFor(() => expect(screen.getByText("panel.empty")).toBeTruthy());
    expect(screen.queryByText("panel.loadFailed")).toBeNull();
    expect(fsMock.readFile, "没有分片就不该去读文件").not.toHaveBeenCalled();
  });
});
