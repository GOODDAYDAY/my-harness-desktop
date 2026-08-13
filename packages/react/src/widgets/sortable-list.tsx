import { createContext, useContext, useEffect, type CSSProperties, type ReactNode } from "react";
import { Reorder, useDragControls } from "framer-motion";
import { useUiStore } from "../../../../src/api/renderer/stores/ui-store";

type Axis = "x" | "y";

interface SortableListContextValue {
  disabled: boolean;
  floatCard: boolean;
  surfaceReady: boolean;
  onEnd?: () => void;
}

// 单列表排序容器——框架承担触发面/排他/悬浮卡/token 化视觉,插件只传 values + render 子项 + onEnd 落盘钩子。
const SortableListContext = createContext<SortableListContextValue | null>(null);

export interface SortableListProps<T extends string | number> {
  /** 受控顺序(Reorder values)。拖动中逐帧回调,onEnd 才推荐落盘。 */
  values: T[];
  /** Reorder 实时回调(仅更新 React state 跟手)。 */
  onReorder: (values: T[]) => void;
  /** 拖放结束的一次性持久化钩子(Reorder.Item onDragEnd 上挂)。 */
  onEnd?: () => void;
  /** 全局禁拖(搜索/归档等情境)。 */
  disabled?: boolean;
  /** 悬浮卡,默认开。默认 token 化的 surface 底 + shadow-md 悬浮卡形态。 */
  floatCard?: boolean;
  /** 拖拽方向 Reorder axis,默认 y。 */
  axis?: Axis;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export interface SortableListItemProps<T extends string | number> {
  /** 与 SortableList.values 数组项一致。 */
  value: T;
  /** 行单项是否禁拖,覆盖父 disabled。 */
  disabled?: boolean;
  /** 行 hover 提示。 */
  title?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

function useFloatCard(): { surfaceReady: boolean } {
  useEffect(() => {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--color-surface").trim();
    if (!v) console.error("[SortableList] 主题缺 color.surface token,悬浮卡将退化为不透明");
  }, []);
  const surfaceReady = typeof document !== "undefined"
    && getComputedStyle(document.documentElement).getPropertyValue("--color-surface").trim() !== "";
  return { surfaceReady };
}

export function SortableList<T extends string | number>({ values, onReorder, onEnd, disabled = false, floatCard, axis = "y", children, className, style }: SortableListProps<T>): ReactNode {
  const { surfaceReady } = useFloatCard();
  const floatCardPref = useUiStore((s) => s.generalConfig["floatCard"]);
  const floatCardOn = (floatCard ?? floatCardPref ?? true) !== false && surfaceReady;
  const ctx: SortableListContextValue = {
    disabled,
    floatCard: floatCardOn,
    surfaceReady,
    onEnd,
  };
  return (
    <SortableListContext.Provider value={ctx}>
      <Reorder.Group as="div" axis={axis} values={values as T[]} onReorder={onReorder} className={className} style={style}>
        {children}
      </Reorder.Group>
    </SortableListContext.Provider>
  );
}

function SortableListItem<T extends string | number>({ value, disabled: itemDisabled, title, style, children }: SortableListItemProps<T>): ReactNode {
  const ctx = useContext(SortableListContext);
  const controls = useDragControls();
  const disabled = itemDisabled ?? ctx?.disabled ?? false;
  const floatCard = (ctx?.floatCard ?? true) && !disabled;
  return (
    <Reorder.Item
      as="div"
      value={value}
      dragListener={false}
      dragControls={controls}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.1, ease: "easeOut" }}
      onPointerDown={(e) => {
        if (disabled) return;
        if ((e.target as HTMLElement).closest("input,textarea,button,[contenteditable]")) return;
        // 根因:framer-motion 拖拽不 preventDefault → pointerdown 放行 mousedown,
        // 拖行时行内文字进选区。preventDefault 只挡选区/焦点,不挡 click 与 FM 拖拽
        // (FM 纯走 pointer 事件链)。
        e.preventDefault();
        controls.start(e);
      }}
      onDragEnd={() => ctx?.onEnd?.()}
      title={title}
      whileDrag={floatCard ? {
        scale: 1.02,
        zIndex: 10,
        boxShadow: "var(--shadow-md)",
        background: "var(--color-surface)",
        color: "var(--color-surface-fg)",
        borderRadius: "var(--radius-sm)",
      } : undefined}
      style={{
        position: "relative",
        cursor: disabled ? undefined : "grab",
        listStyle: "none",
        ...style,
      }}
    >
      {children}
    </Reorder.Item>
  );
}

SortableList.Item = SortableListItem;
