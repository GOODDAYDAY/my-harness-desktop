// dsh-credentials-store 凭证库最小读写面测试:deriveKeyRef + refs 读写(version-1 布局,保留 records)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { deriveKeyRef, readApiKey, writeApiKey } from "./dsh-credentials-store";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dsh-creds-"));
  path = join(dir, ".credentials.yaml");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("deriveKeyRef(与 dsh 官方 settings-models UI 同款)", () => {
  it("provider 大写化、非字母数字转下划线、后缀 _API_KEY", () => {
    expect(deriveKeyRef("us-new")).toBe("US_NEW_API_KEY");
    expect(deriveKeyRef("opencode-zen")).toBe("OPENCODE_ZEN_API_KEY");
    expect(deriveKeyRef("MyProvider.2")).toBe("MYPROVIDER_2_API_KEY");
  });
});

describe("readApiKey / writeApiKey(version-1 布局)", () => {
  it("写读往返 + 空串删除 + 保留 records", () => {
    writeFileSync(path, "version: 1\nrecords:\n  llm-pi-ai/x:\n    kind: grant\n    payload: {}\n", "utf8");
    writeApiKey(path, "us-new", "sk-abc");
    const doc = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect((doc.refs as Record<string, unknown>).US_NEW_API_KEY).toBe("sk-abc");
    expect(doc.records).toBeTruthy(); // records 保留
    expect(readApiKey(path, "us-new")).toBe("sk-abc");

    writeApiKey(path, "us-new", "");
    expect(readApiKey(path, "us-new")).toBe("");
  });

  it("文件缺失时读回空串、写时新建 version-1 文档", () => {
    expect(readApiKey(path, "us-new")).toBe("");
    writeApiKey(path, "us-new", "sk-x");
    const doc = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(doc.version).toBe(1);
    expect((doc.refs as Record<string, unknown>).US_NEW_API_KEY).toBe("sk-x");
  });
});
