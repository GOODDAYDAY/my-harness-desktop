// 密码哈希 + 强度策略 + 远程配置单测(web-service §37.1)。

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword, verifyPassword, generateStrongPassword, validatePasswordStrength, PASSWORD_MIN_LENGTH } from "./password";
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

describe("密码强度(§8.1 修订:数字+字母+特殊符号)", () => {
  it("validatePasswordStrength 逐类拒绝", () => {
    expect(validatePasswordStrength("short")).not.toBeNull(); // 太短
    expect(validatePasswordStrength("abcdefghij")).not.toBeNull(); // 缺数字
    expect(validatePasswordStrength("1234567890")).not.toBeNull(); // 缺字母
    expect(validatePasswordStrength("abcd123456")).not.toBeNull(); // 缺特殊符号
    expect(validatePasswordStrength("Abcd1234!@")).toBeNull(); // 三类齐全
  });

  it("generateStrongPassword 满足强度且长度达标", () => {
    for (let i = 0; i < 50; i++) {
      const pwd = generateStrongPassword();
      expect(pwd.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
      expect(validatePasswordStrength(pwd)).toBeNull();
    }
  });

  it("生成的密码可哈希/校验往返", () => {
    const pwd = generateStrongPassword();
    expect(verifyPassword(pwd, hashPassword(pwd))).toBe(true);
    expect(verifyPassword(pwd + "x", hashPassword(pwd))).toBe(false);
  });
});

describe("RemoteConfigStore", () => {
  it("缺省文件回落 defaults,深层字段逐层合并", () => {
    const s = new RemoteConfigStore(join(tmp(), "remote.json"));
    expect(s.get()).toMatchObject({ enabled: false, bind: "loopback", lan: { enabled: true, passwordHash: null } });
  });

  it("update 写回 + get 反映", async () => {
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

  it("历史遗留键(如已移除的 public)读取时被丢弃", async () => {
    const p = join(tmp(), "remote.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(p, JSON.stringify({ enabled: true, bind: "lan", port: 4763, lan: { enabled: true, passwordHash: null, customized: false }, public: { passwordHash: "legacy" } }));
    const s = new RemoteConfigStore(p);
    expect((s.get() as unknown as Record<string, unknown>).public).toBeUndefined();
    await s.update({ enabled: false });
    const s2 = new RemoteConfigStore(p);
    expect((s2.get() as unknown as Record<string, unknown>).public).toBeUndefined();
  });

  it("固定密码持久化:写入后重读仍可校验(重启不丢)", async () => {
    const p = join(tmp(), "remote.json");
    const s = new RemoteConfigStore(p);
    const hash = hashPassword("MyFixed@2024");
    await s.update({ lan: { ...s.get().lan, passwordHash: hash, customized: true } });
    // 模拟重启:新 store 从盘上读
    const s2 = new RemoteConfigStore(p);
    expect(s2.get().lan.customized).toBe(true);
    expect(verifyPassword("MyFixed@2024", s2.get().lan.passwordHash ?? "")).toBe(true);
    expect(verifyPassword("Other@2024", s2.get().lan.passwordHash ?? "")).toBe(false);
  });
});
