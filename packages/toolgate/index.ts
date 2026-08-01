/**
 * tool-gate —— pi 底座 extension:会话级工具白名单的实际执行者。
 *
 * 数据流:desktop tool-manager Apply → 会话头行 toolConfig.enabledToolIds(组展开在
 * desktop 侧已完成,契约不回退,见 domain SessionToolConfig)→ 本 extension 读头行
 * → pi.setActiveTools。未注册名在写 desktop 侧已对齐底座,setActiveTools 前再过滤一次兜底。
 *
 * 为什么自己读文件而不走 ctx.sessionManager.getHeader():desktop 在会话运行中改头行
 * (updateSessionHeader),sessionManager 缓存的是 spawn 时读的那份——自己读文件才能拿到
 * desktop 刚写的最新值。
 *
 * 触发点:session_start(新会话/切换会话)+ turn_start(每个 turn 开头重读;排序指纹
 * 防抖,无变化不 setActiveTools)。读 8KB 头行窗口的开销可忽略,换来"Apply 后下一个
 * turn 生效"。
 *
 * 类型不 import 官方 @earendil-works/pi-coding-agent(类型包在底座 node_modules,仓库
 * tsconfig 够不到)——手写用到的窄结构,保持本文件在仓库 typecheck 视野内。本文件由
 * client/pi/toolgate-installer.ts 在 app 启动时同步到 ~/.pi/agent/extensions/tool-gate/。
 */
import * as fs from "node:fs";

/** domain SessionToolConfig 的只读镜像(头行 toolConfig 字段;desktop 侧是契约唯一源)。 */
interface SessionToolConfig {
  mode: "all" | "custom";
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
  getAllTools(): { name: string }[];
}

/** 读会话文件头行的 toolConfig。JSONL 第一行即头;任何失败都返回 null(= 恢复全量,安全降级)。 */
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
    const parsed = JSON.parse(nl < 0 ? head : head.slice(0, nl)) as { toolConfig?: SessionToolConfig };
    return parsed.toolConfig ?? null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
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
      // 只认 enabledToolIds:mode!=="custom"、字段缺失(旧数据)一律恢复全量;
      // 显式空数组 = 全禁,尊重 desktop 写入的数据语义。
      const enabled =
        cfg?.mode === "custom" && Array.isArray(cfg.enabledToolIds)
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
  pi.on("turn_start", (_event, ctx) => applyFromHeader(ctx));
}
