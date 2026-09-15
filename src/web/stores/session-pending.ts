// 会话级待执行意图 —— 模型偏好 / 排队消息 / 输入框草稿 / 工具过滤配置。
//
// 为什么独立成一个文件(设计 docs/design/session-scope.md §2.6.1/§2.6.2):
// 这四份态有一个共同性质——「未执行的意图」,按会话隔离、内存态不落盘、物化瞬间要跟着
// 身份搬迁。它们此前是 ui-store 上的四个字段 + 十个 action,与桌面偏好(主题/字体/侧栏宽度)
// 混在同一个 store 里,而且**每个消费方都要自己拼 key**(`ns ?? new:${cwd}`),
// 于是同一个会话在不同消费方那里可能是两个 key(设计 §1.1.2)。
//
// 现在:存储换成会话作用域容器(src/web/stores/session-scope.ts 的框架保留槽),
// key 由本文件内部经 currentScopeKey() 消化,**调用方不再传 key**——身份算法单源(§2.1.1)。
// 业务语义(排队入列/标失败/清失败标记、草稿空文本即清)留在本文件,不塞进通用容器:
// 容器只管「按会话分组 + 搬迁 + 回收」,不管「队列是什么意思」(关注点分离)。
//
// 两种形态:
//  · hook(usePendingQueue / useComposerDraft / …)—— 组件里用,订阅 nonce 自动重渲染、
//    切会话自动换档;
//  · 裸函数(readModelPending / clearComposerDraftAt / …)—— 非渲染路径用(发送编排、
//    事件回调),可显式指定作用域,缺省取当前。
import { useCallback, useMemo } from "react";
import type { SessionToolConfig, SessionModelPrefs } from "@my-harness-desktop/shared";
import { useSessionScopeStore, readFrameworkSlot, writeFrameworkSlot, currentScopeKey } from "./session-scope";
import { useUiStore } from "./ui-store";

/** 评论附件快照条目(与 timeline:composerAttachments 的 items 同构,输入态展示用)。 */
export interface CommentAttachment {
  id: string;
  messageId?: string;
  seq: string;
  quotePreview: string;
  comment: string;
}

/** 排队消息(streaming 时按发送暂存,AI 完成后合并成一条自动 flush)。 */
export interface QueuedMessage {
  id: string;
  text: string;
  /** 空文本项(纯评论入队)的篮内显示文案;由调用方用 t() 算好,store 不持有文案。 */
  displayText?: string;
  /** 入队瞬间的评论附件快照:flush 时活篮子已被消费/清空则回落它,排队意图不漂。 */
  attachments?: {
    items?: CommentAttachment[];
    promptFragment?: string;
    channels?: Record<string, string>;
  };
  failed?: boolean;
  errMsg?: string;
}

/** 会话级工具过滤的未落盘偏好(tool-manager 组开关只写这里,timeline send() 才 flush 到头行)。
 *  flushed=true 已落盘,留存只为 ToolPanelTab 显示不跳变,send() 跳过。config=null = 切回全部工具。
 *  注:此前形态是 `{ sessionPath, config, flushed }` 单值内嵌 key、读取侧靠比对
 *  (设计 §4.6.5);key 由作用域承担后内嵌字段删掉,比对代码一并消失。 */
export interface PendingToolConfig {
  config: SessionToolConfig | null;
  flushed: boolean;
}

// ============================================================================
// 裸函数形态(非渲染路径:发送编排、事件回调)
// ============================================================================

/** 模型意图:读当前作用域(缺省)或指定作用域。 */
export function readModelPending(scopeKey?: string | null): SessionModelPrefs | undefined {
  const key = scopeKey ?? currentScopeKey();
  if (!key) return undefined;
  return readFrameworkSlot<SessionModelPrefs | null>("modelPending", key) ?? undefined;
}
export function writeModelPending(prefs: SessionModelPrefs, scopeKey?: string | null): void {
  const key = scopeKey ?? currentScopeKey();
  if (!key) return;
  writeFrameworkSlot<SessionModelPrefs | null>("modelPending", key, prefs);
}
export function clearModelPending(scopeKey?: string | null): void {
  const key = scopeKey ?? currentScopeKey();
  if (!key) return;
  writeFrameworkSlot<SessionModelPrefs | null>("modelPending", key, null);
}

/** 草稿:空文本即清(不留空串滞留)——与原 ui-store.setComposerDraft 同语义。 */
export function readComposerDraft(scopeKey?: string | null): string {
  const key = scopeKey ?? currentScopeKey();
  if (!key) return "";
  return readFrameworkSlot<string>("composerDraft", key) ?? "";
}
export function writeComposerDraft(text: string, scopeKey?: string | null): void {
  const key = scopeKey ?? currentScopeKey();
  if (!key) return;
  const cur = readFrameworkSlot<string>("composerDraft", key);
  if (text) {
    if (cur === text) return;   // 幂等:同值不写(避免每次按键都递增 nonce 触发全量重渲染)
    writeFrameworkSlot<string>("composerDraft", key, text);
    return;
  }
  if (cur === "") return;
  writeFrameworkSlot<string>("composerDraft", key, "");
}
export function clearComposerDraft(scopeKey?: string | null): void {
  writeComposerDraft("", scopeKey);
}

/** 排队消息:读当前作用域(缺省)或指定作用域。 */
export function readPendingQueue(scopeKey?: string | null): QueuedMessage[] {
  const key = scopeKey ?? currentScopeKey();
  if (!key) return [];
  return readFrameworkSlot<QueuedMessage[]>("pendingQueue", key) ?? [];
}
/** 写整个队列(队列的业务操作都在下面一组函数里,这个是它们的共用落盘口)。 */
function writePendingQueue(list: QueuedMessage[], scopeKey?: string | null): void {
  const key = scopeKey ?? currentScopeKey();
  if (!key) return;
  writeFrameworkSlot<QueuedMessage[]>("pendingQueue", key, list);
}
export function enqueueMessage(text: string, attachments?: QueuedMessage["attachments"], displayText?: string, scopeKey?: string | null): void {
  writePendingQueue([...readPendingQueue(scopeKey), { id: crypto.randomUUID(), text, attachments, displayText }], scopeKey);
}
export function removeFromQueue(id: string, scopeKey?: string | null): void {
  writePendingQueue(readPendingQueue(scopeKey).filter((q) => q.id !== id), scopeKey);
}
export function clearQueue(scopeKey?: string | null): void {
  writePendingQueue([], scopeKey);
}
/** 整队标失败(flush 失败后保留全部,用户重试/逐条编辑/取消)。 */
export function markQueueFailed(errMsg: string, scopeKey?: string | null): void {
  writePendingQueue(readPendingQueue(scopeKey).map((q) => ({ ...q, failed: true, errMsg })), scopeKey);
}
/** 单条标失败(「立即发送」单条失败后标红,flush 被阻塞,用户可编辑/移除/整队重试)。 */
export function markQueueItemFailed(id: string, errMsg: string, scopeKey?: string | null): void {
  writePendingQueue(readPendingQueue(scopeKey).map((q) => (q.id === id ? { ...q, failed: true, errMsg } : q)), scopeKey);
}
/** 清失败标记(重试前调,不删条目)。 */
export function clearQueueFailed(scopeKey?: string | null): void {
  writePendingQueue(readPendingQueue(scopeKey).map((q) => ({ ...q, failed: false, errMsg: undefined })), scopeKey);
}

/** 工具过滤偏好。 */
export function readPendingToolConfig(scopeKey?: string | null): PendingToolConfig | null {
  const key = scopeKey ?? currentScopeKey();
  if (!key) return null;
  return readFrameworkSlot<PendingToolConfig | null>("toolConfig", key) ?? null;
}
export function writePendingToolConfig(p: PendingToolConfig | null, scopeKey?: string | null): void {
  const key = scopeKey ?? currentScopeKey();
  if (!key) return;
  writeFrameworkSlot<PendingToolConfig | null>("toolConfig", key, p);
}

/** 是否有排队中的用户发送(goal 续跑对用户输入让路的判据;设计 §2.4.5 提到的消费方)。
 *  只看当前作用域:goal 的让路语义是「这个会话里有用户待发消息」。 */
export function hasPendingUserSend(scopeKey?: string | null): boolean {
  return readPendingQueue(scopeKey).length > 0;
}

// ============================================================================
// hook 形态(组件里用:订阅 nonce 自动重渲染、切会话自动换档)
// ============================================================================

/** 当前会话的模型意图。 */
export function useModelPending(): [SessionModelPrefs | undefined, (p: SessionModelPrefs) => void, () => void] {
  useSessionScopeStore((s) => s.nonce);
  useCurrentIdentity();
  const set = useCallback((p: SessionModelPrefs) => writeModelPending(p), []);
  const clear = useCallback(() => clearModelPending(), []);
  return [readModelPending(), set, clear];
}

/** 当前会话的输入框草稿。set("") 即清(与原 setComposerDraft 同语义)。 */
export function useComposerDraftStore(): [string, (text: string) => void, () => void] {
  useSessionScopeStore((s) => s.nonce);
  useCurrentIdentity();
  const set = useCallback((text: string) => writeComposerDraft(text), []);
  const clear = useCallback(() => clearComposerDraft(), []);
  return [readComposerDraft(), set, clear];
}

/** 当前会话的排队消息 + 全部队列操作(操作不再收 key 参数,内部取当前作用域)。 */
export interface PendingQueueApi {
  enqueue: (text: string, attachments?: QueuedMessage["attachments"], displayText?: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  markFailed: (errMsg: string) => void;
  markItemFailed: (id: string, errMsg: string) => void;
  clearFailed: () => void;
}
export function usePendingQueue(): [QueuedMessage[], PendingQueueApi] {
  useSessionScopeStore((s) => s.nonce);
  useCurrentIdentity();
  const api = useMemo<PendingQueueApi>(() => ({
    enqueue: (text, attachments, displayText) => enqueueMessage(text, attachments, displayText),
    remove: (id) => removeFromQueue(id),
    clear: () => clearQueue(),
    markFailed: (errMsg) => markQueueFailed(errMsg),
    markItemFailed: (id, errMsg) => markQueueItemFailed(id, errMsg),
    clearFailed: () => clearQueueFailed(),
  }), []);
  return [readPendingQueue(), api];
}

/** 当前会话的工具过滤偏好。 */
export function usePendingToolConfig(): [PendingToolConfig | null, (p: PendingToolConfig | null) => void] {
  useSessionScopeStore((s) => s.nonce);
  useCurrentIdentity();
  const set = useCallback((p: PendingToolConfig | null) => writePendingToolConfig(p), []);
  return [readPendingToolConfig(), set];
}

/** 订阅身份字段:身份一变(ns / cwd 变化)组件重渲染 → 上面几个 hook 读到新会话那份。
 *  这是「切会话自动换档」的机制基础(设计 §2.4.2)——消费方不需要写任何侦测会话切换的 effect。 */
function useCurrentIdentity(): void {
  useUiStore((s) => s.currentNeutralSessionId);
  useUiStore((s) => s.currentCwd);
}
