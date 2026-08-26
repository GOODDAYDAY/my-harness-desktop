// 密码哈希(web-service §37.1)——scrypt + 随机盐,常量时间比较。不引 bcrypt 依赖(node:crypto 内置)。
// 8 位数字密码以 hash 存 remote.json,不落代码、不进日志。

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** 哈希密码:scrypt$<salt hex>$<hash hex>。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

/** 校验密码。stored 非 scrypt 格式或长度不符 → false。 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hash] = parts;
  if (!salt || !hash) return false;
  const actual = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
