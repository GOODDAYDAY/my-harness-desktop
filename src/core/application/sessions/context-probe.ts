/**
 * context-probe 侧车文件读取(写入方:packages/context-probe 底座扩展,经
 * context-probe-installer 同步进底座)。纯文件读 + JSON.parse,失败返回 null
 * (文件缺失/半截 JSON 同一路径)由调用方走兜底链;读不引锁——写方低频小文件,
 * parse 失败即兜底,为读取加锁原语不值(与 known-tools 同一纪律)。
 * agentDir 由调用方注入(bootstrap 给),本函数不读环境。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 读指定会话文件最近一次请求的实测 token 数(chars/4);无记录/损坏返回 null。 */
export function readContextProbeTokens(agentDir: string, sessionFile: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, "desktop-context-probe.json"), "utf8")) as {
      bySession?: Record<string, { tokens?: unknown }>;
    };
    const t = parsed?.bySession?.[sessionFile]?.tokens;
    return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null;
  } catch {
    return null;
  }
}
