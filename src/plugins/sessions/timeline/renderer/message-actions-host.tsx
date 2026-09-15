// message-actions-host.tsx —— messageActions 槽的宿主渲染(消费方一侧)。
//
// timeline 是 messageActions 槽的消费方:查槽拿全部贡献项 → 按适用性筛 → 解析各插件的
// 动作组件渲染成按钮组。动作本身的语义归贡献插件(retry/session-bookmarks/continue…),
// 本文件只管「哪些动作适用于这一条消息」和「怎么排」。
//
// 适用性判定收在圆心(messageActionApplies,packages/shared/src/domain/contributions.ts):
// role + settled 两个谓词对所有贡献者一视同仁,不在这里内联、也不让各动作插件自己判。
// settled 的效果:在飞的流式占位行(pending)不渲染锚点类按钮(重试/分叉/收藏),
// 已落定的历史行照常——**流式生成中照样能分叉/收藏**,禁的只是「拿在飞那条当锚点」。
//
// 排布语义:用户气泡右对齐 → 动作行随之靠右;助手行靠左。整行(hover 淡入/间距/mt)
// 由调用方 MessageRow 统一,这里只做按钮组内排布。
import type { NeutralMessage } from "@my-harness-desktop/shared";
import { messageActionApplies } from "@my-harness-desktop/shared";
import { useMessageActions, resolveMessageActionComponent } from "@my-harness-desktop/react";

export function MessageActionsHost({ message, text }: { message: NeutralMessage; text: string }): React.ReactNode {
  const slotActions = useMessageActions();
  const applicable = slotActions.filter((a) => messageActionApplies(a, message));
  const leftActions = applicable.filter((a) => a.placement !== "right");
  const rightActions = applicable.filter((a) => a.placement === "right");
  if (applicable.length === 0) return null;

  const render = (action: typeof leftActions[number]): React.ReactNode => {
    const Comp = resolveMessageActionComponent(action.pluginId, action.component);
    if (!Comp) return null;
    return <Comp key={`${action.pluginId}:${action.id}`} message={message} text={text} />;
  };

  return (
    <div className="flex items-center gap-1">
      {leftActions.map(render)}
      {rightActions.map(render)}
    </div>
  );
}
