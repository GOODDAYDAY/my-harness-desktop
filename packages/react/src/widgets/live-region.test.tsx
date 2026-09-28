// @vitest-environment jsdom
// 常驻 live region 宿主 + Toast/Announce 的可访问语义。
//
// 为什么值得单测：这类缺陷**看不见也点不出来**——toast 照常弹出、照常 3 秒消失、
// 视觉完全正常，唯一的问题是读屏用户收不到任何一条。而 toast 承载的往往是一次性告知
// （「附件类型不支持」「已跳过 N 个文件」「保存失败」「重试失败」），错过就没有第二次机会。
// 所以只能靠断言 DOM 上的 aria 属性与 portal 目标来守。
//
// 关键前提（也是这组测试真正在守的东西）：`aria-live` 的播报要求**容器先于内容存在于 DOM**。
// 若宿主由第一条 toast 惰性创建，则"建容器"与"填内容"同一次挂载，多数读屏不播报——
// 于是用户听不到的恰好是最该听到的第一条。所以：① 宿主是单例且常驻；② 应用根启动即挂载。

import { describe, it, expect, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ensureToastHost } from "./toast";
import { Toast } from "./toast";
import { Announce, LiveRegionHost } from "./live-region";

beforeEach(() => {
  cleanup();
  // 宿主是模块级单例，跨用例保留是**预期行为**（它就该常驻）；这里只清掉遗留内容，
  // 以免上一个用例的文本干扰断言。
  const existing = document.querySelector("[data-toast-live-region]");
  if (existing) existing.innerHTML = "";
});

describe("ensureToastHost：常驻宿主是单例且带正确的 live region 语义", () => {
  it("创建的宿主带 aria-live=polite + aria-atomic=true + role=status", () => {
    const host = ensureToastHost();
    expect(host.getAttribute("aria-live"), "toast 是告知而非打断，用 polite 不抢占当前朗读").toBe("polite");
    expect(host.getAttribute("aria-atomic"), "整条消息作为一个整体播报（里面可能有图标+文本）").toBe("true");
    expect(host.getAttribute("role")).toBe("status");
    expect(host.hasAttribute("data-toast-live-region"), "要有稳定锚点供测试与审计定位").toBe(true);
  });

  it("幂等：多次调用返回同一个宿主，且文档里只有一个（多个 live region 会互相干扰/重复播报）", () => {
    const a = ensureToastHost();
    const b = ensureToastHost();
    expect(a).toBe(b);
    expect(document.querySelectorAll("[data-toast-live-region]")).toHaveLength(1);
  });

  it("宿主脱离文档后会重建（不会因为一次 DOM 清空就永久失效）", () => {
    const first = ensureToastHost();
    first.remove();
    const second = ensureToastHost();
    expect(second).not.toBe(first);
    expect(second.isConnected, "重建出的宿主必须在文档里").toBe(true);
  });

  it("宿主不产生可见占位（0×0），所以放在应用根不会影响布局", () => {
    const host = ensureToastHost();
    expect(host.style.width).toBe("0px");
    expect(host.style.height).toBe("0px");
    expect(host.style.pointerEvents, "不该挡住下面的点击").toBe("none");
  });
});

describe("LiveRegionHost：应用根挂载即建好宿主", () => {
  it("挂载后宿主已在 DOM 里（这样**第一条** toast 才播得出来）", () => {
    expect(document.querySelector("[data-toast-live-region]"), "前置：本用例前宿主内容已清空").toBeTruthy();
    const before = document.querySelector("[data-toast-live-region]");
    before?.remove();
    render(<LiveRegionHost />);
    const host = document.querySelector("[data-toast-live-region]");
    expect(host, "挂载 LiveRegionHost 后宿主必须存在").toBeTruthy();
  });

  it("自身不渲染任何可见内容", () => {
    const { container } = render(<LiveRegionHost />);
    expect(container.innerHTML, "它是纯副作用组件，不该往自己的位置渲染东西").toBe("");
  });
});

describe("Toast：内容 portal 进常驻宿主，且按变体区分播报强度", () => {
  it("渲染进宿主内部（不是 document.body 直挂）——这是播报可靠的前提", () => {
    render(<Toast message="已保存" onClose={() => {}} />);
    const host = ensureToastHost();
    expect(host.textContent).toContain("已保存");
    expect(host.querySelector("[data-toast-variant]"), "toast 的可视元素应在宿主内").toBeTruthy();
  });

  it("success/info 变体不额外声明 role（交给宿主的 status + polite，不抢占）", () => {
    render(<Toast message="已完成" onClose={() => {}} variant="success" />);
    const el = ensureToastHost().querySelector("[data-toast-variant='success']")!;
    expect(el.getAttribute("role"), "嵌套 live region 会互相干扰，非错误态不该再声明").toBeNull();
  });

  it("error 变体带 role=alert（插入即播报、可打断——出错要立刻知道）", () => {
    render(<Toast message="保存失败" onClose={() => {}} variant="error" />);
    const el = ensureToastHost().querySelector("[data-toast-variant='error']")!;
    expect(el.getAttribute("role")).toBe("alert");
  });
});

describe("Announce：只补「被读到」，不改变原有视觉呈现", () => {
  it("把消息送进常驻宿主（供读屏播报）", () => {
    render(<Announce message="已跳过 2 个不可参考的文件" />);
    expect(ensureToastHost().textContent).toContain("已跳过 2 个不可参考的文件");
  });

  it("info 变体不声明 role，error 变体声明 role=alert", () => {
    const { rerender } = render(<Announce message="提示" variant="info" />);
    expect(ensureToastHost().querySelector("[data-announced='info']")?.getAttribute("role")).toBeNull();
    rerender(<Announce message="出错了" variant="error" />);
    expect(ensureToastHost().querySelector("[data-announced='error']")?.getAttribute("role")).toBe("alert");
  });

  it("空消息不产生节点（避免 live region 里塞空播报）", () => {
    render(<Announce message="" />);
    expect(ensureToastHost().querySelectorAll("[data-announced]")).toHaveLength(0);
  });

  it("自身不渲染可见内容（视觉部分由调用方原有的元素负责，两者并存）", () => {
    const { container } = render(<Announce message="x" />);
    expect(container.innerHTML).toBe("");
  });
});
