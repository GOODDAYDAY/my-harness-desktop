// dsh 提问桥 —— dsh ask 扩展的文件侧车桥在适配器层的收编。
//
// 依据 docs/design/ask-transfer-layer.md §5/§6.1。dsh ask 扩展写问句到
// ~/.pi/agent/.my-harness-desktop-questions/<requestId>.json 并轮询 <requestId>.answer.json；
// 本模块在适配器层完成翻译归位：fs.watch 监听问句目录 → 投中性提问(事件驱动,不再 renderer 轮询)；
// answer 写答案文件(文件侧车桥被封装进 client/dsh,替换时桌面无感)。
//
// 全局单例(非 per-session):dsh 的 sessionId 由服务端惰性创建,per-backend 无法可靠过滤问句归属,
// 故桥对目录全量扫描、按 requestId 去重投递,与文件侧车桥现状(取第一个问句)语义一致。
// 零 import dsh 内核包,只用 node 内建模块。

import { watch, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Question, QuestionAnswer } from "@my-harness-desktop/shared";

export const DSH_QUESTIONS_DIR = join(homedir(), ".pi", "agent", ".my-harness-desktop-questions");

/** 一条 dsh 提问(文件侧车桥读出后投递的中性形状;sessionId 供归属诊断,renderer 不消费)。 */
export interface DshQuestionRequest {
  requestId: string;
  sessionId: string;
  questions: Question[];
}

const questionPath = (requestId: string): string => join(DSH_QUESTIONS_DIR, `${requestId}.json`);
const answerPath = (requestId: string): string => join(DSH_QUESTIONS_DIR, `${requestId}.answer.json`);

/** 写答案文件(dsh ask 扩展轮询读取后回灌模型)。契约单源:DshBackend.answerQuestion 与桥共用。 */
export function writeDshAnswer(requestId: string, answers: QuestionAnswer[]): void {
  writeFileSync(answerPath(requestId), JSON.stringify({ requestId, answers }), "utf8");
}

/**
 * dsh 提问桥:监听问句目录,把新问句翻译成中性提问投给订阅方;answer 写答案文件。
 * 由 bootstrap 装配为单例,提问事件经 session-store 的 injectQuestion 汇入统一中性通道。
 */
export class DshQuestionBridge {
  private watcher: FSWatcher | null = null;
  private emitted = new Set<string>();
  private listeners = new Set<(req: DshQuestionRequest) => void>();

  /** 启动监听:先确保目录存在、全量扫描,再 fs.watch 目录(事件驱动,不轮询)。 */
  start(): void {
    try { mkdirSync(DSH_QUESTIONS_DIR, { recursive: true }); } catch { /* 目录创建失败不致命 */ }
    this.scan();
    if (this.watcher) return;
    this.watcher = watch(DSH_QUESTIONS_DIR, { persistent: false }, () => this.scan());
    this.watcher.on("error", (err) => {
      console.error("[dsh-question-bridge] 目录监听错误:", err instanceof Error ? err.message : String(err));
    });
  }

  /** 扫描目录,投递未 emit 过的新问句(坏文件跳过,下一轮重试)。 */
  private scan(): void {
    let entries: string[];
    try {
      entries = readdirSync(DSH_QUESTIONS_DIR);
    } catch {
      return; // 目录尚不存在,下次事件再扫
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.endsWith(".answer.json")) continue;
      const requestId = entry.slice(0, -".json".length);
      if (this.emitted.has(requestId)) continue;
      try {
        const parsed = JSON.parse(readFileSync(questionPath(requestId), "utf8")) as Partial<DshQuestionRequest>;
        if (typeof parsed?.requestId !== "string" || parsed.requestId !== requestId) continue;
        this.emitted.add(requestId);
        const req: DshQuestionRequest = {
          requestId: parsed.requestId,
          sessionId: String(parsed.sessionId ?? ""),
          questions: Array.isArray(parsed.questions) ? (parsed.questions as Question[]) : [],
        };
        for (const cb of this.listeners) {
          try { cb(req); } catch (err) { console.error("[dsh-question-bridge] 监听器抛错已隔离:", err); }
        }
      } catch {
        // 坏文件跳过,下次事件重试
      }
    }
  }

  /** 订阅新问句。返回取消函数。 */
  onQuestion(cb: (req: DshQuestionRequest) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 写答案文件(dsh ask 扩展轮询读取)。 */
  answer(requestId: string, answers: QuestionAnswer[]): void {
    writeDshAnswer(requestId, answers);
  }

  /** 停止监听。 */
  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    this.listeners.clear();
    this.emitted.clear();
  }
}
