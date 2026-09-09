// minimal 插件系统测试 —— 插件目录扫描 + registerTool 进注册表 + listTools 可见。
//
// 依据 docs/design/minimal-kernel.md §6。验「插件系统是独立模块」:插件 .mjs 导出的
// register(host) 经目录扫描加载,注册的工具进内核注册表(与内置同构,§5.9.2)。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMinimalSubprocess } from "./subprocess-lifecycle";
import { MinimalTransport, type MinimalEvent } from "./minimal-transport";

const CLI_PATH = resolve(process.cwd(), "src/server/kernel/minimal/kernel/minimal-cli.mjs");

let agentDir: string;
let cwd: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-plug-"));
  cwd = mkdtempSync(join(tmpdir(), "minimal-plug-proj-"));
  // 种两个插件:grep.mjs 注册工具;lifecycle.mjs 订阅 agentSettled 写标记文件。
  const pluginsDir = join(agentDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(join(pluginsDir, "grep.mjs"), `
export async function register(host) {
  host.registerTool(
    { name: "grep", description: "搜索内容", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
    (args) => ({ matches: ["命中" + args.pattern] }),
  );
}
`, "utf-8");
  writeFileSync(join(pluginsDir, "lifecycle.mjs"), `
import { writeFileSync } from "node:fs";
export async function register(host) {
  host.on("agentSettled", (payload) => {
    writeFileSync("plugin-settled.txt", JSON.stringify(payload), "utf-8");
  });
  host.registerCommand("customGreet", (args) => {
    writeFileSync("plugin-greet.txt", "hello " + (args.name ?? "world"), "utf-8");
  });
}
`, "utf-8");
  writeFileSync(join(pluginsDir, "config.mjs"), `
import { writeFileSync } from "node:fs";
export async function register(host) {
  const cfg = host.getConfig();
  writeFileSync("plugin-cfg.txt", "greeting=" + (cfg.greeting ?? "none"), "utf-8");
}
`, "utf-8");
  writeFileSync(join(pluginsDir, "config.config.json"), JSON.stringify({ greeting: "你好" }), "utf-8");
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** 事件驱动等文件写穿(§3.6 不 sleep):轮询读到非空内容才返回,超时抛错。插件 handler 在
 *  CLI 进程内写标记,写盘时机与 stdout 事件异步;existsSync 会撞上"文件已建、内容未写"
 *  的空文件窗口(曾 flaky),须读到非空内容才算就绪。 */
async function readFileWhenReady(path: string, timeoutMs = 3000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = readFileSync(path, "utf-8");
      if (content.length > 0) return content;
    } catch { /* 文件还没写完,重试 */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`文件超时未写穿: ${path}`);
}

describe("minimal 插件系统", () => {
  it("插件注册的工具进注册表,listTools 可见", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-plug" });
    const t = new MinimalTransport(handle);
    t.start();
    const resp = await t.request<MinimalEvent & { tools: { name: string }[] }>({ type: "listTools" }, "tools");
    const names = resp.tools.map((x) => x.name);
    expect(names).toContain("grep"); // 插件工具
    expect(names).toContain("read"); // 内置工具仍在
    await t.stop();
  });

  it("插件 on(agentSettled) 在回合结束后被分发(§6.3.2)", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-plug2" });
    const t = new MinimalTransport(handle);
    const settled = new Promise<void>((resolve) => {
      t.onEvent((e) => { if (e.type === "agentSettled") resolve(); });
    });
    t.start();
    t.send({ type: "send", text: "hi" });
    await settled;
    // 插件 handler 在 CLI 进程内写标记(相对 CLI cwd = 测试 cwd)。
    const marker = join(cwd, "plugin-settled.txt");
    const payload = JSON.parse(await readFileWhenReady(marker));
    expect(payload.reason).toBe("completed");
    await t.stop();
  });

  it("插件 registerCommand 注册的命令被 CLI 分发(§6.3.2)", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-plug3" });
    const t = new MinimalTransport(handle);
    t.start();
    t.send({ type: "customGreet", name: "minimal" });
    // 插件 handler 写标记(相对 CLI cwd = 测试 cwd)。
    const marker = join(cwd, "plugin-greet.txt");
    expect(await readFileWhenReady(marker)).toBe("hello minimal");
    await t.stop();
  });

  it("插件 getConfig 读自己的配置文件(§6.10)", async () => {
    const handle = createMinimalSubprocess({ cliPath: CLI_PATH, agentDir, cwd, sessionId: "ns-plug4" });
    const t = new MinimalTransport(handle);
    t.start();
    await t.request<MinimalEvent>({ type: "ping" }, "pong");
    const marker = join(cwd, "plugin-cfg.txt");
    expect(await readFileWhenReady(marker)).toBe("greeting=你好"); // 读到了 <agentDir>/plugins/config.config.json
    await t.stop();
  });
});
