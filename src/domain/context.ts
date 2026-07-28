// 圆心:PluginContext 契约 —— 插件能调用的 API 接口(圆心拥有,零外部依赖)。
//
// 依据 DESIGN.md §3.2.4(PluginContext 接口)、§3.2.5(RendererPluginContext)。
// 圆心只定义接口形状,实现在 application/shell 注入(依赖倒置)。
// 接口里只用圆心中性类型,不 import react/electron/pi(圆心纯度纪律)。
//
// 本文件当前只钉死 config 子对象(本次"插件配置"目标的核心契约);
// rpc/events/i18n/management 等子对象随各阶段补,在此先占位最小集。

import type {
  SessionsApi, MessagingApi, ModelApi, SessionTreeApi, SessionMaintenanceApi, QueueModeApi, BashApi,
  FsReadApi, GitReadApi, DialogApi, ImageInput, BashResult, HeaderPatch, SessionInfo,
} from "./sessions";

/** 插件配置 API(DESIGN.md:760-764)。worker 侧持有,renderer 侧不暴露。 */
export interface PluginConfigApi {
  /** 同步读一个配置 key;不存在返回 undefined,调用方用 ?? 兜底默认值。 */
  get<T>(key: string): T | undefined;
  /** 异步写一个配置 key;落盘完成 resolve。 */
  set<T>(key: string, value: T): Promise<void>;
  /** 同步读整个合并后的配置快照(项目级覆盖用户级)。 */
  all(): Record<string, unknown>;
}

/** i18n 翻译能力(05-plugin-i18n §9)。t 同步查字典;locale 是当前语言(zh-CN/zh-TW/en/de)。 */
export interface I18nApi {
  /** 取文案;vars 插值;缺失走 fallback 链(当前→en→字面值→key 本身)。 */
  t(key: string, vars?: Record<string, unknown>): string;
  /** 当前 locale。 */
  locale: string;
}

/**
 * 插件上下文(圆心拥有,shell 注入实现)。
 *
 * 接口按关注点分组,每组继承 RpcOps 基类(共享 getStats):
 * - sessions:会话生命周期(不继承 RpcOps——管进程和文件,不是发命令)
 * - messaging:消息发送(prompt/abort/steer/followUp/abortRetry)
 * - models:模型与推理(getModels/setModel/cycleModel/thinkingLevel)
 * - tree:会话树操作(fork/clone/getForkMessages)
 * - maintenance:会话维护(compact/exportHtml/autoCompaction/autoRetry)
 * - queue:队列模式(setSteeringMode/setFollowUpMode)
 * - bash?:Bash 执行(需声明 rpc:bash 权限)
 *
 * 新底座命令加进来时,新建子接口 extends RpcOps,加到 PluginContext,已有接口不改(开闭原则)。
 */
export interface PluginContext {
  config: PluginConfigApi;
  sessions: SessionsApi;
  messaging: MessagingApi;
  models: ModelApi;
  tree: SessionTreeApi;
  maintenance: SessionMaintenanceApi;
  queue: QueueModeApi;
  i18n: I18nApi;
  fs?: FsReadApi;
  git?: GitReadApi;
  bash?: BashApi;
  dialog: DialogApi;
}

/**
 * RendererPluginContext 不含 config(DESIGN.md:795-830)——
 * renderer 拿只读配置快照,改了经 onSave→worker 落盘。
 * 当前内置插件全是 renderer 形态、经 window.pi 桥访问能力,故 renderer 侧
 * 复用本接口(@pi-desktop/react 的 usePluginContext 按 pluginId 绑定);
 * permissions 的"未声明不注入"在 main IPC 边界强制(抛错),worker 化后改为真不注入。
 */
