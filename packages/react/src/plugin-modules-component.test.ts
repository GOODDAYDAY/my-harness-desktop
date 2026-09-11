// asReactComponent 的守卫 —— **纯函数 unittest**(react 是真的,零 mock)。
//
// 源码注释自述根因:
//   「旧码只认 typeof function,**memo() 返回对象** → memo 包装的导出(如 MarkdownText)
//     **被静默丢弃**、消费方落兜底(**会话流 markdown 长期退化为纯文本的根因**)」
//
// 失效形态:**不报错** ✗ —— 组件被当成"不是组件"丢掉 ✓,消费方回落到兜底渲染 ✓,
// 于是 markdown 长时间显示成纯文本 ✗。这正是"看着能用、其实是降级"的那一类 ✓。
//
// 故守卫的核心是一条:**memo()/forwardRef() 包装过的组件必须被认成组件** ✓
// (它们都是**对象**而不是函数 —— 只判 `typeof === "function"` 必然漏掉 ✗)。
import { describe, it, expect } from "vitest";
import { memo, forwardRef } from "react";

import { asReactComponent } from "./plugin-modules";

const Plain = (): null => null;
const Memoized = memo(Plain);
const Forwarded = forwardRef<unknown, Record<string, never>>(() => null);

describe("asReactComponent:认组件 —— memo/forwardRef 包装的也必须认(否则静默降级)", () => {
  it("① 普通函数组件 → 认", () => {
    expect(asReactComponent(Plain)).toBe(Plain);
  });

  it("★ ② **memo() 包装的组件 → 必须认**(它是对象;旧码只判 typeof function 会丢 ✗)", () => {
    expect(typeof Memoized, "前提:memo 返回的是对象而非函数").toBe("object");
    expect(asReactComponent(Memoized), "**memo 组件被丢弃了** —— 消费方会回落兜底渲染(markdown 退化为纯文本)").toBe(Memoized);
  });

  it("★ ③ forwardRef() 包装的组件 → 也必须认(同样是对象)", () => {
    expect(typeof Forwarded).toBe("object");
    expect(asReactComponent(Forwarded), "forwardRef 组件被丢弃了").toBe(Forwarded);
  });

  it("④ 非组件 → 不认(不能把任意对象都当组件)", () => {
    for (const bad of [null, undefined, 42, "div", {}, [], { notAComponent: true }]) {
      expect(asReactComponent(bad), `把非组件 ${JSON.stringify(bad)} 认成了组件`).toBeFalsy();
    }
  });

  it("④b 内建宿主标签**字符串**不算组件(它是 tag 名,不是组件对象)", () => {
    expect(asReactComponent("div")).toBeFalsy();
  });
});
