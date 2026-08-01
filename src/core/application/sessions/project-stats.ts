// 项目总统计扫描 —— application 层,聚合 ~/.pi/agent/sessions/<cwd桶>/ 下全部 JSONL 的
// message.usage,产出 domain 契约 ProjectStats。与 session-scanner 同模式:同步 fs、
// agentDir 由 shell 注入、损坏行/损坏文件跳过不拖垮整体。
//
// 口径(以真实文件为准,2026-07 实测底座格式):
// - 只认 type:"message" 条目;usage 仅挂在 role:"assistant" 消息上
// - usage 形状 {input, output, cacheRead, cacheWrite, cost, totalTokens}
// - cost 不是数字,是分解对象 {input, output, cacheRead, cacheWrite, total} —— 取 cost.total
// - turns = role:"user" 消息条数(domain ProjectStats 注释钉的语义)
//
// 增量缓存:按 path 记 {mtimeMs, size, agg},双键不变直接命中;mtime 变则全量重读该文件。
// 活跃会话文件每轮对话都变,但重读单文件是 ms 级;桶内其余文件全命中。
// 演进:桶目录 fs.watch 推送失效(当前是调用时惰性对账,插件在 agentSettled 后拉取,够用)。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProjectStats } from "../../domain/events/session-state";
import { cwdToBucketName } from "../../domain/sessions";

interface FileAgg {
  mtimeMs: number;
  size: number;
  agg: ProjectStats;
}

const zeroStats = (): ProjectStats => ({
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0, sessionCount: 0, turns: 0,
});

/** path → 文件级聚合。模块级单例:main 进程内全插件共享一份缓存。 */
const fileCache = new Map<string, FileAgg>();

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 解析单个会话 JSONL,累加 message.usage + 数 user 消息。损坏行跳过。 */
function parseSessionFile(path: string): ProjectStats {
  const stats = zeroStats();
  stats.sessionCount = 1;
  const content = readFileSync(path, "utf-8");
  let pos = 0;
  while (pos < content.length) {
    const nl = content.indexOf("\n", pos);
    const end = nl === -1 ? content.length : nl;
    const line = content.slice(pos, end);
    pos = end + 1;
    // 快速预过滤再 parse,usage/role 只出现在 message 条目里
    if (!line.includes('"message"')) continue;
    try {
      const j = JSON.parse(line) as { type?: unknown; message?: Record<string, unknown> };
      if (j.type !== "message" || !j.message) continue;
      if (j.message.role === "user") stats.turns += 1;
      const u = j.message.usage as Record<string, unknown> | undefined;
      if (!u) continue;
      stats.tokens.input += num(u.input);
      stats.tokens.output += num(u.output);
      stats.tokens.cacheRead += num(u.cacheRead);
      stats.tokens.cacheWrite += num(u.cacheWrite);
      stats.tokens.total += num(u.totalTokens);
      const c = u.cost;
      // cost 实测是分解对象 {input, output, ..., total};数字形态兜底(旧版底座?)
      stats.cost += typeof c === "number" ? c
        : c && typeof c === "object" ? num((c as Record<string, unknown>).total) : 0;
    } catch {
      // 损坏行跳过
    }
  }
  return stats;
}

/** 聚合某 cwd 桶的项目总统计。桶不存在 = 全零;sessionCount 即成功解析的文件数。 */
export function getProjectStats(agentDir: string, cwd: string): ProjectStats {
  const bucketDir = join(join(agentDir, "sessions"), cwdToBucketName(cwd));
  const total = zeroStats();
  if (!existsSync(bucketDir)) return total;

  const alive = new Set<string>();
  for (const file of readdirSync(bucketDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const fullPath = join(bucketDir, file);
    alive.add(fullPath);
    try {
      const st = statSync(fullPath);
      const hit = fileCache.get(fullPath);
      const fresh = hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size;
      const agg = fresh ? hit.agg : parseSessionFile(fullPath);
      if (!fresh) fileCache.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, agg });
      total.tokens.input += agg.tokens.input;
      total.tokens.output += agg.tokens.output;
      total.tokens.cacheRead += agg.tokens.cacheRead;
      total.tokens.cacheWrite += agg.tokens.cacheWrite;
      total.tokens.total += agg.tokens.total;
      total.cost += agg.cost;
      total.turns += agg.turns;
      total.sessionCount += 1;
    } catch {
      continue; // stat/读失败跳过(比如正被写坏的瞬态),下轮再试
    }
  }
  // 会话文件被删(删会话/清理) → 缓存对账剔除,否则删掉的贡献会复活
  for (const path of fileCache.keys()) {
    if (path.startsWith(bucketDir) && !alive.has(path)) fileCache.delete(path);
  }
  return total;
}
