// 悬停 1s 延迟浮出的解释气泡——titlebar 次级统计与 composer 上下文条共用。
// 原生 title 在 Electron/Chromium 里时延不可控且经常不弹;
// 用 Radix Tooltip 固定 delayDuration=1000,portal/边界翻转/加热区交接全由成熟包代劳。
import * as Tooltip from "@radix-ui/react-tooltip";

const tipStyle: React.CSSProperties = {
  background: "var(--color-surface)",
  color: "var(--color-fg)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-lg)",
  padding: "6px 12px",
  fontSize: "var(--font-size-sm)",
  lineHeight: 1.6,
  fontFamily: "var(--font-family-sans)",
  maxWidth: "280px",
  whiteSpace: "normal",
  zIndex: 99999,
};

export function HoverTip({ text, children }: { text: string; children: React.ReactNode }): React.ReactNode {
  return (
    <Tooltip.Root delayDuration={1000}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="bottom" sideOffset={6} style={tipStyle}>
          {text}
          <Tooltip.Arrow style={{ fill: "var(--color-border)" }} width={10} height={5} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
