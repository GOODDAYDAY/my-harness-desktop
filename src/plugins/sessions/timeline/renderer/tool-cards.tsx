import { useState, useEffect, type CSSProperties, type ReactNode } from "react";
import {
  Check, X, Terminal, FileEdit, FileSearch, FileText, Wrench,
  ChevronRight, ChevronDown,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePluginContext, type ToolCallBlock } from "@pi-desktop/react";
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

interface CardHeaderProps {
  toolName: string;
  summary: string;
  isStreaming: boolean;
  isError?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  right?: ReactNode;
}

function CardHeader({ toolName, summary, isStreaming, isError, collapsed, onToggle, right }: CardHeaderProps): ReactNode {
  const borderColor = isError
    ? "var(--color-accent-error)"
    : isStreaming
      ? "var(--color-accent-success)"
      : toolName === "toolResult" || toolName === "custom_message"
        ? "var(--color-primary)"
        : "var(--color-accent-success)";
  return (
    <div
      className="flex items-center gap-2 text-[length:var(--font-size-sm)] font-[var(--font-family-mono)] cursor-pointer transition-colors rounded-[var(--radius-md)]"
      style={{
        borderLeft: `3px solid ${borderColor}`,
        background: "color-mix(in srgb, var(--color-surface) 30%, transparent)",
        padding: "5px 12px",
        position: "relative",
        overflow: "hidden",
      }}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
    >
      {isStreaming && (
        <span
          aria-hidden
          style={{
            position: "absolute", left: 0, top: 0, bottom: 0, width: 2,
            background: "var(--color-accent-success)",
            animation: "tool-live-pulse 2.4s ease-in-out infinite",
          }}
        />
      )}
      <span className="text-[var(--color-muted)]">{toolIcon(toolName)}</span>
      <span className="text-[var(--color-fg)] flex-1 truncate">{summary || toolName}</span>
      {isStreaming && (
        <span className="text-xs text-[var(--color-accent-success)]" style={{ animation: "shimmer 2s linear infinite" }}>
          running
        </span>
      )}
      {!isStreaming && isError && (
        <span className="text-xs text-[var(--color-accent-error)]">
          <X className="size-3.5" />
        </span>
      )}
      {!isStreaming && !isError && (
        <span className="text-xs text-[var(--color-muted)]">
          <Check className="size-3.5" />
        </span>
      )}
      {right}
      <span className="text-[var(--color-muted)]">
        {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
      </span>
    </div>
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
  const a = (toolCall.args as BashArgs) ?? {};
  const command = a.command ?? "";
  const result = toolCall.result as BashResult | undefined;
  const output = result?.output ?? (typeof toolCall.result === "string" ? toolCall.result : "");
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
            background: "color-mix(in srgb, var(--color-bg) 55%, black)",
            color: isError ? "var(--color-accent-error)" : "var(--color-fg)",
            maxHeight: "40vh",
            overflowY: "auto",
          }}
        >
          <div style={{ color: "var(--color-muted)", marginBottom: 4 }}>$ {command}</div>
          {lines.slice(0, 200).join("\n")}
          {lines.length > 200 && (
            <div style={{ color: "var(--color-muted)", marginTop: 4, fontSize: 11 }}>
              ...({lines.length - 200} {lines.length - 200 > 0 ? "lines collapsed" : ""})
            </div>
          )}
          {isStreaming && <StreamingCaret />}
          {!isStreaming && exitCode !== undefined && (
            <div style={{ marginTop: 6, color: isError ? "var(--color-accent-error)" : "var(--color-muted)", fontSize: 11 }}>
              exit {exitCode}
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
      style={{ background: "color-mix(in srgb, var(--color-bg) 55%, black)" }}
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
                <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)] opacity-60">
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
              style={{ background: "color-mix(in srgb, var(--color-bg) 55%, black)" }}
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
      style={{ background: "color-mix(in srgb, var(--color-bg) 55%, black)", maxHeight: "40vh", overflowY: "auto" }}
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
      {truncated && <div style={{ color: "var(--color-accent-warning)", marginTop: 4 }}>truncated</div>}
    </div>
  );
}

export function ReadCard({ toolCall, collapseDefault = true }: { toolCall: ToolCallItem; collapseDefault?: boolean }): ReactNode {
  const ctx = usePluginContext();
  const a = (toolCall.args as ReadArgs) ?? {};
  const path = a.path ?? a.file_path ?? "";
  const isError = toolCall.isError;
  const isStreaming = toolCall.state === "pending" || toolCall.state === "running";
  const [collapsed, setCollapsed] = useState(collapseDefault);
  useEffect(() => { setCollapsed(collapseDefault); }, [collapseDefault]);

  if (toolCall.name === "read" || toolCall.name === "read_file") {
    const result = toolCall.result as ReadResult | undefined;
    const blocks = result?.content ?? [];
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
                style={{ ...wrapAnywhere, background: "color-mix(in srgb, var(--color-bg) 55%, black)", color: "var(--color-fg)" }}
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
            onOpen={(file, line) => void ctx.dialog.openFile(file)}
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
  const isError = toolCall.isError;
  const borderColor = isError
    ? "var(--color-accent-error)"
    : toolCall.name === "toolResult" || toolCall.name === "custom_message"
      ? "var(--color-primary)"
      : "var(--color-accent-success)";

  return (
    <div
      className="mb-1.5 rounded-[var(--radius-md)] cursor-pointer transition-colors"
      style={{
        borderLeft: `3px solid ${borderColor}`,
        background: "color-mix(in srgb, var(--color-surface) 30%, transparent)",
        padding: "5px 12px",
      }}
      onClick={() => hasDetail && setCollapsed(!collapsed)}
    >
      <div className="flex items-center gap-2 text-[length:var(--font-size-sm)] font-[var(--font-family-mono)]">
        <span className="text-[var(--color-muted)]">{toolIcon(toolCall.name)}</span>
        <span className="text-[var(--color-fg)] flex-1 truncate">{toolCall.name}</span>
        {isStreaming && (
          <span className="text-xs text-[var(--color-muted)]" style={{ animation: "shimmer 2s linear infinite" }}>
            running
          </span>
        )}
        {isError && (
          <span className="text-xs text-[var(--color-accent-error)]">error</span>
        )}
        {hasDetail && (
          <span className="text-[var(--color-muted)]">
            {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          </span>
        )}
      </div>
      {!collapsed && hasDetail && (
        <div className="mt-1 pt-1 border-t border-[var(--color-border)] text-xs font-[var(--font-family-mono)] max-h-[400px] overflow-y-auto">
          {args.length > 0 && (
            <>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)] opacity-60 mb-0.5">
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
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)] opacity-60 mb-0.5 mt-1.5">
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
