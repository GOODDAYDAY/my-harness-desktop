// review 评论篮的会话作用域接入(设计 docs/design/session-scope.md §3.3.1)。
//
// 篮子是**当前会话**的评论数组,存在会话作用域槽里(renderer/index.tsx 声明
// { id: "basket", initial: () => [], carry: "concat" })。此前它是模块级 zustand store 里的
// `baskets: Map<sessionKey, ReviewComment[]>`——外层 Map 由插件自己按 key 分组,物化搬迁
// (壳键 `new:${cwd}` → 真身 ns)还要自己写一个 effect 侦测 key 变化手搬(旧 index.tsx:264-280,
// 17 行 prevKeyRef 逻辑),与框架的 carrySessionKey 是同一逻辑的第二份实现,且时序不同
// (effect 是渲染后异步跑,框架搬迁是换键那一刻同步跑),两者之间有一个窗口。
//
// 现在:外层分组与搬迁都由作用域容器承担(声明 carry:"concat" 即得到「追加到目标已有值之后」
// 的原语义),本文件只剩「读数组 + 用 core 的纯函数算新数组 + 写回」。
//
// 两个 hook 对应两类调用方:
//   useReviewBasket()   —— Overlay 用:操作**当前**会话的篮子(用户正在划词的那个)。
//   useReviewBasketAt() —— BasketBar 用:它拿到的是 timeline 发来的 payload.sessionKey,
//                          那是**入篮那一刻**的身份;用户可能在附件条还挂着时切走了会话,
//                          按 payload 的 key 操作才不会把改动写到别的会话上。
import { useCallback, useMemo } from "react";
import { useSessionScope, useSessionScopeAccess } from "@my-harness-desktop/react";
import {
  basketAdd, basketUpdate, basketRemove, basketClear,
  type ReviewComment,
} from "../core/basket";

export interface ReviewBasket {
  comments: ReviewComment[];
  add: (c: ReviewComment) => void;
  update: (id: string, comment: string) => void;
  remove: (id: string) => void;
  clear: () => void;
}

/** 当前会话的评论篮(渲染订阅 + 四个操作)。切会话自动换档——组件不需要知道会话身份。 */
export function useReviewBasket(): ReviewBasket {
  const [comments, setComments] = useSessionScope<ReviewComment[]>("basket");

  const add = useCallback((c: ReviewComment) => {
    setComments((prev) => basketAdd(prev ?? [], c));
  }, [setComments]);
  const update = useCallback((id: string, comment: string) => {
    setComments((prev) => basketUpdate(prev ?? [], id, comment, Date.now()));
  }, [setComments]);
  const remove = useCallback((id: string) => {
    setComments((prev) => basketRemove(prev ?? [], id));
  }, [setComments]);
  const clear = useCallback(() => { setComments(basketClear()); }, [setComments]);

  // useMemo 保持返回对象引用稳定:调用方把它放进 useCallback/useEffect 的 deps,
  // 每次渲染换新对象会让那些依赖每帧失效。
  return useMemo(
    () => ({ comments: comments ?? [], add, update, remove, clear }),
    [comments, add, update, remove, clear],
  );
}

/** 方法名沿用旧 review-basket-store 的命名(updateComment/removeComment/clearBasket),
 *  消费方(BasketBar)的调用点一行不用改——迁移只换存储,不改调用形状。 */
export interface ReviewBasketAt {
  updateComment: (scopeKey: string, id: string, comment: string) => void;
  removeComment: (scopeKey: string, id: string) => void;
  clearBasket: (scopeKey: string) => void;
}

/** 按**指定作用域**操作篮子(BasketBar 用,理由见文件头注释)。返回对象引用稳定。 */
export function useReviewBasketAt(): ReviewBasketAt {
  const access = useSessionScopeAccess<ReviewComment[]>("basket");
  return useMemo<ReviewBasketAt>(() => ({
    updateComment: (scopeKey, id, comment) => access.setAt(scopeKey, (prev) => basketUpdate(prev ?? [], id, comment, Date.now())),
    removeComment: (scopeKey, id) => access.setAt(scopeKey, (prev) => basketRemove(prev ?? [], id)),
    clearBasket: (scopeKey) => access.setAt(scopeKey, basketClear()),
  }), [access]);
}
