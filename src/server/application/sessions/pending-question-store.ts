// 挂起提问存储 —— ask 续问的「请求单」持久化(docs/design/ask-design.md §4.3)。
//
// 心智:提问 = 壳持有的持久请求单(协议本质是两个 step 之间缺一个 tool_result,§1.1),
// 内核进程只是投递通道。发起即落账,答案先落账再分发,无 TTL、无 expired。
// 一死问句只有一种:查无此单。
//
// 一单一文件(<dir>/<requestId>.json),同步读写:提问是低频事件,单写者(壳后端),
// 与 dsh-question-bridge 的 writeDshAnswer 同纪律(同步小文件写)。
// 零内核 import;路径由 bootstrap 注入(依赖倒置)。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingQuestionRecord, QuestionAnswer } from "@my-harness-desktop/shared";

/** requestId → 文件名(内核 id 可能含路径分隔等非法字符,收敛到安全集;`.` 保留——
 *  它不是路径分隔符,真正防穿越的是把 `/` 收掉)。 */
function fileOf(dir: string, requestId: string): string {
  return join(dir, `${requestId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

export class PendingQuestionStore {
  constructor(private readonly dir: string) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* 目录创建失败不致命,读写时再显形 */ }
  }

  /** 落账/更新一单(整份覆盖写)。 */
  put(record: PendingQuestionRecord): void {
    try {
      writeFileSync(fileOf(this.dir, record.requestId), JSON.stringify(record, null, 2), "utf-8");
    } catch (err) {
      console.error("[pending-question-store] 落账失败:", record.requestId, err instanceof Error ? err.message : String(err));
    }
  }

  /** 按 requestId 读单;不存在/损坏返回 null。 */
  get(requestId: string): PendingQuestionRecord | null {
    try {
      const raw = readFileSync(fileOf(this.dir, requestId), "utf-8");
      const parsed = JSON.parse(raw) as PendingQuestionRecord;
      return typeof parsed?.requestId === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  /** 列某会话的全部记录(按 createdAt 升序,水合重投序)。 */
  listBySession(neutralSessionId: string): PendingQuestionRecord[] {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: PendingQuestionRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(this.dir, entry), "utf-8")) as PendingQuestionRecord;
        if (parsed?.neutralSessionId === neutralSessionId && typeof parsed.requestId === "string") out.push(parsed);
      } catch { /* 坏文件跳过 */ }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** 结算一单(answers/cancelled + answeredAt);单不存在时 no-op。 */
  settle(requestId: string, status: "answered" | "cancelled", answers?: QuestionAnswer[]): void {
    const cur = this.get(requestId);
    if (!cur) return;
    this.put({ ...cur, status, answers, answeredAt: new Date().toISOString() });
  }

  /** 补标送达(分发成功后)。 */
  markDelivered(requestId: string): void {
    const cur = this.get(requestId);
    if (!cur) return;
    this.put({ ...cur, delivered: true });
  }

  /** 级联删某会话的全部记录(会话删除时调用)。 */
  deleteBySession(neutralSessionId: string): void {
    for (const record of this.listBySession(neutralSessionId)) {
      try { rmSync(fileOf(this.dir, record.requestId), { force: true }); } catch { /* 删不掉不致命 */ }
    }
  }

  /** 存在性判断(renderer/对账用;等价 get(req)!==null 的廉价版)。 */
  has(requestId: string): boolean {
    return existsSync(fileOf(this.dir, requestId));
  }

  /** 按 toolCallId 找 pending 记录(toolCallEnd 对账用;扫全目录,提问低频量级可接受)。 */
  findPendingByToolCallId(toolCallId: string): PendingQuestionRecord | null {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(this.dir, entry), "utf-8")) as PendingQuestionRecord;
        if (parsed?.status === "pending" && parsed.toolCallId === toolCallId) return parsed;
      } catch { /* 坏文件跳过 */ }
    }
    return null;
  }
}
