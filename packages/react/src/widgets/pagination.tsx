// Pagination —— 框架级共享翻页组件与 Hook。
//
// 收敛动机:
// plugin-manager / skill-manager 各自抄了一份翻页:iconBtn、页码渲染、滚动方向检测、
// clamp、slice 逻辑完全重复(重复债)。且 skill-manager 把 `iconBtn(i !== currentPage)`
// 的"非当前页"布尔误当"disabled"语义,导致非当前页码 cursor: not-allowed + opacity 0.4 却仍可点击。
// 收敛为框架控件与 Hook。
//
// 设计决策:
// - 1-based 页码。
// - totalPages <= 1 时组件不渲染(调用方不再自包 totalPages > 1 条件)。
// - 禁用态消费 --color-disabled-fg token,不再 opacity 压色——与 Button/PanelIconButton 同一禁用契约。
// - 页码按钮永远 cursor: pointer——"非当前页"不是"禁用"。
import { useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export interface PaginationProps {
  /** 当前页,1-based。 */
  currentPage: number;
  /** 总页数;<= 1 时组件不渲染(调用方不再自包 totalPages > 1 条件)。 */
  totalPages: number;
  /** 目标页回调,1-based;直接传 setState 即可。 */
  onPageChange: (page: number) => void;
  /** 尾随内容(如总数统计),渲染在"下一页"按钮之后。 */
  trailing?: ReactNode;
}

function arrowBtn(disabled: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    color: disabled ? "var(--color-disabled-fg)" : "var(--color-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    padding: 0,
  };
}

function pageBtn(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    fontSize: "var(--font-size-sm)",
    border: active ? "1px solid var(--color-primary)" : "1px solid var(--color-border)",
    borderRadius: "var(--radius-sm)",
    background: active ? "var(--color-primary)" : "transparent",
    color: active ? "var(--color-primary-fg)" : "var(--color-muted)",
    cursor: "pointer",
    padding: 0,
  };
}

export function Pagination({ currentPage, totalPages, onPageChange, trailing }: PaginationProps): ReactNode {
  if (totalPages <= 1) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--spacing-sm)",
        marginTop: "var(--spacing-lg)",
      }}
    >
      <button
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        disabled={currentPage <= 1}
        style={arrowBtn(currentPage <= 1)}
      >
        <ChevronLeft size={14} />
      </button>

      {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
        <button
          key={page}
          onClick={() => onPageChange(page)}
          style={pageBtn(page === currentPage)}
        >
          {page}
        </button>
      ))}

      <button
        onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
        disabled={currentPage >= totalPages}
        style={arrowBtn(currentPage >= totalPages)}
      >
        <ChevronRight size={14} />
      </button>

      {trailing}
    </div>
  );
}

export interface UsePaginationResult<T> {
  currentPage: number;             // 1-based
  totalPages: number;
  pageItems: T[];
  setCurrentPage: Dispatch<SetStateAction<number>>;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function usePagination<T>(items: T[], pageSize: number): UsePaginationResult<T> {
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = Math.ceil(items.length / pageSize);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(Math.max(1, totalPages));
    }
  }, [currentPage, totalPages]);

  const pageItems = useMemo(() => {
    return items.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  }, [items, currentPage, pageSize]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevPageRef = useRef(currentPage);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      if (currentPage > prevPageRef.current) {
        el.scrollTop = 0;
      } else if (currentPage < prevPageRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    }
    prevPageRef.current = currentPage;
  }, [currentPage]);

  return {
    currentPage,
    totalPages,
    pageItems,
    setCurrentPage,
    scrollRef,
  };
}
