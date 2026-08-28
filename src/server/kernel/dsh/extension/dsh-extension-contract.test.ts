// fit 扩展的「全局指令注入」契约回归单测(读源文本,不 import——扩展 import dsh 内核包,
// 壳 vitest 环境不可解析)。dsh 的 agent-instructions 插件把 `source.kind==='agent-instructions'`
// + `baseline:true` 视为「工作区基线」专属标记,反查后直接读 `changes` 字段(visibleBaseline.
// changes.flatMap)。壳扩展注入全局 ~/.claude 指令时误用该标记却从不带 changes/baselineIdentity
// → dsh 第二回合在 flatMap 处 changes=undefined 整回合崩溃(「dsh 不能发送第二条语句」的根因,
// 本地 deepseek-harness 源码裸 RPC 复现:去掉壳扩展后第二回合正常)。
// 契约:壳扩展注入模型可见的全局指令必须用独立 source kind,不得碰 agent-instructions 基线标记。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "dsh-extension", "index.mjs");

describe("fit 扩展全局指令注入契约(不得占用 dsh 基线命名空间)", () => {
  it("注入的上下文消息 source 不得是 agent-instructions + baseline:true(dsh 基线专属标记)", () => {
    const src = readFileSync(EXTENSION, "utf8");
    // 精确匹配旧 bug 形态:kind='agent-instructions' 且 baseline:true 且无 changes 字段。
    // 用宽松正则抓「agent-instructions 与 baseline:true 同框」即可——任何这样的注入都会
    // 触发 dsh 的 visibleBaseline.changes.flatMap 崩溃(壳扩展从不带 changes)。
    const forbidden = /kind:\s*["']agent-instructions["'][^}]*baseline:\s*true/s.test(src);
    expect(forbidden).toBe(false);
  });

  it("注入的上下文消息必须用独立 plugin kind(不识别为基线、不进壳时间线气泡)", () => {
    const src = readFileSync(EXTENSION, "utf8");
    // 修复后的形态:plugin kind + 插件名。模型仍可见(非 user 不进壳翻译层),但 dsh 不视为基线。
    expect(src).toMatch(/source:\s*\{\s*kind:\s*["']plugin["'],\s*plugin:\s*["']my-harness-fit-dsh-extension["']/);
  });
});
