// 种子会话生成器 —— 手写成品会话 JSONL 的结构化生成,供隔离 HOME 预置。
//
// 为什么结构化生成而不是手写 JSONL 字符串:parentId 链、toolCall id↔toolCallId
// 配对、timestamp 单调这些一致性由代码保证,文案是数据——机制与内容分离。
// 格式契约与生产会话一致(见 src/core/domain/events/session-state.ts 的
// sessionEntryToNeutral:message/custom_message/model_change/thinking_level_change/
// label/session_info 等 → NeutralMessage),scanner 与 timeline 消费零差异。
//
// 三条会话:
//   todo 主线  —— 「加 --due 参数」完整干活过程,覆盖全渲染形态,时间"刚干完"
//   todo 旧会话 —— 「修复重复项 bug」,几天前,短对话
//   notes-site —— 第二项目会话,几天前,短对话
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

/** bucket 名规则与 src/core/domain/sessions.ts 的 cwdToBucketName 同源(脚本不 import TS)。 */
export function cwdToBucketName(cwd) {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** 会话文件路径: <agentDir>/sessions/<bucket>/<iso>_<uuid>.jsonl。
 *  文件名格式与生产一致(决定 llm-recorder 落盘对齐,见 llm-recorder-design.md)。
 *  自动创建 bucket 目录。 */
export function sessionFilePath(agentDir, cwd, now = new Date()) {
  const bucket = cwdToBucketName(cwd);
  const dir = `${agentDir}/sessions/${bucket}`;
  mkdirSync(dir, { recursive: true });
  const iso = now.toISOString().replace(/[.:]/g, "-").replace("T", "-").slice(0, 19) + "Z";
  const name = `${iso}_${randomUUID()}.jsonl`;
  return `${dir}/${name}`;
}

/** 主线会话对应的 llm-logs 记录(种子)。与 buildMainSession 同 seq 配对。
 *  落盘 <cwd>/.pi-desktop/llm-logs/<会话文件名>(文件名与 llm-recorder-design.md §3.1 对齐)。
 *  记录格式:seq/ts/kind:request|response/turnIndex/status/durationMs,见 llm-recorder-design.md §3.2。 */
export function buildMainSessionLogs(locale, sessionFileName) {
  const t = textFor(locale);
  const base = Date.now() - 24 * 3600_000;
  const lines = [
    { seq: 1, ts: base, kind: "request", turnIndex: 0, payload: { model: "model-1.1", messages: [{ role: "user", content: t.main.user }] } },
    { seq: 1, ts: base + 2100, kind: "response", status: 200, durationMs: 2100, message: { role: "assistant", content: t.main.done } },
  ];
  return { fileName: sessionFileName.split(/[\\/]/).pop(), lines };
}

/** 4.4 工具调度板块的独立种子会话变体:预置一条"被拦截的写操作"红条。
 *  与主线会话不共享(各板块独立隔离 HOME)——4.2 的纯成功叙事不受污染。
 *  真实模型往返成功时画面是 live 的;失败(soft 降级)时落到本变体的红条画面。
 *  设计文档 §4.4 / QA。 */
export function buildBlockedSession(locale, cwd) {
  const t = textFor(locale);
  const w = makeWriter(cwd, 3600_000); // 1 小时前
  w.session();
  w.modelChange("provider-1", "model-1.1");
  w.thinkingLevelChange("high");
  w.message("user", [{ type: "text", text: t.blocked.user }]);
  w.sessionInfo(t.blocked.sessionName);
  w.message("assistant", [
    { type: "text", text: t.blocked.reply },
    toolCall("call_b1", "write", { path: "README.md", content: "# todo\n" }),
  ], "toolUse");
  w.toolResultError("call_b1", "write", t.blocked.blockedOut);
  w.message("assistant", [{ type: "text", text: t.blocked.after }], "end_turn");
  return w.join();
}

/** 会话 JSONL 内容生成。cwd 是隔离 HOME 里的 fixture 项目路径(运行时已知)。 */
export function buildMainSession(locale, cwd) {
  const t = textFor(locale);
  const w = makeWriter(cwd);
  w.session();
  w.modelChange("provider-1", "model-1.1");
  w.thinkingLevelChange("high");
  w.message("user", [{ type: "text", text: t.main.user }]);
  w.sessionInfo(t.main.sessionName);
  w.message("assistant", [
    { type: "thinking", thinking: t.main.think1, thinkingSignature: "reasoning_content" },
    { type: "text", text: t.main.plan1 },
    toolCall("call_01", "find", { pattern: "**/*.py" }),
  ], "toolUse");
  w.toolResult("call_01", "find", [
    { type: "text", text: "main.py\ntests/test_main.py\nREADME.md" },
  ]);
  w.message("assistant", [
    { type: "text", text: t.main.plan2 },
    toolCall("call_02", "read", { path: "main.py" }),
  ], "toolUse");
  w.toolResult("call_02", "read", [
    { type: "text", text: t.main.mainPy },
  ]);
  w.message("assistant", [
    { type: "thinking", thinking: t.main.think2, thinkingSignature: "reasoning_content" },
    { type: "text", text: t.main.plan3 },
    toolCall("call_03", "bash", { command: t.main.bashCmd }),
  ], "toolUse");
  w.toolResult("call_03", "bash", [
    { type: "text", text: t.main.bashOut },
  ]);
  w.message("assistant", [{ type: "text", text: t.main.done }], "end_turn");
  w.label("main-demo-pin"); // 图钉:已落钉一条(板块 4.7 演示"继续加")
  return w.join();
}

/** 旧会话:「修复重复项 bug」,几天前。 */
export function buildOldSession(locale, cwd) {
  const t = textFor(locale);
  const w = makeWriter(cwd, 3 * 24 * 3600_000); // 3 天前
  w.session();
  w.modelChange("provider-1", "model-1.1");
  w.thinkingLevelChange("high");
  w.message("user", [{ type: "text", text: t.old.user }]);
  w.sessionInfo(t.old.sessionName);
  w.message("assistant", [
    { type: "text", text: t.old.reply },
    toolCall("call_11", "grep", { pattern: "duplicate", path: "main.py" }),
  ], "toolUse");
  w.toolResult("call_11", "grep", [
    { type: "text", text: t.old.grepOut },
  ]);
  w.message("assistant", [{ type: "text", text: t.old.done }], "end_turn");
  w.label("old-bug-pin");
  return w.join();
}

/** 第二项目会话:notes-site 加搜索。 */
export function buildSiteSession(locale, cwd) {
  const t = textFor(locale);
  const w = makeWriter(cwd, 2 * 24 * 3600_000); // 2 天前
  w.session();
  w.modelChange("provider-1", "model-1.1");
  w.message("user", [{ type: "text", text: t.site.user }]);
  w.sessionInfo(t.site.sessionName);
  w.message("assistant", [
    { type: "text", text: t.site.reply },
    toolCall("call_21", "edit", { path: "search.ts", content: t.site.editContent }),
  ], "toolUse");
  w.toolResult("call_21", "edit", [
    { type: "text", text: t.site.editOut },
  ]);
  w.message("assistant", [{ type: "text", text: t.site.done }], "end_turn");
  return w.join();
}

// ── 文案(locale 双语)──────────────────────────────────────────────

function textFor(locale) {
  const zh = locale === "zh-CN";
  return {
    main: {
      user: zh
        ? "给 todo 项目加一个 `--due` 参数，支持按截止日期过滤，超过期限的标出来"
        : "Add a `--due` argument to the todo project to filter by due date and flag overdue items",
      sessionName: zh ? "加 --due 截止日期过滤" : "Add --due due-date filter",
      think1: zh
        ? "用户要在 todo CLI 里加 `--due` 参数。先看项目结构，确认参数解析和 list 逻辑在哪，再动手。"
        : "The user wants a `--due` flag in the todo CLI. Let me look at the project structure first to find argument parsing and the list logic.",
      plan1: zh ? "我先看一下项目结构，找到参数解析和 list 的位置。" : "Let me check the project structure to find argument parsing and list.",
      plan2: zh
        ? "参数在 main.py 里用 argparse 解析，list 命令走同一个入口。我读一下代码确认改动点。"
        : "Arguments are parsed with argparse in main.py, and list goes through the same entry. Let me read the code to confirm where to change.",
      think2: zh
        ? "参数解析在 argparse，list 输出在 parse_args 之后。加 --due 的思路：解析时收一个可选日期，list 时过滤 due 晚于该日期的项，并标注过期项。"
        : "Parsing happens in argparse, list output after parse_args. Plan: accept an optional date, filter items whose due is after it, and mark overdue ones.",
      plan3: zh ? "方案定了：加 `--due` 参数，list 时按截止日期过滤，过期项标红。我直接改。" : "Plan set: add `--due`, filter the list by due date, mark overdue in red. Let me make the change.",
      bashCmd: "python main.py list --due 2026-08-01 && python -m pytest -q",
      bashOut: "todo list --due 2026-08-01\n[1] buy milk (due 2026-07-20) ⚠ overdue\n[3] water plants (due 2026-07-25)\n3 passed in 0.42s",
      mainPy: "# main.py — todo CLI\nimport argparse\n\ndef add(parser):\n    parser.add_argument(\"text\", nargs=\"+\")\n\ndef list_tasks(tasks):\n    for i, t in enumerate(tasks, 1):\n        print(f\"[{i}] {t['text']}\")\n\ndef main():\n    p = argparse.ArgumentParser()\n    sub = p.add_subparsers(dest=\"cmd\")\n    sub.add_parser(\"add\")\n    list_p = sub.add_parser(\"list\")\n    list_p.add_argument(\"--due\")\n    args = p.parse_args()\n    if args.cmd == \"list\":\n        list_tasks(load())\n",
      done: zh
        ? "完成。`todo list --due 2026-08-01` 现在只显示截止在 8/1 之前的任务，过期项带 ⚠ 标记；测试补了 3 条，全绿。"
        : "Done. `todo list --due 2026-08-01` now only shows tasks due before 8/1, overdue items carry a ⚠ mark; 3 tests added, all green.",
    },
    old: {
      user: zh ? "todo list 里重复项很多，去重一下" : "todo list has lots of duplicates — dedupe them",
      sessionName: zh ? "修复重复项 bug" : "Fix duplicate items bug",
      reply: zh ? "先查一下去重逻辑在哪。" : "Let me find where dedup should live.",
      grepOut: "def load():\n    tasks = []\n    for line in read_db():\n        tasks.append(parse(line))\n    return tasks  # 未去重",
      done: zh ? "改好了：load() 里加了个按文本去重的 set，重复项只留一条。" : "Fixed: added a text-keyed set in load() so each item appears once.",
    },
    site: {
      user: zh ? "给 notes-site 加个站内搜索" : "Add site search to notes-site",
      sessionName: zh ? "notes-site 加搜索" : "Add search to notes-site",
      reply: zh ? "翻了一下，页面渲染在 search.ts。加一个简单的标题过滤就行。" : "Rendering lives in search.ts. A simple title filter will do.",
      editContent: "export function search(items, q) {\n  return items.filter((i) => i.title.includes(q));\n}",
      editOut: "applied patch to search.ts (1 insert)",
      done: zh ? "done——搜索框输入关键词即时过滤标题，已联调。" : "done — typing in the search box filters titles live.",
    },
    blocked: {
      user: zh ? "往 README.md 加一行用法说明" : "Add a usage line to README.md",
      sessionName: zh ? "只读模式下被拦了一次" : "Blocked once in read-only mode",
      reply: zh ? "我来给 README 加一行用法说明。" : "I'll add a usage line to the README.",
      blockedOut: "❌ blocked: tool 'write' is disabled (read-only mode).\nAllowed tools: read, grep, ls, find",
      after: zh ? "被拦住了——当前工具组只开放 read-only，写操作没权限。" : "Blocked — the current tool group only allows read-only tools.",
    },
  };
}

// ── JSONL writer(parentId 链 / timestamp 单调由构造保证)────────────────

function makeWriter(cwd, offsetMs = 0) {
  const entries = [];
  let lastId = null;
  const base = Date.now() - offsetMs;

  const push = (obj) => {
    const id = randomUUID().slice(0, 8);
    entries.push({ ...obj, id, parentId: lastId, timestamp: new Date(base + entries.length * 300).toISOString() });
    lastId = id;
  };

  return {
    session() {
      // 文件头:type session(带 id/timestamp/cwd;custom 由 desktop 补写,种子不带)
      entries.push({
        type: "session", version: 3, id: randomUUID(),
        timestamp: new Date(base).toISOString(), cwd,
      });
    },
    modelChange(provider, modelId) {
      push({ type: "model_change", provider, modelId });
    },
    thinkingLevelChange(level) {
      push({ type: "thinking_level_change", thinkingLevel: level });
    },
    sessionInfo(name) {
      push({ type: "session_info", name });
    },
    message(role, content, stopReason = "end_turn") {
      push({
        type: "message",
        message: {
          role, content,
          api: "openai-completions", provider: "provider-1", model: "model-1.1",
          stopReason,
          timestamp: Date.now() + entries.length,
        },
      });
    },
    toolResult(toolCallId, toolName, content) {
      push({
        type: "message",
        message: {
          role: "toolResult", toolCallId, toolName, content,
          isError: false, timestamp: Date.now() + entries.length,
        },
      });
    },
    toolResultError(toolCallId, toolName, content) {
      push({
        type: "message",
        message: {
          role: "toolResult", toolCallId, toolName, content,
          isError: true, timestamp: Date.now() + entries.length,
        },
      });
    },
    label(label) {
      push({ type: "label", label });
    },
    join() {
      return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    },
  };
}

function toolCall(id, name, arguments_) {
  return { type: "toolCall", id, name, arguments: arguments_ };
}
