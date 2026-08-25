/**
 * toolgate 能力 —— 会话级工具白名单的实际执行者 + 工具清单播报员。
 * (原 packages/toolgate/index.ts,收编进统一扩展;窄类型上提 runtime.ts 契约单源)
 *
 * 职责一(过滤):desktop tool-manager Apply → 会话头行 custom-my-harness-desktop.toolConfig.enabledToolIds
 * (组展开在 desktop 侧已完成,契约不回退)→ 本能力读头行 → pi.setActiveTools。
 * 职责二(播报):session_start/turn_start 把 pi.getAllTools() 全量清单写侧车文件
 * ~/.pi/agent/desktop-known-tools.json(按 cwd 分桶),桌面经 kernel:knownTools IPC 读取。
 *
 * 为什么自己读文件而不走 ctx.sessionManager.getHeader():desktop 在会话运行中改头行,
 * sessionManager 缓存的是 spawn 时读的那份——自己读文件才能拿到 desktop 刚写的最新值。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type AnnouncedTool, type ExtensionApi, type SessionStartContext, type SessionToolConfig, type ToolInfoNarrow,
} from "./runtime";

const KNOWN_TOOLS_FILE = path.join(os.homedir(), ".pi", "agent", "desktop-known-tools.json");

/** 读会话文件头行的 toolConfig(custom-my-harness-desktop.toolConfig 保留键)。JSONL 第一行即头;任何失败都返回 null(= 恢复全量,安全降级)。 */
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
      "custom-my-harness-desktop"?: { toolConfig?: SessionToolConfig };
    };
    return parsed["custom-my-harness-desktop"]?.toolConfig ?? null;
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
 *  被并发覆盖后下一 turn 发现缺失即重写(自愈)。 */
function announceTools(pi: ExtensionApi): void {
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

export function setupToolgate(pi: ExtensionApi): void {
  /** 上次已应用集合的排序指纹——turn_start 每轮都触发,无变化不重复 setActiveTools。 */
  let lastAppliedKey: string | null = null;

  const applyFromHeader = (ctx: SessionStartContext): void => {
    try {
      const sessionFile = ctx.sessionManager?.getSessionFile();
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
