import React from "react";

/** ErrorBoundary:子组件抛错不拖垮整树。
 *  默认显示错误信息(根级用法,白屏不如红字);传 fallback={null} 则静默——
 *  悬浮层等附属 UI 的合格降级是消失,不是在视口里留一块红。 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode; onError?: (error: Error) => void },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }
  componentDidCatch(error: Error): void {
    this.props.onError?.(error);
  }
  render(): React.ReactNode {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div style={{ padding: 32, color: "red", fontFamily: "monospace", fontSize: 14 }}>
          渲染错误: {String(this.state.error.message)}
        </div>
      );
    }
    return this.props.children;
  }
}
