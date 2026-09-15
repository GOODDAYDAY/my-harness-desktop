// review/core/basket —— 评论篮的纯数据模型(不 import react、不碰 ctx,可裸单测)。
//
// 为什么下沉到 core(设计 docs/design/session-scope.md §3.3.1):篮子迁入会话作用域槽后,
// 槽的值就是 `ReviewComment[]`,而「入篮/改文本/删单条/清空」这四个操作有两个消费方
// (划词浮层 Overlay 与输入框附件条 BasketBar)。若各自写一遍数组操作,就是同一逻辑在两个
// 入口重复(CLAUDE.md §1.1 判别气味三);收进 core 后两处共用同一实现,且纯函数可裸单测。
//
// 全部函数不 mutate 入参、返回新数组——与 zustand/作用域容器的写入口配合(set 收新值),
// 也让调用方不必担心「改了数组但容器没察觉变更」。

/** 一条评论:划选的原文片段 + 用户意见。 */
export interface ReviewComment {
  id: string;
  /** 被评论的消息 id(锚点);纯评论(无锚点)时缺省。 */
  messageId?: string;
  /** 划选的原文(已截断)。 */
  quote: string;
  /** 用户意见正文。 */
  comment: string;
  createdAt: number;
  updatedAt: number;
}

/** 入篮:追加到末尾(序号 ①②③ 按数组顺序派生,所以顺序就是用户加入顺序)。 */
export function basketAdd(list: ReviewComment[], c: ReviewComment): ReviewComment[] {
  return [...list, c];
}

/** 改文本:只动命中的那条,updatedAt 推进;未命中原样返回同一数组引用(调用方可据此判无变化)。 */
export function basketUpdate(list: ReviewComment[], id: string, comment: string, now: number): ReviewComment[] {
  let changed = false;
  const next = list.map((c) => {
    if (c.id !== id) return c;
    changed = true;
    return { ...c, comment, updatedAt: now };
  });
  return changed ? next : list;
}

/** 删单条。 */
export function basketRemove(list: ReviewComment[], id: string): ReviewComment[] {
  return list.filter((c) => c.id !== id);
}

/** 清空:返回新的空数组(不复用同一个引用,避免跨会话共享)。 */
export function basketClear(): ReviewComment[] {
  return [];
}
