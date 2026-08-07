/**
 * context-probe —— pi 底座 extension:上下文用量的请求侧实测探针。
 *
 * 解决什么:部分供应商/路由不上报 prompt 侧 token(usage.input/cacheRead/cacheWrite 恒 0,
 * 只报 output),usage 锚点整条失效——底座的上下文估算退化成"拿输出量当上下文"(假数字),
 * 桌面侧按纪律显示诚实未知,用户看不到上下文占用。
 *
 * 实测来源:before_provider_request 的 payload 是发给供应商的完整请求体(system prompt +
 * 工具定义 + 消息历史全在里面),对它做 chars/4 就是上下文的真实量级——与底座自己的
 * estimateTokens 同一启发式,但覆盖全量 payload 而非仅消息历史。
 *
 * 传输:写侧车文件 ~/.pi/agent/desktop-context-probe.json,按 sessionFile 分桶,
 * 桌面 main 侧 getStats/openSession 读取合成 contextUsage(信任序:usage 锚 > 本探针 > 诚实未知)。
 * 与 tool-gate 的 desktop-known-tools.json 同一侧车先例;读改写在请求发起时,低频小文件。
 *
 * 纪律:handler 必须返回 undefined——返回值会替换请求体(runner 语义),本探针只观测不干预。
 * 任何异常静默:探针失败不影响会话,下一次请求自重试。
 *
 * 类型不 import 官方 @earendil-works/pi-coding-agent(类型包在底座 node_modules,仓库
 * tsconfig 够不到)——手写用到的窄结构,保持本文件在仓库 typecheck 视野内。本文件由
 * client/pi/context-probe-installer.ts 在 app 启动时同步到 ~/.pi/agent/extensions/context-probe/。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface ContextProbeApi {
  on(event: "before_provider_request", handler: (event: { payload?: unknown }, ctx: ProbeContext) => unknown): void;
}

interface ProbeContext {
  sessionManager: {
    getSessionFile(): string | undefined;
  };
}

const PROBE_FILE = path.join(os.homedir(), ".pi", "agent", "desktop-context-probe.json");
/** 侧车容量上限:按 updatedAt 淘汰最旧桶(会话文件删了桶不自清,封顶防无限涨)。 */
const MAX_BUCKETS = 200;

interface ProbeFile {
  version: number;
  bySession: Record<string, { tokens: number; updatedAt: number }>;
}

function writeProbe(sessionFile: string, tokens: number): void {
  let file: ProbeFile = { version: 1, bySession: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(PROBE_FILE, "utf8")) as ProbeFile;
    if (parsed?.bySession && typeof parsed.bySession === "object") file = parsed;
  } catch {
    // 文件缺失或半截 JSON:从空起步,本次写入即修复
  }
  file.bySession[sessionFile] = { tokens, updatedAt: Date.now() };
  const keys = Object.keys(file.bySession);
  if (keys.length > MAX_BUCKETS) {
    const byAge = keys.map((k) => [k, file.bySession[k].updatedAt] as const).sort((a, b) => a[1] - b[1]);
    for (const [k] of byAge.slice(0, keys.length - MAX_BUCKETS)) delete file.bySession[k];
  }
  fs.mkdirSync(path.dirname(PROBE_FILE), { recursive: true });
  fs.writeFileSync(PROBE_FILE, JSON.stringify(file), "utf8");
}

export default function contextProbe(pi: ContextProbeApi): void {
  pi.on("before_provider_request", (event, ctx) => {
    try {
      const sf = ctx.sessionManager.getSessionFile();
      if (!sf || event.payload == null) return;
      const tokens = Math.ceil(JSON.stringify(event.payload).length / 4);
      if (tokens > 0) writeProbe(sf, tokens);
    } catch {
      // 探针异常静默——不影响会话,下一次请求自重试
    }
  });
}
