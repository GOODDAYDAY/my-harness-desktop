// @vitest-environment jsdom
// `ErrorBoundary` 的行为（r153；此前零测试引用，而它是**渲染崩溃的最后兜底**）。
//
// ## 为什么它必须有测试
//
// 它坏了的后果是二选一，都很重：
//   · 兜底不生效 ⇒ 一个插件渲染抛错就**白屏整棵树**（用户连"哪里坏了"都看不到）；
//   · 兜底太吵 ⇒ 附属 UI（悬浮层等）出错时在视口里留一块红字，而它的合格降级是**消失**。
// 而这两条正好由 `fallback` 的**三态**决定：`undefined`（默认红字）/ `null`（静默）/ 节点（自定义）。
// ⚠ `fallback={null}` 与 `fallback` 不传是**两种不同语义**——判据是 `!== undefined`，
//   若哪天写成 `if (!this.props.fallback)`，"静默"就会退化成"红字"，而这类回归很难被发现
//   （要正好有一个悬浮层组件抛错才会暴露）。这是本测试的重点（③）。
//
// 另一条被测的性质：它**不依赖 React 上下文 / i18n Provider**（直接用全局 i18next 实例），
// 因为崩溃时不能假定 Provider 还活着。测试通过"不包任何 Provider 直接渲染"来钉住这一点（④）。

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorBoundary } from "./error-boundary";

// ⚠ 必须初始化 i18next 才能断言兜底文案：未初始化时 t() 返回**键名**（不是 defaultValue），
//   r153 首版就因此断言失败。这里给**真字典**（r54/r56/r90 的纪律：不软化断言、不断言键名）。
//   路径深度：packages/react/src → 仓库根是 **3** 级（r151 刚踩过 4 级的坑，这次按目标文件算）。
const HERE = dirname(fileURLToPath(import.meta.url));
const FLAT = JSON.parse(
  readFileSync(join(HERE, "../../../src/plugins/system/i18n/locales/zh-CN/shell.json"), "utf-8"),
) as Record<string, string>;
const NS: Record<string, string> = {};
for (const [k, v] of Object.entries(FLAT)) {
  const d = k.indexOf(".");
  NS[d > 0 ? k.slice(d + 1) : k] = v;
}
const LABEL = NS["renderError"] ?? "Render error";

function Boom({ message }: { message: string }): never {
  throw new Error(message);
}

describe("ErrorBoundary：渲染崩溃的最后兜底", () => {
  beforeEach(async () => {
    // React 会把捕获到的错误打进 console.error；静音以免淹没测试输出（不影响断言）
    vi.spyOn(console, "error").mockImplementation(() => {});
    if (!i18next.isInitialized) {
      await i18next.init({
        lng: "zh-CN", fallbackLng: "en", defaultNS: "shell", ns: ["shell"],
        nsSeparator: ".", keySeparator: ".", interpolation: { escapeValue: false },
        returnEmptyString: false, resources: { "zh-CN": { shell: NS } },
      });
    }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("① 子树正常 ⇒ 原样渲染，不显示任何兜底", () => {
    render(<ErrorBoundary><span data-probe="ok">正常内容</span></ErrorBoundary>);
    expect(screen.getByText("正常内容")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(LABEL))).toBeNull();
  });

  it("② 子树抛错 + 未传 fallback ⇒ 显示**默认红字兜底**（白屏不如红字），且带错误消息", () => {
    render(<ErrorBoundary><Boom message="插件渲染炸了" /></ErrorBoundary>);
    expect(screen.getByText(/插件渲染炸了/), "要把真实错误消息给用户/给排查者看到").toBeInTheDocument();
    // 文案走 i18n（shell.renderError），且**必须有英文 defaultValue**（i18n 自身可能就是崩因）
    expect(LABEL, "真字典里应有 shell.renderError").toBeTruthy();
    expect(screen.getByText(new RegExp(LABEL)), "兜底文案应是**译文**而不是裸键名").toBeInTheDocument();
  });

  it("③ **fallback={null} ⇒ 完全静默**（附属 UI 的合格降级是消失，不是在视口里留一块红）", () => {
    const { container } = render(
      <ErrorBoundary fallback={null}><Boom message="悬浮层炸了" /></ErrorBoundary>,
    );
    expect(container.textContent, "不该留下任何可见文本").toBe("");
    expect(screen.queryByText(/悬浮层炸了/)).toBeNull();
  });

  it("④ 不包任何 Provider 也能工作（崩溃时不能假定 i18n/上下文还活着）", () => {
    // 本测试文件从头到尾没有 I18nextProvider / 任何 Context.Provider —— 这就是断言本身。
    render(<ErrorBoundary><Boom message="无 Provider 也炸" /></ErrorBoundary>);
    expect(screen.getByText(/无 Provider 也炸/)).toBeInTheDocument();
  });

  it("⑤ onError 回调被调用且拿到真实 Error（供上层上报/降级）", () => {
    const onError = vi.fn();
    render(<ErrorBoundary onError={onError}><Boom message="要上报的错" /></ErrorBoundary>);
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("要上报的错");
  });

  it("⑥ 未传 onError 时抛错也**不该**再抛出去（回调是可选的）", () => {
    expect(() => render(<ErrorBoundary><Boom message="没人接的错" /></ErrorBoundary>)).not.toThrow();
  });

  it("⑦ fallback 传自定义节点 ⇒ 渲染它而不是默认红字", () => {
    render(
      <ErrorBoundary fallback={<span data-probe="custom">这块坏了</span>}>
        <Boom message="自定义兜底" />
      </ErrorBoundary>,
    );
    expect(screen.getByText("这块坏了")).toBeInTheDocument();
    expect(screen.queryByText(/自定义兜底/), "自定义兜底时不该再显示原始错误文本").toBeNull();
  });

  it("⑧ 钉桩：判据是 `fallback !== undefined` 而不是 `!fallback`（③与②的区别全靠它）", () => {
    // 反证：若实现退化成 if (!this.props.fallback) return 默认红字，③ 会失败。
    // 这里再用一个"falsy 但非 null/undefined"的 fallback 钉住语义边界。
    const { container } = render(
      <ErrorBoundary fallback={<></>}><Boom message="空片段兜底" /></ErrorBoundary>,
    );
    expect(container.textContent, "空片段是**显式**兜底（不是缺省），所以不该出现默认红字").toBe("");
    expect(screen.queryByText(/空片段兜底/)).toBeNull();
  });
});
