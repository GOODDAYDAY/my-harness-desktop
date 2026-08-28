// use-session-draft.ts —— 输入框草稿按会话 key 隔离的 hook。
//
// 目标(§会话流输入框草稿):每个 session 的输入框内容不是通用的——切走时保存、
// 切回时恢复,发送成功经 setInput("") 清空。草稿存 ui-store.composerDrafts(内存态,
// 与 sessionModelPending/pendingQueue 同款;发送成功才落盘进会话文件)。
//
// 返回 [input, setInput]:setInput 是统一写口(空文本 = 清除草稿),所有调用方用它
// 而不是裸 useState 的 setter;草稿 key 变化时自动保存旧草稿 + 恢复新草稿。
import { useCallback, useEffect, useRef, useState } from "react";
import { useUiStore } from "@my-harness-desktop/react";

export function useSessionDraft(
  draftKey: string | null,
): [string, (updater: string | ((prev: string) => string)) => void] {
  const [input, setInputState] = useState("");
  // 供同步读取最新值(切换保存 / setInput 函数式 updater),避免闭包旧值。
  const inputRef = useRef(input);
  inputRef.current = input;
  const draftKeyRef = useRef<string | null>(draftKey);

  useEffect(() => {
    if (draftKeyRef.current === draftKey) return;
    const prevKey = draftKeyRef.current;
    const cur = inputRef.current;
    if (prevKey) {
      // 保存旧会话草稿(空草稿即清,不留空串滞留)
      if (cur) useUiStore.getState().setComposerDraft(prevKey, cur);
      else useUiStore.getState().clearComposerDraft(prevKey);
    }
    draftKeyRef.current = draftKey;
    // 恢复目标会话草稿
    setInputState(draftKey ? (useUiStore.getState().composerDrafts[draftKey] ?? "") : "");
  }, [draftKey]);

  const setInput = useCallback((updater: string | ((prev: string) => string)) => {
    const prev = inputRef.current;
    const next = typeof updater === "string" ? updater : updater(prev);
    setInputState(next);
    inputRef.current = next;
    const key = draftKeyRef.current;
    if (key) {
      if (next) useUiStore.getState().setComposerDraft(key, next);
      else useUiStore.getState().clearComposerDraft(key);
    }
  }, []);

  return [input, setInput];
}
