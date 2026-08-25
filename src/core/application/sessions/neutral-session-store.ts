// 中立会话树的持久化存储 —— 壳自己的会话存储,不读内核存储。
//
// 依据 docs/design/session-neutral-layer.md §7:NeutralSession 存壳侧,内核的存储
// (pi 文件 / dsh session log)是「这个中立树的投影」。这是「壳不读内核存储」这条
// 不变量的最终落地——壳读自己的中立存储,不读 pi 文件/dsh 日志。
//
// 本层是纯存储(JSON 整读整写,会话树规模小),不依赖内核、不 import client。

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { NeutralSession } from "../../domain/session-neutral";

export class NeutralSessionStore {
  constructor(private readonly dir: string) {}

  private filePath(neutralSessionId: string): string {
    return join(this.dir, `${neutralSessionId}.json`);
  }

  /** 读一个中立会话树;不存在/损坏返回 null。 */
  get(neutralSessionId: string): NeutralSession | null {
    const file = this.filePath(neutralSessionId);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as NeutralSession;
    } catch {
      return null;
    }
  }

  /** 列某 cwd 下的全部中立会话(扫 *.json、按 header.cwd 过滤;损坏文件跳过)。
   *  §kernel-forkless-branch §27 阶段 A:中立层独立回答「某 cwd 有哪些会话」——
   *  这是阶段 D「list 读中立层」的前置能力。 */
  listByCwd(cwd: string): NeutralSession[] {
    if (!existsSync(this.dir)) return [];
    const result: NeutralSession[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const session = JSON.parse(readFileSync(join(this.dir, file), "utf-8")) as NeutralSession;
        if (session?.header?.cwd === cwd) result.push(session);
      } catch {
        // 损坏文件跳过,不中断枚举
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
