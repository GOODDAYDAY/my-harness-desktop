// dsh 后端 —— BaseBackend 的 dsh 实现:spawn dsh 子进程 + JSON-RPC + 事件翻译。
//
// 依据 docs/design/base-interface-lineage.md §3.2。dsh 的会话是扁平 append-only 事件流,
// fork 是 ctx.sessions.fork(自带前缀拷贝),会话树是 session forest(父会话 + 子会话)。
// 本后端把这些投影到 BaseBackend 中性契约上。
//
// 传输层:client/dsh/json-rpc(JSON-RPC 2.0 行传输);协议面:dsh sdk-jsonrpc-server
// 的方法集(initialize/session/prompt/session/fork/...)。事件翻译(dsh SessionEvent →
// 中性 SessionEvent)是独立一块。
//
// 能力门槛(docs/design/dsh-capability-gate.md):装上的 dsh 版本可能缺某些 session/*
// 方法。本后端做懒探测——按需调用,捕获 "unknown method" 即记为缺面、转成清晰错误,
// 经 capabilities.dsh.missing / onMissing 上报壳,壳据此显式降级,不裸炸、不静默吞。

import { rmSync } from "node:fs";
import type { JsonRpcTransport } from "./json-rpc";
import type { Anchor, BoundaryRef, LineageTree, DshCapabilities, SeedOptions } from "@my-harness-desktop/shared";
import { AbstractBackend, type BackendContext } from "../abstract-backend";
import type { SessionEvent, NeutralMessage } from "@my-harness-desktop/shared";
import type { QuestionAnswer } from "@my-harness-desktop/shared";
import type { NeutralEntry } from "@my-harness-desktop/shared";
import { cwdToBucketName, type ImageInput } from "@my-harness-desktop/shared";
import { createDshEventTranslator } from "./dsh-event-translator";
import { writeDshAnswer } from "./dsh-question-bridge";
import { DSH_METHODS } from "./dsh-methods";

/** dsh 后端的会话级配置(initialize 握手参数)。cwd/sessionId 来自中性 BackendContext,
 *  provider/model/maxTokens/tempDir 是 dsh 专属的 initialize/清理字段。 */
export interface DshBackendConfig extends BackendContext {
  /** dsh 侧模型 provider(initialize 握手)。 */
  provider: string;
  /** dsh 侧模型(initialize 握手)。 */
  model: string;
  /** 输出 token 上限(initialize 握手)。 */
  maxTokens?: number;
  /** 临时会话目录(ephemeral 时由工厂创建;stop 时连同子进程一起清理)。 */
  tempDir?: string;
  /** dsh 原生配置路径(cordis.yml/settings.yaml;configDepPaths 用,spawn 依赖快照)。 */
  cordisConfig?: string;
  settingsPath?: string;
}

/** dsh 侧 "unknown method" 错误前缀(sdk-jsonrpc-server handleRequest default 分支吐的原文)。 */
const UNKNOWN_METHOD_PREFIX = "unknown DeepSeek Harness SDK runtime method";

/** dsh 后端:JSON-RPC 传输 + BaseBackend 五操作投影 + 懒能力探测。 */
export class DshBackend extends AbstractBackend<DshBackendConfig> {
  private currentSessionId: string;

  /** 懒探测记下的缺面方法名(session/xxx)。首次「unknown method」时记录,本进程内不再重调。 */
  private readonly missingMethods = new Set<string>();

  /** dsh 能力面(§7.6):missing 是活缺面清单,onMissing 由壳绑定后广播降级事件。 */
  override readonly capabilities: { dsh: DshCapabilities } = {
    dsh: { missing: this.missingMethods, onMissing: null },
  };

  constructor(
    private readonly transport: JsonRpcTransport,
    config: DshBackendConfig,
  ) {
    super(config);
    this.currentSessionId = config.sessionId ?? cwdToBucketName(config.cwd);
  }

  /** 当前内核侧会话标识(缺省=桶名,seed 后重绑为服务端返回的 childSessionId)。 */
  override get sessionId(): string {
    return this.currentSessionId;
  }

  /** dsh spawn 时读取的配置文件(cordis.yml/settings.yaml;变了壳重建进程)。 */
  override get configDepPaths(): string[] {
    const paths: string[] = [];
    if (this.ctx.cordisConfig) paths.push(this.ctx.cordisConfig);
    if (this.ctx.settingsPath) paths.push(this.ctx.settingsPath);
    return paths;
  }

  /** 内核身份(§kernel-layer 圆心契约):dsh 后端固定 "dsh"。 */
  readonly kernel = "dsh" as const;

  get alive(): boolean {
    return this.transport.alive;
  }

  /** 起传输 + initialize 握手(sessionId 由服务端在首个 prompt 时惰性创建)。
   *  握手带重试:settings-file 插件的 settings.yaml 是异步 init(读文件+监听),initialize 可能
   *  赶上它尚未完成 → 返回 "no adapter registered"(瞬时)。短延迟重试等 settings 就绪,上限 10s;
   *  非该瞬时错误(真没配该 provider/其他错)立即外抛,不空等。 */
  async start(): Promise<void> {
    this.transport.start();
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await this.transport.request(DSH_METHODS.initialize, {
          cwd: this.ctx.cwd,
          provider: this.ctx.provider,
          model: this.ctx.model,
          maxTokens: this.ctx.maxTokens,
        });
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("no adapter registered") || Date.now() >= deadline) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  async stop(): Promise<void> {
    await this.transport.stop();
    if (this.ctx.tempDir) {
      try { rmSync(this.ctx.tempDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不致命 */ }
    }
  }

  /** 带流式状态的翻译器(每会话进程一个):assistant/chunk 增量组装成 messageStart/Update。 */
  private readonly translateEvent = createDshEventTranslator();

  /** 订阅中性事件流:session.event 通知 → 翻译成中性(§4.3)。一个 dsh 事件可能产多个中性事件。 */
  onEvent(cb: (event: SessionEvent) => void): () => void {
    return this.transport.onNotification((method, params) => {
      if (method !== "session.event") return;
      const p = params as { sessionId?: string; event?: unknown };
      for (const event of this.translateEvent(p.event)) cb(event);
    });
  }

  /** 记一个缺面方法并广播降级事件(懒探测首次命中时调用)。 */
  private recordMissing(method: string): void {
    if (this.missingMethods.has(method)) return;
    this.missingMethods.add(method);
    this.capabilities.dsh.onMissing?.(method);
  }

  /** 判定是否为「方法不存在」错误(sdk server handleRequest default 分支)。 */
  private isUnknownMethod(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.includes(UNKNOWN_METHOD_PREFIX);
  }

  /** 缺面的清晰错误(替代裸 unknown-method 泄漏)。 */
  private missingMethodError(method: string): Error {
    return new Error(`dsh 内核版本过旧,缺少 ${method} 方法(请升级 dsh 内核)`);
  }

  /** 懒探测发一个 session/* 方法:已知缺面直接抛清晰错误;未知则调用,
   *  首次「unknown method」记缺面并转成清晰错误。 */
  private async requestSession<T>(method: string, params?: unknown): Promise<T> {
    if (this.missingMethods.has(method)) throw this.missingMethodError(method);
    try {
      return await this.transport.request<T>(method, params);
    } catch (e) {
      if (this.isUnknownMethod(e)) {
        this.recordMissing(method);
        throw this.missingMethodError(method);
      }
      throw e;
    }
  }

  async sendMessage(text: string, images?: ImageInput[]): Promise<void> {
    await this.transport.request(DSH_METHODS.sessionPrompt, {
      sessionId: this.sessionId,
      contentBlocks: [{ type: "text", text }],
      ...(images && images.length > 0
        ? { images: images.map(i => ({ data: i.data, mediaType: i.mimeType, ...(i.name ? { name: i.name } : {}) })) }
        : {}),
    });
  }

  async abort(): Promise<void> {
    await this.requestSession(DSH_METHODS.sessionAbort, { sessionId: this.sessionId });
  }

  /** 继续执行（第八意图）：dsh 走 session/continue RPC，服务端按 turn/end reason 语义分发
   *  （重挂 goal 或注入续跑提示）。懒探测缺面：旧 dsh 内核无此方法 → 记缺面 + 抛清晰错误。 */
  async continue(): Promise<void> {
    await this.requestSession(DSH_METHODS.sessionContinue, { sessionId: this.sessionId });
  }

  /** 回答一次提问:写答案文件(dsh ask 扩展轮询读取;文件侧车桥封装进适配器)。 */
  async answerQuestion(questionId: string, answers: QuestionAnswer[]): Promise<void> {
    writeDshAnswer(questionId, answers);
  }

  /** 命名当前会话(中立命名意图):dsh 走 session/rename RPC(懒探测缺面)。
   *  旧运行时无 session/rename → 记缺面 + no-op(命名是可选能力,不因缺面打断发送)。
   *  与 setModel 同款:unknown method 记缺面不抛;unknown session 是会话未惰性创建,纯冗余。 */
  async setSessionName(name: string): Promise<void> {
    try {
      await this.transport.request(DSH_METHODS.sessionRename, { sessionId: this.sessionId, name });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (this.isUnknownMethod(e)) {
        this.recordMissing(DSH_METHODS.sessionRename);
        return;
      }
      if (msg.includes("unknown session")) return;
      throw e;
    }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    try {
      await this.transport.request(DSH_METHODS.sessionSetModel, { sessionId: this.sessionId, provider, modelId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 方法缺失(旧运行时没有 session/setModel)→ 记缺面 + warn + no-op:
      // initialize 握手已把 provider/model 落到 server,惰性创建的会话自然用这套值,
      // 所以「运行时切模型」缺面时模型停在握手定的值,不算崩;但必须让用户看见没生效,
      // 不能静默吞(§dsh-capability-gate §4)。「unknown session」是会话尚未惰性创建,纯冗余,照旧 no-op。
      if (this.isUnknownMethod(e)) {
        this.recordMissing(DSH_METHODS.sessionSetModel);
        console.warn("[dsh-backend] 运行时切模型缺面:该 dsh 内核版本没有 session/setModel,模型停在 initialize 握手值");
        return;
      }
      if (msg.includes("unknown session")) return;
      throw e;
    }
  }


  async getTree(sessionId: string): Promise<LineageTree> {
    return this.requestSession<LineageTree>(DSH_METHODS.sessionGetTree, { sessionId });
  }

  async getEntries(lineageId: string): Promise<NeutralMessage[]> {
    return this.requestSession<NeutralMessage[]>(DSH_METHODS.sessionGetEntries, { lineageId });
  }

  async bookmark(lineageId: string, entryId: string): Promise<Anchor> {
    await this.requestSession(DSH_METHODS.sessionBookmark, {
      lineageId,
      boundarySeq: Number(entryId),
    });
    // 去 opaque:只回中立坐标,子会话定位线索由 dsh 服务端从坐标找回
    return { lineageId, entryId };
  }

  async resume(anchor: Anchor): Promise<string> {
    const res = await this.requestSession<{ lineageId: string }>(DSH_METHODS.sessionResume, { anchor });
    return res.lineageId;
  }

  /** 删除书签:坐标书签无副本要回收,dsh 侧 deleteBookmark 是 no-op。 */
  async deleteBookmark(anchor: Anchor): Promise<void> {
    await this.requestSession(DSH_METHODS.sessionDeleteBookmark, { anchor });
  }

  /** §kernel-forkless §18:seed 单线投影——sessionId 传 lineageId 当 SessionId(dsh 的
   *  SessionId 是值对象,可显式指定),session 传单条 lineage 的完整线性内容。
   *  关键:重绑 this.sessionId——sendMessage/abort/setModel 全读 this.sessionId,不重绑则
   *  首切 pi→dsh 后所有消息发到构造时的桶名会话(§13.1)。 */
  async seed(lineage: NeutralEntry[], opts: SeedOptions): Promise<string> {
    const res = await this.requestSession<{ sessionId: string }>(DSH_METHODS.sessionSeed, {
      sessionId: opts.lineageId,
      session: lineage,
    });
    this.currentSessionId = res.sessionId;
    return res.sessionId;
  }
}
