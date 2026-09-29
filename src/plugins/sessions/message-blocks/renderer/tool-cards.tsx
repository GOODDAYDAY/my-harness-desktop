import { useState, useEffect, type CSSProperties, type ReactNode } from "react";
import {
  Check, X, Terminal, FileEdit, FileSearch, FileText, Wrench,
  ChevronRight, ChevronDown,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { CollapsibleCardHeader, ExecutionStatus, fireAndReport, type ExecStatus } from "@my-harness-desktop/react";
import { usePluginContext, type ToolCallBlock } from "@my-harness-desktop/react";
import { StreamingCaret } from "./stream-text-reveal";

// toolCall 块形状以 domain ToolCallBlock 为唯一源(曾本地各写一份,已收敛)。
type ToolCallItem = ToolCallBlock;

/** 溢出适配统一口径:pre-wrap 只在空白符处断行,无空格长串(base64/单行JSON/长路径)会横向溢出容器;
 *  补 overflowWrap:anywhere 任意处断行。五个输出容器(Bash/Read grep/diff/Default)同一需求,收敛一处。 */
const wrapAnywhere: CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" };

function toolIcon(name: string): ReactNode {
  const n = name.toLowerCase();
  if (n === "bash" || n === "execute_bash" || n === "run_tests") return <Terminal className="size-3.5" />;
  if (n === "edit" || n === "write" || n === "multi_edit" || n === "edit_file" || n === "write_file") return <FileEdit className="size-3.5" />;
  if (n === "read" || n === "grep" || n === "find" || n === "ls" || n === "glob" || n === "read_file") return <FileSearch className="size-3.5" />;
  if (n === "toolresult") return <Check className="size-3.5" />;
  if (n === "custom_message") return <FileText className="size-3.5" />;
  return <Wrench className="size-3.5" />;
}

function toolSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const obj = args as Record<string, unknown>;
  const path = obj.path ?? obj.file_path ?? obj.command ?? obj.pattern ?? obj.cwd;
  return path ? String(path) : "";
}

function fmtArgs(args: unknown): [string, string][] {
  if (args == null) return [];
  if (typeof args === "string") return [["input", args]];
  if (typeof args === "object") {
    const obj = args as Record<string, unknown>;
    return Object.entries(obj).map(([k, v]) => [k, typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })()]);
  }
  return [["args", String(args)]];
}

function fmtResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null) return "";
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

/* 折回结果为内核 content 块数组(bus_status 等部分工具)时取 text 块拼文本,与 fmtResult 的数组分支同形。 */
function contentBlocksText(result: unknown): string {
  if (!Array.isArray(result)) return "";
  return result
    .map((b) => (typeof b === "object" && b !== null ? String((b as Record<string, unknown>).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

interface CardHeaderProps {
  toolName: string;
  summary: string;
  isStreaming: boolean;
  isError?: boolean;
  collapsed: boolean;
  /** 是否有可展开的详情。false ⇒ 不画 chevron、不给 button 语义、不声明 aria-expanded
   *  （给一个点了不动的元素挂 aria-expanded="false" 是**错误承诺**，读屏用户会一直试着展开）。 */
  expandable?: boolean;
  onToggle: () => void;
  right?: ReactNode;
}

function CardHeader({ toolName, summary, isStreaming, isError, collapsed, onToggle, right, expandable = true }: CardHeaderProps): ReactNode {
  // r57 收敛：容器样式/交互三件套/四段布局全部来自共享的 `CollapsibleCardHeader`，
  // 本函数只剩**工具卡特有**的两件事：① 按 isError/isStreaming/toolName 算左边条颜色；
  // ② 组装图标（含运行态 animate-pulse）与执行状态。
  // 此前这里是完整的一份实现，与 goal 插件 GoalCard 的内联头逐字重复——
  // r41 修的那三个缺陷（aria-expanded / 硬编码 running / 纯图标状态）在 GoalCard 里
  // 一个不少地留着，就是重复实现的代价（§3.5）。
  const borderColor = isError
    ? "var(--color-accent-error)"
    : isStreaming
      ? "var(--color-accent-success)"
      : toolName === "toolResult" || toolName === "custom_message"
        ? "var(--color-primary)"
        : "var(--color-accent-success)";
  const status: ExecStatus = isStreaming ? "running" : isError ? "error" : "success";
  return (
    <CollapsibleCardHeader
      borderColor={borderColor}
      collapsed={collapsed}
      onToggle={onToggle}
      expandable={expandable}
      livePulse={isStreaming}
      // 运行中图标明暗交替(诉求 15):「只要运行中,图标要么动、要么明暗交替」是逐图标的纪律。
      icon={<span className={`text-[var(--color-muted)]${isStreaming ? " animate-pulse" : ""}`}>{toolIcon(toolName)}</span>}
      summary={summary || toolName}
      status={<ExecutionStatus state={status} />}
      trailing={right}
    />
  );
}


interface BashArgs {
  command?: string;
  cwd?: string;
}
interface BashResult {
  output?: string;
  exitCode?: number;
  truncated?: boolean;
  fullOutputPath?: string;
}

export function BashCard({ toolCall, collapseDefault = true }: { toolCall: ToolCallItem; collapseDefault?: boolean }): ReactNode {
  const { t } = useTranslation();
  const a = (toolCall.args as BashArgs) ?? {};
  const command = a.command ?? "";
  const result = toolCall.result as BashResult | undefined;
  const output = result?.output
    ?? (typeof toolCall.result === "string" ? toolCall.result : contentBlocksText(toolCall.result));
  const lines = output.split("\n");
  const exitCode = result?.exitCode;
  const isError = toolCall.isError || (exitCode !== undefined && exitCode !== 0);
  const isStreaming = toolCall.state === "pending" || toolCall.state === "running";
  const [collapsed, setCollapsed] = useState(collapseDefault);
  useEffect(() => { setCollapsed(collapseDefault); }, [collapseDefault]);
  const summary = command ? `$ ${command}` : toolSummary(toolCall.args);

  return (
    <div className="mb-1.5">
      <CardHeader
        toolName="bash"
        summary={summary}
        isStreaming={isStreaming}
        isError={isError}
        collapsed={collapsed}
        onToggle={() => setCollapsed(c => !c)}
      />
      {!collapsed && (
        <div
          className="mt-1 rounded-[var(--radius-md)] p-2.5 font-[var(--font-family-mono)] text-[length:var(--font-size-sm)] leading-5"
          style={{
            ...wrapAnywhere,
            background: "color-mix(in srgb, var(--color-bg) 55%, var(--color-border))",
            color: isError ? "var(--color-accent-error)" : "var(--color-fg)",
            maxHeight: "40vh",
            overflowY: "auto",
          }}
        >
          <div style={{ color: "var(--color-muted)", marginBottom: 4 }}>$ {command}</div>
          {lines.slice(0, 200).join("\n")}
          {lines.length > 200 && (
            <div style={{ color: "var(--color-muted)", marginTop: 4, fontSize: 11 }}>
              {t("timeline.linesCollapsed", { count: lines.length - 200 })}
            </div>
          )}
          {isStreaming && <StreamingCaret />}
          {!isStreaming && exitCode !== undefined && (
            <div style={{ marginTop: 6, color: isError ? "var(--color-accent-error)" : "var(--color-muted)", fontSize: 11 }}>
              {t("timeline.exitCode", { code: exitCode })}
            </div>
          )}
          {result?.truncated && result.fullOutputPath && (
            <div style={{ marginTop: 4, color: "var(--color-accent-warning)", fontSize: 11 }}>
              {result.fullOutputPath}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface EditArgs {
  path?: string;
  file_path?: string;
  edits?: { oldText?: string; newText?: string }[];
  content?: string;
}

function FallbackDiff({ oldText, newText }: { oldText: string; newText: string }): ReactNode {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  return (
    <div
      className="rounded-[var(--radius-sm)] p-2 font-[var(--font-family-mono)] text-[length:var(--font-size-sm)]"
      style={{ background: "color-mix(in srgb, var(--color-bg) 55%, var(--color-border))" }}
    >
      {oldLines.map((l, i) => (
        <div key={`o${i}`} style={{ ...wrapAnywhere, color: "var(--color-accent-error)" }}>- {l}</div>
      ))}
      {newLines.map((l, i) => (
        <div key={`n${i}`} style={{ ...wrapAnywhere, color: "var(--color-accent-success)" }}>+ {l}</div>
      ))}
    </div>
  );
}

export function EditCard({ toolCall, collapseDefault = true }: { toolCall: ToolCallItem; collapseDefault?: boolean }): ReactNode {
  const a = (toolCall.args as EditArgs) ?? {};
  const path = a.path ?? a.file_path ?? "";
  const isError = toolCall.isError;
  const isStreaming = toolCall.state === "pending" || toolCall.state === "running";
  const [collapsed, setCollapsed] = useState(collapseDefault);
  useEffect(() => { setCollapsed(collapseDefault); }, [collapseDefault]);
  const summary = path || toolSummary(toolCall.args);

  if (a.edits && a.edits.length > 0) {
    return (
      <div className="mb-1.5">
        <CardHeader
          toolName={toolCall.name}
          summary={summary}
          isStreaming={isStreaming}
          isError={isError}
          collapsed={collapsed}
          onToggle={() => setCollapsed(c => !c)}
        />
        {!collapsed && (
          <div className="mt-1 space-y-1.5">
            {a.edits.map((e, i) => (
              <div key={i} className="space-y-0.5">
                <div className="text-[length:var(--font-size-xs)] uppercase tracking-wide text-[var(--color-muted)] opacity-60">
                  edit {i + 1}/{a.edits!.length}
                </div>
                <FallbackDiff oldText={e.oldText ?? ""} newText={e.newText ?? ""} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (a.content != null) {
    return (
      <div className="mb-1.5">
        <CardHeader
          toolName={toolCall.name}
          summary={summary}
          isStreaming={isStreaming}
          isError={isError}
          collapsed={collapsed}
          onToggle={() => setCollapsed(c => !c)}
        />
        {!collapsed && (
          <div className="mt-1">
            <pre
              className="rounded-[var(--radius-sm)] p-2.5 text-[length:var(--font-size-sm)] overflow-x-auto"
              style={{ background: "color-mix(in srgb, var(--color-bg) 55%, var(--color-border))" }}
            >
              {a.content}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return <DefaultCard toolCall={toolCall} collapseDefault={collapseDefault} />;
}

interface ReadArgs {
  path?: string;
  file_path?: string;
  pattern?: string;
  glob?: string;
}
interface ReadResultContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}
interface ReadResult {
  content?: ReadResultContent[];
  details?: {
    matchLimitReached?: number;
    resultLimitReached?: number;
    entryLimitReached?: number;
    truncation?: { truncated?: boolean };
  };
}

function CollapsibleOutput({
  text,
  onOpen,
  truncated,
}: {
  text: string;
  onOpen: (file: string, line?: number) => void;
  truncated?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const lines = text.split("\n").filter(l => l.trim() !== "");
  const parseFileLine = (line: string): { file: string; line?: number } | null => {
    const m = /^([^:\s]+):(\d+):/.exec(line);
    if (m) return { file: m[1], line: Number(m[2]) };
    if (line.trim()) return { file: line.trim() };
    return null;
  };
  return (
    <div
      className="mt-1 rounded-[var(--radius-sm)] p-2 font-[var(--font-family-mono)] text-[length:var(--font-size-sm)]"
      style={{ background: "color-mix(in srgb, var(--color-bg) 55%, var(--color-border))", maxHeight: "40vh", overflowY: "auto" }}
    >
      {lines.map((l, i) => {
        const parsed = parseFileLine(l);
        return (
          <div
            key={i}
            className="px-1 leading-5 hover:bg-[var(--color-surface)]"
            style={{ ...wrapAnywhere, cursor: parsed ? "pointer" : "default" }}
            onClick={() => parsed && onOpen(parsed.file, parsed.line)}
            onKeyDown={(e) => {
              if (parsed && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                onOpen(parsed.file, parsed.line);
              }
            }}
            role={parsed ? "button" : undefined}
            tabIndex={parsed ? 0 : undefined}
          >
            {l}
          </div>
        );
      })}
      {/* 此前是硬编码英文 `truncated`（r51 修）。它能溜过 r42 的英文守卫，是因为那条判据
          刻意要求「2 个以上英文单词」以避免专名/类名造成大片假阳性——**单词级字面量是它
          记录在案的已知盲区**。这类"一个词的界面提示"只能靠人工看 DOM 或逐个组件审。 */}
      {truncated && <div style={{ color: "var(--color-accent-warning)", marginTop: 4 }}>{t("timeline.outputTruncated")}</div>}
    </div>
  );
}

export function ReadCard({ toolCall, collapseDefault = true }: { toolCall: ToolCallItem; collapseDefault?: boolean }): ReactNode {
  // r193：本组件此前没有 t（onOpen 的失败播报要用插件语言包；框架零文案 §1.2）
  const { t } = useTranslation();
  const ctx = usePluginContext();
  const a = (toolCall.args as ReadArgs) ?? {};
  const path = a.path ?? a.file_path ?? "";
  const isError = toolCall.isError;
  const isStreaming = toolCall.state === "pending" || toolCall.state === "running";
  const [collapsed, setCollapsed] = useState(collapseDefault);
  useEffect(() => { setCollapsed(collapseDefault); }, [collapseDefault]);

  if (toolCall.name === "read" || toolCall.name === "read_file") {
    const result = toolCall.result as ReadResult | undefined;
    const blocks = result?.content ?? (Array.isArray(toolCall.result) ? (toolCall.result as ReadResultContent[]) : []);
    const textBlocks = blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("\n");
    const imageBlock = blocks.find(b => b.type === "image");
    const summary = path || toolSummary(toolCall.args);
    return (
      <div className="mb-1.5">
        <CardHeader
          toolName={toolCall.name}
          summary={summary}
          isStreaming={isStreaming}
          isError={isError}
          collapsed={collapsed}
          onToggle={() => setCollapsed(c => !c)}
        />
        {!collapsed && (
          <div className="mt-1">
            {imageBlock && imageBlock.data ? (
              <img
                src={`data:${imageBlock.mimeType ?? "image/png"};base64,${imageBlock.data}`}
                style={{ maxWidth: "100%", borderRadius: "var(--radius-sm)" }}
                alt={path}
              />
            ) : (
              <pre
                className="rounded-[var(--radius-sm)] p-2.5 text-[length:var(--font-size-sm)]"
                style={{ ...wrapAnywhere, background: "color-mix(in srgb, var(--color-bg) 55%, var(--color-border))", color: "var(--color-fg)" }}
              >
                {textBlocks}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  }

  if (toolCall.name === "grep" || toolCall.name === "find" || toolCall.name === "ls" || toolCall.name === "glob") {
    const result = toolCall.result as ReadResult | undefined;
    const text = (result?.content ?? []).map(b => b.text ?? "").join("\n");
    const summary = a.pattern ? `${a.pattern}${path ? ` · ${path}` : ""}` : toolSummary(toolCall.args);
    return (
      <div className="mb-1.5">
        <CardHeader
          toolName={toolCall.name}
          summary={summary}
          isStreaming={isStreaming}
          isError={isError}
          collapsed={collapsed}
          onToggle={() => setCollapsed(c => !c)}
        />
        {!collapsed && (
          <CollapsibleOutput
            text={text}
            // ⚠ r193：不能发射后不管。这与 r182 修的 file-preview/skill-manager 是**同一缺陷类**，
            //   只是走了另一条 API 路径（ctx.dialog.openFile 与 ctx.openFile 都通向
            //   window.kernel.openFile）——r182 只搜了 `void ctx.openFile` 所以漏了这处。
            //   教训：搜同类要按**底层能力**搜（openFile），不能只按当时看到的那个门面名字搜。
            //   失败时用户点了文件名却什么都没发生（§7.6 禁止的静默失败），
            //   而且 openFile 在远程/Node 宿主可能 UNSUPPORTED（r191 的宿主能力判据）。
            onOpen={(file) => fireAndReport(ctx.dialog.openFile(file), {
              tag: "message-blocks",
              message: (detail) => t("timeline.openFileFailed", { detail }),
            })}
            truncated={!!result?.details?.truncation?.truncated || !!result?.details?.matchLimitReached}
          />
        )}
      </div>
    );
  }

  return <DefaultCard toolCall={toolCall} collapseDefault={collapseDefault} />;
}

export function DefaultCard({ toolCall, collapseDefault = true }: { toolCall: ToolCallItem; collapseDefault?: boolean }): ReactNode {
  const { t } = useTranslation();
  // 兜底卡片承载的多是 custom_message/未知工具(如 claude-md-context 注入),
  // args/result 动辄整段长文,默认铺开会刷屏;默认收起随全局设置,点 header 再展开。
  const [collapsed, setCollapsed] = useState(collapseDefault);
  useEffect(() => { setCollapsed(collapseDefault); }, [collapseDefault]);
  const args = fmtArgs(toolCall.args);
  const resultText = fmtResult(toolCall.result);
  const hasDetail = args.length > 0 || resultText.length > 0;
  const isStreaming = toolCall.state === "pending" || toolCall.state === "running";
  const isError = !!toolCall.isError;

  // ⚠ 卡头**复用 CardHeader**，不再自己内联一份（r41 收敛）。
  //   内联那一份比 CardHeader 差三处，而且都是"看不见"的：
  //     ① `onClick` 挂在 div 上却**没有 role / tabIndex / 键处理** ⇒ 键盘完全不可达
  //        （BashCard / EditCard / ReadCard 都走 CardHeader，唯独兜底卡不行——
  //        而兜底卡恰恰是 custom_message / 未知工具的落点，最需要能被展开看内容）；
  //     ② 状态文案硬编码英文 `running` / `error`（换语言不变，且与 CardHeader 的 i18n 版并存）；
  //     ③ 没有 `aria-expanded`（展开与否只有 chevron 图标在变）。
  //   收敛到一份实现后三处一起消失，也符合 §3.5「手写收敛」与 §3.3「框架管通用」。
  //   视觉差异：外层不再自带 borderLeft/背景（改由 CardHeader 提供，与其它卡片一致），
  //   正文块改用与 BashCard 正文同款的容器样式；`isStreaming` 时左边条取 success 色
  //   （原兜底卡在这一分支取 primary，现与其余卡片统一）。
  return (
    <div className="mb-1.5">
      <CardHeader
        toolName={toolCall.name}
        summary={toolCall.name}
        isStreaming={isStreaming}
        isError={isError}
        collapsed={collapsed}
        expandable={hasDetail}
        onToggle={() => setCollapsed((c) => !c)}
      />
      {!collapsed && hasDetail && (
        <div
          className="mt-1 rounded-[var(--radius-md)] p-2.5 text-xs font-[var(--font-family-mono)] max-h-[400px] overflow-y-auto"
          style={{ background: "color-mix(in srgb, var(--color-bg) 55%, var(--color-border))" }}
        >
          {args.length > 0 && (
            <>
              <div className="text-[length:var(--font-size-xs)] font-semibold uppercase tracking-wide text-[var(--color-muted)] opacity-60 mb-0.5">
                {t("shell.toolParams")}
              </div>
              {args.map(([k, v]) => (
                <div key={k} className="flex gap-1.5 leading-6">
                  <span className="text-[var(--color-primary)] min-w-[50px]">{k}</span>
                  <span className="text-[var(--color-fg)] break-all">{v}</span>
                </div>
              ))}
            </>
          )}
          {resultText && (
            <>
              <div className="text-[length:var(--font-size-xs)] font-semibold uppercase tracking-wide text-[var(--color-muted)] opacity-60 mb-0.5 mt-1.5">
                {t("shell.toolResult")}
              </div>
              <pre
                className="text-[var(--color-muted)] leading-5 rounded-[var(--radius-sm)] px-2.5 py-1.5 mt-0.5"
                style={{ ...wrapAnywhere, background: "var(--color-bg)" }}
              >
                {resultText}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolCardRenderer({ toolCall, collapseDefault = true }: { toolCall: ToolCallItem; collapseDefault?: boolean }): ReactNode {
  const n = toolCall.name.toLowerCase();
  if (n === "bash" || n === "execute_bash" || n === "run_tests") return <BashCard toolCall={toolCall} collapseDefault={collapseDefault} />;
  if (n === "edit" || n === "write" || n === "multi_edit" || n === "edit_file" || n === "write_file") return <EditCard toolCall={toolCall} collapseDefault={collapseDefault} />;
  if (n === "read" || n === "read_file" || n === "grep" || n === "find" || n === "ls" || n === "glob") return <ReadCard toolCall={toolCall} collapseDefault={collapseDefault} />;
  return <DefaultCard toolCall={toolCall} collapseDefault={collapseDefault} />;
}
