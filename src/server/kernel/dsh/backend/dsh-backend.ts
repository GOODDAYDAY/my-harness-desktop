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
import type { JsonRpcTransport } from "../protocol/json-rpc";
import type { Anchor, BoundaryRef, LineageTree, DshCapabilities, SeedOptions, NeutralSession } from "@my-harness-desktop/shared";
import { AbstractBackend, type BackendContext } from "../../core/abstract-backend";
import type { SessionEvent, NeutralMessage } from "@my-harness-desktop/shared";
import type { QuestionAnswer } from "@my-harness-desktop/shared";
import type { NeutralEntry } from "@my-harness-desktop/shared";
import { type ImageInput } from "@my-harness-desktop/shared";
import { createDshEventTranslator } from "./dsh-event-translator";
import { writeDshAnswer } from "../manager/dsh-question-bridge";
import { DSH_METHODS } from "../protocol/dsh-methods";

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

/**
 * dsh seed 的转录纯函数(§7.6 适配器翻译):把 forkless 的「线性 NeutralEntry[]」重新包回
 * dsh 运行时 `session/seed` 要的「单 lineage 树」。dsh 运行时那份 wire 类型
 * `NeutralSessionWire`(deepseek-harness packages/sdk/protocol)明确 mirrors desktop 的
 * `NeutralSession`——即 `session/seed` 的 `session` 参数是树(`{ neutralSessionId, lineages }`),
 * 不是线性数组。壳的中立 seed 契约是单条 lineage 线性内容,这里把线性 lineage 包成
 * 根 lineage(fork=null) 的单元素树,再交给 `DshBackend.seed` 发 RPC。
 *
 * pi 的对应转录是 `piSeedSession`(写 JSONL 文件)——两边吃同一份中立输入 `NeutralEntry[]`,
 * 各投各的内核形态:pi 投 JSONL、dsh 投 session/seed 树。这是「换内核 = 换投影实现」的
 * 落地,中立层一行不动。
 *
 * 同时剥离 `display`(展示元数据永不进内核投影,neutral-session-first §4)——dsh 的
 * `entriesToSeedEvents` 只读 entry.message,display 只是桌面渲染字段。
 */
export function buildDshSeedSession(lineage: NeutralEntry[], opts: SeedOptions): NeutralSession {
  return {
    // 根 lineageId ≡ neutralSessionId 不变量(§kernel-forkless §12.2/§5.2):seed 投影把
    // 「活跃 lineage」单线重包成新会话,该 lineage 在新会话里是根(fork=null)——neutralSessionId
    // 必须 = lineageId(= dsh 会话 id)。此前用 opts.neutralSessionId(壳会话 ns=根 lineage id),
    // 对 fork 分支 seed 时 ns 仍是根、lineageId 是分支,两者不一致 → dsh 内核 seed 出 id 与
    // 投影不符、分支回合挂起不收敛(实弹复现:fork 分支发送停止钮不出、回合永不 settle)。
    neutralSessionId: opts.lineageId,
    header: opts.header,
    lineages: [{
      lineageId: opts.lineageId,
      fork: null,
      // 只投影对话内容条目(user/assistant/toolResult):divider/注解(中立层会话注解,
      // 自定义 role)是壳的展示数据,不进内核投影——与 piSeedSession 的过滤同口径。
      entries: lineage
        .filter((e) => ["user", "assistant", "toolResult"].includes(e.message.role))
        .map(({ neutralEntryId, kernelEntryId, message }) => ({
          neutralEntryId,
          ...(kernelEntryId !== undefined ? { kernelEntryId } : {}),
          message,
        })),
    }],
  };
}

/** dsh 后端:JSON-RPC 传输 + BaseBackend 五操作投影 + 懒能力探测。 */
export class DshBackend extends AbstractBackend<DshBackendConfig> {
  private currentSessionId: string;

  /** 懒探测记下的缺面方法名(session/xxx)。首次「unknown method」时记录,本进程内不再重调。 */
  private readonly missingMethods = new Set<string>();

  /** dsh 能力面(§7.6):missing 是活缺面清单,onMissing 由壳绑定后广播降级事件。
   *  getThinkingLevels:思考档位清单查询(补面,dsh-thinking-level.md)——桌面适配插件
   *  拦截 session/getThinkingLevels 提供;旧版插件无此面 → 懒探测记缺面 + 空清单,
   *  壳据此藏档位控件(显式降级,不伪造可切)。 */
  override readonly capabilities: { dsh: DshCapabilities } = {
    dsh: { missing: this.missingMethods, onMissing: null, getThinkingLevels: () => this.fetchThinkingLevels() },
  };

  /** 能力轴(docs/model-switching.md §11.2):运行时切模型 = session/setModel 不缺面。
   *  未探测过按乐观 true(第一次调用见真章);懒探测记缺面后翻 false,壳据此把
   *  模型失配回落成停旧起新。 */
  override get supportsRuntimeSetModel(): boolean {
    return !this.missingMethods.has(DSH_METHODS.sessionSetModel);
  }

  /** 带流式状态的翻译器(每会话进程一个):assistant/chunk 增量组装成 messageStart/Update。
   *  初值带 spawn 握手的 provider/model:request/header 派生分隔线只在「实际生效配置 ≠
   *  握手配置」时触发——重开/重spawn 同模型不刷假分隔线(防刷屏)。构造体赋值(ctx 是
   *  基类参数属性,字段初始化器里读序不可靠,勿回退为字段初始化)。 */
  private readonly translateEvent: (event: unknown) => SessionEvent[];

  constructor(
    private readonly transport: JsonRpcTransport,
    config: DshBackendConfig,
  ) {
    super(config);
    // 身份不变量守卫(session-single-source §2.3/§4.3):会话标识必须由壳显式给出(中立主键 ns),
    // 缺了直接抛错——宁可早炸,不串会话。历史上这里回落 cwd 桶名,真走到就是
    // 「消息发进桶名会话」的静默错绑。
    if (!config.sessionId) throw new Error("dsh 后端缺少会话标识(应由壳传入中立主键)");
    this.currentSessionId = config.sessionId;
    this.translateEvent = createDshEventTranslator({ provider: config.provider, model: config.model });
  }

  /** 当前内核侧会话标识(= 当前物化 lineage 的 id;构造时由壳传入中立主键,seed 断言后重绑)。 */
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
    // 首个 prompt 落定即物化服务端会话——此前因 unknown session 暂存的思考档位在此补发
    // (与 pi 的 pendingModelPrefs 同款模式);补发失败只记日志不炸发送(首个 step 已按旧档位出发)。
    if (this.pendingThinkingLevel !== undefined) await this.flushThinkingLevel().catch((e) => console.warn("[dsh-backend] 思考档位补发失败:", e));
  }

  /** 思考档位暂存:会话未物化(unknown session)时 setThinkingLevel 记此,首个 prompt 后补发。 */
  private pendingThinkingLevel: string | undefined;

  /** 补发暂存的思考档位;一次性(成败都清账,不无限重试)。 */
  private async flushThinkingLevel(): Promise<void> {
    const level = this.pendingThinkingLevel;
    this.pendingThinkingLevel = undefined;
    if (level === undefined) return;
    await this.requestSession(DSH_METHODS.sessionSetThinkingLevel, { sessionId: this.sessionId, level });
  }

  /** override 契约缺面默认(dsh-thinking-level.md):运行时切思考深度经桌面适配插件的
   *  session/setThinkingLevel(installModelSelection 热切,下一 step 生效,不重启)。
   *  降级纪律:旧版适配插件无此面 → 懒探测记缺面 + no-op(capabilityDegraded 显形,
   *  不打断发送);会话未物化(首个 prompt 前)→ 暂存 pending,首发落定补发;
   *  校验拒绝(模型不支持该档位)等真错误照常外抛——诚实,立即反馈。 */
  override async setThinkingLevel(level: string): Promise<void> {
    try {
      await this.requestSession(DSH_METHODS.sessionSetThinkingLevel, { sessionId: this.sessionId, level });
      this.pendingThinkingLevel = undefined;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (this.missingMethods.has(DSH_METHODS.sessionSetThinkingLevel)) {
        console.warn("[dsh-backend] 运行时切思考深度缺面:该 dsh 适配插件版本没有 session/setThinkingLevel,档位停在配置值");
        return;
      }
      if (msg.includes("unknown session")) {
        this.pendingThinkingLevel = level;
        return;
      }
      throw e;
    }
  }

  /** 思考档位清单(补面查询):桌面适配插件答精确模型的支持档位;无推理元数据的模型 →
   *  空清单(壳藏档位控件);旧版插件缺面 → 懒探测记录 + 空清单。 */
  private async fetchThinkingLevels(): Promise<string[]> {
    try {
      const res = await this.requestSession<{ levels?: unknown }>(DSH_METHODS.sessionGetThinkingLevels, { sessionId: this.sessionId });
      return Array.isArray(res?.levels) ? res.levels.filter((l): l is string => typeof l === "string") : [];
    } catch (e) {
      if (this.missingMethods.has(DSH_METHODS.sessionGetThinkingLevels)) return [];
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("unknown session")) return [];
      throw e;
    }
  }

  async abort(): Promise<void> {
    await this.requestSession(DSH_METHODS.sessionAbort, { sessionId: this.sessionId });
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
    // 身份守卫:回切结果必须是有效 lineageId,空响应即显式报错(不静默错绑)。
    if (typeof res?.lineageId !== "string" || !res.lineageId) {
      throw new Error("dsh resume 返回了无效的 lineageId");
    }
    return res.lineageId;
  }

  /** 删除书签:坐标书签无副本要回收,dsh 侧 deleteBookmark 是 no-op。 */
  async deleteBookmark(anchor: Anchor): Promise<void> {
    await this.requestSession(DSH_METHODS.sessionDeleteBookmark, { anchor });
  }

  /** §kernel-forkless §18 + wire 对齐(§7.6 适配器翻译):dsh 运行时的 session/seed 要的是
   *  NeutralSessionWire 树(mirrors desktop NeutralSession),不是线性 NeutralEntry[]。壳的
   *  forkless seed 契约给单条 lineage 线性内容,这里经 buildDshSeedSession 重新包回
   *  「单 lineage 树」再发——这是 dsh 适配器的转录职责(pi 对应 piSeedSession 写 JSONL)。
   *  sessionId 传 lineageId 当 SessionId(dsh 的 SessionId 是值对象,可显式指定)。
   *  关键:重绑 this.sessionId——sendMessage/abort/setModel 全读 this.sessionId,不重绑则
   *  首切 pi→dsh 后所有消息发到构造时的桶名会话(§13.1)。
   *  身份断言(session-single-source §4.3):服务端返回的标识必须等于按规则派生的值
   *  (=lineageId)——不等即显式报错,不静默重绑到错会话。 */
  async seed(lineage: NeutralEntry[], opts: SeedOptions): Promise<string> {
    const res = await this.requestSession<{ sessionId: string }>(DSH_METHODS.sessionSeed, {
      sessionId: opts.lineageId,
      session: buildDshSeedSession(lineage, opts),
    });
    if (res.sessionId !== opts.lineageId) {
      throw new Error(`dsh seed 身份断言失败: 期望 ${opts.lineageId},服务端返回 ${res.sessionId}`);
    }
    this.currentSessionId = res.sessionId;
    return res.sessionId;
  }
}
