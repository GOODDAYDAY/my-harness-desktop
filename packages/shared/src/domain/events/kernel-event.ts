// 圆心:统一内核事件抽象 —— domain/events,零外部依赖。
//
// 依据 docs/core/event-mechanism.md §2。
// 一个 KernelEvent 联合覆盖四条信息流:
//   1. pi 内核事件(已翻译为中性 SessionEvent)
//   2. 提问请求(内核→桌面端,需回复;pi 与 dsh 都投成中性形状)
//   3. 进程退出/崩溃(桌面端自产)
//   4. RPC 错误(超时/进程退出导致 reject)
//
// SessionEvent 是内核事件的子集投影,KernelEvent 是全部信息流的投影。
// 插件订阅 onEvent 收「激活会话」的内核事件(视图流);订阅 onKernelEvent 收全量事件
// (含后台会话,带 sessionKey 归属)——运维类需求(列表刷新/统计)用后者,视图渲染用前者。

import type { SessionEvent } from "./session-state";
import type { KernelId } from "../kernel";

// ============ 来源一:内核推送 ============

/** 内核事件(已翻译为中性 SessionEvent)。 */
export interface SessionMessageEvent {
  kind: "session";
  /** 事件来源会话(procs Map 的 key)——多会话并存时订阅方据此区分归属;
   *  对比 ProcessExit/RpcError 原有字段,此处补齐使四类事件归属信息一致。 */
  sessionKey: string;
  event: SessionEvent;
}

/** 一道中性提问(对齐 DSH question.ts 的 Question 形状;契约单源在圆心)。 */
export interface Question {
  /** 稳定 id,答案里原样回显。 */
  id: string;
  /** 问句正文。 */
  question: string;
  /** 可选短标题。 */
  header?: string;
  /** 可选选项;缺省/空数组 = 自由输入。 */
  options?: { label: string; description?: string }[];
  /** 是否允许多选;默认 false。 */
  multi_select?: boolean;
}

/** 一道提问的答案(与 DSH answer 对齐)。 */
export interface QuestionAnswer {
  /** 对应 Question.id。 */
  id: string;
  /** 选中的选项 label;自由输入/跳过时为空。 */
  selected: string[];
  /** 自定义输入(哨兵选项进入时)。 */
  custom?: string;
}

/** 中性提问请求:内核挂起、向用户要输入。pi 与 dsh 都投成这一形状(需回复)。 */
export interface QuestionRequestEvent {
  kind: "question";
  /** 内核铸造的提问 id,answerQuestion 回填时原样带回。 */
  requestId: string;
  /** 请求来源会话(procs Map 的 key)。 */
  sessionKey: string;
  /** 中性问题数组(一次可多题)。 */
  questions: Question[];
}

/**
 * 挂起提问记录(壳持久化的请求单;进程生死不影响其存续)。
 * 依据 docs/design/ask-design.md §3.2:提问 = 壳持有的持久请求单,内核只是发起方与投递通道。
 * 无 TTL、无 expired——死问句只有一种:store 里查无此单。
 */
export interface PendingQuestionRecord {
  /** 内核铸造的提问 id(pi=extension_ui 帧 id;dsh=扩展 randomUUID)。 */
  requestId: string;
  /** 发起内核(答案的归宿内核;路由按它找槽位,不读全局 activeKernel 偶然态)。 */
  kernel: KernelId;
  /** 归属会话中立主键(水合/级联删除的 join 键)。 */
  neutralSessionId: string;
  /** 会话 cwd(dsh 续路定位会话桶用)。 */
  cwd: string;
  /** 发起时的 proc key(pi=会话文件路径;dsh=投影地址)。诊断 + 续路定位用。 */
  sessionKey: string;
  /** 发起进程的出生证(SessionProc 每次创建/换绑生成)。answer 时比对,判定活路/续路。 */
  procNonce: string;
  /** 发起提问的 ask_user_question 工具调用 id(壳从 toolCallStart 对账捕获;卡片精确锚定)。 */
  toolCallId: string | null;
  /** 发起时的生效模型(续路回填消息的 prefs 路由用——回到提问的归宿内核,不读全局偶然态)。 */
  model?: { provider: string; modelId: string };
  /** 中性问题数组;id 已按 toolCallStart.args.questions 对账为模型出题时的真实 id。 */
  questions: Question[];
  status: "pending" | "answered" | "cancelled";
  answers?: QuestionAnswer[];
  createdAt: string;
  answeredAt?: string;
  /** 答案是否已成功送达内核(落账与送达分离:落账先,送达后补标;水合据此补投)。 */
  delivered?: boolean;
}

// ============ 来源二:desktop 自产 ============

/** 进程退出(期望退出或崩溃)。 */
export interface ProcessExitEvent {
  kind: "processExit";
  /** 退出码;null = 被 signal 杀死。 */
  code: number | null;
  /** 退出信号;null = 正常 exit。 */
  signal: string | null;
  /** 是否桌面端主动停止(期望退出,非崩溃)。 */
  expected: boolean;
  /** stderr 最后 500 字符(崩溃时辅助诊断)。 */
  stderr: string;
  /** 关联的会话 key(procs Map 的 key,非 sessionFile)。 */
  sessionKey: string;
}

/** RPC 命令失败(超时或进程退出导致 reject)。 */
export interface RpcErrorEvent {
  kind: "rpcError";
  /** 失败原因分类。 */
  reason: "timeout" | "processExit" | "sendError";
  /** 超时时附带的命令 id(timeout 时有值)。 */
  requestId?: string;
  /** 错误消息。 */
  message: string;
  /** 关联的会话 key。 */
  sessionKey: string;
}

/** 内核切换完成(desktop 自产;跨内核切换五步收尾后广播,驱动 renderer 内核标刷新)。 */
export interface KernelChangedEvent {
  kind: "kernelChanged";
  /** 关联的会话 key。 */
  sessionKey: string;
  /** 新内核。 */
  kernel: KernelId;
  /** 新内核的扩展能力面(renderer 据此显式降级,不按内核身份硬分支)。 */
  capabilities: SessionCapabilities;
}

/** 当前会话后端的扩展能力面(中性旗标,壳据以置灰入口——§7.6 显式降级)。 */
export interface SessionCapabilities {
  /** 当前会话内核归属(无激活进程/未选模型时 null——内核 = 模型的派生量,没有模型就没有内核,
   *  不回落 "pi")。renderer 据此置灰非当前内核的切换入口;null 时无锁定语义。 */
  kernel: KernelId | null;
  /** 会话是否已锁定内核(活跃进程且已发消息)——锁定后不可跨内核切换(§7.6 显式降级)。
   *  判据与 session-store.setModel 的跨内核降级一致(§3.2),保证 UI 置灰与主侧拒绝同步。 */
  locked: boolean;
  /** pi 专属扩展面(steer/followUp/thinkingLevel/队列/导出/abortRetry 等)是否可用。 */
  piExtension: boolean;
  /** dsh 运行时能力面(懒探测缺面)是否可用。 */
  dshExtension: boolean;
}

/** 内核能力缺面(desktop 自产;dsh 懒探测首次发现某 session/* 方法缺失时广播,
 *  驱动 renderer 置灰对应入口。payload 是缺失的方法名,不是整套缺面清单)。 */
export interface CapabilityDegradedEvent {
  kind: "capabilityDegraded";
  /** 关联的会话 key(procs Map 的 key)。 */
  sessionKey: string;
  /** 缺失的 session/* 方法名。 */
  method: string;
}

/** 能力面变化(desktop 自产;任何会改变 SessionCapabilities 的转变——会话打开/新建、
 *  模型切换、内核就绪、首次发送后锁定——之后广播。renderer 订阅一次即可,不再在
 *  每个生命周期转变处散拉式 refreshCapabilities(拉式缓存失同步的根因)。 */
export interface CapabilitiesChangedEvent {
  kind: "capabilitiesChanged";
  /** 关联的会话 key。 */
  sessionKey: string;
  /** 变化后的完整能力面(renderer 直接采信,不必再 getCapabilities 重拉)。 */
  capabilities: SessionCapabilities;
}

// ============ 统一联合 ============

/** 内核事件联合:覆盖内核推送 + 桌面端自产的全部信息流。 */
export type KernelEvent =
  | SessionMessageEvent
  | QuestionRequestEvent
  | ProcessExitEvent
  | RpcErrorEvent
  | KernelChangedEvent
  | CapabilityDegradedEvent
  | CapabilitiesChangedEvent;

// ============ Extension UI 回复类型(pi 适配器内部,不属中性事件)============

/** Extension UI 回复(桌面端→pi 内核,经 stdin 写回;pi 适配器翻译 QuestionAnswer 用)。 */
export interface ExtensionUIResponse {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: true;
}
