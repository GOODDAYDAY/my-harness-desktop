// 会话 JSONL writer —— 纯机制:把"rows 数据"写成生产格式的会话文件。
//
// rows 是去掉 id/parentId/timestamp/文件头的 JSONL 行(形状与生产条目一致,
// 见 src/core/domain/events/session-state.ts 的 sessionEntryToNeutral 消费契约)。
// writer 负责三类结构不变量:parentId 链、timestamp 单调、文件头五项齐全——
// 内容(文案/工具参数)全部来自数据,机制与内容分离。
//
// bucket/文件名规则与生产同源:cwdToBucketName 镜像 src/core/domain/sessions.ts
// (脚本不 import TS);文件名 <ISO>_<uuid>.jsonl 决定 llm-recorder 落盘对齐。
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

/** bucket 名规则与 src/core/domain/sessions.ts 的 cwdToBucketName 同源。 */
export function cwdToBucketName(cwd) {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** 会话文件路径: <agentDir>/sessions/<bucket>/<iso>_<uuid>.jsonl,自动建 bucket 目录。 */
export function sessionFilePath(agentDir, cwd, now = new Date()) {
  const bucket = cwdToBucketName(cwd);
  const dir = `${agentDir}/sessions/${bucket}`;
  mkdirSync(dir, { recursive: true });
  const iso = now.toISOString().replace(/[.:]/g, "-").replace("T", "-").slice(0, 19) + "Z";
  return `${dir}/${iso}_${randomUUID()}.jsonl`;
}

/** rows → 成品会话 JSONL 并落盘。ageHours:会话时间距"现在"的小时数(排序预算用)。
 *  message 行补默认字段(api/provider/model/message.timestamp/usage),数据已给的字段优先。
 *  usage 必须补:新版底座按轮聚合 usage 时直读 totalTokens,缺失即抛错
 *  (errorMessage: reading 'totalTokens'),整轮失败写成空 assistant——形状照抄底座
 *  错误 entry 自带的零值 usage。 */
export function writeSessionFile(agentDir, cwd, rows, ageHours = 0) {
  const base = Date.now() - ageHours * 3600_000;
  const entries = [];
  let lastId = null;

  entries.push({
    type: "session", version: 3, id: randomUUID(),
    timestamp: new Date(base).toISOString(), cwd,
  });

  rows.forEach((row, i) => {
    const id = randomUUID().slice(0, 8);
    const stamped = { ...row, id, parentId: lastId, timestamp: new Date(base + (i + 1) * 300).toISOString() };
    if (row.type === "message" && row.message && typeof row.message === "object") {
      stamped.message = {
        api: "openai-completions", provider: "provider-1", model: "model-1.1",
        ...row.message,
        usage: row.message.usage ?? zeroUsage(),
        timestamp: Date.now() + i,
      };
    }
    entries.push(stamped);
    lastId = id;
  });

  const path = sessionFilePath(agentDir, cwd, new Date(base));
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  return path;
}

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** 从会话 rows 提取 llm-logs 配对文案:首条 user 文本 + 末条 end_turn assistant 文本。 */
export function sessionLogTexts(rows) {
  const textOf = (content) => (Array.isArray(content) ? content : [])
    .filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("");
  let user = null;
  let done = null;
  for (const row of rows) {
    if (row.type !== "message" || !row.message) continue;
    const m = row.message;
    if (m.role === "user" && user === null) user = textOf(m.content);
    if (m.role === "assistant" && m.stopReason === "end_turn") done = textOf(m.content);
  }
  return { user: user ?? "", done: done ?? "" };
}
