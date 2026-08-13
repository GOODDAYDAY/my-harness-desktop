// attach-images 运行时验证:role:image 消息吸附到最近的 user 消息(IM 配图风格)。
// 覆盖:正常吸附(跳过 assistant)、content 损坏丢弃、无可吸附 user 保留独立行、原引用透传。
import { describe, it, expect } from "vitest";
import type { NeutralMessage } from "@pi-desktop/contract";
import { attachImagesToUsers, parseImageContent } from "./attach-images";

const m = (extra: Record<string, unknown>): NeutralMessage => ({ content: "", ...extra }) as NeutralMessage;

describe("parseImageContent", () => {
  it("合法 JSON + src → {src, title?}", () => {
    expect(parseImageContent(JSON.stringify({ src: "~/.pi-desktop/s/a.png", title: "hi" })))
      .toEqual({ src: "~/.pi-desktop/s/a.png", title: "hi" });
  });
  it("损坏/缺 src → null", () => {
    expect(parseImageContent("not-json")).toBeNull();
    expect(parseImageContent(JSON.stringify({ title: "x" }))).toBeNull();
  });
});

describe("attachImagesToUsers", () => {
  it("image 吸附到最近 user(跳过中间的 assistant)", () => {
    const list = [
      m({ role: "user", id: "u1", content: "你好" }),
      m({ role: "assistant", id: "a1", content: "回复" }),
      m({ role: "image", id: "i1", content: JSON.stringify({ src: "~/.pi-desktop/s/a.png" }) }),
    ];
    const out = attachImagesToUsers(list);
    expect(out).toHaveLength(2);
    expect((out[0] as { __image?: unknown }).__image).toEqual({ src: "~/.pi-desktop/s/a.png" });
    expect(out[1]).toBe(list[1]); // assistant 原引用透传
  });

  it("相邻 [user, image] 吸附,user 换新引用", () => {
    const user = m({ role: "user", id: "u1" });
    const list = [user, m({ role: "image", id: "i1", content: JSON.stringify({ src: "s.png", title: "t" }) })];
    const out = attachImagesToUsers(list);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toBe(user); // 换新引用
    expect((out[0] as { __image?: unknown }).__image).toEqual({ src: "s.png", title: "t" });
  });

  it("user 自带 __image(乐观期)透传,不动", () => {
    const user = m({ role: "user", id: "u1", __image: { src: "s.png", title: "t" } });
    const out = attachImagesToUsers([user, m({ role: "assistant", id: "a1" })]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(user); // 原引用透传
    expect((out[0] as { __image?: unknown }).__image).toEqual({ src: "s.png", title: "t" });
  });

  it("content 损坏 → 丢弃 image,不吸附", () => {
    const user = m({ role: "user", id: "u1" });
    const out = attachImagesToUsers([user, m({ role: "image", id: "i1", content: "bad" })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(user); // 原引用
  });

  it("无 user 可吸附 → 保留独立行", () => {
    const img = m({ role: "image", id: "i1", content: JSON.stringify({ src: "s.png" }) });
    const out = attachImagesToUsers([m({ role: "assistant", id: "a1" }), img]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(img);
  });
});
