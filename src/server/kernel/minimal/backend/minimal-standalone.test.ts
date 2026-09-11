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

describe("单线执行器的并发与原子写(§9.8.2 / §3.2.3)", () => {
  it("并发 send：第二条被显式拒绝为 busy（不排队、不静默丢弃）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minimal-busy-"));
    // 一次把两条 send 灌进 stdin：单线执行器同一时刻只能跑一条回合。
    const { events } = await runBare(cwd, [
      { type: "send", text: "第一条" },
      { type: "send", text: "第二条" },
    ]);
    const busy = events.filter((e) => e["type"] === "error");
    expect(
      busy.some((e) => e["error"] === "busy"),
      `第二条 send 必须显式回 busy（实际事件：${JSON.stringify(events.map((e) => e["type"]))}）`,
    ).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("并发 send 不写坏会话文件：只有一条回合的条目（此前两条回合交错写同一文件）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minimal-busy-file-"));
    await runBare(cwd, [
      { type: "send", text: "第一条" },
      { type: "send", text: "第二条" },
    ]);
    const files = sessionFiles();
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(agentDir, "sessions", files[0]), "utf-8")
      .split("\n").map((l) => l.trim()).filter(Boolean);
    // 每一行都必须是完整 JSON（半条 = 写坏了）
    const parsed = lines.map((l) => JSON.parse(l));
    const messages = parsed.filter((e) => e.type === "message");
    expect(messages.map((m) => m.message.role)).toEqual(["user", "assistant"]);
    expect(messages[0].message.content).toBe("第一条");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("原子写：反复整文件重写(setModel/setSessionName)后文件始终是完整 JSON，且不留 .tmp 残骸", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minimal-atomic-"));
    await runBare(cwd, [
      { type: "setModel", provider: "minimal", modelId: "echo" },
      { type: "setSessionName", name: "名字一" },
      { type: "setSessionName", name: "名字二" },
      { type: "setTools", tools: "read-only" },
      { type: "send", text: "内容" },
    ]);
    const files = sessionFiles();
    expect(files).toHaveLength(1);
    const raw = readFileSync(join(agentDir, "sessions", files[0]), "utf-8");
    // 每行都是完整 JSON（updateHeader 是整文件重写，非原子时写一半就会留下半条）
    for (const line of raw.split("\n").map((l) => l.trim()).filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // 临时文件不留残骸（rename 成功后 tmp 已不存在）
    const bucket = join(agentDir, "sessions");
    const leftovers = readdirSync(bucket, { recursive: true }).map(String).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("原子写的**机制守卫**：会话文件的所有非追加写都必须经 writeAtomicFile（不许裸 writeFileSync）", () => {
    // 上面那条"文件是完整 JSON"的行为断言**不能**证明原子性——非原子写在没被 kill 时同样产出完整文件，
    // 所以它只是必要条件（实测：把 updateHeader 改回 writeFileSync 它照样绿 = 假守卫）。
    // 真正的判据是**机制**：整文件重写必须先写临时文件再 rename。这里静态检查这一点——
    // 会话文件路径上唯一的 writeFileSync 只允许是 writeAtomicFile 里那次（写 tmp）。
    const src = readFileSync(resolve(process.cwd(), "src/server/kernel/minimal/kernel/minimal-cli.mjs"), "utf-8");
    const calls = [...src.matchAll(/writeFileSync\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    const illegal = calls.filter((target) => target !== "tmp");
    expect(
      illegal,
      `会话文件出现了裸 writeFileSync（目标=${illegal.join(",")}）：整文件重写不是原子的，` +
        `写一半被 kill 会留下半条 JSON（§3.2.3）。请改走 writeAtomicFile。`,
    ).toEqual([]);
    expect(calls, "writeAtomicFile 的 tmp 写不见了——原子写机制被整体删除？").toContain("tmp");
  });
});

describe("协议命令全覆盖：每条命令都不许产出 error 事件", () => {
  // 为什么要有这一条（它抓的是真事，不是"以防万一"）：
  // CLI 的主循环把命令处理包在 try/catch 里，任何异常都会被转成一个 `{type:"error"}` 事件
  // 发给壳 —— 于是**命令处理器里的运行时错误在协议层表现为"多了一条 error 事件"**，
  // 而按语义写的守卫（如 abort 只断言"消息带 stopped"）完全看不到它。
  // 实测踩过一次：`aborted = true` 指向一个已被删除的变量（ESM 严格模式 → ReferenceError），
  // 每次 abort 都多发一个 error 事件，而 abort 守卫一路绿。
  // 这条守卫的作用是**覆盖整个命令面**：加新命令时忘了声明变量、写错字段、路径算错，
  // 都会在这里当场现形，不需要为每条命令各写一个"它不炸"的断言。
  it("ping/abort/setModel/setSessionName/setTools/listTools/getTree/getEntries/seed 全部无 error 事件", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "minimal-cmds-"));
    const { events } = await runBare(cwd, [
      { type: "ping" },
      { type: "abort" },
      { type: "setModel", provider: "minimal", modelId: "echo" },
      { type: "setSessionName", name: "命令覆盖" },
      { type: "setTools", tools: "write" },
      { type: "listTools" },
      { type: "getTree" },
      { type: "getEntries" },
      { type: "setTools", tools: "read-only" },
      { type: "send", text: "收尾" },
    ]);
    const errors = events.filter((e) => e["type"] === "error");
    expect(
      errors,
      `有命令产出了 error 事件（说明某个处理器抛了异常，或命令名/字段对不上）：${JSON.stringify(errors)}`,
    ).toEqual([]);
    // 正向证据：真收到了这些命令的应答（不是"什么都没跑所以没报错"）
    const types = events.map((e) => e["type"]);
    for (const t of ["pong", "tools", "tree", "entries", "agentSettled"]) {
      expect(types, `缺少 ${t} 的应答——命令面没真跑起来`).toContain(t);
    }
    rmSync(cwd, { recursive: true, force: true });
  });
});
