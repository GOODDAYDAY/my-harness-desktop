// minimal 裸跑（脱离 desktop）验收 —— 内核本体自足性的最低那条线。
//
// 依据 docs/design/minimal-kernel.md §2.1.1 / §2.1.2 / §2.10.1：
//   「minimal 是一个独立内核，不是 desktop 的附属物」；「`echo '{"type":"send","text":"你好"}' | minimal`
//   就能喂一条」；「在干净的机器上只装 minimal，配好模型，从命令行完整地聊完一轮、关掉、再打开续聊」。
//
// 此前这条验收线**跑不起来**：CLI 把 `--session` 当必填，不给就在第一次用到会话路径时抛
// 「minimal 未绑定会话」——文档承诺的裸跑形态根本不存在，而没有守卫，谁也不会发现。
// 本文件用真实 spawn 钉住三件事：
//   ① 不给 `--session` 也能跑（喂一条命令就出事件流、就落盘）；
//   ② 默认会话 id **由 cwd 确定性派生**：同一个项目跑第二次**续写同一个文件**（"关掉再打开续聊"）；
//   ③ 不同 cwd 落不同文件（会话按项目分桶，不串味）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const CLI_PATH = resolve(process.cwd(), "src/server/kernel/minimal/kernel/minimal-cli.mjs");

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-standalone-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

/** 裸跑一次：把 JSONL 命令喂给 minimal cli 的 stdin，收 stdout 上的全部事件。 */
function runBare(cwd: string, commands: object[]): Promise<{ events: Record<string, unknown>[] }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, "--agent-dir", agentDir, "--cwd", cwd], { stdio: ["pipe", "pipe", "pipe"] });
    const events: Record<string, unknown>[] = [];
    let buf = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch { /* 半行/坏行跳过 */ }
      }
    });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
    const done = (): void => {
      // 喂完命令关 stdin，进程 end → exit 0；等退出后再断言，避免读到半截事件流。
      child.stdin.end();
    };
    child.on("exit", () => {
      if (events.length === 0 && stderr) reject(new Error(`裸跑无任何事件输出，stderr: ${stderr.slice(0, 300)}`));
      else resolvePromise({ events });
    });
    child.on("error", reject);
    for (const c of commands) child.stdin.write(`${JSON.stringify(c)}\n`);
    // 等 agentSettled（回合收敛）再关 stdin：单线执行器，settled 之后不会再有本回合事件。
    const waitSettled = setInterval(() => {
      if (events.some((e) => e["type"] === "agentSettled")) {
        clearInterval(waitSettled);
        done();
      }
    }, 50);
    setTimeout(() => { clearInterval(waitSettled); done(); }, 8000);
  });
}

const sessionFiles = (): string[] =>
  existsSync(join(agentDir, "sessions"))
    ? readdirSync(join(agentDir, "sessions"), { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"))
    : [];

describe("minimal 裸跑（无 desktop、无 --session）", () => {
  it("`echo '{type:send}' | minimal`：不给 --session 也能跑出事件流并落盘", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minimal-bare-cwd-"));
    const { events } = await runBare(cwd, [{ type: "send", text: "你好" }]);
    const types = events.map((e) => e["type"]);
    expect(types, "裸跑必须产出回合边界事件").toContain("agentStart");
    expect(types).toContain("agentSettled");
    expect(types, "裸跑也要走真流式（messageStart/Update/End 三态）").toContain("messageEnd");
    expect(sessionFiles().length, "裸跑必须落盘会话文件（独立内核不能只活在内存里）").toBeGreaterThan(0);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("同一个 cwd 跑两次 = 续写同一个会话文件（『关掉再打开续聊』的物理前提）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minimal-bare-resume-"));
    await runBare(cwd, [{ type: "send", text: "第一轮" }]);
    const after1 = sessionFiles();
    expect(after1).toHaveLength(1);
    const first = readFileSync(join(agentDir, "sessions", after1[0]), "utf-8");

    await runBare(cwd, [{ type: "send", text: "第二轮" }]);
    const after2 = sessionFiles();
    expect(after2, "默认会话 id 必须由 cwd 确定性派生——随机 id 会让每次裸跑都开新会话").toHaveLength(1);
    const second = readFileSync(join(agentDir, "sessions", after2[0]), "utf-8");
    expect(second.startsWith(first), "第二次必须是同一文件的续写（旧内容原样在前）").toBe(true);
    expect(second.length).toBeGreaterThan(first.length);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("不同 cwd = 不同会话文件（按项目分桶，不串味）", async () => {
    const cwdA = mkdtempSync(join(tmpdir(), "minimal-bare-a-"));
    const cwdB = mkdtempSync(join(tmpdir(), "minimal-bare-b-"));
    await runBare(cwdA, [{ type: "send", text: "A" }]);
    await runBare(cwdB, [{ type: "send", text: "B" }]);
    expect(sessionFiles()).toHaveLength(2);
    rmSync(cwdA, { recursive: true, force: true });
    rmSync(cwdB, { recursive: true, force: true });
  });
});
