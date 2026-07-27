// pi.ui Composer —— OpenWebUI 式输入区软容器壳。
//
// 对照 open-webui MessageInput.svelte #message-input-container:
// 一个 rounded-3xl + backdrop-blur 的毛玻璃软容器,装 textarea + 底部左右分置工具栏。
// 左侧胶囊区(children 注入,现在空)预留 web search / image gen 等工具开关;
// 右侧 Voice 占位 + Send 按钮。
//
// 这是 shell 细节:组件代码归项目管,圆心不感知。token 经 CSS 变量消费,
// blur/半透明背景是固定视觉常量(呼应 OpenWebUI 直接写死,不进主题 token)。
import { cva, type VariantProps } from "class-variance-authority";
import { Button } from "./button";
import { cn } from "./button";
import { Send, Mic } from "lucide-react";

const composerVariants = cva(
  // 软容器:全页最大圆角 + 毛玻璃 + 阴影,聚焦时边框反而更亮(对话感隐喻)
  "flex-1 flex flex-col relative w-full shadow-lg rounded-3xl border transition " +
    "bg-white/5 dark:bg-gray-500/5 backdrop-blur-sm " +
    "border-gray-100/30 dark:border-gray-850/30 " +
    "hover:border-gray-200 focus-within:border-gray-100 " +
    "dark:hover:border-gray-800 dark:focus-within:border-gray-800",
  {
    variants: {},
    defaultVariants: {},
  }
);

export interface ComposerProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value" | "onSubmit"> {
  /** 当前输入文本(受控)。 */
  value: string;
  /** 文本变化回调。 */
  onValueChange: (v: string) => void;
  /** 发送(Enter/Cmd+Enter 或点 Send)。返回 Promise 以支持异步发送,发送中禁用按钮。 */
  onSubmit: () => void | Promise<void>;
  /** 左侧胶囊区(工具开关,现在空)。 */
  children?: React.ReactNode;
  /** 是否正在发送(禁用 Send)。 */
  sending?: boolean;
  /** 占位提示。 */
  placeholder?: string;
}

export function Composer({
  value,
  onValueChange,
  onSubmit,
  children,
  sending = false,
  placeholder = "给 agent 发消息…  (Enter 发送 / Shift+Enter 换行)",
  ...rest
}: ComposerProps): React.ReactNode {
  const canSend = value.trim().length > 0 && !sending;

  return (
    <form
      className="flex flex-col gap-1.5 w-full"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) void onSubmit();
      }}
    >
      <div className={composerVariants()}>
        {/* textarea:自适高,封顶 max-h-96,无边框(容器已圆) */}
        <textarea
          {...rest}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) void onSubmit();
            }
          }}
          placeholder={placeholder}
          rows={1}
          className="resize-none outline-none bg-transparent w-full px-3 py-3 max-h-96 overflow-auto scrollbar-hidden text-[var(--font-size-base)] font-[var(--font-family-sans)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)]"
        />

        {/* 底部工具栏:左右分置。左 flex-1 min-w-0 可横向滚动承载多工具,右 shrink-0 永保按钮完整 */}
        <div className="flex justify-between items-end mt-1 mb-1.5 mx-1">
          {/* 左胶囊区:空时不占高,有 children 时横向滚动 */}
          <div className="flex flex-1 min-w-0 items-center gap-1 overflow-x-auto scrollbar-none">
            {children}
          </div>

          {/* 右按钮区:Voice 占位 + Send */}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="size-8 p-0 rounded-full"
              aria-label="语音输入"
              tabIndex={-1}
            >
              <Mic className="size-4" />
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!canSend}
              className="size-8 p-0 rounded-full"
              aria-label="发送"
            >
              <Send className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

export { composerVariants };
