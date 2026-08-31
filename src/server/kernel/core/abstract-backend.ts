// 抽象后端基类 —— BaseBackend 契约的骨架 + 缺面默认。
//
// 依据 docs/design/abstract-backend.md + kernel-layer.md §9.4。BaseBackend 是契约(接口),
// PiBackend / DshBackend 是两个平行实现。两个实现各自的「会话模型、事件形状、fork 语义」
// 处处相反,那些差异保持 abstract;只有「可缺面能力的默认」才收进基类共享。
//
// 三条纪律:
// 1. 基类只 import core/domain,绝不 import 具体内核(client/pi、client/dsh)——它是机制
//    (契约骨架 + 缺面默认),不是内容。
// 2. 子类只填差异:数据(上下文扩展)+ override abstract 方法。不为「看起来能复用」硬塞基类。
// 3. 组装归 bootstrap:createPiBackend / createDshBackend 在 bootstrap/kernel,本文件不 import 实现。

import type { KernelId } from "@my-harness-desktop/shared";
import type { BaseBackend, Anchor, BoundaryRef, LineageTree, DshCapabilities, SeedOptions } from "@my-harness-desktop/shared";
import type { SessionEvent, NeutralMessage } from "@my-harness-desktop/shared";
import type { QuestionAnswer } from "@my-harness-desktop/shared";
import type { KnownToolInfo, ImageInput } from "@my-harness-desktop/shared";
import type { NeutralEntry } from "@my-harness-desktop/shared";

/**
 * 中性后端上下文:AbstractBackend 与两个子类共享的最小路径/偏好字段。
 *
 * 只放「两个内核都需要的」字段。内核专属 spawn 字段(cordisConfig/env/cliPath)留在工厂闭包
 * (§6.2,不进契约);内核专属上下文字段(agentDir / provider / model / tempDir)由子类 extends
 * 扩展。子类通过 `AbstractBackend<C>` 的泛型拿到自己扩展后的完整类型。
 */
export interface BackendContext {
  /** 项目根(cwd 桶名、会话路径生成、initialize 握手共用)。 */
  cwd: string;
  /** 要打开/续接的会话标识(pi=JSONL 路径,dsh=不透明 id)。缺省=新会话。 */
  sessionId?: string;
}

/**
 * 抽象后端:BaseBackend 契约的骨架实现。
 *
 * - 15 条必实现意图全部声明为 abstract,由 PiBackend / DshBackend 各自 override——
 *   加第 N 个内核时编译器逼着它实现全量意图,漏一条就编译错,杜绝静默缺面。
 * - 4 条可缺面意图(listTools / answerQuestion / continue / setThinkingLevel)给缺面默认:
 *   listTools 返回 null(壳走降级),其余抛错(不静默吞、不伪造成功)。
 *
 * 本类不 import 任何具体内核,只依赖圆心契约 + 中性类型。
 */
export abstract class AbstractBackend<C extends BackendContext = BackendContext> implements BaseBackend {
  protected constructor(protected readonly ctx: C) {}

  /** 内核专属能力探测面(§7.6;默认空,子类 override)。pi 后端给 { pi: this },dsh 给 { dsh: DshCapabilities }。 */
  readonly capabilities: { pi?: unknown; dsh?: DshCapabilities } = {};

  /** 内核 spawn 时读取的配置文件路径清单(缺省无依赖;pi/dsh 子类各自 override)。 */
  get configDepPaths(): string[] { return []; }

  /** 内核身份(pi/dsh),子类固定字面量。 */
  abstract readonly kernel: KernelId;

  /** 当前内核侧会话标识(缺省取 ctx.sessionId;子类可 override,如 dsh 有桶名默认 + seed 重绑)。 */
  get sessionId(): string | null {
    return this.ctx.sessionId ?? null;
  }

  /** 子进程是否存活(各自委托 transport/adapter)。 */
  abstract get alive(): boolean;

  /** 起内核子进程(实现自定 spawn + 握手)。 */
  abstract start(): Promise<void>;

  /** 停内核子进程(实现自定收尾)。 */
  abstract stop(): Promise<void>;

  /** 订阅中性事件流(翻译由各实现投喂)。 */
  abstract onEvent(cb: (event: SessionEvent) => void): () => void;

  /** 发用户消息。 */
  abstract sendMessage(text: string, images?: ImageInput[]): Promise<void>;

  /** 中断当前生成。 */
  abstract abort(): Promise<void>;

  /**
   * 切模型。⚠ 两个内核定模型的时机不对称,实现者必须记住:
   * - pi:模型在 setModel 时定(set_model RPC),start 时不定;
   * - dsh:模型在 start 的 initialize 握手时定,setModel 因旧运行时缺 session/setModel 是 no-op。
   * 因此「发起 LLM 前必须先定模型」——dsh 侧要换模型,只能停旧进程、带新 provider/model 重启
   * (由 session-store 的 ensureForSend 编排),不能指望 setModel 生效。
   */
  abstract setModel(provider: string, modelId: string): Promise<void>;

  /** 命名当前会话(中立命名意图)。 */
  abstract setSessionName(name: string): Promise<void>;

  /** 读一个会话的全部 lineage。 */
  abstract getTree(sessionId: string): Promise<LineageTree>;

  /** 读一条 lineage 的线性消息序列。 */
  abstract getEntries(lineageId: string): Promise<NeutralMessage[]>;

  /** 把分叉点持久化成可重启锚点。 */
  abstract bookmark(lineageId: string, boundary: BoundaryRef): Promise<Anchor>;

  /** 删除书签锚点。 */
  abstract deleteBookmark(anchor: Anchor): Promise<void>;

  /** §kernel-forkless §21:投影单条 lineage 到内核,返回派生标识。 */
  abstract seed(lineage: NeutralEntry[], opts: SeedOptions): Promise<string>;

  /** 缺面默认:内核不支持工具发现 → null,壳走降级(§7.6)。子类可 override。 */
  listTools(): Promise<KnownToolInfo[] | null> {
    return Promise.resolve(null);
  }

  /** 缺面默认:内核不支持交互式提问 → 显式抛错,不静默吞、不伪造成功。子类可 override。 */
  answerQuestion(_questionId: string, _answers: QuestionAnswer[]): Promise<void> {
    return Promise.reject(new Error("当前内核不支持交互式提问"));
  }

  /** 缺面默认:内核不支持「继续执行」→ 显式抛错,不静默吞、不伪造成功。子类可 override。 */
  continue(_text?: string): Promise<void> {
    return Promise.reject(new Error("当前内核不支持继续执行"));
  }

  /** 缺面默认:内核不支持思考强度运行时切换 → 显式抛错,不静默吞、不伪造成功(§7.6)。
   *  子类可 override(pi=set_thinking_level RPC;dsh 继承本默认)。设计 docs/design/atomic-send.md §3。 */
  setThinkingLevel(_level: string): Promise<void> {
    return Promise.reject(new Error("当前内核不支持思考强度切换"));
  }
}
