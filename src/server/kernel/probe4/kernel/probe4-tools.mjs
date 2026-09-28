// probe4 工具注册表 —— 内置工具(schema + 实现 + 档位),独立模块,零壳依赖。
//
// 依据 docs/design/probe4-kernel.md §5。工具 = 对模型的 schema(name/description/parameters)
// + 对执行的实现(run: 进 JSON 出 JSON)。档位(§5.7)是语义字段:readOnly / write / dangerous,
// 决定默认开还是关。工具集(§5.5)是工具的命名分组,setTools 切活跃集。
//
// **本模块的两条硬纪律（都是文档点名、而此前没做到的）**：
//
// ① 工具必须**异步执行 + 有强制超时**（§5.3.2）。文档原话：超时「必须是被强制的，不是等工具
//    自己返回……没有这个强制，一个 bash 跑 `while true` 或读一个永不返回的 pipe，
//    会把整个 probe4 进程永久卡死，超时机制无从触发」。
//    此前用 `execFileSync` —— 同步阻塞。它不只是"工具不会超时"，而是**整个 CLI 事件循环被占住**，
//    连 stdin 都读不到；于是 §4.6.2 写明的语义（"用户点 abort 时，一个正在跑的 bash 会自己跑完
//    或到超时被 kill；abort 只保证执行完当前工具不再进下一轮"）**根本不成立**：abort 命令压根
//    进不来，CLI 在 bash 跑完之前是聋的。同步执行与文档语义直接冲突，不是"少了个超时参数"。
//
// ② `write` 是**受控写：限定在项目目录内**（§5.7.1）。此前是裸 `writeFileSync(String(args.path))`，
//    绝对路径与 `..` 都能写穿项目目录——而文档对它的承诺是"受控"，档位也标的是 write 不是 dangerous。

import { readFile, writeFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

/** per-tool 超时默认值（§5.3.2：默认 30 秒，超时强制终止）。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** 项目根（write 的受控范围）。由 CLI 从 `--cwd` 注入；缺省 = 当前进程 cwd。 */
let projectRoot = process.cwd();

/** 设置项目根（§5.7.1 受控写的边界）。CLI 解析完 argv 后调一次。 */
export function setProjectRoot(root) {
  projectRoot = resolve(root);
}

/** 当前项目根（测试与报错文案用）。 */
export function getProjectRoot() {
  return projectRoot;
}

/**
 * 把一个 path 参数解析成**项目内**的绝对路径；越界则抛。
 * 用 `relative` 判定而不是 `startsWith(projectRoot)`：后者会把 `/proj-evil` 当成 `/proj` 内部
 * （前缀相同但不是子目录），这正是路径门最常见的一个假阴性。
 */
function resolveInsideProject(p) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(projectRoot, p);
  const rel = relative(projectRoot, abs);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error(`路径越界:${p} 不在项目目录内(${projectRoot})——write 是受控写(§5.7.1)`);
  }
  return abs;
}

/** 工具超时的哨兵错误（与工具自身的失败区分：超时要额外说明"已强制终止"）。 */
class ToolTimeoutError extends Error {}

export function isToolTimeout(e) {
  return e instanceof ToolTimeoutError;
}

/**
 * 带**强制超时**的执行包装（§5.3.2）。
 * 超时时：① kill 该工具起的全部子进程（`spawns`）；② 以 ToolTimeoutError 收口，让上层落成 isError 结果。
 * 不直接 `Promise.race` 丢下工具 promise —— 那会留下"还在跑但没人管"的孤儿（bash 尤其致命）。
 */
function withTimeout(promise, spawns, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      for (const child of spawns) { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }
      reject(new ToolTimeoutError(`工具超时(${timeoutMs}ms)，已强制终止其子进程`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 工具定义。parameters 是 JSON Schema(面向模型),run 是执行实现(面向内核)。
 * grade: readOnly(默认开) / write(默认开) / dangerous(默认关,需显式启用)。
 * run 签名 `async (args, ctx) => result`：ctx.spawns 里登记的子进程会被超时包装接管（可被 kill）。
 */
export const TOOLS = {
  read: {
    name: "read",
    description: "读一个文件的内容(UTF-8)。",
    grade: "readOnly",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    // 异步读（fs/promises）：同步 readFileSync 读一个永不返回的 pipe 会把事件循环占死，
    // 超时包装再强也触发不了 —— 这正是 §5.3.2「取消它挂起的 IO」对实现的要求。
    run: async (args) => ({ text: await readFile(String(args.path), "utf-8") }),
  },
  list: {
    name: "list",
    description: "列一个目录下的文件/子目录名。",
    grade: "readOnly",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    run: async (args) => ({ entries: (await readdir(String(args.path))).sort() }),
  },
  write: {
    name: "write",
    description: "写一个文件(覆盖写,UTF-8)。受控写:只能写项目目录内。",
    grade: "write",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    run: async (args) => {
      const target = resolveInsideProject(String(args.path));
      await writeFile(target, String(args.content), "utf-8");
      return { ok: true, path: target };
    },
  },
  bash: {
    name: "bash",
    description: "执行一条 shell 命令,返回 stdout/stderr/exitCode。危险工具,默认关闭。",
    grade: "dangerous",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    run: (args, ctx) =>
      new Promise((resolvePromise, reject) => {
        // 异步 execFile：bash 跑的时候 CLI 仍能读 stdin（否则 abort 命令进不来，§4.6.2 的语义
        // 就是空的）。子进程登记进 ctx.spawns，超时包装据此 kill 它。
        const child = execFile(
          "bash",
          ["-c", String(args.command)],
          { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => {
            ctx.spawns.delete(child);
            if (err && err.killed) return reject(new Error(`命令超时/被终止: ${String(args.command)}`));
            // 非零退出是**结果**不是异常（§5.3.2：失败也是结果，要回喂给模型）。
            if (err && typeof err.code !== "number") return reject(err);
            resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode: typeof err?.code === "number" ? err.code : 0 });
          },
        );
        ctx.spawns.add(child);
      }),
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

/**
 * 执行一个工具(§5.3)：按 name 查注册表，进 JSON 出 JSON；未知名/失败/超时都返回 isError 结果。
 * **异步**——工具本身是异步的，且执行完才回喂模型。
 */
export async function executeTool(name, args, { timeoutMs = DEFAULT_TOOL_TIMEOUT_MS } = {}) {
  const tool = TOOLS[name];
  if (!tool) return { isError: true, error: `unknown tool: ${name}` };
  const spawns = new Set();
  try {
    return await withTimeout(Promise.resolve(tool.run(args ?? {}, { spawns })), spawns, timeoutMs);
  } catch (e) {
    if (e instanceof ToolTimeoutError) return { isError: true, error: e.message, timeout: true };
    return { isError: true, error: e instanceof Error ? e.message : String(e) };
  } finally {
    // 兜底：无论如何不留孤儿子进程（正常路径里回调已把它们移出集合）。
    for (const child of spawns) { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }
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
