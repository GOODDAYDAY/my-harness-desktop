// 密码哈希与强度策略(web-service §37.1)——scrypt + 随机盐,常量时间比较。不引 bcrypt 依赖(node:crypto 内置)。
// 密码以 hash 存 remote.json,不落代码、不进日志。
// 强度策略(§8.1 修订):数字 + 字母 + 特殊符号混合——纯数字 8 位可被离线字典秒破,
// 且密码不进 URL(登录走表单 + 限流),故字符集不受 URL 安全约束。

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

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

/** 密码字符类:数字 / 字母 / 特殊符号(排除易混的 0/O、1/l/I)。 */
const DIGITS = "23456789";
const LETTERS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";
const SYMBOLS = "!@#$%^&*()-_=+";
const ALL = DIGITS + LETTERS + SYMBOLS;

/** 密码强度下限:至少 10 位,且数字、字母、特殊符号三类齐全。 */
export const PASSWORD_MIN_LENGTH = 10;

/** 校验密码强度。合法返回 null,否则返回原因(供 UI 展示)。 */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`;
  if (!/\d/.test(password)) return "密码须包含数字";
  if (!/[a-zA-Z]/.test(password)) return "密码须包含字母";
  if (!/[^a-zA-Z0-9]/.test(password)) return "密码须包含特殊符号";
  return null;
}

/** 生成强密码:12 位,三类字符各保底一个,其余随机打散(§8.1)。 */
export function generateStrongPassword(length = 12): string {
  const pick = (set: string): string => set[randomInt(set.length)];
  const chars = [pick(DIGITS), pick(LETTERS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(ALL));
  // Fisher-Yates 洗牌:保底字符不落固定位
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
