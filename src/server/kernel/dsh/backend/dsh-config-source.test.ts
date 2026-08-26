// dsh-config-source cordis.yml 块编辑测试 —— addPluginBlock / removePluginBlock（dsh 内核插件随附通道的挂摘原语）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DshConfigSource, assertPiAiRouteServiceable } from "./dsh-config-source";

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

  it("deepseek-official 固定路由跳过校验(走 llm-deepseek catalog)", () => {
    expect(() =>
      assertPiAiRouteServiceable("deepseek-official", { models: [] }),
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
