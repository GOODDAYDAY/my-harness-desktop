import { create } from "zustand";

/** 评论篮子模块级 store(设计 docs/design/plugin-decoupling.md §5.2):渲染归位后
 *  Overlay(选区浮层)与 BasketBar(composer 附件槽组件)共用同一份篮子状态——
 *  提升到模块级,不再经 timeline 路由回执(六个 review:* 通道已删)。 */

export interface ReviewComment {
  id: string;
  messageId?: string;
  quote: string;
  comment: string;
  createdAt: number;
  updatedAt: number;
}

interface ReviewBasketState {
  /** sessionKey → 评论列表。 */
  baskets: Map<string, ReviewComment[]>;
  addComment: (sessionKey: string, c: ReviewComment) => void;
  updateComment: (sessionKey: string, commentId: string, comment: string) => void;
  removeComment: (sessionKey: string, commentId: string) => void;
  clearBasket: (sessionKey: string) => void;
}

export const useReviewBasketStore = create<ReviewBasketState>((set) => ({
  baskets: new Map(),
  addComment: (sessionKey, c) =>
    set((s) => {
      const next = new Map(s.baskets);
      const list = next.get(sessionKey) ?? [];
      next.set(sessionKey, [...list, c]);
      return { baskets: next };
    }),
  updateComment: (sessionKey, commentId, comment) =>
    set((s) => {
      const next = new Map(s.baskets);
      const list = next.get(sessionKey) ?? [];
      next.set(sessionKey, list.map((c) => c.id === commentId ? { ...c, comment, updatedAt: Date.now() } : c));
      return { baskets: next };
    }),
  removeComment: (sessionKey, commentId) =>
    set((s) => {
      const next = new Map(s.baskets);
      const list = next.get(sessionKey) ?? [];
      next.set(sessionKey, list.filter((c) => c.id !== commentId));
      return { baskets: next };
    }),
  clearBasket: (sessionKey) =>
    set((s) => {
      const next = new Map(s.baskets);
      next.set(sessionKey, []);
      return { baskets: next };
    }),
}));
