// minimal 工具注册表 —— 内置工具(schema + 实现 + 档位),独立模块,零壳依赖。
//
// 依据 docs/design/minimal-kernel.md §5。工具 = 对模型的 schema(name/description/parameters)
// + 对执行的实现(run: 进 JSON 出 JSON)。档位(§5.7)是语义字段:readOnly / write / dangerous,
// 决定默认开还是关。工具集(§5.5)是工具的命名分组,setTools 切活跃集。

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * 工具定义。parameters 是 JSON Schema(面向模型),run 是执行实现(面向内核)。
 * grade: readOnly(默认开) / write(默认开) / dangerous(默认关,需显式启用)。
 */
export const TOOLS = {
  read: {
    name: "read",
    description: "读一个文件的内容(UTF-8)。",
    grade: "readOnly",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run: (args) => ({ text: readFileSync(String(args.path), "utf-8") }),
  },
  list: {
    name: "list",
    description: "列一个目录下的文件/子目录名。",
    grade: "readOnly",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run: (args) => ({ entries: readdirSync(String(args.path)).sort() }),
  },
  write: {
    name: "write",
    description: "写一个文件(覆盖写,UTF-8)。",
    grade: "write",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    run: (args) => { writeFileSync(String(args.path), String(args.content), "utf-8"); return { ok: true }; },
  },
  bash: {
    name: "bash",
    description: "执行一条 shell 命令,返回 stdout/stderr/exitCode。危险工具,默认关闭。",
    grade: "dangerous",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    run: (args) => {
      const out = execFileSync("bash", ["-c", String(args.command)], { encoding: "utf-8", timeout: 30000 });
      return { stdout: out, exitCode: 0 };
    },
  },
};

/** 内置工具集(§5.5):read-only = 只读,write = 只读+写,full = 全部(含危险)。 */
export const TOOL_SETS = {
  "read-only": ["read", "list"],
  "write": ["read", "list", "write"],
  "full": ["read", "list", "write", "bash"],
};

/** 活跃工具集的工具名集合(§5.4/§5.5)。缺省 read-only(危险默认关,§5.7)。 */
let activeSet = "read-only";

export function setActiveToolSet(set) {
  if (!TOOL_SETS[set]) throw new Error(`工具集不存在: ${set}`);
  activeSet = set;
}

/** 当前活跃工具集的 id（`read-only`/`write`/`full`）。头行 `tools` 快照与 sessionStart 事件
 *  都报这个值——同一个量只有一处算（此前头行写的是"用户传进来的字符串"，没校验过是否存在）。 */
export function activeToolSetId() {
  return activeSet;
}

export function activeToolNames() {
  return TOOL_SETS[activeSet] ?? [];
}

/** 活跃工具的 schema 清单(注入模型请求,§5.2)。 */
export function activeToolSchemas() {
  return activeToolNames().map((n) => ({ type: "function", function: { name: TOOLS[n].name, description: TOOLS[n].description, parameters: TOOLS[n].parameters } }));
}

/** 执行一个工具(§5.3):按 name 查注册表,进 JSON 出 JSON;失败/未知名返回 isError 结果。 */
export function executeTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) return { isError: true, error: `unknown tool: ${name}` };
  try {
    return tool.run(args ?? {});
  } catch (e) {
    return { isError: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 全部工具清单(listTools 用,§5.6):name/description/档位。 */
export function listTools() {
  return Object.values(TOOLS).map((t) => ({ name: t.name, description: t.description, source: "builtin", grade: t.grade }));
}

/** 插件注册工具(§5.9.2):往注册表加工具,内置与插件同构、同注册表。 */
export function registerTool(name, tool) {
  TOOLS[name] = tool;
}

/** 插件卸载撤工具(§6.4.2):从注册表撤掉,不留孤儿。 */
export function unregisterTool(name) {
  delete TOOLS[name];
}
