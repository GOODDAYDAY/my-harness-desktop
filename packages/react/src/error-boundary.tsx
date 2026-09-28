import React from "react";
// 直接用全局 i18next 实例（不是 useTranslation）：本组件是渲染崩溃的最后兜底，
// 不能假定 React 上下文/i18n Provider 还活着；且 class 组件拿不到 hook。
import i18next from "i18next";

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
          {/* 这是"渲染整个崩了"的最后兜底，此时不能假定 React 上下文/i18n Provider 还活着，
              所以不用 useTranslation（class 组件也拿不到 hook），而是直接问全局 i18next 实例。
              ⚠ 但**必须有英文 defaultValue**：i18n 自身也可能就是崩因，那时 t() 返回 defaultValue，
              用户至少读到英文而不是空白。此前这里是写死的中文「渲染错误:」——英文/德文用户在
              崩溃时看到中文（§7.1 铁律一：壳不内嵌文案）。 */}
          {i18next.t("shell.renderError", { defaultValue: "Render error" })}: {String(this.state.error.message)}
        </div>
      );
    }
    return this.props.children;
  }
}
