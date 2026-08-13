// 会话流图片"刷新后消失"的决定性验证:真实会话文件(header + user + custom_message)
// → readSession → attachImagesToUsers → user.__image。若此链路通过,问题必在落盘侧。
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession } from "./session-scanner";
import { attachImagesToUsers } from "../../../plugins/sessions/timeline/core/attach-images";

describe("会话流图片刷新后读回(真实文件)", () => {
  it("custom_message(image) 条目在文件里 → readSession → 吸附到 user → __image 可渲染", () => {
    const dir = mkdtempSync(join(tmpdir(), "stk-sess-"));
    const f = join(dir, "s.jsonl");
    try {
      const entry = (o: Record<string, unknown>): string => JSON.stringify(o);
      writeFileSync(f, [
        entry({ type: "session", id: "s1", version: 3, timestamp: "2026-01-01T00:00:00Z", cwd: "/p" }),
        entry({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "帮我整理日报" } }),
        entry({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:10Z", message: { role: "assistant", content: "好的" } }),
        entry({ type: "custom_message", id: "i1", parentId: "a1", customType: "image", display: true, content: JSON.stringify({ src: "~/.pi-desktop/stickers/banners/x.png", title: "日报" }), timestamp: "2026-01-01T00:00:11Z" }),
      ].join("\n"));
      const detail = readSession(f);
      expect(detail).not.toBeNull();
      // 文件读回的 messages 里必须有 image 角色(否则 attach 无源可吸附)
      expect(detail!.messages.some((m) => m.role === "image")).toBe(true);
      const out = attachImagesToUsers(detail!.messages);
      // 吸附后 image 独立消息消失,user 带 __image
      expect(out.some((m) => m.role === "image")).toBe(false);
      const user = out.find((m) => m.role === "user") as { __image?: { src: string; title?: string } } | undefined;
      expect(user?.__image).toEqual({ src: "~/.pi-desktop/stickers/banners/x.png", title: "日报" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
