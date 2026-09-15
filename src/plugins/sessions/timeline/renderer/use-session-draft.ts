// use-session-draft.ts —— 输入框草稿按会话隔离的 hook。
//
// 目标:每个 session 的输入框内容不是通用的——切走时保存、切回时恢复,发送成功经
// setInput("") 清空。草稿是未发送内容,内存态不落盘(发送成功才进会话文件),刷新丢失可接受。
//
// 存储已迁到会话作用域容器(设计 docs/design/session-scope.md §2.6.1):草稿是框架保留槽
// composerDraft,经 session-pending 的 useComposerDraftStore 读写,key 由 currentScopeKey 内部
// 消化。此前草稿存 ui-store.composerDrafts(按 key 分组的 Record),本 hook 要自己侦测 draftKey
// 变化、用 prevKeyRef 把 input 存回旧 key——那是「手动实现作用域」,与 review 手写物化迁移、
// goal 自造 goalBirthPath 同族(设计 §1.1.1 的第 N 处)。现在作用域容器承担隔离与搬迁,
// 本 hook 只剩「把 React 本地 input 与作用域槽双向同步」这一件真正属于它的事。
//
// 返回 [input, setInput]:setInput 是统一写口(空文本 = 清除草稿),所有调用方用它
// 而不是裸 useState 的 setter。
import { useCallback, useEffect, useRef, useState } from "react";
import { useComposerDraftStore, useCurrentScopeKey, writeComposerDraft, clearComposerDraft } from "@my-harness-desktop/react";

/** 按指定作用域写/清草稿(换档时存回**旧**作用域用——此刻 currentScopeKey 已是新值,
 *  必须显式传旧 key,所以走派生层的裸函数形态而不是 hook 绑定的写口)。 */
function writeDraftAt(scopeKey: string, text: string): void { writeComposerDraft(text, scopeKey); }
function clearDraftAt(scopeKey: string): void { clearComposerDraft(scopeKey); }

export function useSessionDraft(): [string, (updater: string | ((prev: string) => string)) => void] {
  // 作用域 key:身份一变(切会话/物化)它就变,驱动下面的换档 effect。
  const scopeKey = useCurrentScopeKey();
  // 草稿槽(读当前作用域那份 + 写口)。
  const [draft, writeDraft, clearDraft] = useComposerDraftStore();
  const [input, setInputState] = useState(draft ?? "");
  // 供同步读取最新值(切换保存 / setInput 函数式 updater),避免闭包旧值。
  const inputRef = useRef(input);
  inputRef.current = input;
  const scopeKeyRef = useRef<string | null>(scopeKey);
  // 写口经 ref 暴露给 effect,避免把 writeDraft/clearDraft 放进 deps 导致 effect 重跑。
  const writeRef = useRef(writeDraft);
  writeRef.current = writeDraft;
  const clearRef = useRef(clearDraft);
  clearRef.current = clearDraft;

  // 换档:scopeKey 变化时,把当前 input 存回**旧**作用域,从**新**作用域恢复 input。
  // 作用域容器负责隔离与物化搬迁(壳键→真身),本 effect 只负责「React 本地 input ↔ 槽」的同步。
  useEffect(() => {
    if (scopeKeyRef.current === scopeKey) return;
    const prevKey = scopeKeyRef.current;
    const cur = inputRef.current;
    // 存回旧作用域(显式按 prevKey 写,不是当前 key——此刻 currentScopeKey 已经是新值)。
    if (prevKey) {
      if (cur) writeDraftAt(prevKey, cur);
      else clearDraftAt(prevKey);
    }
    scopeKeyRef.current = scopeKey;
    // 从新作用域恢复(draft 已随 useComposerDraftStore 订阅到新值;这里同步本地 input)。
    setInputState(draft ?? "");
  }, [scopeKey, draft, writeDraft, clearDraft]);

  const setInput = useCallback((updater: string | ((prev: string) => string)) => {
    const prev = inputRef.current;
    const next = typeof updater === "string" ? updater : updater(prev);
    setInputState(next);
    inputRef.current = next;
    // 写当前作用域(空文本即清,与原 setComposerDraft 同语义,由 writeComposerDraft 内部保证)。
    if (next) writeRef.current(next);
    else clearRef.current();
  }, []);

  return [input, setInput];
}
