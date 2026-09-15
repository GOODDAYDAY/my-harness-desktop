// @vitest-environment jsdom
// MessageActionsHost DOM 交互测试:验「流式生成中照样能分叉/收藏,禁的只是在飞那一行」
// 这个核心裁定落在真实 DOM 上。
//
// 为什么必须有这层(§5.6 三级测试):圆心 messageActionApplies 的裸单测只证明谓词算得对,
// 不证明宿主真按谓词筛了、筛完真渲染/真不渲染按钮。这一层钉的是渲染结果——
// 按 role/title 查真实 DOM 元素,不查 class。
//
// mock 面:useMessageActions 给一份「四个真实贡献项形状」的槽清单(retry/fork/bookmark
// 声明 settled,copy 不声明),resolveMessageActionComponent 给可断言的桩组件。
// 谓词本身不 mock(走真圆心实现,断言跑真过滤)。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { NeutralMessage } from "@my-harness-desktop/shared";
import { usePluginId } from "@my-harness-desktop/react";

/** 桩动作组件:渲染一个带 title 的按钮,title = 动作 id,便于按 title 查 DOM。
 *  同时把 usePluginId() 读到的值写进 data-pluginid——用来断言宿主确实用**贡献方的**
 *  pluginId 包了 PluginIdContext(不是渲染它的 timeline 的 id,也不是空串)。 */
function stubAction(id: string): React.ComponentType<{ message: NeutralMessage; text: string }> {
  return function StubAction() {
    const pluginId = usePluginId();
    return <button title={id} data-pluginid={pluginId}>{id}</button>;
  };
}

const SLOT_ACTIONS = [
  // 锚点类(声明 settled):在飞的 pending 行不渲染
  { id: "retry", component: "RetryAction", placement: "left", when: { role: ["assistant"], settled: true }, order: 50, pluginId: "retry" },
  { id: "fork", component: "ForkAction", placement: "left", when: { role: ["assistant"], settled: true }, order: 18, pluginId: "session-bookmarks" },
  { id: "bookmark", component: "BookmarkAction", placement: "left", when: { role: ["assistant"], settled: true }, order: 20, pluginId: "session-bookmarks" },
  // 非锚点类(不声明 settled):pending 行也渲染(copy 是纯展示动作)
  { id: "copy", component: "CopyAction", placement: "left", order: 10, pluginId: "timeline" },
  // rewind:role=user + settled
  { id: "rewind", component: "RewindAction", placement: "right", when: { role: ["user"], settled: true }, order: 10, pluginId: "timeline" },
];

// 部分 mock:只桩掉槽清单与组件解析,**PluginIdContext 走真实 React Context**
// (宿主用它给每个动作组件包贡献方 pluginId;mock 成假的会绕过这层,测不到真 Provider)。
vi.mock("@my-harness-desktop/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@my-harness-desktop/react")>();
  return {
    ...actual,
    useMessageActions: () => SLOT_ACTIONS,
    resolveMessageActionComponent: (_pluginId: string, component: string) => {
      const map: Record<string, string> = {
        RetryAction: "retry", ForkAction: "fork", BookmarkAction: "bookmark",
        CopyAction: "copy", RewindAction: "rewind",
      };
      const id = map[component];
      return id ? stubAction(id) : undefined;
    },
  };
});

import { MessageActionsHost } from "./message-actions-host";

const assistant = (pending?: boolean): NeutralMessage =>
  ({ role: "assistant", content: "回答", id: "a1", pending }) as NeutralMessage;
const userMsg = (pending?: boolean): NeutralMessage =>
  ({ role: "user", content: "问题", id: "u1", pending }) as NeutralMessage;

describe("MessageActionsHost:流式生成中的粒度是「行」不是「会话」", () => {
  beforeEach(() => cleanup());

  it("在飞的 pending assistant 行:锚点类(重试/分叉/收藏)全不渲染", () => {
    render(<MessageActionsHost message={assistant(true)} text="回答" />);
    // 非锚点类的 copy 照常渲染(证明不是整行动作区被摘掉)
    expect(screen.getByTitle("copy")).toBeInTheDocument();
    // 三个锚点类动作一个都不出现——在飞那条没进中立层,没锚可锚
    expect(screen.queryByTitle("retry")).not.toBeInTheDocument();
    expect(screen.queryByTitle("fork")).not.toBeInTheDocument();
    expect(screen.queryByTitle("bookmark")).not.toBeInTheDocument();
  });

  it("已落定的 assistant 行(流式中同样成立):重试/分叉/收藏照常渲染", () => {
    render(<MessageActionsHost message={assistant(false)} text="回答" />);
    expect(screen.getByTitle("retry")).toBeInTheDocument();
    expect(screen.getByTitle("fork")).toBeInTheDocument();
    expect(screen.getByTitle("bookmark")).toBeInTheDocument();
    expect(screen.getByTitle("copy")).toBeInTheDocument();
  });

  it("pending 未设(undefined,旧数据/常态):锚点类照常渲染(只排 pending===true)", () => {
    render(<MessageActionsHost message={assistant(undefined)} text="回答" />);
    expect(screen.getByTitle("fork")).toBeInTheDocument();
  });

  it("role 谓词不被 settled 破坏:assistant 行不出 rewind(它 role=user)", () => {
    render(<MessageActionsHost message={assistant(false)} text="回答" />);
    expect(screen.queryByTitle("rewind")).not.toBeInTheDocument();
  });

  it("已落定的 user 行:rewind 渲染", () => {
    render(<MessageActionsHost message={userMsg(false)} text="问题" />);
    expect(screen.getByTitle("rewind")).toBeInTheDocument();
    // assistant 专属动作不出现在 user 行
    expect(screen.queryByTitle("retry")).not.toBeInTheDocument();
  });

  it("在飞的 pending user 行(乐观回显):rewind 不渲染", () => {
    render(<MessageActionsHost message={userMsg(true)} text="问题" />);
    expect(screen.queryByTitle("rewind")).not.toBeInTheDocument();
  });

  // 宿主必须用**贡献方**的 pluginId 包 Provider:动作组件里的 usePluginContext() 才是
  // pluginId 绑定的(config/events 的归属)。漏包时组件拿到渲染方(timeline)的 id 或空串,
  // 写进作用域槽就会落到 `timeline:xxx` 这种没人读的键上——composerAttachments 槽踩过
  // (review 的 BasketBar 删除写进了 timeline:basket),同一缺陷族,一并钉住。
  it("每个动作组件拿到的 pluginId 是它自己的贡献方 id(不是宿主 timeline、不是空串)", () => {
    render(<MessageActionsHost message={assistant(false)} text="回答" />);
    expect(screen.getByTitle("retry")).toHaveAttribute("data-pluginid", "retry");
    expect(screen.getByTitle("fork")).toHaveAttribute("data-pluginid", "session-bookmarks");
    expect(screen.getByTitle("bookmark")).toHaveAttribute("data-pluginid", "session-bookmarks");
    expect(screen.getByTitle("copy")).toHaveAttribute("data-pluginid", "timeline");
  });

  it("未声明 when 的动作适用任意 role(divider 行仍有 copy):settled 不误伤非锚点类", () => {
    render(<MessageActionsHost message={{ role: "divider", content: "" } as unknown as NeutralMessage} text="" />);
    expect(screen.getByTitle("copy")).toBeInTheDocument();
    // 锚点类仍按 role 拦住(不是靠 settled)
    expect(screen.queryByTitle("fork")).not.toBeInTheDocument();
  });
});
