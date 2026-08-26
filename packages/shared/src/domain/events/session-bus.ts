// 圆心:Session Bus 中性契约 —— 会话间消息信封、地址、tap 闸门级别的唯一类型源。
//
// 设计文档:docs/design/session-bus.md。信封只有一个形状(契约单源):
// 上行请求、下行响应、事件通知全是 SessionBusMessage,kind 鉴别用途、
// replyTo 配对请求,不存在"传输层一套字段、应用层一套字段"的两张皮。
//
// 中性 = 不依赖任何框架/库/运行时。router(application)、rpc-adapter(client)、
// preload(api)、bus-extension(pi 进程内,手写窄镜像)共用这个形状;
// 换 Electron/换传输,本文件不动。

/** 总线消息信封(唯一形状)。 */
export interface SessionBusMessage {
  /** 协议标记,识别锚点(接收方 JSON.parse 后判 $bus === true);恒为 true。 */
  $bus: true;
  /** randomUUID,追踪与接收方去重(同一 id 重复到达只处理一次)。 */
  id: string;
  /** 发送方地址。由传输层认证:pi 侧=路由器按到达管道覆写,插件侧=框架注入 plugin:<id>,不自报。 */
  from: string;
  /** 目标地址:session:<key> | channel:<name> | plugin:<id> | "desktop"(路由器内部 handler)。 */
  to: string;
  /** 开放字符串。总线自产 = 控制帧 "bus_response" + 事件帧七种
   *  ("chat" | "task" | "result" | "tap_event" | "session_done" | "peer_joined" | "peer_left"),
   *  内容层可自定义;路由器按 kind 只区分响应帧与事件帧(streamingBehavior 分派),不枚举业务 kind。 */
  kind: string;
  /** 各 kind 的内容层自定义载荷。 */
  payload: unknown;
  /** Unix ms。 */
  timestamp: number;
  /** 请求-响应配对(响应帧带,值 = 原请求的 id)。 */
  replyTo?: string;
}

/** tap 闸门级别:done=只给完成信号;lifecycle=加五个边界事件;stream=全量(仅 plugin 目标)。 */
export type TapFilter = "done" | "lifecycle" | "stream";

/** lifecycle 级别的五个边界事件(起止标记,不含执行细节);stream = 这五个 + 全部增量。 */
export const LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "sessionStart",
  "agentStart",
  "agentEnd",
  "agentSettled",
  "messageEnd",
]);

/** tap 描述(路由器运行时状态,不持久化)。 */
export interface BusTap {
  id: string;
  /** 观察目标:session 盯一个会话的事件;channel 盯一个房间的消息流(filter 不适用)。 */
  target: { session?: string; channel?: string };
  filter: TapFilter;
  /** 事件帧投递地址(session:<key> 或 plugin:<id>)。 */
  deliverTo: string;
  /** 创建者地址(可溯源;tap_list 与清理用)。 */
  owner: string;
}

/** 地址构造/判定 helper(纯函数,消费方共享,防各处手拼前缀漂移)。 */
export function sessionAddress(sessionKey: string): string {
  return `session:${sessionKey}`;
}
export function channelAddress(name: string): string {
  return `channel:${name}`;
}
export function pluginAddress(pluginId: string): string {
  return `plugin:${pluginId}`;
}
export function isSessionAddress(to: string): boolean {
  return to.startsWith("session:");
}
export function isChannelAddress(to: string): boolean {
  return to.startsWith("channel:");
}
export function isPluginAddress(to: string): boolean {
  return to.startsWith("plugin:");
}
/** 从 session 地址取回 procs key(session:<key> → <key>)。 */
export function sessionKeyOf(address: string): string {
  return address.slice("session:".length);
}
/** 从 channel 地址取房名(channel:<name> → <name>)。 */
export function channelNameOf(address: string): string {
  return address.slice("channel:".length);
}

/** session_done 的完成状态。 */
export type SessionDoneStatus = "done" | "error" | "aborted" | "timeout";

/** session_done 帧的 payload 形状(完成状态 + 完整输出;超长截断附文件路径)。 */
export interface SessionDonePayload {
  session: string;
  status: SessionDoneStatus;
  output: string;
  /** 输出被截断时非空:会话文件绝对路径,接收方可经 read 工具取全文。 */
  sessionPath?: string;
}

/** Session Bus 插件能力面(permissions: "sessions:bus";实现=application SessionBus,经 IPC 门控)。
 *  与 extension 的 7 个 tool 同一组 op(契约单源)——publish/reply 是 send 的参数化,
 *  join/leave 合进 channelMember,查询全部收敛进 status(一轮拿全景)。 */
export interface BusApi {
  /** 一轮查全景:身份 + 运行中会话 + 全部房间(含成员)+ 相关 tap。 */
  status(): Promise<unknown>;
  /** 发消息到任意地址(session:<key>/channel:<name>/plugin:<id>);回复带 replyTo。 */
  send(to: string, kind: string, payload: unknown, replyTo?: string): Promise<{ delivered: string }>;
  /** 起一个新会话进程(task 首条注入;watch=true 完成回 session_done 含完整输出;channels 起完即入房)。 */
  sessionCreate(opts: { task?: string; cwd?: string; name?: string; model?: { provider: string; modelId: string }; toolConfig?: unknown; watch?: boolean; channels?: string[] }): Promise<unknown>;
  sessionAbort(session: string): Promise<unknown>;
  /** 房间成员管理(member 缺省=自己,可替别人拉/退房)。 */
  channelMember(channel: string, action: "join" | "leave", member?: string): Promise<unknown>;
  tapStart(opts: { session?: string; channel?: string; filter?: TapFilter; deliverTo?: string }): Promise<{ tapId: string; filter: string }>;
  tapStop(tapId: string): Promise<unknown>;
  /** 订阅投递到本插件的总线帧(返回值取消订阅;按 to === plugin:<ownId> 自行过滤)。 */
  onMessage(cb: (message: SessionBusMessage) => void): () => void;
}
