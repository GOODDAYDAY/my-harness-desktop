// 会话流图片"刷新后消失"的诊断:读回链路验证。
// custom_message(image) 条目 → sessionEntryToNeutral → role:image → attachImagesToUsers 吸附。
import { describe, it, expect } from "vitest";
import { sessionEntryToNeutral } from "@pi-desktop/contract";
import { attachImagesToUsers } from "../../../sessions/timeline/core/attach-images";

describe("会话流图片读回链路(刷新/重开后)", () => {
  it("custom_message(image) 条目读回 → 吸附到最近 user → __image 携带 src", () => {
    // 模拟会话 JSONL 读回的条目:header 后 user 消息 + 图条目(在 assistant 之后,与落盘顺序一致)
    const entries = [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "帮我整理日报" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:10Z", message: { role: "assistant", content: "好的" } },
      { type: "custom_message", id: "img1", parentId: "a1", customType: "image", display: true, content: JSON.stringify({ src: "~/.pi-desktop/stickers/banners/x.png", title: "日报" }), timestamp: "2026-01-01T00:00:11Z" },
    ];
    const neutral = entries.map((e) => sessionEntryToNeutral(e)).filter((n): n is NonNullable<typeof n> => !!n);
    expect(neutral.some((m) => m.role === "image")).toBe(true);
    const out = attachImagesToUsers(neutral);
    // 图吸附到最近 user,user 带 __image;image 独立消息被移除
    expect(out.some((m) => m.role === "image")).toBe(false);
    const user = out.find((m) => m.role === "user") as { __image?: { src: string } } | undefined;
    expect(user?.__image).toEqual({ src: "~/.pi-desktop/stickers/banners/x.png", title: "日报" });
  });

  it("content 是纯图贴纸(无 title)也能解析吸附", () => {
    const e = { type: "custom_message", id: "i2", customType: "image", display: true, content: JSON.stringify({ src: "~/.pi-desktop/s/a.gif" }), timestamp: "2026-01-01T00:00:00Z" };
    const neutral = sessionEntryToNeutral(e);
    expect(neutral?.role).toBe("image");
    const out = attachImagesToUsers([
      { role: "user", id: "u", content: "" },
      neutral as NonNullable<typeof neutral>,
    ]);
    expect((out[0] as { __image?: unknown }).__image).toEqual({ src: "~/.pi-desktop/s/a.gif" });
  });
});
