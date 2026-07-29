import { useState, type CSSProperties, type ReactNode } from "react";

export interface PanelSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function PanelSearchInput({ value, onChange, placeholder }: PanelSearchInputProps): ReactNode {
  const [focused, setFocused] = useState(false);
  const style: CSSProperties = {
    width: "100%",
    padding: "var(--sidepanel-input-py) var(--sidepanel-input-px)",
    border: focused ? "var(--sidepanel-input-border-focus)" : "var(--sidepanel-input-border)",
    borderRadius: "var(--sidepanel-input-radius)",
    background: "var(--sidepanel-input-bg)",
    color: "var(--color-fg)",
    fontSize: "var(--font-size-sm)",
    fontFamily: "var(--font-family-sans)",
    outline: "none",
    transition: "border-color 0.15s",
  };
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder={placeholder}
      style={style}
    />
  );
}
