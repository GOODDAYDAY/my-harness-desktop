// dsh-config-source cordis.yml 块编辑测试 —— addPluginBlock / removePluginBlock（dsh 内核插件随附通道的挂摘原语）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DshConfigSource } from "./dsh-config-source";

let dir: string;
let cordisPath: string;
let src: DshConfigSource;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-blocks-"));
  cordisPath = join(dir, "cordis.yml");
  src = new DshConfigSource(cordisPath);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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
