// 一套壳中立 session 协议 → 两个内核各自转录/翻译的契约一致性测试(§7.6 适配器翻译)。
//
// 这是「换内核 = 换投影实现,中立会话层一行不动」的可执行验收:
//  - 同一份中立输入(NeutralEntry[] = 一条 lineage 的完整线性内容)同时喂给 pi 和 dsh 的
//    seed 转录函数;
//  - pi 投成 JSONL 文件(piSeedSession,pi 的存储形态);
//  - dsh 投成 NeutralSessionWire 树(buildDshSeedSession,dsh 的 session/seed wire 形态);
//  - 两边的会话标识都派生自 lineageId(pi=派生文件路径,dsh=sessionId 直接取 lineageId),幂等。
//
// 不启动任何内核子进程:piSeedSession 是纯文件写、buildDshSeedSession 是纯函数。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NeutralEntry, NeutralSessionHeader } from "@my-harness-desktop/shared";
import { piSeedSession } from "./pi/backend/pi-backend";
import { buildDshSeedSession } from "./dsh/backend/dsh-backend";

/** 一条 canonical 中立输入:user / assistant(thinking+text+toolCall)/ toolResult 三连,
 *  外加一条带 display 的条目——两边转录函数都必须正确消费它。 */
const header: NeutralSessionHeader = { kernel: "pi", cwd: "/proj", createdAt: "2025-01-01T00:00:00.000Z" };
const canonical: NeutralEntry[] = [
  { neutralEntryId: "root:0", kernelEntryId: "km0", message: { role: "user", content: "算一下 1+1" } },
  {
    neutralEntryId: "root:1",
    kernelEntryId: "km1",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "简单加法" },
        { type: "text", text: "2" },
        { type: "toolCall", id: "call-1", name: "bash", args: "{\"command\":\"echo 2\"}" },
      ],
    },
    display: { image: { src: "sticker.png" } }, // 展示元数据:永不应进内核投影
  },
  {
    neutralEntryId: "root:2",
    kernelEntryId: "km2",
    message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "2" },
  },
];

describe("一套壳协议 → pi/dsh 各自转录(seed 投影契约一致性)", () => {
  let agentDir: string;
  beforeEach(() => { agentDir = mkdtempSync(join(tmpdir(), "seed-transcription-")); });
  afterEach(() => { rmSync(agentDir, { recursive: true, force: true }); });

  it("pi 转录:线性 NeutralEntry[] → JSONL(头行 + message 行 + parentId 链,保真 role/content/tool)", async () => {
    const path = await piSeedSession(agentDir, "/proj", canonical, { lineageId: "root", header });
    // pi 会话标识派生自 lineageId:文件 basename = lineageId(幂等 seed 同路径)
    expect(path.endsWith("/root.jsonl")).toBe(true);

    const lines = readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].type).toBe("session");
    expect(lines[0].cwd).toBe("/proj");
    expect(lines[0]["custom-my-harness-desktop"].kernel).toBe("pi");

    expect(lines).toHaveLength(4); // 头行 + user + assistant + toolResult
    expect(lines[1].message.role).toBe("user");
    expect(lines[1].message.content).toBe("算一下 1+1");

    expect(lines[2].message.role).toBe("assistant");
    // pi 原样搬 content 块数组(thinking/text/toolCall 不丢)
    expect(Array.isArray(lines[2].message.content)).toBe(true);
    expect(lines[2].message.content.map((b: { type: string }) => b.type)).toEqual(["thinking", "text", "toolCall"]);
    expect(lines[2].parentId).toBe("km0"); // parentId 链挂前一条(复用 kernelEntryId)

    expect(lines[3].message.role).toBe("toolResult");
    expect(lines[3].message.toolName).toBe("bash");
    expect(lines[3].message.toolCallId).toBe("call-1");
    expect(lines[3].parentId).toBe("km1");
  });

  it("dsh 转录:线性 NeutralEntry[] → 单 lineage 树(fork=null),剥离 display,sessionId 派生自 lineageId", () => {
    const s = buildDshSeedSession(canonical, { neutralSessionId: "ns-1", lineageId: "root", header });

    expect(s.neutralSessionId).toBe("ns-1");
    expect(s.header).toEqual(header);
    expect(s.lineages).toHaveLength(1);
    expect(s.lineages[0]).toMatchObject({ lineageId: "root", fork: null });
    expect(s.lineages[0].entries).toHaveLength(3);

    // 条目保真:role 顺序一致;display(展示元数据)被剥离,不进内核投影
    expect(s.lineages[0].entries.map((e) => e.message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(s.lineages[0].entries[1]).not.toHaveProperty("display");
    expect(s.lineages[0].entries[1].message.content).toEqual(canonical[1].message.content);
  });

  it("两边转录互不依赖:同一中立输入,pi 写文件、dsh 出树,谁都不 mutate 中立输入", async () => {
    const snapshot = JSON.parse(JSON.stringify(canonical)); // 深拷贝作基线
    await piSeedSession(agentDir, "/proj", canonical, { lineageId: "root", header });
    buildDshSeedSession(canonical, { neutralSessionId: "ns-1", lineageId: "root", header });
    expect(canonical).toEqual(snapshot); // 两个转录函数都是纯函数,不改中立输入
    expect(canonical[1].display).toEqual({ image: { src: "sticker.png" } }); // display 仍在原始中立输入上
  });
});
