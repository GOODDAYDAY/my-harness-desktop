/**
 * tool-gate —— pi 底座 extension:会话级工具白名单的实际执行者 + 工具清单播报员。
 *
 * 职责一(过滤):desktop tool-manager Apply → 会话头行 custom-pi-desktop.toolConfig.enabledToolIds
 * (组展开在 desktop 侧已完成,契约不回退,见 domain SessionToolConfig)→ 本 extension 读头行
 * → pi.setActiveTools。未注册名在写 desktop 侧已对齐底座,setActiveTools 前再过滤一次兜底。
 *
 * 职责二(播报,docs/design/tool-manager-design.md §4.4):session_start/turn_start 把
 * pi.getAllTools() 全量清单写侧车文件 ~/.pi/agent/desktop-known-tools.json(按 cwd 分桶),
 * 桌面经 kernel:knownTools IPC 读取——工具发现的权威来源,替代"toolCallStart 事件被动收集"
 * 的过渡形态。sourceInfo 映射在本侧完成,底座内部结构不泄漏给桌面。
 *
 * 为什么自己读文件而不走 ctx.sessionManager.getHeader():desktop 在会话运行中改头行
 * (updateSessionHeader),sessionManager 缓存的是 spawn 时读的那份——自己读文件才能拿到
 * desktop 刚写的最新值。
 *
 * 触发点:过滤挂 session_start(新会话/切换会话)+ turn_start(每个 turn 开头重读;排序指纹
 * 防抖,无变化不 setActiveTools)。读 8KB 头行窗口的开销可忽略,换来"Apply 后下一个
 * turn 生效"。播报只挂 turn_start:bus/subagent 等扩展把 registerTool 门控在与 desktop 的
 * 握手之后(ping 探测,裸 pi 优雅退化),session_start 时扩展工具尚未注册,getAllTools()
 * 只有核心 7 个——此时播报会把 byCwd 里的好桶回写成残缺集(热进程每次 spawn 都退化一次),
 * turn_start 时握手早已完成,集合才是权威。
 *
 * 类型不 import 官方 @earendil-works/pi-coding-agent(类型包在底座 node_modules,仓库
 * tsconfig 够不到)——手写用到的窄结构,保持本文件在仓库 typecheck 视野内。本文件由
 * client/pi/toolgate-installer.ts 在 app 启动时同步到 ~/.pi/agent/extensions/tool-gate/。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** domain SessionToolConfig 的只读镜像(落头行 custom-pi-desktop.toolConfig 保留键;desktop 侧 domain/sessions.ts 是契约唯一源)。
 *  v7 起无 mode 字段:enabledToolIds 存在即过滤,显式空数组 = 全禁。 */
interface SessionToolConfig {
  enabledGroupIds?: string[];
  enabledToolIds?: string[];
}

interface ToolGateContext {
  sessionManager: {
    getSessionFile(): string | undefined;
  };
}

interface ToolGateApi {
  on(event: "session_start" | "turn_start", handler: (event: unknown, ctx: ToolGateContext) => unknown): void;
  setActiveTools(toolNames: string[]): void;
  getAllTools(): ToolInfoNarrow[];
}

/** 底座 ToolInfo 的窄镜像:只取播报用到的字段。 */
interface ToolInfoNarrow {
  name: string;
  description?: string;
  sourceInfo?: { source?: string; path?: string };
}

/** 播报文件的工具元素(中性形状,契约 docs/design/tool-manager-design.md §4.4.2)。 */
interface AnnouncedTool {
  name: string;
  description: string;
  source: "builtin" | "extension";
  extensionPath?: string;
}

const KNOWN_TOOLS_FILE = path.join(os.homedir(), ".pi", "agent", "desktop-known-tools.json");

/** 读会话文件头行的 toolConfig(custom-pi-desktop.toolConfig 保留键)。JSONL 第一行即头;任何失败都返回 null(= 恢复全量,安全降级)。 */
function readSessionToolConfig(sessionFile: string): SessionToolConfig | null {
  let fd: number;
  try {
    fd = fs.openSync(sessionFile, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    const head = buf.subarray(0, n).toString("utf8");
    const nl = head.indexOf("\n");
    const parsed = JSON.parse(nl < 0 ? head : head.slice(0, nl)) as {
      "custom-pi-desktop"?: { toolConfig?: SessionToolConfig };
    };
    return parsed["custom-pi-desktop"]?.toolConfig ?? null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** sourceInfo 映射在扩展侧完成(翻译贴边界):builtin 直标,其余为 extension 并记来源路径。 */
function toAnnouncedTool(t: ToolInfoNarrow): AnnouncedTool {
  const builtin = t.sourceInfo?.source === "builtin";
  return {
    name: t.name,
    description: t.description ?? "",
    source: builtin ? "builtin" : "extension",
    ...(builtin ? {} : { extensionPath: t.sourceInfo?.path }),
  };
}

/** 播报:读-改-写保留他 cwd 桶;指纹比对象不是内存而是文件里的自有桶——
 *  被并发覆盖后下一 turn 发现缺失即重写(自愈,§4.4.3/§4.4.5)。 */
function announceTools(pi: ToolGateApi): void {
  try {
    const cwd = process.cwd();
    const tools = pi.getAllTools().map(toAnnouncedTool);
    const fingerprint = JSON.stringify([...tools].sort((a, b) => a.name.localeCompare(b.name)));
    let file: { version: number; byCwd: Record<string, { tools: AnnouncedTool[]; updatedAt: number }> } = { version: 1, byCwd: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(KNOWN_TOOLS_FILE, "utf8")) as typeof file;
      if (parsed?.byCwd && typeof parsed.byCwd === "object") file = parsed;
    } catch {
      // 文件缺失或半截 JSON:从空起步,本次写入即修复
    }
    const own = file.byCwd[cwd];
    if (own) {
      const ownFingerprint = JSON.stringify([...own.tools].sort((a, b) => a.name.localeCompare(b.name)));
      if (ownFingerprint === fingerprint) return;
    }
    file.byCwd[cwd] = { tools, updatedAt: Date.now() };
    fs.mkdirSync(path.dirname(KNOWN_TOOLS_FILE), { recursive: true });
    fs.writeFileSync(KNOWN_TOOLS_FILE, JSON.stringify(file, null, 2), "utf8");
  } catch {
    // 播报失败静默——不影响会话,下一 turn 重试(与过滤同一异常纪律)
  }
}

export default function toolGate(pi: ToolGateApi): void {
  /** 上次已应用集合的排序指纹——turn_start 每轮都触发,无变化不重复 setActiveTools。 */
  let lastAppliedKey: string | null = null;

  const applyFromHeader = (ctx: ToolGateContext): void => {
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      const cfg = sessionFile ? readSessionToolConfig(sessionFile) : null;
      const allNames = pi.getAllTools().map((t) => t.name);
      // 只认 enabledToolIds:字段缺失(无配置/旧数据)一律恢复全量;
      // 显式空数组 = 全禁,尊重 desktop 写入的数据语义。
      const enabled =
        Array.isArray(cfg?.enabledToolIds)
          ? cfg.enabledToolIds.filter((n) => allNames.includes(n))
          : allNames;
      const key = [...enabled].sort().join(",");
      if (key === lastAppliedKey) return;
      lastAppliedKey = key;
      pi.setActiveTools(enabled);
    } catch {
      // extension 异常不该炸掉底座会话——本轮维持现状,下一 turn 重试。
    }
  };

  pi.on("session_start", (_event, ctx) => applyFromHeader(ctx));
  pi.on("turn_start", (_event, ctx) => { applyFromHeader(ctx); announceTools(pi); });
}
