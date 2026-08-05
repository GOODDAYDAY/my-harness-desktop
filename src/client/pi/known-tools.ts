/**
 * known-tools 读取 —— tool-gate 播报文件的桌面侧读取(契约 docs/design/tool-manager-design.md §4.4.2;
 * 写入方是底座扩展 packages/toolgate/index.ts,经 toolgate-installer 同步进底座)。
 * 纯文件读 + JSON.parse,失败返回 null(文件缺失/半截 JSON 同一路径)由调用方走兜底链;
 * 读不引锁——写方低频小文件、parse 失败即兜底,为读取加锁原语不值(§4.4.4)。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KnownToolInfo } from "../../core/domain/sessions";

const KNOWN_TOOLS_FILE = join(homedir(), ".pi", "agent", "desktop-known-tools.json");

export function readKnownTools(cwd: string): KnownToolInfo[] | null {
  try {
    const parsed = JSON.parse(readFileSync(KNOWN_TOOLS_FILE, "utf8")) as {
      byCwd?: Record<string, { tools?: unknown }>;
    };
    const tools = parsed?.byCwd?.[cwd]?.tools;
    if (!Array.isArray(tools)) return null;
    return tools.filter(
      (t): t is KnownToolInfo =>
        typeof t === "object" && t !== null && typeof (t as KnownToolInfo).name === "string",
    );
  } catch {
    return null;
  }
}
