// @vitest-environment jsdom
// 「内核扩展页」两侧 wrapper 的**成对断言** —— 用 skills §10.4.1 的手法(同族并排看):
//
//   kernels/pi/renderer/extensions.tsx   → <KernelExtensionsPage kernel="pi"  … />
//   kernels/dsh/renderer/extensions.tsx  → <KernelExtensionsPage kernel="dsh" … />
//
// 两文件各 11/12 行、几乎逐字相同 —— 正是**复制粘贴忘改**的高发处。
// 一旦 dsh 那份留着 kernel="pi",**不会报错**,只会让 DSH 的扩展页**静默列出 pi 的扩展**
// (本会话反复遇到的"静默错"形态;也正是需求 §11/§14 要防的"内核身份混乱")。
// 所以这里断言的不是"页面能渲染",而是 **每侧都传自己的 kernel 身份**。
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@my-harness-desktop/react", () => ({
  usePluginContext: () => ({
    kernels: { pi: { id: "K_PI" }, dsh: { id: "K_DSH" } },
    kernelConfig: { pi: { id: "C_PI" }, dsh: { id: "C_DSH" } },
  }),
  // 探针:把收到的 props 变成可断言的属性
  KernelExtensionsPage: ({ kernel, title, refreshSignal }: { kernel: string; title: string; refreshSignal: number }) => (
    <div data-testid="page" data-kernel={kernel} data-title={title} data-refresh={String(refreshSignal)} />
  ),
  KernelVersionPage: ({ api, i18nPrefix }: { api: { id: string }; i18nPrefix: string }) => (
    <div data-testid="ver" data-api={api.id} data-prefix={i18nPrefix} />
  ),
  KernelConfigForm: ({ api, refreshSignal }: { api: { id: string }; refreshSignal: number }) => (
    <div data-testid="cfg" data-api={api.id} data-refresh={String(refreshSignal)} />
  ),
}));

import { ExtensionManagerPage } from "./pi/renderer/extensions";
import { DshExtensionsPage } from "./dsh/renderer/extensions";

const props = (refreshSignal = 0) => ({ refreshSignal, config: null, onChange: () => {} });
const page = () => screen.getByTestId("page");

describe("内核扩展页 wrapper 对(kernel 身份必须各传各的)", () => {
  it("pi 侧传 kernel=\"pi\"", () => {
    render(<ExtensionManagerPage {...props()} />);
    expect(page().getAttribute("data-kernel")).toBe("pi");
  });

  it("dsh 侧传 kernel=\"dsh\"(**复制粘贴忘改就会是 pi**)", () => {
    render(<DshExtensionsPage {...props()} />);
    expect(page().getAttribute("data-kernel"), "dsh 扩展页传了别的内核身份(会列出另一内核的扩展)").toBe("dsh");
  });

  it("两侧的标题取自各自的 i18n 命名空间(dsh 用 dsh.* 前缀)", () => {
    const { unmount } = render(<ExtensionManagerPage {...props()} />);
    expect(page().getAttribute("data-title")).toBe("settings.extensions");
    unmount();

    render(<DshExtensionsPage {...props()} />);
    expect(page().getAttribute("data-title"), "dsh 侧用了 pi 的文案 key").toBe("dsh.extTitle");
  });

  it("refreshSignal 原样透传(两侧都要传,否则刷新失效)", () => {
    const { unmount } = render(<ExtensionManagerPage {...props(7)} />);
    expect(page().getAttribute("data-refresh")).toBe("7");
    unmount();

    render(<DshExtensionsPage {...props(7)} />);
    expect(page().getAttribute("data-refresh"), "dsh 侧没有透传 refreshSignal").toBe("7");
  });
});

// ── 第二对:内核「版本 + 配置」页 wrapper(pi: index.tsx / dsh: kernel.tsx) ──────────
// 同一类契约的又一实例:api={ctx.kernels.<own>} / api={ctx.kernelConfig.<own>} / i18nPrefix 各归各的。
// 传错同样静默 —— 会让某内核的「版本」页显示**另一个内核**的版本,或把配置存到**另一个内核**的命名空间。
import { PiManagerPage } from "./pi/renderer/index";
import { DshKernelPage } from "./dsh/renderer/kernel";

describe("内核版本+配置页 wrapper 对(内核身份必须各传各的)", () => {
  it("pi 侧:kernels.pi / kernelConfig.pi / i18nPrefix=\"kernel\"", () => {
    render(<PiManagerPage {...props(5)} />);
    expect(screen.getByTestId("ver").getAttribute("data-api")).toBe("K_PI");
    expect(screen.getByTestId("ver").getAttribute("data-prefix")).toBe("kernel");
    expect(screen.getByTestId("cfg").getAttribute("data-api")).toBe("C_PI");
    expect(screen.getByTestId("cfg").getAttribute("data-refresh")).toBe("5");
  });

  it("dsh 侧:kernels.dsh / kernelConfig.dsh / i18nPrefix=\"dsh\"", () => {
    render(<DshKernelPage {...props(5)} />);
    expect(screen.getByTestId("ver").getAttribute("data-api"), "dsh 版本页拿了 pi 的内核面").toBe("K_DSH");
    expect(screen.getByTestId("ver").getAttribute("data-prefix")).toBe("dsh");
    expect(screen.getByTestId("cfg").getAttribute("data-api"), "dsh 配置表单写到了 pi 的命名空间").toBe("C_DSH");
    expect(screen.getByTestId("cfg").getAttribute("data-refresh")).toBe("5");
  });
});
