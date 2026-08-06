// echo 徽章持久化端到端 —— 真实文件 IO 全链路回归(除 Electron IPC 外壳全真)。
// 背景:首版持久化因"反查在水合前"时序错序从未生效,单元测试却全绿(预置水合态
// 绕开了时序)。本文件用真实 JSONL 文件 + 真实 updateSessionHeader/readSession 把
// 写盘与重扫回贴两环钉在文件系统上,杜绝"代码读着眼对、线上就是不行"。
// 独立成文件:vitest 按文件隔离模块态,本文件的 initSessionStore 拿到的 window
// stub 不被 session-store.test.ts 的 inited 占用。
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSessionStore, useSessionStore, type EchoAttachment } from "./session-store";
import { useUiStore } from "./ui-store";
import type { NeutralMessage } from "@pi-desktop/contract";
import { updateSessionHeader, readSession } from "../../../core/application/sessions/session-scanner";

const badge: EchoAttachment = { seq: "①", quotePreview: "引文", comment: "意见" };
const FULL_TEXT = "正文\n\n---\n> 评论\n\n> ① : 引文\n意见";

describe("echo 徽章持久化端到端(真实文件 IO)", () => {
  it("发送→落盘→头行有 echoAttachments 域→重扫打开→徽章回贴", async () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-e2e-"));
    const file = join(dir, "s.jsonl");
    try {
      const header = { type: "session", version: 3, id: "s1", timestamp: "2026-08-06T12:52:37.727Z", cwd: "/tmp/proj" };
      writeFileSync(file, JSON.stringify(header) + "\n");
      const entry = {
        type: "message", id: "e-real", parentId: null, timestamp: "2026-08-06T12:52:57.696Z",
        message: { role: "user", content: FULL_TEXT },
      };
      appendFileSync(file, JSON.stringify(entry) + "\n");

      let onEvent: ((e: unknown) => void) | null = null;
      vi.stubGlobal("window", {
        pi: {
          sessions: {
            onEvent: (cb: (e: unknown) => void) => { onEvent = cb; return () => {}; },
            onSnapshot: () => () => {},
            updateHeader: (p: string, patch: Record<string, unknown>) => updateSessionHeader(p, patch as never),
            openSession: async (p: string) => readSession(p),
            setContext: async () => {},
            getStats: async () => null,
            getThinkingLevels: async () => [],
          },
        },
      });
      useUiStore.setState({ currentSessionPath: file });
      useSessionStore.setState({
        messages: [
          { role: "user", id: "tmp-uuid", content: "正文", __sendText: FULL_TEXT, echoAttachments: [badge], __optimistic: true },
          { role: "assistant", id: "tmp-asst", content: "", pending: true },
        ] as unknown as NeutralMessage[],
      });
      initSessionStore();
      // 真实事件序:底座 appendMessage 在 message_end 处理内,entry_appended 随其后——
      // messageEnd 先把 user 消息转正(保留临时 uuid 与徽章),entryAppended 的 id 水合
      // 因消息不再 anchorable 而失败(既有 warn),persist 走内容双轨兜底。
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      onEvent!({ type: "messageEnd", message: { role: "user", content: FULL_TEXT } });
      onEvent!({ type: "entryAppended", entry });
      warnSpy.mockRestore();

      // 写环:真实文件头行必须出现 echoAttachments 域,键是权威 entryId。
      // 写入是 fire-and-forget(设计语义),真实目录锁+fs 落盘需要等异步完成再断言。
      await vi.waitFor(() => {
        const headLine = JSON.parse(readFileSync(file, "utf-8").split("\n")[0]) as Record<string, never>;
        const custom = headLine["custom-pi-desktop"] as Record<string, Record<string, EchoAttachment[]>> | undefined;
        expect(custom?.echoAttachments?.["e-real"]).toEqual([badge]);
      });

      // 读环:真实 readSession 重扫 + openSession 回贴,消息必须带徽章
      useSessionStore.setState({ messages: [] });
      const ok = await useSessionStore.getState().openSession(file);
      expect(ok).toBe(true);
      const msgs = useSessionStore.getState().messages;
      const user = msgs.find((m) => m.role === "user");
      expect(user?.id).toBe("e-real");
      expect((user as { echoAttachments?: EchoAttachment[] }).echoAttachments).toEqual([badge]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
