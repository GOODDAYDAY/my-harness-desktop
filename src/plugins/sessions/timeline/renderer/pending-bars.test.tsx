// @vitest-environment jsdom
// 待发送图片条 / 待发送文件条的 DOM 交互测试。
//
// 为什么单测这两个小组件：它们承载的是"用户即将发送什么"的**可见确认**。附件语义是
// **绝对路径引用、不读 base64**（`index.tsx` 的 `ingestFiles`），所以界面上显示的就是路径本身——
// 显示错一个字符，用户就会以为带上了另一个文件。出错的代价不是崩溃，是"以为附件带上了其实没带"。
//
// 抽成独立模块（`pending-bars.tsx`）也正是为了能这样测：埋在 1600+ 行的插件入口里只能靠 e2e，
// 而 e2e **驱动不了附件入口**——r26 实测：合成 drop/paste 事件下 React 的 onDrop 确实跑了
// （文档级冒泡观察到 `defaultPrevented=true`，而在 body 上派发同一事件是 false，可证明是
// React 处理器所为），但既不出现 chip、也不出现"已跳过"toast、且零 pageerror / 零 console 错误，
// 证据链自相矛盾（无 toast ⇒ rejected=0；无 chip ⇒ newFiles=0 ⇒ files 为空，而 files 为空
// 又与 preventDefault 冲突）。判定为合成事件在本环境驱动不了这条路径，与 framer-motion
// 拖拽同类（skill §17.15），所以改由本单测覆盖可确定性验证的那半。

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PendingFileBar, PendingImageBar } from "./pending-bars";

const HERE = dirname(fileURLToPath(import.meta.url));
// i18n 给**真字典**：直接读插件自己的 zh-CN locale，不在测试里另抄一份（另抄必然漂移，
// 于是"测试绿但界面是别的字"）。CLAUDE.md §5.6。
const DICT = JSON.parse(
  readFileSync(join(HERE, "../locales/zh-CN/timeline.json"), "utf-8"),
) as Record<string, string>;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>): string => {
      let v = DICT[k] ?? k;
      for (const [name, val] of Object.entries(vars ?? {})) v = v.split(`{{${name}}}`).join(String(val));
      return v;
    },
    i18n: { exists: (k: string) => k in DICT },
  }),
}));

describe("PendingFileBar：待发送文件条（路径引用）", () => {
  const FILES = [
    { path: "/proj/a/notes.md", name: "notes.md" },
    { path: "/proj/b/spec.txt", name: "spec.txt" },
  ];

  it("每个文件一个 chip，锚点值就是**绝对路径**（附件身份 = 路径，不是下标）", () => {
    const { container } = render(<PendingFileBar files={FILES} onRemove={() => {}} />);
    const chips = [...container.querySelectorAll("[data-composer-pending-file]")];
    expect(chips.map((c) => c.getAttribute("data-composer-pending-file"))).toEqual([FILES[0].path, FILES[1].path]);
    expect(container.querySelector("[data-composer-pending-files]")?.getAttribute("data-composer-pending-files"),
      "容器上带数量，便于审计一眼看出条数").toBe("2");
  });

  it("chip 里显示的是**完整路径**（用户据此确认带的是哪个文件；只显示文件名会让同名的两个文件无法区分）", () => {
    const { container } = render(<PendingFileBar files={FILES} onRemove={() => {}} />);
    const chip = container.querySelector(`[data-composer-pending-file="${FILES[0].path}"]`)!;
    expect(chip.textContent).toContain(FILES[0].path);
    // title 也是路径（截断时悬浮可看全）
    expect(chip.querySelector("span[title]")?.getAttribute("title")).toBe(FILES[0].path);
  });

  it("每个 chip 的移除按钮**各自**回调，且带上自己的路径（不能移除错行）", () => {
    const onRemove = vi.fn();
    const { container } = render(<PendingFileBar files={FILES} onRemove={onRemove} />);
    const btn = container.querySelector(`[data-composer-pending-file-remove="${FILES[1].path}"]`)!;
    expect(btn, "移除钮的锚点值 = 它要移除的路径").toBeTruthy();
    fireEvent.click(btn);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith(FILES[1].path);
  });

  it("移除按钮有**已翻译**的可访问名（图标按钮，无文本 → 名字只能来自 title）", () => {
    const { container } = render(<PendingFileBar files={FILES} onRemove={() => {}} />);
    const btn = container.querySelector(`[data-composer-pending-file-remove="${FILES[0].path}"]`)!;
    const title = btn.getAttribute("title") ?? "";
    expect(title.length).toBeGreaterThan(0);
    expect(title, "必须是真译文而不是裸 i18n key").toBe(DICT["timeline.removeFile"]);
    expect(title).not.toContain("timeline.");
  });

  it("空清单不渲染容器（不留一个空的框占位）", () => {
    const { container } = render(<PendingFileBar files={[]} onRemove={() => {}} />);
    expect(container.querySelector("[data-composer-pending-files]")?.getAttribute("data-composer-pending-files")).toBe("0");
    expect(container.querySelectorAll("[data-composer-pending-file]")).toHaveLength(0);
  });
});

describe("PendingImageBar：待发送图片条", () => {
  it("有 dataUri 时渲染 <img>，alt 用图片标题（无标题则回落已翻译的通用文案）", () => {
    const { container, rerender } = render(
      <PendingImageBar image={{ src: "/proj/pic.png", title: "示意图", dataUri: "data:image/png;base64,AA" }} onRemove={() => {}} />,
    );
    const bar = container.querySelector("[data-composer-pending-image]")!;
    expect(bar.getAttribute("data-composer-pending-image"), "锚点值 = 图片 src").toBe("/proj/pic.png");
    expect(bar.querySelector("img")?.getAttribute("alt")).toBe("示意图");
    // 无标题 → 回落到 i18n 文案（不能是空 alt，也不能是裸 key）
    rerender(<PendingImageBar image={{ src: "/proj/pic.png", dataUri: "data:image/png;base64,AA" }} onRemove={() => {}} />);
    const alt = container.querySelector("[data-composer-pending-image] img")?.getAttribute("alt");
    expect(alt).toBe(DICT["timeline.pendingImageAlt"]);
    expect(alt).not.toContain("timeline.");
  });

  it("无 dataUri 时**不渲染 <img>**，改为显示 src 文本（没有数据就不该造一个坏图占位）", () => {
    const { container } = render(<PendingImageBar image={{ src: "/proj/pic.png" }} onRemove={() => {}} />);
    const bar = container.querySelector("[data-composer-pending-image]")!;
    expect(bar.querySelector("img"), "无 dataUri 不该有 img 元素").toBeNull();
    expect(bar.textContent).toContain("/proj/pic.png");
  });

  it("移除按钮回调一次，且有已翻译的可访问名", () => {
    const onRemove = vi.fn();
    const { container } = render(<PendingImageBar image={{ src: "/proj/pic.png" }} onRemove={onRemove} />);
    const btn = container.querySelector("[data-composer-pending-image-remove]")!;
    expect(btn.getAttribute("title")).toBe(DICT["timeline.removeImage"]);
    fireEvent.click(btn);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
