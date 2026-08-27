// 收藏快照的持久化存储 —— 壳自己的快照存储,不读内核存储。
//
// 依据 docs/design/bookmark-snapshot-fork-unify.md §3。快照是中立 `NeutralEntry[]` 的
// 物化拷贝(自包含),存项目级 `<cwd>/.my-harness-desktop/bookmarks/<id>.json`,
// 与内核存储格式无关。发起时经 seed 投影投到任意内核。
//
// 本层是纯文件 CRUD(整读整写,快照规模小),不依赖内核、不 import client,
// 镜像 NeutralSessionStore 的形状。目录(bookmarks 目录)由调用方按项目注入。

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseBookmarkSnapshot, serializeBookmarkSnapshot, type BookmarkSnapshot } from "@my-harness-desktop/shared";

export class BookmarkSnapshotStore {
  constructor(private readonly dir: string) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** 读一个快照;不存在/版本不符/损坏返回 null(调用方显式降级)。 */
  get(id: string): BookmarkSnapshot | null {
    const file = this.filePath(id);
    if (!existsSync(file)) return null;
    try {
      return parseBookmarkSnapshot(readFileSync(file, "utf-8"));
    } catch {
      return null;
    }
  }

  /** 列目录下全部快照(损坏跳过,不中断枚举;孤儿对账用)。 */
  list(): BookmarkSnapshot[] {
    if (!existsSync(this.dir)) return [];
    const out: BookmarkSnapshot[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        out.push(parseBookmarkSnapshot(readFileSync(join(this.dir, file), "utf-8")));
      } catch {
        // 损坏文件跳过
      }
    }
    return out;
  }

  /** 写一个快照(整文件覆盖)。 */
  put(snapshot: BookmarkSnapshot): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.filePath(snapshot.id), serializeBookmarkSnapshot(snapshot), "utf-8");
  }

  /** 删一个快照文件(取消收藏时回收)。 */
  delete(id: string): void {
    const file = this.filePath(id);
    if (existsSync(file)) rmSync(file);
  }
}
