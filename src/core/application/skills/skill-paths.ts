// 共享 skill 路径 helper —— application/skills。
//
// 评估 P2:skill-scanner 与 skill-toggle 各自复制 toPosixPath/resolvePath/isOverridePattern/
// stripOverridePrefix,且 resolvePath 已在两份间漂移(scanner 用 resolve 规范化,toggle 用 join
// 不规范化)。收敛到本文件单一源(契约单源 §1.3 + 关注点分离 §3.3)。
import { join, resolve, sep } from "node:path";

/** 平台路径分隔符 → posix(底座 skills 路径约定 posix)。 */
export function toPosixPath(p: string): string {
  return p.split(sep).join("/");
}

/** 解析路径:~ 展开(用注入的 homeDir,不直读 node:os)、绝对路径 resolve 规范化、
 *  相对路径基于 baseDir resolve。统一用 resolve 规范化(消除 scanner vs toggle 的 join/resolve 漂移)。 */
export function resolvePath(input: string, baseDir: string, homeDir: string): string {
  let p = input.trim();
  if (p.startsWith("~")) p = join(homeDir, p.slice(1));
  if (p.startsWith("/")) return resolve(p);
  return resolve(baseDir, p);
}

/** 是否 override 前缀模式(!/+/-,底座 skills 数组的启用/禁用标记)。 */
export function isOverridePattern(s: string): boolean {
  return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

/** 去掉 override 前缀,返回纯路径。 */
export function stripOverridePrefix(s: string): string {
  return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") ? s.slice(1) : s;
}
