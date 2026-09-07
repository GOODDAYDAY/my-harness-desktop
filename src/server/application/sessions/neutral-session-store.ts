// 中立会话树的持久化存储 —— 壳自己的会话存储,不读内核存储。
//
// 依据 docs/design/session-neutral-layer.md §7:NeutralSession 存壳侧,内核的存储
// (pi 文件 / dsh session log)是「这个中立树的投影」。这是「壳不读内核存储」这条
// 不变量的最终落地——壳读自己的中立存储,不读 pi 文件/dsh 日志。
//
// 本层是纯存储(不依赖内核、不 import client)。
//
// ── 存储格局(docs/design/neutral-storage-split.md,2026-08 拆分) ──
//   <ns>.header.json   —— { neutralSessionId, rootLineageId, header }  列表/写头只碰它
//   <ns>.entries.json  —— { neutralSessionId, lineages(含 entries) }   打开会话才读
//   <ns>.json          —— 遗留整树文件(拆分前),读到即懒迁移(拆开+顺手 heal 头+删除)
// 拆分动因:归档一个布尔位曾走「整树读+整树写+全目录整树 parse」(实测 N=1089/308MB 时
// 单次列表重拉 1.75s)。拆分后写头 O(header),列表 O(N×header)。
// 写序约定:entries 先于 header(header 列表行字段可从 entries 派生自愈,崩在半路
// 最坏 header 陈旧,内容不丢)。两文件一律紧凑序列化(不做美化缩进)。

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { derivedHeaderFromSession, type NeutralSession, type NeutralSessionHeader, type NeutralSessionSummary } from "@my-harness-desktop/shared";

const HEADER_SUFFIX = ".header.json";
const ENTRIES_SUFFIX = ".entries.json";

/** header 文件的磁盘形状(含 rootLineageId——clone/seed 会话根 lineageId ≠ ns,列表投影要用)。 */
interface HeaderFile {
  neutralSessionId: string;
  rootLineageId: string;
  header: NeutralSessionHeader;
}

/** entries 文件的磁盘形状。 */
interface EntriesFile {
  neutralSessionId: string;
  lineages: NeutralSession["lineages"];
}

export class NeutralSessionStore {
  constructor(private readonly dir: string) {}

  private legacyPath(neutralSessionId: string): string {
    return join(this.dir, `${neutralSessionId}.json`);
  }

  private headerPath(neutralSessionId: string): string {
    return join(this.dir, `${neutralSessionId}${HEADER_SUFFIX}`);
  }

  private entriesPath(neutralSessionId: string): string {
    return join(this.dir, `${neutralSessionId}${ENTRIES_SUFFIX}`);
  }

  /** 中立会话文件的磁盘路径(「打开 desktop 会话文件」用;壳自己的存储,非内核存储)。
   *  拆分后返回 entries 文件(内容主体);未迁移的遗留文件仍返回旧路径。 */
  filePathOf(neutralSessionId: string): string {
    const entries = this.entriesPath(neutralSessionId);
    if (existsSync(entries)) return entries;
    return this.legacyPath(neutralSessionId);
  }

  private rootLineageIdOf(session: NeutralSession): string {
    return session.lineages.find((l) => l.fork === null)?.lineageId ?? session.neutralSessionId;
  }

  private writeSplit(session: NeutralSession): void {
    mkdirSync(this.dir, { recursive: true });
    const entries: EntriesFile = { neutralSessionId: session.neutralSessionId, lineages: session.lineages };
    const header: HeaderFile = { neutralSessionId: session.neutralSessionId, rootLineageId: this.rootLineageIdOf(session), header: session.header };
    // 写序:entries 先(header 可从 entries 派生自愈),header 后。
    writeFileSync(this.entriesPath(session.neutralSessionId), JSON.stringify(entries), "utf-8");
    writeFileSync(this.headerPath(session.neutralSessionId), JSON.stringify(header), "utf-8");
  }

  /** 遗留整树文件懒迁移:读整树 → heal 头字段(pre-阶段-D 数据缺 lastMessage/lastEntryId/updatedAt,
   *  迁移是唯一能免费拿整树的时刻,愈合落盘,列表从此不需要读时兜底)→ 写拆分文件 → 删旧。 */
  private migrateLegacy(neutralSessionId: string): boolean {
    const legacy = this.legacyPath(neutralSessionId);
    if (!existsSync(legacy)) return false;
    try {
      const session = JSON.parse(readFileSync(legacy, "utf-8")) as NeutralSession;
      if (!Array.isArray(session?.lineages) || typeof session?.neutralSessionId !== "string") {
        console.error(`[neutral-store] 遗留会话文件形状坏,迁移跳过: ${neutralSessionId}(lineages=${typeof session?.lineages})`);
        return false;
      }
      const healed: NeutralSession = {
        ...session,
        header: {
          ...session.header,
          ...(session.header.lastMessage === undefined || session.header.lastEntryId === undefined || session.header.updatedAt === undefined
            ? derivedHeaderFromSession(session)
            : {}),
        },
      };
      this.writeSplit(healed);
      rmSync(legacy);
      return true;
    } catch {
      return false;
    }
  }

  /** 读一个中立会话树;不存在、形状坏、JSON 损坏,三者都返回 null。
   *  形状守卫(r370 同源,listByCwd 的姊妹口):合法 JSON 但形状坏(lineages=null/
   *  非数组)曾滑过 parse——get() 的 9 个调用方(openSession/写穿/树投影等)全部
   *  直接信任返回值,坏形状会在下游 .lineages.find/flatMap 炸。与 listByCwd
   *  同一条纪律:坏形状 = 损坏,返回 null + 记日志。 */
  get(neutralSessionId: string): NeutralSession | null {
    if (!existsSync(this.headerPath(neutralSessionId)) || !existsSync(this.entriesPath(neutralSessionId))) {
      this.migrateLegacy(neutralSessionId);
    }
    try {
      if (!existsSync(this.headerPath(neutralSessionId)) || !existsSync(this.entriesPath(neutralSessionId))) return null;
      const header = JSON.parse(readFileSync(this.headerPath(neutralSessionId), "utf-8")) as HeaderFile;
      const entries = JSON.parse(readFileSync(this.entriesPath(neutralSessionId), "utf-8")) as EntriesFile;
      if (!Array.isArray(entries?.lineages) || typeof header?.neutralSessionId !== "string" || !header?.header) {
        console.error(`[neutral-store] 会话文件形状坏,get 返回 null: ${neutralSessionId}(lineages=${typeof entries?.lineages})`);
        return null;
      }
      return { neutralSessionId: header.neutralSessionId, header: header.header, lineages: entries.lineages };
    } catch {
      return null;
    }
  }

  /** 只读 header(列表/写头热路径;几 KB 小读,不碰 entries)。
   *  不存在/损坏返回 null;遗留整树文件读到即迁移。 */
  getHeader(neutralSessionId: string): NeutralSessionSummary | null {
    if (!existsSync(this.headerPath(neutralSessionId))) this.migrateLegacy(neutralSessionId);
    try {
      if (!existsSync(this.headerPath(neutralSessionId))) return null;
      const parsed = JSON.parse(readFileSync(this.headerPath(neutralSessionId), "utf-8")) as HeaderFile;
      if (typeof parsed?.neutralSessionId !== "string" || typeof parsed?.rootLineageId !== "string" || !parsed?.header) {
        console.error(`[neutral-store] header 文件形状坏,getHeader 返回 null: ${neutralSessionId}`);
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /** 列某 cwd 下的全部中立会话摘要(只读 header 文件,不 parse entries——
   *  拆分前这里对每棵树全量 readFileSync+JSON.parse,实测 1089 会话/308MB ≈1.75s/次,
   *  且被 headerChanged 广播按「归档次数×客户端数」乘法放大;拆分后 O(N×几KB))。
   *  灾难隔离(r370 根因修复,勿回退):try 只包住 JSON.parse——**合法 JSON 但形状坏**
   *  会滑过 parse 落进 result,然后在下游炸掉整条 map——单个坏文件拖垮整个会话列表。
   *  修法:形状校验挪进同一 try,坏形状与坏 JSON 同等跳过 + 记日志(可观测,不静默)。
   *  遗留整树文件(<ns>.json)读到即懒迁移——升级后首次列表一次性迁移全部存量。 */
  listByCwd(cwd: string): NeutralSessionSummary[] {
    if (!existsSync(this.dir)) return [];
    const result: NeutralSessionSummary[] = [];
    for (const file of readdirSync(this.dir)) {
      if (file.endsWith(HEADER_SUFFIX)) {
        const parsed = this.getHeader(file.slice(0, -HEADER_SUFFIX.length));
        if (parsed?.header?.cwd === cwd) result.push(parsed);
        continue;
      }
      if (file.endsWith(ENTRIES_SUFFIX)) continue;
      if (file.endsWith(".json")) {
        // 遗留整树文件:迁移后按新 header 判定(迁移失败=损坏,跳过不中断枚举)。
        const ns = file.slice(0, -".json".length);
        if (this.migrateLegacy(ns)) {
          const parsed = this.getHeader(ns);
          if (parsed?.header?.cwd === cwd) result.push(parsed);
        }
      }
    }
    return result;
  }

  /** 写一个中立会话树(entries + header 双文件覆盖写;顺手删同 ns 遗留整树文件防诈尸)。 */
  put(session: NeutralSession): void {
    this.writeSplit(session);
    const legacy = this.legacyPath(session.neutralSessionId);
    if (existsSync(legacy)) rmSync(legacy);
  }

  /** 只写 header(归档/置顶/改名/模型域等纯头变更的定点写口,不动 entries 大文件)。
   *  rootLineageId 从现有 header 文件保序;header 文件不存在(异常态)安静跳过。 */
  putHeader(neutralSessionId: string, header: NeutralSessionHeader): void {
    const cur = this.getHeader(neutralSessionId);
    if (!cur) return;
    mkdirSync(this.dir, { recursive: true });
    const next: HeaderFile = { ...cur, header };
    writeFileSync(this.headerPath(neutralSessionId), JSON.stringify(next), "utf-8");
  }

  /** 删一个中立会话树(删会话时级联;三文件变体全清)。 */
  delete(neutralSessionId: string): void {
    for (const p of [this.headerPath(neutralSessionId), this.entriesPath(neutralSessionId), this.legacyPath(neutralSessionId)]) {
      if (existsSync(p)) rmSync(p);
    }
  }
}
