// 标题栏 —— 无边框窗口的自定义 chrome(壳的本职)。
//
// 整条是拖拽区(-webkit-app-region: drag),按钮 no-drag。
// 左:左栏开关 + π pi / {会话标题} 面包屑;右:右面板开关。
import { PanelLeft, PanelRight } from "lucide-react";
import { useUiStore } from "../ui-store";

const iconBtn: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: "28px", height: "28px", border: "none", borderRadius: "var(--radius-sm)",
  background: "transparent", color: "var(--color-muted)", cursor: "pointer",
  // @ts-expect-error 拖拽区是 Electron 私有 CSS 属性
  WebkitAppRegion: "no-drag",
};

export function Titlebar(): React.ReactNode {
  const sessionTitle = useUiStore((s) => s.sessionTitle);
  const leftPanelOpen = useUiStore((s) => s.leftPanelOpen);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const setLeftPanelOpen = useUiStore((s) => s.setLeftPanelOpen);
  const setRightPanelOpen = useUiStore((s) => s.setRightPanelOpen);

  return (
    <div
      className="flex items-center h-10 shrink-0 select-none"
      style={{
        // @ts-expect-error Electron 私有属性:整条标题栏可拖拽移动窗口
        WebkitAppRegion: "drag",
        paddingLeft: "88px", // 给红绿灯让位(trafficLightPosition x:14)
        paddingRight: "var(--spacing-sm)",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <button style={iconBtn} title="切换左栏 (⌘B)" onClick={() => setLeftPanelOpen(!leftPanelOpen)}>
        <PanelLeft className="size-4" style={{ opacity: leftPanelOpen ? 1 : 0.5 }} />
      </button>

      <div className="flex items-center gap-1.5 ml-2 text-[var(--font-size-sm)] text-[var(--color-muted)]">
        <span style={{ fontFamily: "var(--font-family-sans)" }}>π</span>
        <span>pi</span>
        <span style={{ opacity: 0.5 }}>/</span>
        <span className="text-[var(--color-fg)]">{sessionTitle ?? "新对话"}</span>
      </div>

      <div className="ml-auto">
        <button style={iconBtn} title="切换右侧面板 (⌘J)" onClick={() => setRightPanelOpen(!rightPanelOpen)}>
          <PanelRight className="size-4" style={{ opacity: rightPanelOpen ? 1 : 0.5 }} />
        </button>
      </div>
    </div>
  );
}
