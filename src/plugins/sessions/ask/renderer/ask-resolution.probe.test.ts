// QA 探针测试(临时):ask 模块导出 → 注册表 → 组件解析 全链验证
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import * as askMod from "./index";
import { registerPluginModule, asReactComponent } from "../../../../../packages/react/src/plugin-modules";
import { resolveBlockRenderer, resolveBlockRendererComponent, type BlockRendererItem } from "../../../../../packages/react/src/block-renderers";

describe("ask 块渲染解析链(QA 探针)", () => {
  it("模块导出 AskQuestionCard 且是组件", () => {
    expect(askMod.AskQuestionCard).toBeDefined();
    expect(asReactComponent(askMod.AskQuestionCard)).toBeDefined();
  });

  it("注册后 (toolCall, ask_user_question) 能解析出组件", () => {
    registerPluginModule("ask", askMod as Record<string, unknown>);
    const items: BlockRendererItem[] = [
      { id: "ask", block: "toolCall", names: ["ask_user_question"], component: "AskQuestionCard", pluginId: "ask" },
    ];
    const item = resolveBlockRenderer(items, "toolCall", "ask_user_question");
    expect(item?.pluginId).toBe("ask");
    const Comp = item && resolveBlockRendererComponent(item);
    expect(Comp).toBeDefined();
  });
});
