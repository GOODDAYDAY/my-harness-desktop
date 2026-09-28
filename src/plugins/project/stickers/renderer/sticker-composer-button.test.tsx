// @vitest-environment jsdom
// StickerComposerButton DOM 交互 e2e —— 真实渲染 + 真实键盘/点击交互:
// 打开选择器 → ↑↓ 垂直跨行移动(列保持回绕)、←→ 水平平移 → 选中项标题条跟随 →
// Enter 直接发(emit stickers:send)、「加入」emit stickers:fillComposer、Esc 关;
// 键位提示在顶栏中缝(迷你灰字),底部无独立提示条。
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import zhCN from "../locales/zh-CN/stickers.json";

// i18n:真字典(断言跑真文案,不断言 key)。
vi.mock("react-i18next", () => {
  const dict = zhCN as Record<string, string>;
  const t = (k: string): string => dict[k] ?? k;
  return { useTranslation: () => ({ t, i18n: { language: "zh-CN" } }) };
});

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  on: vi.fn(() => () => {}),
  // 7 项:jsdom 无布局,resolveGridCols 走宽度公式兜底(视口 1024 → 5 列),
  // 行0 = s1-s5(满),行1 = s6-s7(缺列 2/3/4)。
  stickers: ["一", "二", "三", "四", "五", "六", "七"].map((w, i) => ({
    id: `s${i + 1}`,
    title: `标题${w}`,
    content: `内容${w}`,
    order: i,
    createdAt: 1,
    updatedAt: 1,
    layer: "project" as const,
  })),
}));

vi.mock("@my-harness-desktop/react", () => {
  // 稳定 API 对象(同 goal-bar.test.tsx 纪律):ctx 每次渲染新对象会让
  // 装载 effect(deps 含 ctx)反复重跑,异步 setStickers 逃逸 act 并把选中项重置。
  const ctx = { events: { emit: mocks.emit, on: mocks.on } };
  return {
    usePluginContext: () => ctx,
    useUiStore: (sel?: (s: { currentCwd: string }) => unknown) => (sel ? sel({ currentCwd: "/p" }) : { currentCwd: "/p" }),
    useSessionStore: (sel?: (s: { streaming: boolean }) => unknown) => (sel ? sel({ streaming: false }) : { streaming: false }),
  };
});

vi.mock("../client/stickers-store", () => ({
  loadStickers: vi.fn(async () => mocks.stickers),
}));

vi.mock("./sticker-card", () => ({
  useBannerDataUri: () => ({ uri: null, lost: false }),   // r140：hook 返回三态
  readBannerDataUri: vi.fn(async () => undefined),
}));

import { StickerComposerButton } from "./sticker-composer-button";

async function openPicker(): Promise<void> {
  render(<StickerComposerButton />);
  fireEvent.click(screen.getByTitle(zhCN["stickers.composerEntry"]));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // loadStickers 链落进 act
  await screen.findByText("标题一");
}

/** 选中项标题条(网格上方固定条,文本形如「标题N · 内容N」)。 */
function strip(): HTMLElement {
  return screen.getByText(/^标题[一二三四五六七] · 内容/);
}

describe("StickerComposerButton 网格选择器", () => {
  beforeEach(() => {
    mocks.emit.mockClear();
  });

  it("↑↓ 垂直跨行移动(列保持回绕),←→ 水平平移;标题条跟随选中项", async () => {
    await openPicker();
    expect(strip()).toHaveTextContent("标题一 · 内容一");
    fireEvent.keyDown(window, { key: "ArrowDown" }); // 0 → 5(下一行同列)
    expect(strip()).toHaveTextContent("标题六 · 内容六");
    fireEvent.keyDown(window, { key: "ArrowDown" }); // 5 越底 → 该列首行 0
    expect(strip()).toHaveTextContent("标题一 · 内容一");
    fireEvent.keyDown(window, { key: "ArrowUp" });   // 0 越顶 → 该列末行 5
    expect(strip()).toHaveTextContent("标题六 · 内容六");
    fireEvent.keyDown(window, { key: "ArrowUp" });   // 5 → 0
    fireEvent.keyDown(window, { key: "ArrowRight" }); // 0 → 1
    expect(strip()).toHaveTextContent("标题二 · 内容二");
    fireEvent.keyDown(window, { key: "ArrowRight" }); // 1 → 2
    fireEvent.keyDown(window, { key: "ArrowUp" });    // 行1 缺列 2 → 停 2
    expect(strip()).toHaveTextContent("标题三 · 内容三");
    fireEvent.keyDown(window, { key: "ArrowLeft" });  // 2 → 1
    expect(strip()).toHaveTextContent("标题二 · 内容二");
  });

  it("Enter 直接发选中项(emit stickers:send)并关弹层", async () => {
    await openPicker();
    fireEvent.keyDown(window, { key: "ArrowDown" }); // → s6
    fireEvent.keyDown(window, { key: "Enter" });
    expect(mocks.emit).toHaveBeenCalledWith("stickers:send", { text: "内容六", image: undefined });
    expect(screen.queryByText(zhCN["stickers.pickerHint"])).toBeNull(); // 已关
  });

  it("「加入」emit stickers:fillComposer(不发送)", async () => {
    await openPicker();
    fireEvent.click(screen.getAllByTitle(zhCN["stickers.fillComposer"])[1]!); // s2
    expect(mocks.emit).toHaveBeenCalledWith("stickers:fillComposer", { text: "内容二", image: undefined });
    expect(screen.queryByText(zhCN["stickers.pickerHint"])).toBeNull(); // 已关
  });

  it("Esc 关闭弹层", async () => {
    await openPicker();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText(zhCN["stickers.pickerHint"])).toBeNull();
  });

  it("键位提示在顶栏中缝(迷你灰字),底部无独立提示条", async () => {
    await openPicker();
    const keys = screen.getByText(zhCN["stickers.pickerKeys"]);
    expect(keys).toHaveClass("text-[10px]", "text-[var(--color-muted)]");
    // 顶栏三段:左标题 → 中键位提示 → 右操作提示
    const header = keys.parentElement!;
    expect(header.firstElementChild).toHaveTextContent(zhCN["stickers.composerEntry"]);
    expect(keys.nextElementSibling).toHaveTextContent(zhCN["stickers.pickerHint"]);
    // 提示全局只此一份(底部条已移除)
    expect(screen.getAllByText(zhCN["stickers.pickerKeys"])).toHaveLength(1);
  });
});
