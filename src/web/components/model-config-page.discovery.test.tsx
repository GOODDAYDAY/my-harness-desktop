// @vitest-environment jsdom
// 「从 Base URL 发现」区块的 DOM 测试：经共享 base ModelConfigPage 渲染，
// stub window.kernel.modelsProbe（IPC 边界）验证 默认收起 → baseUrl 行内开关展开 →
// 扫描 → 行渲染 → ping 计时展示 → 全部 Ping → + 添加 → 收起保留结果。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ModelConfigPage } from "../../../packages/react/src/manager/model-config-page";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => (vars ? `${k} ${JSON.stringify(vars)}` : k),
    i18n: { language: "zh-CN" },
  }),
}));

const discoverMock = vi.fn();
const pingMock = vi.fn();

/** usePluginContext 在 render 期读取的 window.kernel 字段全集（属性访问，不调用）。 */
function stubKernel(): void {
  (window as unknown as { kernel: unknown }).kernel = {
    config: {}, sessions: { pi: {} }, i18n: {}, fs: {}, git: {}, gitWrite: {}, llm: {}, bus: {}, dialog: {},
    prefs: {}, themes: {}, fonts: {}, kernels: {}, dshModels: {}, kernelModels: {}, kernelConfig: {},
    dshSettings: {}, models: {}, piSettings: {}, plugins: {}, kernelExtensions: {}, skills: {}, restart: {},
    configFile: { get: vi.fn(), append: vi.fn(), readBinary: vi.fn(), writeBinary: vi.fn() },
    openFile: vi.fn(), appInfo: { get: vi.fn(), restart: vi.fn() }, notify: { show: vi.fn() },
    window: { isFocused: vi.fn() },
    modelsProbe: { discover: discoverMock, ping: pingMock },
  };
}

function makeProvider(over?: Record<string, unknown>) {
  return {
    id: "p1", displayName: "P1", api: "openai-completions",
    baseUrl: "https://api.p1.test/v1", apiKey: "sk-1",
    models: [{ id: "m-a", name: "Model A", contextWindow: 128000, maxTokens: 8192 }],
    ...over,
  };
}

function renderPage(provider = makeProvider(), onChange = vi.fn()) {
  const api = { test: vi.fn() };
  render(
    <ModelConfigPage
      api={api as never}
      i18nPrefix="models"
      capabilities={{ reasoning: true }}
      config={{ providers: [provider], default: null } as never}
      dirty={false}
      onChange={onChange}
    />,
  );
  return onChange;
}

/** 展开发现区块（baseUrl 行内开关）。 */
function openDiscovery(): void {
  fireEvent.click(screen.getByText("models.discoverToggle"));
}

beforeEach(() => {
  vi.clearAllMocks();
  stubKernel();
});

describe("从 Base URL 发现区块", () => {
  it("默认收起不占版面：区块不可见；baseUrl 行内有「发现模型」开关，点开才展开", () => {
    renderPage();
    // 开关在 baseUrl 行内（与输入框同一 flex 行）
    const toggle = screen.getByText("models.discoverToggle");
    expect(toggle).toBeVisible();
    // 区块内容已挂载但不可见（display:none——保留状态用）
    expect(screen.getByText("models.discoverScan")).not.toBeVisible();
    openDiscovery();
    expect(screen.getByText("models.discoverScan")).toBeVisible();
    // 展开后开关文案变「收起」
    expect(screen.getByText("models.discoverCollapse")).toBeVisible();
  });

  it("扫描 → 列出模型行，已配置/未配置徽标正确，未配置行带「+ 添加」", async () => {
    discoverMock.mockResolvedValue({ ok: true, models: ["m-a", "m-b"] });
    renderPage();
    openDiscovery();
    fireEvent.click(screen.getByText("models.discoverScan"));
    expect(discoverMock).toHaveBeenCalledWith({ baseUrl: "https://api.p1.test/v1", apiKey: "sk-1", api: "openai-completions" });
    expect(await screen.findByText("m-a")).toBeInTheDocument();
    expect(await screen.findByText("m-b")).toBeInTheDocument();
    expect(screen.getByText("models.discoverConfigured")).toBeInTheDocument();
    expect(screen.getByText("models.discoverNotConfigured")).toBeInTheDocument();
    expect(screen.getAllByText("models.discoverAdd")).toHaveLength(1);
    expect(screen.getByText(/models\.discoverSummary/)).toHaveTextContent('"found":2');
    expect(screen.getByText(/models\.discoverSummary/)).toHaveTextContent('"configured":1');
  });

  it("Ping 行：成功显示 ✓ 耗时；失败显示 ✗ 耗时+错误原文", async () => {
    discoverMock.mockResolvedValue({ ok: true, models: ["m-a", "m-b"] });
    pingMock.mockImplementation((input: { model: string }) =>
      Promise.resolve(input.model === "m-a"
        ? { ok: true, latencyMs: 842 }
        : { ok: false, latencyMs: 1204, error: "HTTP 404: model not found" }));
    renderPage();
    openDiscovery();
    fireEvent.click(screen.getByText("models.discoverScan"));
    await screen.findByText("m-b");
    const pingButtons = screen.getAllByText("models.discoverPing");
    await act(async () => { fireEvent.click(pingButtons[0]); });
    expect(pingMock).toHaveBeenCalledWith({ baseUrl: "https://api.p1.test/v1", apiKey: "sk-1", api: "openai-completions", model: "m-a" });
    expect(await screen.findByText("✓ 842ms")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getAllByText("models.discoverPing")[1]); });
    expect(await screen.findByText(/✗ 1\.20s · HTTP 404: model not found/)).toBeInTheDocument();
  });

  it("全部 Ping：串行逐个调 ping（每个模型恰好一次）", async () => {
    discoverMock.mockResolvedValue({ ok: true, models: ["m-a", "m-b", "m-c"] });
    pingMock.mockResolvedValue({ ok: true, latencyMs: 100 });
    renderPage();
    openDiscovery();
    fireEvent.click(screen.getByText("models.discoverScan"));
    await screen.findByText("m-c");
    await act(async () => { fireEvent.click(screen.getByText("models.discoverPingAll")); });
    expect(pingMock).toHaveBeenCalledTimes(3);
    expect(pingMock.mock.calls.map((c) => (c[0] as { model: string }).model)).toEqual(["m-a", "m-b", "m-c"]);
  });

  it("收起再展开：扫描/ping 结果保留（display:none 不卸载）", async () => {
    discoverMock.mockResolvedValue({ ok: true, models: ["m-a"] });
    pingMock.mockResolvedValue({ ok: true, latencyMs: 66 });
    renderPage();
    openDiscovery();
    fireEvent.click(screen.getByText("models.discoverScan"));
    await screen.findByText("m-a");
    await act(async () => { fireEvent.click(screen.getByText("models.discoverPing")); });
    await screen.findByText("✓ 66ms");
    // 收起（开关文案此时是 discoverCollapse）
    fireEvent.click(screen.getByText("models.discoverCollapse"));
    expect(screen.getByText("✓ 66ms")).not.toBeVisible();
    // 再展开：结果仍在，且没有重新发 discover
    fireEvent.click(screen.getByText("models.discoverToggle"));
    expect(screen.getByText("✓ 66ms")).toBeVisible();
    expect(discoverMock).toHaveBeenCalledTimes(1);
  });

  it("「+ 添加」：把未配置模型经 onChange 加成配置模型", async () => {
    discoverMock.mockResolvedValue({ ok: true, models: ["m-b"] });
    const onChange = renderPage();
    openDiscovery();
    fireEvent.click(screen.getByText("models.discoverScan"));
    await screen.findByText("m-b");
    fireEvent.click(screen.getByText("models.discoverAdd"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as { providers: { id: string; models: { id: string }[] }[] };
    expect(next.providers[0].models.map((m) => m.id)).toContain("m-b");
  });

  it("扫描失败：错误原文展示", async () => {
    discoverMock.mockResolvedValue({ ok: false, error: "HTTP 401: bad key" });
    renderPage();
    openDiscovery();
    fireEvent.click(screen.getByText("models.discoverScan"));
    expect(await screen.findByText("HTTP 401: bad key")).toBeInTheDocument();
  });

  it("饱和覆盖：google-genai 也不禁用开关（全协议形状都会试）", () => {
    renderPage(makeProvider({ api: "google-genai" }));
    expect(screen.getByText("models.discoverToggle")).not.toBeDisabled();
  });

  it("端点无列表 API（扫描报错）→ 「改用已配置模型」降级路径，可正常 Ping", async () => {
    discoverMock.mockResolvedValue({ ok: false, error: "HTTP 400: Model not found in request" });
    pingMock.mockResolvedValue({ ok: true, latencyMs: 1448 });
    renderPage();
    openDiscovery();
    fireEvent.click(screen.getByText("models.discoverScan"));
    // 错误原文展示 + 降级按钮出现（该 provider 有 1 个已配置模型 m-a）
    expect(await screen.findByText("HTTP 400: Model not found in request")).toBeInTheDocument();
    const fallback = await screen.findByText(/models\.discoverUseConfigured/);
    expect(fallback).toHaveTextContent('"count":1');
    fireEvent.click(fallback);
    // 已配置模型进列表，可直接 Ping 出耗时
    await screen.findByText("m-a");
    await act(async () => { fireEvent.click(screen.getByText("models.discoverPing")); });
    expect(await screen.findByText("✓ 1.45s")).toBeInTheDocument(); // ≥1s 格式化成秒
    expect(pingMock).toHaveBeenCalledWith(expect.objectContaining({ model: "m-a" }));
  });

  it("未填 baseUrl → 开关禁用 + tooltip 提示", () => {
    renderPage(makeProvider({ baseUrl: "" }));
    const toggle = screen.getByText("models.discoverToggle");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("title", "models.discoverNoBaseUrl");
  });
});
