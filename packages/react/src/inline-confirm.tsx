// 原位两步确认共享原语 —— 替代 window.confirm / 遮罩弹窗的统一交互契约。
//
// 规则:任何需要二次确认的动作,第一步在触发点,第二步在触发点原位变换;
// 全程无遮罩、无原生 dialog、焦点不离开上下文。
//
// 两种形态(收敛自 retry/fork/bookmark 四处同构消费,§3.3 达标):
//   - InlineConfirmInput(输入形态):原位输入框,Enter/✓ 确认,Esc/✗/失焦 取消。
//   - useArmConfirm(武装形态):按钮原地变"确认?",再点执行;Esc/超时自动复位。
//
// 容器契约(消费方须知):第二步控件 autoFocus 之后,父容器经 `focus-within:opacity-100`
// 保持可见,不依赖 hover——否则鼠标移开、第二步组件连同行一起闪退。
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, X } from "lucide-react";

export interface InlineConfirmInputProps {
  /** 初始值。挂载即聚焦+全选:Enter 直接确认默认值,打字即覆盖,零多余击键。 */
  defaultValue?: string;
  placeholder?: string;
  /** title 文案由消费方 i18n 供(框架组件零文案,§1.2)。 */
  confirmTitle?: string;
  cancelTitle?: string;
  inputStyle?: CSSProperties;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function InlineConfirmInput({
  defaultValue = "",
  placeholder,
  confirmTitle,
  cancelTitle,
  inputStyle,
  onConfirm,
  onCancel,
}: InlineConfirmInputProps): ReactNode {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const confirm = (): void => {
    const v = value.trim();
    if (v) onConfirm(v);
  };

  return (
    <div
      ref={rootRef}
      style={{ display: "flex", alignItems: "center", gap: 2 }}
      onBlur={(e) => {
        // 焦点离开整组(input/✓/✗)= 放弃;点击空白即取消
        if (!rootRef.current?.contains(e.relatedTarget as Node)) onCancel();
      }}
    >
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); confirm(); }
          else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        style={{
          width: 150, padding: "1px 6px", fontSize: "var(--font-size-xs)",
          color: "var(--color-fg)", background: "var(--color-bg)",
          border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)",
          outline: "none", ...inputStyle,
        }}
      />
      <button onClick={confirm} title={confirmTitle} disabled={!value.trim()} style={iconBtnStyle}>
        <Check size={14} />
      </button>
      <button onClick={onCancel} title={cancelTitle} style={iconBtnStyle}>
        <X size={14} />
      </button>
    </div>
  );
}

/** 武装两步确认状态机:arm(value) 置位 armed,超时/Esc 自动复位。
 *  单按钮场景:useArmConfirm() + arm(true) + armed===true 判断;
 *  同面板多行场景:useArmConfirm<string>() + arm(rowId) + armed===rowId 判断。 */
export function useArmConfirm<T = boolean>(timeoutMs = 6000): {
  armed: T | null;
  arm: (value: T) => void;
  disarm: () => void;
} {
  const [armed, setArmed] = useState<T | null>(null);

  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), timeoutMs);
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setArmed(null); };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
    };
  }, [armed, timeoutMs]);

  return { armed, arm: setArmed, disarm: () => setArmed(null) };
}

const iconBtnStyle: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 18, height: 18, padding: 0, border: "none", background: "transparent",
  color: "var(--color-muted)", cursor: "pointer", borderRadius: "var(--radius-sm)", flexShrink: 0,
};
