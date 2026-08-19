// dsh-questions IPC —— 壳侧文件侧车桥的 main 进程端点（与 dsh ask 扩展经侧车文件通信）。
//
// 文件侧车桥方案（docs/design/goal-ask-pi-port.md 实现修订）：dsh ask 扩展写问句到
// ~/.pi/agent/.my-harness-desktop-questions/<requestId>.json 并轮询 <requestId>.answer.json；
// 本模块暴露 list（读目录返回活跃问句）与 answer（写答案文件）两条 IPC，renderer 轮询
// list、渲染选项、用户作答后调 answer 回填。不经 deepseek-harness 的 SDK server。
//
// 依赖方向只向内：api/ipc 是流入适配器，经 registerDshQuestionsIpc(ctx) 注入依赖。
import { ipcMain } from "electron";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MainContext } from "./main-context";

const QUESTIONS_DIR = join(homedir(), ".pi", "agent", ".my-harness-desktop-questions");

interface ActiveQuestion {
  requestId: string;
  sessionId: string;
  questions: unknown[];
}

/** 读目录，返回未回答的活跃问句（跳过 .answer.json 与坏文件）。 */
function listActiveQuestions(): ActiveQuestion[] {
  try {
    if (!existsSync(QUESTIONS_DIR)) return [];
    const out: ActiveQuestion[] = [];
    for (const entry of readdirSync(QUESTIONS_DIR)) {
      if (entry.endsWith(".answer.json")) continue;
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(QUESTIONS_DIR, entry), "utf8")) as ActiveQuestion;
        if (typeof parsed?.requestId === "string") out.push(parsed);
      } catch {
        // 坏文件跳过，下一轮 list 重试。
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeAnswer(requestId: string, answers: unknown): void {
  const p = join(QUESTIONS_DIR, `${requestId}.answer.json`);
  writeFileSync(p, JSON.stringify({ requestId, answers }), "utf8");
}

/** 注册 dsh 问询桥 IPC：dshQuestions:list / dshQuestions:answer。 */
export function registerDshQuestionsIpc(_ctx: MainContext): void {
  ipcMain.handle("dshQuestions:list", () => listActiveQuestions());
  ipcMain.handle("dshQuestions:answer", (_event, requestId: string, answers: unknown) => {
    try {
      writeAnswer(requestId, answers);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
