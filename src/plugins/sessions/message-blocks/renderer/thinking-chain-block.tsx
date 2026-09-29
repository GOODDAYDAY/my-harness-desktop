import { useState, useEffect, useRef, type ReactNode } from "react";
import { ChevronRight, ChevronDown, Brain } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type ThinkingContent } from "@my-harness-desktop/react";
import { StreamTextReveal, useStalledHint } from "./stream-text-reveal";

export type { ThinkingContent };

export interface ThinkingChainBlockProps {
  content: ThinkingContent;
  streaming: boolean;
  startedAt?: number;
  completedAt?: number;
  /** 非流式时默认折叠(true)还是展开(false);由 general.json timelineCollapseDefault 驱动。 */
  collapseDefault?: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m${rest}s`;
}

/**
 * 用户对「思考块展开/收起」的显式选择 —— 粘性覆盖（null = 未表态，用设置默认）。
 *
 * 为什么必须是模块级而不是组件 useState（根因，勿回退成局部 state）：
 * 组件 state 在**重挂（remount）**时被重置回 `!collapseDefault`，而这一行**每轮都会重挂**——
 * timeline 的 Virtuoso `computeItemKey` 用消息 id 作 key，而消息 id 在定稿瞬间**必然改变**：
 * 流式期是内核的流 id / `stream-N`，定稿后叠加层占位被摘除、改由中立层镜像供行，
 * id 变成 `neutralEntryId`（形如 `{lineageId}:{seq}`），两者永不相等。
 * 于是「用户手动展开 → 定稿重挂 → state 重置 → 又合上了」，用户看到的就是
 * 「跑完又自己收起来了」——同一条诉求在 #15 那批修复里被判为已解决，其实只删掉了
 * 流式强制翻转的 effect，没处理重挂这条真正路径。
 *
 * 用粘性覆盖而不是「按消息 id 记忆」：id 恰恰是这里不可靠的东西（见上），
 * 按它记忆等于把守卫架在会变的值上。粘性覆盖在语义上也更贴用户诉求——
 * 「打开就一直打开」说的是**态度**（我想看思考过程），不是一个具体块的坐标，
 * 与全局设置项 `timelineCollapseDefault` 同一层级，作用域一致。
 *
 * 生命周期：renderer 窗口内存态，刷新即回到设置默认；不做持久化——
 * 想长期展开的用户应该去改 `timelineCollapseDefault`（那是它的正式入口），
 * 本覆盖只负责「这一会儿别自己动」。
 */
let thinkingOpenOverride: boolean | null = null;

/** 测试专用：清空粘性覆盖（模块级状态跨用例泄漏会让守卫互相污染）。 */
export function resetThinkingOpenOverride(): void {
  thinkingOpenOverride = null;
}

export function ThinkingChainBlock({
  content,
  streaming,
  startedAt,
  completedAt,
  collapseDefault = true,
}: ThinkingChainBlockProps): ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(thinkingOpenOverride ?? !collapseDefault);
  // 默认折叠(设置项 collapseDefault 驱动),**不随流式自动翻转**——用户诉求「默认收起来,
  // 打开就保持打开,别我看着看着又自动收起来」。此前流式中强制展开、流式结束回落折叠默认,
  // 造成「思考中自动展开 → 跑完又自动收起」的跳变。
  // 用户已显式表态过(overriding)则设置项变化不再动它——否则改设置会把用户当前的选择顶掉。
  useEffect(() => {
    if (thinkingOpenOverride === null) setOpen(!collapseDefault);
  }, [collapseDefault]);

  /** 用户手动开合：既改本次渲染，也记成粘性覆盖（重挂后按它恢复）。 */
  const toggleOpen = (): void => {
    const next = !open;
    thinkingOpenOverride = next;
    setOpen(next);
  };
  const stalled = useStalledHint(streaming, content.thinking.length);
  const [elapsed, setElapsed] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (streaming && startedAt) {
      timerRef.current = setInterval(() => {
        setElapsed(formatDuration(Date.now() - startedAt));
      }, 100);
    }
    if (!streaming) {
      if (timerRef.current) clearInterval(timerRef.current);
      if (startedAt && completedAt) {
        setElapsed(formatDuration(completedAt - startedAt));
      }
      // 折叠态收口在上方流式翻转 effect(单源),此处只管计时收尾。
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [streaming, startedAt, completedAt]);

  if (content.redacted) {
    return (
      <div className="mb-1" data-thinking-block="filtered">
        {/* r238：稳定锚点（状态位而不是文案）。此前 e2e 只能按译文子串探针
            （"无思考内容"/"思考已完成|思考过程"），换语言即失效（§1.2/r113）。 */}
        <button
          className="flex items-center gap-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)] bg-transparent border-none cursor-pointer p-0"
        >
          <Brain className="size-3.5" />
          {t("shell.thinkingFiltered")}
        </button>
      </div>
    );
  }

  // 流式期也要露出计时(用户诉求「看到计时在增长」):elapsed 由 100ms 心跳实时刷新,
  // 拼在「思考中…/思考时间较长…」之后;非流式仍走「思考已完成({{duration}})」单源。
  const label = streaming
    ? (stalled ? t("shell.thinkingStalled") : t("shell.thinkingInProgress"))
      + (elapsed ? ` ${elapsed}` : "")
    : elapsed
      ? t("shell.thinkingDone", { duration: elapsed })
      : t("shell.thinkingProcess");

  // 空思考定稿的显式降级(不静默):供应商只回了空 thinking 帧时(实测:anthropic-messages
  // 网关的 reasoning 模型,content_block_start 后无 thinking_delta,pi 落盘 thinking:""),
  // 块里没有任何正文——此时渲染「可点击展开器」等于假装点开有东西(实测观感 = 点击没用、
  // 不展开、点开也看不到)。非流式 + 空正文 → 静态提示(保留时长信息),无 chevron、不可点;
  // 流式期不受影响(正文可能还在路上),有正文的块照旧点击展开全文(无任何截断)。
  if (!streaming && content.thinking.trim().length === 0) {
    return (
      <div
        className="mb-1 flex items-center gap-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)]"
        data-thinking-block="empty"
        data-thinking-elapsed={elapsed ? "true" : "false"}
      >
        <Brain className="size-3.5" />
        {label} · {t("shell.thinkingEmpty")}
      </div>
    );
  }

  return (
    <div
      className="mb-1"
      // r238：稳定锚点 = 状态位（展开/收起、是否流式、有没有时长），
      //   让 e2e 不必从译文反推状态（r96 的通则：断言状态位要让产品暴露状态位本身）。
      data-thinking-block={open ? "expanded" : "collapsed"}
      data-thinking-streaming={streaming ? "true" : "false"}
      data-thinking-elapsed={elapsed ? "true" : "false"}
    >
      <button
        onClick={toggleOpen}
        // 展开/收起态此前只由 ChevronRight/ChevronDown 图标表达（视觉态有、可访问态无）
        aria-expanded={open}
        className="flex items-center gap-1 text-[length:var(--font-size-sm)] text-[var(--color-muted)] hover:text-[var(--color-fg)] bg-transparent border-none cursor-pointer p-0"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {/* 思考中(streaming)的 Brain 图标明暗交替(§目标 15):运行中态要有「动的 icon/明暗交替」,
         *  与侧栏 PhaseIcon、工具卡 running 的 pulse/shimmer 同语义;非流式保持静态。 */}
        <Brain className={`size-3.5 ${streaming ? "animate-pulse" : ""}`} />
        {label}
      </button>
      {open && (
        <div className="mt-1 pl-4 border-l-2 border-[var(--color-border)] text-[length:var(--font-size-sm)] leading-6 text-[var(--color-muted)] whitespace-pre-wrap">
          <StreamTextReveal text={content.thinking} streaming={streaming} />
        </div>
      )}
    </div>
  );
}
