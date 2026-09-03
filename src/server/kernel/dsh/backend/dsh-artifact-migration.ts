// dsh 会话工件编码迁移——zstd 历史工件一次性转明文(session.jsonl.zstd → session.jsonl)。
//
// 背景(ask-design §5.2):桌面把 dsh 会话持久化部署为明文诊断模式(compression:'none'
// + packChunks:false),ask 续问才能在进程死亡窗口往日志追加一行。但该配置落地之前,
// 桌面/CLI 已经在同一根里写过 zstd 工件;持久化层的根编码守卫(ensureRootEncoding,
// 任何 list/append 前扫全根)遇到混合编码直接抛 encodingMismatch——遗留一个 zstd,
// 所有 dsh 会话的创建/列举/续跑全挂(「生成失败 session artifact ... uses .jsonl.zstd」)。
//
// 性质:这是 §2.1「壳不读内核存储」的显式例外(离线迁移工具,与 pi 旧文件导入同级),
// 不是会话流的运行时读路径。幂等:无 zstd 工件即零操作;重复运行无害。
//
// 内容保全:zstd 是同一明文字节流的确定性压缩——解压落盘字节与内核直写完全一致;
// 工件是 append-only 日志,同会话两份并存时取内容更长者(更长 = 前缀延展更全)。

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

export interface ArtifactMigrationResult {
  /** zstd → 明文 转换数。 */
  migrated: number;
  /** 明文已存在、按长度裁决后清理的 zstd 数。 */
  deduped: number;
  /** 解压失败隔离(改名 .broken,不丢数据)数。 */
  quarantined: number;
}

const ZSTD_SUFFIX = ".jsonl.zstd";
const PLAIN_SUFFIX = ".jsonl";

/** 原子写明文工件(temp + rename),失败不留半截。 */
function writePlainAtomic(path: string, content: Buffer): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** 启动迁移:扫会话根全部桶,把 zstd 工件转成明文并保持根编码统一。
 *  调用方(assemble)保证只在「cordis.yml sessions 块 compression:'none'」时调用——
 *  用户手改回 zstd 部署时本迁移不动手(尊重部署选择,不反向打架)。 */
export function migrateZstdSessionArtifacts(sessionRoot: string): ArtifactMigrationResult {
  const result: ArtifactMigrationResult = { migrated: 0, deduped: 0, quarantined: 0 };
  if (!existsSync(sessionRoot)) return result;
  let buckets: string[];
  try {
    buckets = readdirSync(sessionRoot);
  } catch {
    return result; // 根不可读:迁移不挡启动
  }
  for (const bucket of buckets) {
    const bucketDir = join(sessionRoot, bucket);
    let sessionDirs: string[];
    try {
      if (!statSync(bucketDir).isDirectory()) continue;
      sessionDirs = readdirSync(bucketDir);
    } catch {
      continue;
    }
    for (const dirName of sessionDirs) {
      const dir = join(bucketDir, dirName);
      const zstdPath = join(dir, `session${ZSTD_SUFFIX}`);
      const plainPath = join(dir, `session${PLAIN_SUFFIX}`);
      try {
        if (!statSync(dir).isDirectory() || !existsSync(zstdPath)) continue;
      } catch {
        continue;
      }
      let plain: Buffer;
      try {
        plain = zstdDecompressSync(readFileSync(zstdPath));
      } catch {
        // 解压失败(截断/手改):隔离不销毁,根编码守卫只认精确后缀,改名即出扫描面。
        try {
          renameSync(zstdPath, `${zstdPath}.broken`);
          result.quarantined += 1;
        } catch { /* 隔离也失败:留在原地,启动不挡 */ }
        continue;
      }
      try {
        if (existsSync(plainPath)) {
          // 两份并存(flip-flop 配置残留):append-only 日志取更长者为准,短的移除。
          if (plain.length > statSync(plainPath).size) writePlainAtomic(plainPath, plain);
          rmSync(zstdPath, { force: true });
          result.deduped += 1;
        } else {
          writePlainAtomic(plainPath, plain);
          rmSync(zstdPath, { force: true });
          result.migrated += 1;
        }
      } catch {
        // 写/删失败:留现场下次启动再试(幂等),不挡启动。
      }
    }
  }
  return result;
}
