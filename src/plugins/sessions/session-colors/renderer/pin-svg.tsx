import React from "react";

export function PinSVG({ color, style }: { color: string; style?: React.CSSProperties }): React.ReactNode {
  return (
    <svg viewBox="0 0 22 26" fill="none" xmlns="http://www.w3.org/2000/svg" style={style}>
      <ellipse cx="11" cy="5.5" rx="6.5" ry="4.5" fill={color} />
      <ellipse cx="9" cy="4" rx="2.8" ry="1.6" fill="rgba(255,255,255,0.35)" />
      <path d="M11 10 L11 20" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M11 20 L9.5 24" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M11 20 L12.5 24" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
