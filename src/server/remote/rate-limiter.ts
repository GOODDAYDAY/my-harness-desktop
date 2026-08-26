// 失败限速器(web-service §8.4/§19.3)——同 key 连续 5 错锁 60s,成功清零。
// 纯内存 Map,不落盘。作用于 /login 与 hello 两个入口,共用一个实例。

export interface RateLimitResult {
  locked: boolean;
  retryAfterSec: number;
}

export interface RateLimiter {
  /** 记录一次失败。返回是否已锁 + 锁剩余秒数。 */
  recordFailure(key: string): RateLimitResult;
  /** 记录一次成功,清零该 key 的失败计数。 */
  recordSuccess(key: string): void;
}

/** 组装限速器。maxFailures 默认 5,lockSec 默认 60。 */
export function createRateLimiter(opts?: { maxFailures?: number; lockSec?: number }): RateLimiter {
  const maxFailures = opts?.maxFailures ?? 5;
  const lockSec = opts?.lockSec ?? 60;
  const entries = new Map<string, { count: number; lockedUntil: number }>();

  return {
    recordFailure(key) {
      const now = Date.now();
      const cur = entries.get(key) ?? { count: 0, lockedUntil: 0 };
      if (cur.lockedUntil > now) {
        return { locked: true, retryAfterSec: Math.ceil((cur.lockedUntil - now) / 1000) };
      }
      cur.count += 1;
      if (cur.count >= maxFailures) {
        cur.lockedUntil = now + lockSec * 1000;
        cur.count = 0;
        entries.set(key, cur);
        return { locked: true, retryAfterSec: lockSec };
      }
      entries.set(key, cur);
      return { locked: false, retryAfterSec: 0 };
    },
    recordSuccess(key) {
      entries.delete(key);
    },
  };
}
