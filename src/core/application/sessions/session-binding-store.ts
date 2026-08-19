// 会话身份持久化映射表 —— core/application,中立会话 id → 私有会话 id 的绑定。
//
// 依据 docs/design/session-neutral-layer.md §14–§16。映射表是「会话坐标中立化」的落地载体:
// 没有它,neutralSessionId 就只是另一个不稳定 id;有了它,pi→dsh→pi 来回切才能找回原会话。
//
// 一行 = 一个内核下的一次绑定。主键 (neutralSessionId, kernel) 唯一。JSONL 追加写不锁全文件,
// 与项目现有会话存储同款纪律。映射表是壳的用例编排,内核不知道它的存在。

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { KernelId } from "../../domain/kernel";
import type { KernelSessionBinding } from "../../domain/session-neutral";

export class SessionBindingStore {
  constructor(private readonly dir: string) {}

  private get filePath(): string {
    return join(this.dir, "bindings.jsonl");
  }

  private readAll(): KernelSessionBinding[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return readFileSync(this.filePath, "utf-8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as KernelSessionBinding);
    } catch {
      return [];
    }
  }

  /** 按 (neutralSessionId, kernel) 查绑定;命中返回,否则 null。 */
  get(neutralSessionId: string, kernel: KernelId): KernelSessionBinding | null {
    return this.readAll().find((b) => b.neutralSessionId === neutralSessionId && b.kernel === kernel) ?? null;
  }

  /** 写一行绑定(同主键去重,保留最新)。 */
  put(binding: KernelSessionBinding): void {
    const rest = this.readAll().filter(
      (b) => !(b.neutralSessionId === binding.neutralSessionId && b.kernel === binding.kernel),
    );
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.filePath, [...rest, binding].map((b) => JSON.stringify(b)).join("\n") + "\n", "utf-8");
  }

  /** 删一个中立会话的全部绑定行(删会话时级联)。 */
  deleteBySession(neutralSessionId: string): void {
    const rest = this.readAll().filter((b) => b.neutralSessionId !== neutralSessionId);
    if (rest.length === 0) {
      if (existsSync(this.filePath)) rmSync(this.filePath);
      return;
    }
    writeFileSync(this.filePath, rest.map((b) => JSON.stringify(b)).join("\n") + "\n", "utf-8");
  }
}
