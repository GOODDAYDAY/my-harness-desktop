// minimal 模型面测试 —— 读清单(与 CLI 同源) + **写面真落盘**(§7.9.3 禁「伪造成功」)。
//
// 依据 docs/design/minimal-kernel.md §4.9（配置与凭证分开存）/ §4.9.2（apiKey 唯一入口是
// KernelModelsApi.set）/ §7.9.3（桩不许伪造成功）/ §3.2.3（原子写）。
//
// 本文件锁的三条不变式（此前全是洞）:
//   ① 写面真的落盘 —— set/remove/rename/setDefault/saveConfig 之后，**重新读文件**要能读回。
//      此前这些方法返空数组/回显入参，设置页点保存看着成功、盘上什么都没变。
//   ② apiKey 不落 models.json，只落凭证文件 —— 配置与凭证分离（§4.9.1）。
//   ③ 无配置就空清单，不编造占位模型 —— 只读面也不许编。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinimalConfigSource } from "./minimal-config-source";
import { MinimalModelSource, MinimalModelsApi } from "./minimal-models";

let agentDir: string;
let src: MinimalConfigSource;
let api: MinimalModelsApi;

/** 直接读盘上的 models.json（不经适配器）——用来验「真的写进去了」。 */
const modelsFile = (): { providers: { id: string; baseURL: string; models: { id: string; name?: string }[]; apiKey?: string }[]; default?: { provider: string; model: string } } =>
  JSON.parse(readFileSync(join(agentDir, "models.json"), "utf-8"));
const credFile = (): Record<string, string> => JSON.parse(readFileSync(join(agentDir, ".credentials.json"), "utf-8"));

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "minimal-src-"));
  src = new MinimalConfigSource(agentDir);
  api = new MinimalModelsApi(src, () => Promise.resolve({ ok: true }));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("MinimalModelSource（读清单，与内核子进程同源）", () => {
  it("读真 models.json 清单(kernel 标 minimal)", () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: [{ id: "acme", baseURL: "https://x/v1", models: [{ id: "m1", name: "Mock 1" }, { id: "m2" }] }],
      default: { provider: "acme", model: "m1" },
    }));
    const models = new MinimalModelSource(src).listModels();
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ kernel: "minimal", provider: "acme", id: "m1", name: "Mock 1" });
    expect(models[1]).toMatchObject({ kernel: "minimal", provider: "acme", id: "m2", name: "m2" }); // name 缺省回 id
  });

  it("零配置 = 内置 offline provider `echo`（§4.9.1b 裁决，不是编造项）", () => {
    // 这条曾判为"编造项"（文档没表态、代码一直有）。裁决见 minimal-kernel.md §4.9.1b：
    // 它是内核的一等 offline 行为，不是任何外部模型的替身——模型 id 就叫 echo。
    // 守卫它的**存在**，因为在 4.9.1b 落地前它正是"下一轮被当成 bug 删掉"的高危项，
    // 而删掉会同时打断「零配置也能跑通一轮」的独立内核底线与唯一的零 token e2e 通路。
    expect(new MinimalModelSource(src).listModels()).toEqual([
      { kernel: "minimal", provider: "minimal", id: "echo", name: "Minimal Echo" },
    ]);
  });

  it("配了 provider 就不再出现 echo（回落只在一个都没配时生效）", async () => {
    await api.set("acme", { baseUrl: "https://x/v1", models: [{ id: "m1", name: "M1" }] });
    expect(new MinimalModelSource(src).listModels().map((m) => m.id)).toEqual(["m1"]);
  });

  it("配置损坏 = 回落内置 offline（读不回不致命，但不能处于「发不出消息」的半死态）", () => {
    writeFileSync(join(agentDir, "models.json"), "{ 不是 JSON");
    expect(new MinimalModelSource(src).listModels()).toEqual([
      { kernel: "minimal", provider: "minimal", id: "echo", name: "Minimal Echo" },
    ]);
  });
});

describe("MinimalModelsApi 写面必须真落盘（§7.9.3 禁伪造成功）", () => {
  it("set → 重读文件读得回（此前返空数组、盘上无变化）", async () => {
    const after = await api.set("acme", { baseUrl: "https://api.acme/v1", apiKey: "sk-1", models: [{ id: "m1", name: "M1" }] });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: "acme", baseUrl: "https://api.acme/v1", apiKey: "sk-1" });
    // 盘上确认（不经适配器）
    const disk = modelsFile();
    expect(disk.providers).toHaveLength(1);
    expect(disk.providers[0]).toMatchObject({ id: "acme", baseURL: "https://api.acme/v1" });
    expect(disk.providers[0].models).toEqual([{ id: "m1", name: "M1" }]);
  });

  it("apiKey 只落凭证文件，models.json 里不留明文（§4.9.1）", async () => {
    await api.set("acme", { baseUrl: "https://api.acme/v1", apiKey: "sk-secret", models: [{ id: "m1", name: "m1" }] });
    expect(credFile()).toEqual({ acme: "sk-secret" });
    expect(modelsFile().providers[0].apiKey).toBeUndefined();
    expect(readFileSync(join(agentDir, "models.json"), "utf-8")).not.toContain("sk-secret");
  });

  it("凭证文件权限收到 0600（密钥不该世界可读）", async () => {
    await api.set("acme", { baseUrl: "https://x/v1", apiKey: "sk-secret", models: [{ id: "m1", name: "m1" }] });
    if (process.platform !== "win32") {
      expect(statSync(join(agentDir, ".credentials.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("setDefault 落盘（此前返回入参却不落盘，刷新即丢）", async () => {
    await api.set("acme", { baseUrl: "https://x/v1", models: [{ id: "m1", name: "m1" }] });
    const got = await api.setDefault({ provider: "acme", model: "m1" });
    expect(got).toEqual({ provider: "acme", model: "m1" });
    expect(modelsFile().default).toEqual({ provider: "acme", model: "m1" });
    expect(await api.getDefault()).toEqual({ provider: "acme", model: "m1" });
  });

  it("remove 清掉 provider + 凭证 + 指向它的悬空 default", async () => {
    await api.set("acme", { baseUrl: "https://x/v1", apiKey: "k", models: [{ id: "m1", name: "m1" }] });
    await api.setDefault({ provider: "acme", model: "m1" });
    const after = await api.remove("acme");
    expect(after).toEqual([]);
    expect(modelsFile().providers).toEqual([]);
    expect(modelsFile().default).toBeUndefined(); // 不留指向已删 provider 的指针
    expect(credFile()).toEqual({});                 // 不留已删 provider 的密钥
  });

  it("rename 迁移 provider 记录 + default 指针 + 凭证 ref 三处", async () => {
    await api.set("old", { baseUrl: "https://x/v1", apiKey: "k", models: [{ id: "m1", name: "m1" }] });
    await api.setDefault({ provider: "old", model: "m1" });
    await api.rename("old", "new");
    expect(modelsFile().providers.map((p) => p.id)).toEqual(["new"]);
    expect(modelsFile().default).toEqual({ provider: "new", model: "m1" });
    expect(credFile()).toEqual({ new: "k" });
    expect(await api.test("", "new", "m1")).toEqual({ ok: true }); // testModel 走壳注入的通道
  });

  it("saveConfig 全量 reconcile：删缺 + 增改 + 清默认，返回**盘上真值**", async () => {
    await api.set("gone", { baseUrl: "https://x/v1", models: [{ id: "x", name: "x" }] });
    await api.setDefault({ provider: "gone", model: "x" });
    const result = await api.saveConfig({
      providers: [{ id: "kept", baseUrl: "https://y/v1", apiKey: "k2", models: [{ id: "m2", name: "M2" }] }],
      default: null,
    });
    expect(result.providers.map((p) => p.id)).toEqual(["kept"]);
    expect(result.default).toBeNull();
    // 此前返回 {providers:[],default:null} 的字面值——既没落盘、也不是盘上真值
    expect(modelsFile().providers.map((p) => p.id)).toEqual(["kept"]);
    expect(modelsFile().default).toBeUndefined();
    expect(credFile()).toEqual({ kept: "k2" });
  });

  it("readConfig 与 list 同源（读面不另起一份解析）", async () => {
    await api.set("acme", { baseUrl: "https://x/v1", apiKey: "k", models: [{ id: "m1", name: "m1" }] });
    const cfg = await api.readConfig();
    expect(cfg.providers).toEqual(await api.list());
  });
});

describe("最小写面 —— 原子写（§3.2.3 半截 JSON 不得出现）", () => {
  it("写入后目录里不留 .tmp 残骸", async () => {
    await api.set("acme", { baseUrl: "https://x/v1", models: [{ id: "m1", name: "m1" }] });
    expect(readdirSync(agentDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("写失败不留半截文件、不破坏旧内容、不留 .tmp 残骸", () => {
    src.writeConfig({ keep: "old" });
    // 用不可序列化的值触发抛错（序列化发生在 touch 目标文件之前）
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => src.writeConfig(circular)).toThrow();
    // 旧内容原样（不是被截断成空/半截）
    expect(src.readConfig()).toEqual({ keep: "old" });
    expect(readdirSync(agentDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("MinimalConfigSource.migratePlaintextApiKeys（legacy 明文迁进凭证库）", () => {
  it("把 models.json 里的明文 apiKey 搬进凭证文件并抹掉明文", () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: [{ id: "legacy", baseURL: "https://x/v1", apiKey: "sk-plain", models: [{ id: "m1", name: "m1" }] }],
    }));
    expect(src.migratePlaintextApiKeys()).toBe(true);
    expect(credFile()).toEqual({ legacy: "sk-plain" });
    expect(readFileSync(join(agentDir, "models.json"), "utf-8")).not.toContain("sk-plain");
    expect(modelsFile().providers[0].apiKey).toBeUndefined();
  });

  it("幂等：再跑一次不改变任何东西（第二次返回 false）", () => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: [{ id: "legacy", baseURL: "https://x/v1", apiKey: "sk-plain", models: [{ id: "m1", name: "m1" }] }],
    }));
    src.migratePlaintextApiKeys();
    const snapshot = readFileSync(join(agentDir, "models.json"), "utf-8");
    expect(src.migratePlaintextApiKeys()).toBe(false);
    expect(readFileSync(join(agentDir, "models.json"), "utf-8")).toBe(snapshot);
  });
});
