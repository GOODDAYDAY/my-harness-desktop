// **dsh SDK 方法面补全的真机验证** —— 起真实的**瘦版** dsh 运行时（npm 发布版，原生只有
// initialize / session/prompt / shutdown 三个 request 方法），装上本仓的 cordis 适配插件，
// 逐条打通桌面所需的 16 个 session/* 方法。
//
// 为什么这条测试是补面的直接证据：瘦版原生**没有** session/seed / getTree / rename / …
// 任何一条通过，都只可能是补面在起作用。它不花真 token（seed/getTree/getEntries/rename
// 全是本地操作，不发 LLM 请求），所以可以常态跑，不像 dsh-backend.integration.test.ts 要 API key。
//
// 环境隔离（不碰用户的 ~/.dsh）：把扩展源码 cpSync 到临时目录，临时目录的 node_modules
// 符号链接到**瘦版安装目录**的 node_modules → 插件的 bare import 解析到瘦版副本，
// 而 CLI 也在同一份 node_modules 里，两侧同源（不制造假的双副本，也不依赖用户环境状态）。
//
// 跳过条件：瘦版内核未安装（无 CLI / 无 node_modules）→ 显式跳过，不伪造成功。
// 真机运行：`npx vitest run src/server/kernel/dsh/extension/dsh-sdk-supplement.integration.test.ts`
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_SRC = join(HERE, "dsh-extension");

/** 生产安装目录（瘦版 npm 运行时；`KernelManager` 的数据根）。 */
const INSTALL_DIR = join(homedir(), ".my-harness-desktop", "dsh");
const CLI = join(INSTALL_DIR, "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-demo", "lib", "bin.js");
const RUNTIME_MODULES = join(INSTALL_DIR, "node_modules");

const available = existsSync(CLI) && existsSync(RUNTIME_MODULES);

describe.skipIf(!available)("dsh SDK 方法面补全（真机瘦版运行时）", () => {
  let workDir = "";
  let child: ChildProcessWithoutNullStreams | null = null;
  let idc = 0;
  const pending = new Map<number, (frame: any) => void>();
  let stdoutBuf = "";
  const notifications: any[] = [];

  /** JSON-RPC 请求；返回原始帧（result 或 error 都可能存在，含 result:null）。 */
  const rpc = (method: string, params?: unknown, timeout = 30_000): Promise<any> =>
    new Promise((res, rej) => {
      if (!child) return rej(new Error("进程未起"));
      const id = ++idc;
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(`RPC 超时: ${method}`)); }, timeout);
      pending.set(id, (frame) => { clearTimeout(timer); res(frame); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "dsh-supplement-"));
    // 插件目录：cpSync 仓库源码（测的就是仓库里那份，不是历史同步残留）
    const pluginDir = join(workDir, "plugins", "my-harness-fit-dsh-extension");
    cpSync(EXTENSION_SRC, pluginDir, { recursive: true });
    // node_modules 符号链接到瘦版安装目录 → bare import 解析到瘦版副本
    symlinkSync(RUNTIME_MODULES, join(workDir, "node_modules"), "dir");

    // 最小 cordis.yml：只保留补面所需的运行时组合（去掉用户的 goal/llm-recorder/skills 配置）
    writeFileSync(join(workDir, "cordis.yml"), [
      "- id: sdk-jsonrpc-server",
      "  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'",
      "- id: agent-core",
      "  name: '@deepseek-ai/dsh-agent-spine-demo'",
      "  config:",
      "    workspaceContext:",
      "      maxBytes: 65536",
      "    skills:",
      "      filesystem:",
      "        providerName: filesystem-builtin",
      "        includeDefaultRoots: false",
      "- id: llm-deepseek",
      "  name: '@deepseek-ai/dsh-llm-deepseek'",
      "- id: settings-file",
      "  name: '@deepseek-ai/dsh-settings-file'",
      "- id: llm-pi-ai",
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      "- id: sessions",
      "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      "  config:",
      `    root: '${join(workDir, ".sessions")}'`,
      "    compression: 'none'",
      "    packChunks: false",
      "- id: session-checkpoints",
      "  name: '@deepseek-ai/dsh-session-checkpoint-policy'",
      "- id: subprocess",
      "  name: '@deepseek-ai/dsh-subprocess-local'",
      "- id: bash",
      "  name: '@deepseek-ai/dsh-bash-local'",
      "- id: fs-local",
      "  name: '@deepseek-ai/dsh-fs-local'",
      "- id: credentials-local",
      "  name: '@deepseek-ai/dsh-credentials-local'",
      // fit 插件用**绝对路径**挂载（相对路径相对 cordis.yml 解析，此处两者同目录，绝对更明确）
      "- id: my-harness-fit-dsh-extension",
      `  name: '${join(pluginDir, "index.mjs")}'`,
      "",
    ].join("\n"));

    child = spawn("node", [CLI, join(workDir, "cordis.yml")], {
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DSH_SESSION_ROOT: join(workDir, ".sessions"), DSH_HOME: workDir },
    }) as ChildProcessWithoutNullStreams;

    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("exit", (code) => {
      if (stderr.trim()) console.error(`[dsh 瘦版运行时 exit=${code}] ${stderr.slice(0, 2000)}`);
    });
    child.stdout.on("data", (d: Buffer) => {
      stdoutBuf += d.toString();
      let i: number;
      while ((i = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, i);
        stdoutBuf = stdoutBuf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          if (frame.id !== undefined && pending.has(frame.id)) { pending.get(frame.id)!(frame); pending.delete(frame.id); }
          else if (frame.method) notifications.push(frame);
        } catch { /* 非协议行忽略 */ }
      }
    });

    // 等插件树装载（fit 插件的 apply 里 await 安装补面；给足时间，不赌固定短延迟）
    await wait(8_000);
    const init = await rpc("initialize", { cwd: workDir, provider: "deepseek-official", model: "deepseek-official" });
    expect(init.result?.serverInfo?.name, "initialize 握手失败（插件树可能没装载起来，看 stderr）").toBe("deepseek-harness-sdk-runtime");
  }, 60_000);

  afterAll(async () => {
    try { child?.kill("SIGTERM"); } catch { /* 已退出 */ }
    await wait(500);
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不致命 */ }
  });

  /** 中立条目构造（seed 的输入形状）。 */
  const entry = (i: number, role: string, text: string) => ({
    neutralEntryId: `e${i}`,
    message: { role, content: [{ type: "text", text }] },
  });

  it("原生运行时确实只有 3 个 request 方法（测试前提：否则本测试证明不了补面在起作用）", async () => {
    const src = readFileSync(join(RUNTIME_MODULES, "@deepseek-ai", "dsh-sdk-jsonrpc-server", "lib", "index.js"), "utf8");
    const cases = [...src.matchAll(/case "([a-z]+\/[a-zA-Z]+|initialize|shutdown)"/g)].map((m) => m[1]);
    // 瘦版实测为 initialize / session/prompt / shutdown。若上游哪天真发了全量方法面，
    // 这条会失败——那时补面应按 preferNative 退役，本测试的断言口径要一并更新。
    expect(cases.length, `原生方法面已变化（${cases.join(", ")}），补面的退役条件到了，见设计文档 §4.6`).toBeLessThanOrEqual(3);
    expect(cases).not.toContain("session/seed");
  });

  it("seed：线性中立 lineage 灌进内核，返回同一 sessionId", async () => {
    const res = await rpc("session/seed", {
      sessionId: "supplement-seed",
      session: {
        neutralSessionId: "supplement-seed",
        header: { kernel: "dsh", cwd: workDir, createdAt: new Date().toISOString() },
        lineages: [{
          lineageId: "supplement-seed",
          fork: null,
          entries: [entry(1, "user", "第一句"), entry(2, "assistant", "第一答"), entry(3, "user", "第二句"), entry(4, "assistant", "第二答")],
        }],
      },
    });
    expect(res.error, JSON.stringify(res.error)).toBeUndefined();
    expect(res.result?.sessionId).toBe("supplement-seed");
  }, 40_000);

  it("getEntries：seed 的历史被忠实回放（同角色序列，不是空会话）", async () => {
    const res = await rpc("session/getEntries", { lineageId: "supplement-seed" });
    expect(res.error, JSON.stringify(res.error)).toBeUndefined();
    expect(res.result.map((m: any) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // 内容也在（不只是角色对得上）
    const first = res.result[0];
    expect(JSON.stringify(first.content)).toContain("第一句");
  }, 40_000);

  it("getTree：根 lineage 成树", async () => {
    const res = await rpc("session/getTree", { sessionId: "supplement-seed" });
    expect(res.error, JSON.stringify(res.error)).toBeUndefined();
    expect(res.result.rootId).toBe("supplement-seed");
    expect(res.result.lineages[0]).toMatchObject({ id: "supplement-seed", fork: null });
  });

  it("bookmark + resume：坐标书签能 fork 出新 lineage，且 fork 关系进 getTree", async () => {
    const bm = await rpc("session/bookmark", { lineageId: "supplement-seed", boundarySeq: 5 });
    expect(bm.error, JSON.stringify(bm.error)).toBeUndefined();
    expect(bm.result).toMatchObject({ lineageId: "supplement-seed", boundary: "5" });

    const rs = await rpc("session/resume", { anchor: { lineageId: "supplement-seed", entryId: "5" } });
    expect(rs.error, JSON.stringify(rs.error)).toBeUndefined();
    const forkedId = rs.result?.lineageId;
    expect(typeof forkedId).toBe("string");
    expect(forkedId).not.toBe("supplement-seed");

    // fork 关系必须能被 getTree 反查到（子会话 header 的 parentSession/seedLength 已落盘）
    const tree = await rpc("session/getTree", { sessionId: "supplement-seed" });
    const lineages = tree.result?.lineages ?? [];
    expect(lineages.length).toBeGreaterThanOrEqual(2);
    expect(lineages.some((l: any) => l.id === forkedId && l.fork?.parentLineageId === "supplement-seed")).toBe(true);

    const del = await rpc("session/deleteBookmark", { anchor: { lineageId: "supplement-seed", entryId: "5" } });
    expect(del.result).toEqual({});
  }, 60_000);

  it("rename + updateHeader + get：元数据 merge 回读（不是 last-write-wins 互相抹掉）", async () => {
    expect((await rpc("session/rename", { sessionId: "supplement-seed", name: "补面测试会话" })).error).toBeUndefined();
    expect((await rpc("session/updateHeader", { sessionId: "supplement-seed", patch: { pinned: true, custom: { goal: "x" } } })).error).toBeUndefined();

    const got = await rpc("session/get", { sessionId: "supplement-seed" });
    expect(got.error, JSON.stringify(got.error)).toBeUndefined();
    // 关键：rename 写的 name 不能被后一次 updateHeader 抹掉（桌面把元数据拆两个写口分别调）
    expect(got.result?.info).toMatchObject({ name: "补面测试会话", pinned: true });
    expect(got.result?.info?.custom).toEqual({ goal: "x" });
    expect(Array.isArray(got.result?.messages)).toBe(true);

    // unknown 会话 → null（不是错误）：目录页读 custom 依赖这个语义
    const missing = await rpc("session/get", { sessionId: "不存在的会话" });
    expect(missing.result).toBeNull();
    expect(missing.error).toBeUndefined();
  }, 40_000);

  it("rename 会广播 session.event 通知（事件驱动，桌面靠它刷新会话名）", () => {
    const metaEvents = notifications.filter((n) => n.method === "session.event" && n.params?.event?.type === "session/meta");
    expect(metaEvents.length).toBeGreaterThan(0);
    expect(metaEvents.some((n) => n.params.event.data?.meta?.name === "补面测试会话")).toBe(true);
  });

  it("list + projectStats：持久化清单与 token 聚合", async () => {
    const list = await rpc("session/list", { cwd: workDir });
    expect(list.error, JSON.stringify(list.error)).toBeUndefined();
    expect(Array.isArray(list.result)).toBe(true);
    expect(list.result.some((s: any) => s.id === "supplement-seed")).toBe(true);

    const stats = await rpc("session/projectStats", { cwd: workDir });
    expect(stats.error, JSON.stringify(stats.error)).toBeUndefined();
    expect(stats.result?.tokens).toMatchObject({ input: expect.any(Number), total: expect.any(Number) });
    expect(stats.result?.cost).toBe(0); // dsh 无成本核算
    expect(stats.result?.turns).toBeGreaterThanOrEqual(2); // seed 灌了 2 条 user
    expect(stats.result?.sessionCount).toBeGreaterThanOrEqual(1);
  }, 40_000);

  it("abort：unknown 会话是 no-op（空闲时 abort 无害），已物化会话不抛", async () => {
    expect((await rpc("session/abort", { sessionId: "不存在的会话" })).result).toEqual({});
    expect((await rpc("session/abort", { sessionId: "supplement-seed" })).result).toEqual({});
  });

  it("setModel / getThinkingLevels：既有强语义接管项仍然生效（收敛进单一 patch 点后的回归）", async () => {
    const sm = await rpc("session/setModel", { sessionId: "supplement-seed", provider: "deepseek-official", model: "deepseek-official" });
    expect(sm.error, JSON.stringify(sm.error)).toBeUndefined();

    const levels = await rpc("session/getThinkingLevels", { sessionId: "supplement-seed" });
    expect(levels.error, JSON.stringify(levels.error)).toBeUndefined();
    expect(Array.isArray(levels.result?.levels)).toBe(true);
  }, 40_000);

  it("delete：live + durable 都清掉（npm 版无 sessions.delete/persistence.delete，自行组合）", async () => {
    expect((await rpc("session/delete", { sessionId: "supplement-seed" })).result).toEqual({});
    // 落盘需要一点时间；用轮询而非固定 sleep 赌时序
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      const list = await rpc("session/list", { cwd: workDir });
      gone = Array.isArray(list.result) && !list.result.some((s: any) => s.id === "supplement-seed");
      if (!gone) await wait(300);
    }
    expect(gone, "delete 后会话仍在 list 里（durable artifact 没清掉）").toBe(true);
    // 删不存在的会话也不抛（幂等）
    expect((await rpc("session/delete", { sessionId: "supplement-seed" })).result).toEqual({});
  }, 60_000);

  it("prompt 带图片：显式报错而非静默丢图（该运行时未挂载 attachment 服务）", async () => {
    const res = await rpc("session/prompt", {
      sessionId: "img-probe",
      contentBlocks: [{ type: "text", text: "看图" }],
      images: [{ data: Buffer.from("hello").toString("base64"), mediaType: "image/png" }],
    });
    // 静默丢图 = 伪造成功（用户以为图发出去了、模型没看到），§1.5 明令禁止。
    expect(res.error, "带图片的 prompt 静默成功了 —— 图片被丢弃而用户无感知").toBeDefined();
    expect(String(res.error?.message)).toContain("attachment");
  }, 40_000);
});
