// 密码哈希 + 远程配置单测(web-service §37.1)。

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword, verifyPassword } from "./password";
import { RemoteConfigStore } from "./remote-config";

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "remote-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("password(scrypt)", () => {
  it("hash → verify 往返一致", () => {
    const h = hashPassword("12345678");
    expect(verifyPassword("12345678", h)).toBe(true);
    expect(verifyPassword("87654321", h)).toBe(false);
  });

  it("每次 hash 随机盐(同密码不同 hash)", () => {
    expect(hashPassword("12345678")).not.toBe(hashPassword("12345678"));
  });

  it("非 scrypt 格式 → false", () => {
    expect(verifyPassword("x", "bcrypt$abc")).toBe(false);
    expect(verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("RemoteConfigStore", () => {
  it("缺省文件回落 defaults,深层字段逐层合并", () => {
    const s = new RemoteConfigStore(join(tmp(), "remote.json"));
    expect(s.get()).toMatchObject({ enabled: false, bind: "loopback", lan: { enabled: true, passwordHash: null } });
  });

  it("update 写回 + get 反映", () => {
    const p = join(tmp(), "remote.json");
    const s = new RemoteConfigStore(p);
    await s.update({ enabled: true, bind: "lan" });
    expect(s.get().enabled).toBe(true);
    expect(s.get().bind).toBe("lan");
    // 重读(新 store 从盘上读)
    const s2 = new RemoteConfigStore(p);
    expect(s2.get().enabled).toBe(true);
    expect(s2.get().bind).toBe("lan");
  });
});
