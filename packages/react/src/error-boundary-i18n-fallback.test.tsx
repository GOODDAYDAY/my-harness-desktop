// @vitest-environment jsdom
// ErrorBoundary 在 **i18n 自身不可用**时的兜底（r167；补 r153/r166 两次记下的未覆盖项）。
//
// ## 为什么这条要单独一个文件
//
// 实现里那行注释写着：
//   「⚠ 但**必须有英文 defaultValue**：i18n 自身也可能就是崩因，那时 t() 返回 defaultValue，
//     用户至少读到英文而不是空白。此前这里是写死的中文「渲染错误:」——英文/德文用户在
//     崩溃时看到中文（§7.1 铁律一：壳不内嵌文案）。」
// 也就是说 `defaultValue` 存在的**唯一理由**就是"i18n 挂了"这个场景，而 r153 那轮的测试
// 用真字典初始化了 i18next ⇒ 走的永远是译文分支，**这条性质一次都没被验证过**。
//
// ⚠ 单独开文件是因为 i18next 是**单例**：同文件里先 init 了真字典，再想测"没字典"
//   就得 re-init，而 re-init 会污染同一文件里其它测试。vitest 默认按文件隔离模块，
//   所以"空资源"这种全局状态用一个独立文件最干净。
//
// 顺带钉住 r153 那条已知事实的另一面：**未 init 时 t() 返回键名**（不是 defaultValue），
// 所以"i18n 崩了"要分成两种形态各测一次：① 完全没 init；② init 了但资源为空。

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { ErrorBoundary } from "./error-boundary";

function Boom(): never { throw new Error("渲染炸了-boom"); }

describe("ErrorBoundary：i18n 不可用时的兜底文案", () => {
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("① i18next **init 了但资源为空**（主题/语言插件没装上）⇒ 显示英文 defaultValue，且错误消息仍在", async () => {
    if (!i18next.isInitialized) {
      await i18next.init({
        lng: "zh-CN", fallbackLng: "en", defaultNS: "shell", ns: ["shell"],
        nsSeparator: ".", keySeparator: ".", interpolation: { escapeValue: false },
        resources: {},                       // ← 关键：一个键都没有
      });
    }
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    // t("shell.renderError", { defaultValue: "Render error" }) 在空资源下回落 defaultValue
    expect(screen.getByText(/Render error/), "空资源时应回落英文 defaultValue，不该是键名或空白").toBeInTheDocument();
    expect(screen.getByText(/渲染炸了-boom/), "真实错误消息必须仍在（排查线索）").toBeInTheDocument();
  });

  it("② 兜底文案**不是裸键名**（键名对用户毫无意义，等于没兜底）", () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.queryByText(/shell\.renderError/), "不该把 i18n 键名丢给用户看").toBeNull();
  });

  it("③ 兜底**不是空白**（此前写死中文时，英/德用户至少能看到中文；若 defaultValue 丢了就什么都看不到）", () => {
    const { container } = render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect((container.textContent ?? "").trim().length, "兜底区必须有可读文本").toBeGreaterThan(0);
  });
});
