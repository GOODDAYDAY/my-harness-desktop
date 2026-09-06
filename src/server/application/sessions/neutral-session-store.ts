// 中立会话树的持久化存储 —— 壳自己的会话存储,不读内核存储。
//
// 依据 docs/design/session-neutral-layer.md §7:NeutralSession 存壳侧,内核的存储
// (pi 文件 / dsh session log)是「这个中立树的投影」。这是「壳不读内核存储」这条
// 不变量的最终落地——壳读自己的中立存储,不读 pi 文件/dsh 日志。
//
// 本层是纯存储(JSON 整读整写,会话树规模小),不依赖内核、不 import client。

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { NeutralSession } from "@my-harness-desktop/shared";

export class NeutralSessionStore {
  constructor(private readonly dir: string) {}

  private filePath(neutralSessionId: string): string {
    return join(this.dir, `${neutralSessionId}.json`);
  }

  /** 中立会话文件的磁盘路径(「打开 desktop 会话文件」用;壳自己的存储,非内核存储)。 */
  filePathOf(neutralSessionId: string): string {
    return this.filePath(neutralSessionId);
  }

  /** 读一个中立会话树;不存在、形状坏、JSON 损坏,三者都返回 null。
   *  形状守卫(r370 同源,listByCwd 的姊妹口):合法 JSON 但形状坏(lineages=null/
   *  非数组)曾滑过 parse——get() 的 9 个调用方(openSession/写穿/树投影等)全部
   *  直接信任返回值,坏形状会在下游 .lineages.find/flatMap 炸。与 listByCwd
   *  同一条纪律:坏形状 = 损坏,返回 null + 记日志。 */
  get(neutralSessionId: string): NeutralSession | null {
    const file = this.filePath(neutralSessionId);
    if (!existsSync(file)) return null;
    try {
      const session = JSON.parse(readFileSync(file, "utf-8")) as NeutralSession;
      if (!Array.isArray(session?.lineages) || typeof session?.neutralSessionId !== "string") {
        console.error(`[neutral-store] 会话文件形状坏,get 返回 null: ${neutralSessionId}(lineages=${typeof session?.lineages})`);
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  /** 列某 cwd 下的全部中立会话(扫 *.json、按 header.cwd 过滤;损坏文件跳过)。
   *  §kernel-forkless-branch §27 阶段 A:中立层独立回答「某 cwd 有哪些会话」——
   *  这是阶段 D「list 读中立层」的前置能力。
   *  灾难隔离(r370 根因修复,勿回退):try 只包住 JSON.parse——**合法 JSON 但形状坏**
   *  (lineages=null/非数组,断电半写的常见形态)会滑过 parse 落进 result,然后在
   *  session-store.neutralToSessionInfo 的 lineages.find 上炸掉整条 map——单个
   *  坏文件拖垮整个会话列表(候选十一实钉:健康的邻居会话也消失)。修法:形状校验
   *  挪进同一 try,坏形状与坏 JSON 同等跳过 + 记日志(可观测,不静默)。 */
  listByCwd(cwd: string): NeutralSession[] {
    if (!existsSync(this.dir)) return [];
    const result: NeutralSession[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const session = JSON.parse(readFileSync(join(this.dir, file), "utf-8")) as NeutralSession;
        if (!Array.isArray(session?.lineages) || typeof session?.neutralSessionId !== "string") {
          // 形状坏(结构损坏):跳过该文件,不中断枚举;记日志可观测。
          console.error(`[neutral-store] 会话文件形状损坏,列表已跳过: ${file}(lineages=${typeof session?.lineages},ns=${typeof session?.neutralSessionId})`);
          continue;
        }
        if (session?.header?.cwd === cwd) result.push(session);
      } catch {
        // 损坏文件(JSON 解析失败)跳过,不中断枚举
      }
    }
    return result;
  }

  /** 写一个中立会话树(整读整写覆盖)。 */
  put(session: NeutralSession): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.filePath(session.neutralSessionId), JSON.stringify(session, null, 2), "utf-8");
  }

  /** 删一个中立会话树(删会话时级联)。 */
  delete(neutralSessionId: string): void {
    const file = this.filePath(neutralSessionId);
    if (existsSync(file)) rmSync(file);
  }
}
