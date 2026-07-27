// pi.ui Composer —— ChatGPT 式药丸输入区。
//
// 形态对照 chatgpt.com:rounded-[28px] 大药丸、surface 底、shadow 浮起、
// 左侧 "+" 圆形 ghost 按钮,右侧语音占位 + 圆形实心发送键(ArrowUp)。
// token 消费:bg 用 color.surface,发送键用 color.primary(chatgpt-dark 里是白底黑箭头)。
import { Plus, Mic, ArrowUp } from "lucide-react";

export interface ComposerProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value" | "onSubmit"> {
  /** 当前输入文本(受控)。 */
  value: string;
  /** 文本变化回调。 */
  onValueChange: (v: string) => void;
  /** 发送(Enter/Cmd+Enter 或点发送键)。返回 Promise 以支持异步发送,发送中禁用按钮。 */
  onSubmit: () => void | Promise<void>;
  /** 左侧胶囊区(工具开关,现在空)。 */
  children?: React.ReactNode;
  /** 是否正在发送(禁用发送键)。 */
  sending?: boolean;
  /** 占位提示。 */
  placeholder?: string;
}

const circleBtn = (enabled: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "32px", height: "32px", borderRadius: "50%", border: "none", flexShrink: 0,
  background: "transparent", color: "var(--color-muted)", cursor: enabled ? "pointer" : "default",
});

export function Composer({
  value,
  onValueChange,
  onSubmit,
  children,
  sending = false,
  placeholder = "给 agent 发消息…",
  ...rest
}: ComposerProps): React.ReactNode {
  const canSend = value.trim().length > 0 && !sending;

  return (
    <form
      className="flex flex-col w-full"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) void onSubmit();
      }}
    >
      <div
        className="flex flex-col w-full rounded-[28px] px-2 py-1.5"
        style={{
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-md)",
          border: "1px solid var(--color-border)",
        }}
      >
        {/* textarea:自适高,封顶 max-h-64,无边框(容器已圆) */}
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
          className="resize-none outline-none bg-transparent w-full px-3 pt-2.5 pb-1 max-h-64 overflow-auto scrollbar-hidden text-[length:var(--font-size-base)] leading-7 font-[var(--font-family-sans)] text-[var(--color-fg)] placeholder:text-[var(--color-muted)]"
        />

        {/* 底部工具栏:左 "+" / 右 语音占位 + 发送 */}
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-1">
            <button type="button" style={circleBtn(true)} title="附件(待接入)" tabIndex={-1}>
              <Plus className="size-5" />
            </button>
            {children}
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" style={circleBtn(true)} title="语音输入(待接入)" tabIndex={-1}>
              <Mic className="size-4.5" />
            </button>
            <button
              type="submit"
              disabled={!canSend}
              aria-label="发送"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: "32px", height: "32px", borderRadius: "50%", border: "none", flexShrink: 0,
                background: canSend ? "var(--color-primary)" : "var(--color-border)",
                color: canSend ? "var(--color-primary-fg)" : "var(--color-muted)",
                cursor: canSend ? "pointer" : "not-allowed",
                transition: "background 0.15s",
              }}
            >
              <ArrowUp className="size-4.5" strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
