// dsh-config-source cordis.yml 块编辑测试 —— addPluginBlock / removePluginBlock（dsh 内核插件随附通道的挂摘原语）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DshConfigSource, assertPiAiRouteServiceable } from "./dsh-config-source";
import { parse as parseYaml } from "yaml";

let dir: string;
let cordisPath: string;
let src: DshConfigSource;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-blocks-"));
  cordisPath = join(dir, "cordis.yml");
  src = new DshConfigSource(cordisPath);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("DshConfigSource resolveEntryPath(相对 cordis.yml 目录解析相对路径 entry)", () => {
  it("相对路径 name 解析到 cordis.yml 同目录", () => {
    // cordisPath = <dir>/cordis.yml → 相对 name 落在 <dir> 下
    expect(src.resolveEntryPath("./.my-harness-desktop-plugins/ask/index.mjs"))
      .toBe(join(dir, ".my-harness-desktop-plugins", "ask", "index.mjs"));
  });

  it("npm 包名原样返回(不做路径解析)", () => {
    expect(src.resolveEntryPath("@deepseek-ai/dsh-subagent")).toBe("@deepseek-ai/dsh-subagent");
  });
});

describe("DshConfigSource addPluginBlock / removePluginBlock", () => {
  it("addPluginBlock 追加块", () => {
    writeFileSync(cordisPath, "- id: existing\n  name: './a.mjs'\n");
    src.addPluginBlock("my-harness-desktop-read-claude-md", "./.my-harness-desktop-plugins/read-claude-md/index.mjs");
    const text = readFileSync(cordisPath, "utf8");
    expect(text).toContain("- id: my-harness-desktop-read-claude-md");
    expect(text).toContain("name: './.my-harness-desktop-plugins/read-claude-md/index.mjs'");
  });

  it("addPluginBlock 幂等:同 id 存在则替换 name,不重复追加", () => {
    writeFileSync(cordisPath, "- id: my-harness-desktop-x\n  name: './old.mjs'\n");
    src.addPluginBlock("my-harness-desktop-x", "./new.mjs");
    const text = readFileSync(cordisPath, "utf8");
    expect(text).toContain("name: './new.mjs'");
    expect(text.split("- id: my-harness-desktop-x").length).toBe(2); // 该 id 块只出现一次
  });

  it("removePluginBlock 删除指定块,保留其余", () => {
    writeFileSync(cordisPath, "- id: a\n  name: './a.mjs'\n- id: b\n  name: './b.mjs'\n");
    src.removePluginBlock("b");
    const text = readFileSync(cordisPath, "utf8");
    expect(text).toContain("- id: a");
    expect(text).not.toContain("- id: b");
  });

  it("removePluginBlock 幂等:不存在则 no-op", () => {
    writeFileSync(cordisPath, "- id: a\n  name: './a.mjs'\n");
    src.removePluginBlock("ghost");
    expect(readFileSync(cordisPath, "utf8")).toContain("- id: a");
  });
});

describe("DshConfigSource addPlugin id 冲突防护(根因:重复 loader entry id 致内核启动崩)", () => {
  it("同 id 已被别的包占用 → 抛清晰错误且不写盘", () => {
    writeFileSync(cordisPath, "- id: subprocess\n  name: '@deepseek-ai/dsh-subprocess-local'\n");
    expect(() => src.addPlugin("@deepseek-ai/dsh-subprocess")).toThrow(/已被「@deepseek-ai\/dsh-subprocess-local」占用/);
    // 未被污染:仍只有一条 subprocess 块
    expect(readFileSync(cordisPath, "utf-8").split("- id: subprocess").length).toBe(2);
  });

  it("同 name 已存在 → 幂等跳过,不抛错", () => {
    writeFileSync(cordisPath, "- id: subprocess\n  name: '@deepseek-ai/dsh-subprocess-local'\n");
    expect(() => src.addPlugin("@deepseek-ai/dsh-subprocess-local")).not.toThrow();
    expect(readFileSync(cordisPath, "utf-8").split("- id: subprocess").length).toBe(2);
  });
});

describe("DshConfigSource 凭证服务挂载(根因:凭证库写了没人读 → MISSING_CREDENTIAL)", () => {
  it("DEFAULT_CORDIS_YAML 默认组合含 credentials-local,且在 llm-pi-ai 之前", () => {
    // 首次运行写入路径:缺 cordis.yml 时写默认组合
    const s = new DshConfigSource(cordisPath);
    s.ensureDefaultCordis();
    const text = readFileSync(cordisPath, "utf8");
    expect(text).toContain("- id: credentials-local");
    expect(text).toContain("name: '@deepseek-ai/dsh-credentials-local'");
    // 凭证服务必须先于消费方 llm-pi-ai 挂载
    expect(text.indexOf("credentials-local")).toBeLessThan(text.indexOf("llm-pi-ai"));
  });

  it("ensureCredentialsPlugin:存量 cordis.yml 缺块则补挂,已挂则幂等不动", () => {
    // 存量安装:有 llm-pi-ai 但没挂凭证服务(回归前的真实形态)
    writeFileSync(cordisPath, "- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n");
    const s = new DshConfigSource(cordisPath);
    s.ensureCredentialsPlugin();
    let text = readFileSync(cordisPath, "utf8");
    expect(text).toContain("- id: credentials-local");
    expect(text).toContain("@deepseek-ai/dsh-credentials-local");
    // 幂等:再跑一遍不重复挂
    s.ensureCredentialsPlugin();
    text = readFileSync(cordisPath, "utf8");
    expect(text.split("- id: credentials-local").length).toBe(2);
    // 原有块保留
    expect(text).toContain("- id: llm-pi-ai");
  });

  it("凭证链闭环:写库 → 读回(字面值一致,不落 settings.yaml 明文)", async () => {
    // settingsPath 与 cordis.yml 同目录 → 凭证库落 <dir>/.credentials.yaml
    const settingsPath = join(dir, "settings.yaml");
    const s = new DshConfigSource(cordisPath, settingsPath);
    await s.setProvider("us-new", { baseURL: "https://x", apiKey: "sk-secret-123", models: [{ id: "m1" }] });
    // settings.yaml 里只存派生的 apiKeyEnv 引用,不存明文
    const settingsText = readFileSync(settingsPath, "utf8");
    expect(settingsText).toContain("apiKeyEnv: US_NEW_API_KEY");
    expect(settingsText).not.toContain("sk-secret-123");
    // 凭证库 refs 里存字面值,listProviders 读回
    const credText = readFileSync(join(dir, ".credentials.yaml"), "utf8");
    expect(credText).toContain("sk-secret-123");
    expect(s.listProviders()[0]).toMatchObject({ provider: "us-new", apiKey: "sk-secret-123" });
  });
});

describe("DshConfigSource listAvailablePlugins 过滤(根因:抽象服务定义/库包不是插件)", () => {
  it("只列已知插件 ∪ 直接依赖,排除传递依赖的抽象服务定义与库包", () => {
    const installDir = join(dir, "dsh");
    mkdirSync(join(installDir, "node_modules", "@deepseek-ai"), { recursive: true });
    // 直接依赖 = 真插件(subprocess-local);抽象服务定义(subprocess)/库包(tools)都是传递依赖
    writeFileSync(join(installDir, "package.json"), JSON.stringify({
      dependencies: { "@deepseek-ai/dsh-subprocess-local": "0.1.1-rc.2" },
    }));
    for (const n of ["dsh-subprocess-local", "dsh-subprocess", "dsh-agent-spine-demo", "dsh-tools"]) {
      mkdirSync(join(installDir, "node_modules", "@deepseek-ai", n), { recursive: true });
    }
    const s = new DshConfigSource(cordisPath, undefined, installDir);
    const names = s.listAvailablePlugins().map((p) => p.name);
    expect(names).toContain("@deepseek-ai/dsh-subprocess-local"); // 直接依赖
    expect(names).toContain("@deepseek-ai/dsh-agent-spine-demo"); // PLUGIN_ID_MAP 已知插件
    expect(names).not.toContain("@deepseek-ai/dsh-subprocess");   // 抽象服务定义(传递),排除
    expect(names).not.toContain("@deepseek-ai/dsh-tools");        // 库包(传递),排除
  });
});

describe("assertPiAiRouteServiceable(根因:空路由毒化整段 llm-pi-ai)", () => {
  it("非空 models 通过(不校验 baseURL,避免误杀 catalog 路由的空串清覆盖语义)", () => {
    expect(() =>
      assertPiAiRouteServiceable("us-new", { models: [{ id: "m1" }] }),
    ).not.toThrow();
  });

  it("空 models 抛错(毒化整段的根因)", () => {
    expect(() =>
      assertPiAiRouteServiceable("provider-x", { models: [] }),
    ).toThrow(/没有模型/);
  });

  it("空 model id 抛错", () => {
    expect(() =>
      assertPiAiRouteServiceable("provider-x", { models: [{ id: "" }] }),
    ).toThrow(/空 model id/);
  });
});

describe("DshConfigSource provider 纯自定义(listProviders/setProvider/rename/remove + 凭证库)", () => {
  it("listProviders 只列 llm-pi-ai 路由,apiKey 从凭证库读回(不落 settings.yaml)", async () => {
    const s = new DshConfigSource(join(dir, "cordis.yml"), join(dir, "settings.yaml"));
    await s.setProvider("us-new", {
      displayName: "US New",
      api: "openai-completions",
      baseURL: "https://x",
      apiKey: "sk-abc",
      models: [{ id: "m1" }],
    });
    const providers = s.listProviders();
    expect(providers.map((p) => p.provider)).toEqual(["us-new"]);
    expect(providers[0]).toMatchObject({ baseURL: "https://x", apiKey: "sk-abc" });

    // settings.yaml 只写 apiKeyEnv(派生 ref),不落密钥字面值
    const settingsText = readFileSync(join(dir, "settings.yaml"), "utf8");
    expect(settingsText).not.toContain("sk-abc");
    expect(settingsText).toContain("US_NEW_API_KEY");
  });

  it("renameProvider 迁移凭证库 ref,removeProvider 清除凭证库 ref", async () => {
    const s = new DshConfigSource(join(dir, "cordis.yml"), join(dir, "settings.yaml"));
    await s.setProvider("us-new", { apiKey: "sk-abc", models: [{ id: "m1" }] });
    await s.renameProvider("us-new", "us-new-2");
    expect(s.listProviders()[0]).toMatchObject({ provider: "us-new-2", apiKey: "sk-abc" });

    await s.removeProvider("us-new-2");
    expect(s.listProviders()).toHaveLength(0);
  });

  it("deepseek-official 不再是固定路由,可作为普通自定义路由增删改名", async () => {
    const s = new DshConfigSource(join(dir, "cordis.yml"), join(dir, "settings.yaml"));
    await s.setProvider("deepseek-official", { baseURL: "https://custom", apiKey: "sk-ds", models: [{ id: "m1" }] });
    expect(s.listProviders()[0]).toMatchObject({ provider: "deepseek-official", apiKey: "sk-ds" });
    await s.renameProvider("deepseek-official", "deepseek-custom");
    expect(s.listProviders()[0].provider).toBe("deepseek-custom");
    await s.removeProvider("deepseek-custom");
    expect(s.listProviders()).toHaveLength(0);
  });
});

describe("DshConfigSource 模型 reasoning 标记 → settings.yaml reasoningEfforts(补面配套,dsh-thinking-level.md §5)", () => {
  // 独立 fixture:setProvider 要写 settings.yaml,需构造带 settingsPath 的实例。
  let sdir: string;
  let scordis: string;
  let ssettings: string;
  let ssrc: DshConfigSource;
  beforeEach(() => {
    sdir = mkdtempSync(join(tmpdir(), "dsh-reasoning-"));
    scordis = join(sdir, "cordis.yml");
    ssettings = join(sdir, "settings.yaml");
    writeFileSync(scordis, "- id: settings-file\n  name: '@deepseek-ai/dsh-settings-file'\n");
    ssrc = new DshConfigSource(scordis, ssettings);
  });
  afterEach(() => { rmSync(sdir, { recursive: true, force: true }); });

  it("reasoning=true 的模型写回 reasoningEfforts(off 缺省 + 低中高同名);reasoning 缺省不写", async () => {
    await ssrc.setProvider("us-new", {
      api: "openai-completions",
      baseURL: "https://gw/",
      apiKey: "k",
      models: [
        { id: "dsv4-pro", name: "dsv4", reasoning: true, contextWindow: 100000, maxTokens: 64000 },
        { id: "plain", name: "plain", contextWindow: 100000, maxTokens: 64000 },
      ],
    });
    const doc = parseYaml(readFileSync(ssettings, "utf-8")) as Record<string, any>;
    const models = doc["llm-pi-ai"].providers["us-new"].models;
    const reasoning = models.find((m: { id: string }) => m.id === "dsv4-pro");
    const plain = models.find((m: { id: string }) => m.id === "plain");
    expect(reasoning.reasoningEfforts).toEqual({ off: null, low: "low", medium: "medium", high: "high" });
    expect(plain.reasoningEfforts).toBeUndefined();
  });

  it("读回:settings.yaml 有 reasoningEfforts → 模型 reasoning=true;无则缺省", () => {
    writeFileSync(ssettings, JSON.stringify({
      "llm-pi-ai": { providers: { "us-new": { models: [
        { id: "dsv4-pro", reasoningEfforts: { off: null, low: "low", high: "high" } },
        { id: "plain" },
      ] } } },
    }));
    const provs = ssrc.listProviders();
    const us = provs.find((p) => p.provider === "us-new")!;
    expect(us.models.find((m) => m.id === "dsv4-pro")?.reasoning).toBe(true);
    expect(us.models.find((m) => m.id === "plain")?.reasoning).toBeUndefined();
  });
});
