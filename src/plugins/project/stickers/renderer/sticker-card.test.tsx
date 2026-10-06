// @vitest-environment jsdom
// StickerDisplay 的 banner **读取失败态**（r141；兑现 r140 账本里的 next）。
//
// ## 为什么在 DOM 层测而不是真机
//
// 失败态要出现，需要 `ctx.configFile.readBinary` **reject**。真机侧造不出来：
// 服务端的 `readBinaryFile` 虽然不吞错（与 `readJsonFile` 的 `catch { return {} }` 不同，
// EACCES/IO 会抛 ⇒ transport reject），但要触发它得把 banner 文件设成不可读，
// 而 r100–r102 已查明：① 运行期 chmod 无效（服务端有配置缓存）；
// ② 启动前 chmod 又与 boot 的种子逻辑纠缠。所以按 §5.6 的三级分工落在 **DOM 交互层**：
// jsdom 里可以精确控制 `readBinary` 的成败。
//
// ## 被验的性质（r140 修的那条）
//
// "没有图"与"图读失败"在 UI 上必须**可区分**——§7.6 要求降级必须解释。
// 修复前 `useBannerDataUri` 只有 `.then` 无 `.catch`：失败时 uri 停在 null，
// 渲染结果与"这张贴纸本来就没图"完全一样，且 rejection 变成 unhandled。
// 修复后失败会渲染 `[data-sticker-banner-lost]` + `stickers.bannerLost` 译文。
//
// ⚠ 断言跑**真文案**（真字典，r54/r56/r78/r90 的纪律），不断言键名。

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import zhCN from "../locales/zh-CN/stickers.json";

vi.mock("react-i18next", () => {
  const dict = zhCN as Record<string, string>;
  const t = (k: string, vars?: Record<string, unknown>): string => {
    let out = dict[k] ?? k;
    for (const [kk, vv] of Object.entries(vars ?? {})) out = out.split(`{{${kk}}}`).join(String(vv));
    return out;
  };
  return { useTranslation: () => ({ t, i18n: { language: "zh-CN" } }) };
});

const mocks = vi.hoisted(() => ({
  readBinary: vi.fn(),
  emit: vi.fn(),
  on: vi.fn(() => () => {}),
}));

vi.mock("@my-harness-desktop/react", async () => {
  const actual = await vi.importActual<typeof import("@my-harness-desktop/react")>("@my-harness-desktop/react");
  // 稳定 ctx 对象（同 composer-button.test.tsx 的纪律：每次渲染新对象会让 effect 反复重跑）
  const ctx = {
    configFile: { readBinary: mocks.readBinary },
    events: { emit: mocks.emit, on: mocks.on },
  };
  return { ...actual, usePluginContext: () => ctx };
});

import { StickerDisplay } from "./sticker-card";

const STICKER = {
  id: "s1",
  title: "测试贴纸",
  content: "内容",
  order: 0,
  createdAt: 1,
  updatedAt: 1,
  layer: "project" as const,
  banner: "stickers/banners/s1.png",
};

function renderCard(): void {
  render(
    <StickerDisplay
      sticker={STICKER}
      onActivate={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      onMoveLayer={() => {}}
      onFillComposer={() => {}}
      onSend={() => {}}
      onToggleExpand={() => {}}
      expanded={false}
      sending={false}
    />,
  );
}

describe("StickerDisplay：banner 读取失败必须是**可见的失败态**，不能与「没有图」混淆", () => {
  beforeEach(() => { mocks.readBinary.mockReset(); });

  it("判据不空转：真字典里有失败态文案，且不是键名", () => {
    const v = (zhCN as Record<string, string>)["stickers.bannerLost"];
    expect(v, "语言包里必须有 stickers.bannerLost（否则本测试在断言一个不存在的键）").toBeTruthy();
    expect(v).not.toBe("stickers.bannerLost");
  });

  it("① readBinary **reject** ⇒ 渲染失败态锚点 + 译文，且**不**渲染图片", async () => {
    mocks.readBinary.mockRejectedValue(new Error("EACCES: permission denied"));
    renderCard();
    await waitFor(() => expect(document.querySelector("[data-sticker-banner-lost]")).not.toBeNull());
    const lost = document.querySelector("[data-sticker-banner-lost]")!;
    expect(lost.textContent?.trim(), "失败态要显示译文（不是裸键）").toBe(zhCN["stickers.bannerLost"]);
    expect(document.querySelector("img[src^='data:']"), "读取失败时不该渲染出图片").toBeNull();
  });

  it("② readBinary 返回 **null**（文件不存在）⇒ 同样进失败态（与 reject 同一呈现）", async () => {
    mocks.readBinary.mockResolvedValue(null);
    renderCard();
    await waitFor(() => expect(document.querySelector("[data-sticker-banner-lost]")).not.toBeNull());
  });

  it("③ 读取**成功** ⇒ 渲染图片，且**不**出现失败态（反证：失败态不是恒在）", async () => {
    mocks.readBinary.mockResolvedValue("aGVsbG8=");   // "hello" 的 base64
    renderCard();
    await waitFor(() => expect(document.querySelector("img[src^='data:']")).not.toBeNull());
    expect(document.querySelector("[data-sticker-banner-lost]"), "成功时不该有失败态").toBeNull();
  });

  it("④ 没有 banner 字段的贴纸 ⇒ 既不读、也不报失败（正常空态，不是失败）", async () => {
    render(
      <StickerDisplay
        sticker={{ ...STICKER, banner: undefined }}
        onActivate={() => {}} onEdit={() => {}} onDelete={() => {}} onMoveLayer={() => {}}
        onFillComposer={() => {}} onSend={() => {}} onToggleExpand={() => {}}
        expanded={false} sending={false}
      />,
    );
    await waitFor(() => expect(mocks.readBinary).not.toHaveBeenCalled());
    expect(document.querySelector("[data-sticker-banner-lost]"),
      "『没有图』是正常态、不该显示『读取失败』——这正是 r140 要区分的两种空态").toBeNull();
  });
});
