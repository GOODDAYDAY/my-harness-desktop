// llm-recorder 结构化视图 —— 把 100KB+ 的原始 JSON 墙拆成可折叠的组成块:
// 请求 = 概览参数 + System + 工具定义 + 消息历史(逐条逐块),响应 = 用量 + 内容块。
// 折叠态默认重置:展开记录时组件才挂载,各 Fold 内部 state 天然从零开始。
import { Fragment, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import {
  useBlockRenderers, resolveBlockRenderer, resolveBlockRendererComponent,
} from "@my-harness-desktop/react";
import {
  describeRequest, describeResponse, firstLineOf, safeStringify,
  type PayloadPart, type ToolParamView, type ToolView, type UsageView,
} from "../core/payload-model";

type MarkdownComponent = ComponentType<{ text: string; streaming?: boolean }>;

// markdown 渲染走槽消费,本插件不 import 渲染引擎(与 file-preview 同款):
// blockRenderers 槽的 text 赢家即 markdown 插件;槽中无渲染器(插件被禁用)回落纯文本。
function useMarkdownComponent(): MarkdownComponent | undefined {
  const items = useBlockRenderers();
  return useMemo(() => {
    const item = resolveBlockRenderer(items, "text");
    return item ? (resolveBlockRendererComponent(item) as MarkdownComponent | undefined) : undefined;
  }, [items]);
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function paramText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return safeStringify(value);
}

function Chip({ label, mono = false, color }: { label: string; mono?: boolean; color?: string }): ReactNode {
  return (
    <span
      title={label}
      style={{
        padding: "1px 6px", borderRadius: "var(--radius-sm)", fontSize: "var(--font-size-xs)",
        border: "1px solid var(--color-border)", color: color ?? "var(--color-muted)",
        fontFamily: mono ? "var(--font-family-mono)" : undefined,
        maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        display: "inline-block", verticalAlign: "middle",
      }}
    >
      {label}
    </span>
  );
}

function Fold({ title, meta, defaultOpen = false, children }: {
  title: ReactNode; meta?: ReactNode; defaultOpen?: boolean; children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
          padding: "3px 0", fontSize: "var(--font-size-xs)", color: "var(--color-fg)",
        }}
      >
        {open
          ? <ChevronDown size={12} style={{ flexShrink: 0 }} />
          : <ChevronRight size={12} style={{ flexShrink: 0 }} />}
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 }}>
          {title}
        </span>
        {meta !== undefined && (
          <span style={{ marginLeft: "auto", color: "var(--color-muted)", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6 }}>
            {meta}
          </span>
        )}
      </div>
      {open && <div style={{ marginLeft: 6 }}>{children}</div>}
    </div>
  );
}

function CopyButton({ getText }: { getText: () => string }): ReactNode {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <span
      title={t("panel.copy")}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(getText()).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }).catch(() => { /* 剪贴板不可用时静默 */ });
      }}
      style={{
        cursor: "pointer", flexShrink: 0, display: "inline-flex", alignItems: "center",
        color: done ? "var(--color-accent-success)" : "var(--color-muted)",
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </span>
  );
}

const bodyBoxStyle: React.CSSProperties = {
  margin: "2px 0 6px", padding: "var(--spacing-sm)", maxHeight: 280, overflow: "auto",
  background: "var(--color-bg-secondary, transparent)", border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)", fontSize: "var(--font-size-xs)",
};

function CodePre({ children }: { children: string }): ReactNode {
  return (
    <pre style={{ ...bodyBoxStyle, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{children}</pre>
  );
}

function TextBody({ text, markdown }: { text: string; markdown: MarkdownComponent | undefined }): ReactNode {
  if (!markdown) return <CodePre>{text}</CodePre>;
  const Comp = markdown;
  return (
    <div style={bodyBoxStyle}>
      <Comp text={text} streaming={false} />
    </div>
  );
}

const KIND_LABEL_KEY: Record<PayloadPart["kind"], string> = {
  text: "panel.text",
  thinking: "panel.thinking",
  toolUse: "panel.toolCall",
  toolResult: "panel.toolResult",
  toolCall: "panel.toolCall",
  other: "panel.other",
};

function partColor(part: PayloadPart): string {
  if (part.kind === "toolResult") {
    return part.isError === true ? "var(--color-accent-danger)" : "var(--color-accent-success)";
  }
  if (part.kind === "toolUse" || part.kind === "toolCall") return "var(--color-primary)";
  return "var(--color-muted)";
}

function PartView({ part, markdown, defaultOpen = false }: {
  part: PayloadPart;
  markdown: MarkdownComponent | undefined;
  defaultOpen?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const textual = part.kind === "text" || part.kind === "thinking";
  const body = textual ? (part.raw as string) : prettyJson(part.raw);
  return (
    <Fold
      defaultOpen={defaultOpen}
      title={
        <>
          <span style={{ color: partColor(part), flexShrink: 0 }}>{t(KIND_LABEL_KEY[part.kind])}</span>
          {!textual && <span style={{ flexShrink: 0 }}>{part.title}</span>}
          {part.isError === true && <span style={{ color: "var(--color-accent-danger)", flexShrink: 0 }}>{t("panel.error")}</span>}
          <span style={{ color: "var(--color-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {textual ? part.title : part.preview}
          </span>
        </>
      }
      meta={
        <>
          <span>{fmtBytes(part.bytes)}</span>
          <CopyButton getText={() => body} />
        </>
      }
    >
      {textual ? <TextBody text={body} markdown={markdown} /> : <CodePre>{body}</CodePre>}
    </Fold>
  );
}

function ToolParams({ params }: { params: ToolParamView[] }): ReactNode {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "2px 0" }}>
      {params.map((p) => (
        <div key={p.name} style={{ fontSize: "var(--font-size-xs)" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
            <span style={{ fontFamily: "var(--font-family-mono)", color: "var(--color-fg)", flexShrink: 0 }}>
              {p.name}
              {p.required && <span style={{ color: "var(--color-accent-warning)" }}>*</span>}
            </span>
            <span style={{ fontFamily: "var(--font-family-mono)", color: "var(--color-muted)", flexShrink: 0 }}>{p.type}</span>
          </div>
          {p.description !== undefined && (
            <div style={{ color: "var(--color-muted)", marginTop: 1 }}>{p.description}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function ToolBody({ tool, markdown }: { tool: ToolView; markdown: MarkdownComponent | undefined }): ReactNode {
  if (tool.description === undefined && tool.params.length === 0) {
    return <CodePre>{prettyJson(tool.raw)}</CodePre>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
      {tool.description !== undefined && <TextBody text={tool.description} markdown={markdown} />}
      {tool.params.length > 0 && <ToolParams params={tool.params} />}
    </div>
  );
}

function RawJsonFold({ value }: { value: unknown }): ReactNode {
  const { t } = useTranslation();
  const text = useMemo(() => prettyJson(value), [value]);
  const bytes = useMemo(() => new TextEncoder().encode(text).length, [text]);
  return (
    <Fold
      title={t("panel.raw")}
      meta={
        <>
          <span>{fmtBytes(bytes)}</span>
          <CopyButton getText={() => text} />
        </>
      }
    >
      <CodePre>{text}</CodePre>
    </Fold>
  );
}

function roleColor(role: string): string {
  if (role === "user") return "var(--color-primary)";
  if (role === "assistant") return "var(--color-accent-success)";
  if (role === "system") return "var(--color-accent-warning)";
  return "var(--color-muted)";
}

const hintStyle: React.CSSProperties = {
  fontSize: "var(--font-size-xs)", color: "var(--color-muted)",
  padding: "var(--spacing-xs) 0",
};

export function RequestPayloadView({ payload }: { payload: unknown }): ReactNode {
  const { t } = useTranslation();
  const view = useMemo(() => describeRequest(payload), [payload]);
  const markdown = useMarkdownComponent();

  if (!view.recognized) {
    return (
      <div>
        <div style={hintStyle}>{t("panel.unrecognizedRequest")}</div>
        <RawJsonFold value={payload} />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{
        display: "grid", gridTemplateColumns: "max-content 1fr",
        columnGap: "var(--spacing-sm)", rowGap: 2, padding: "2px 0",
        fontSize: "var(--font-size-xs)", fontFamily: "var(--font-family-mono)",
      }}>
        {view.model !== undefined && (
          <Fragment>
            <span style={{ color: "var(--color-muted)" }}>model</span>
            <span style={{ color: "var(--color-fg)", wordBreak: "break-all" }}>{view.model}</span>
          </Fragment>
        )}
        {view.params.map((p) => (
          <Fragment key={p.key}>
            <span style={{ color: "var(--color-muted)" }}>{p.key}</span>
            <span style={{ color: "var(--color-fg)", wordBreak: "break-all" }}>{paramText(p.value)}</span>
          </Fragment>
        ))}
      </div>
      <div style={{ color: "var(--color-muted)", fontSize: "var(--font-size-xs)", textAlign: "right" }}>
        {fmtBytes(view.totalBytes)}
      </div>

      {view.system.length > 0 && (
        <Fold
          title={t("panel.system")}
          meta={<span>{view.system.length > 1 ? `${view.system.length} · ` : ""}{fmtBytes(view.systemBytes)}</span>}
        >
          {view.system.map((blk, i) => (
            <Fold
              key={i}
              title={<span style={{ color: "var(--color-muted)" }}>{firstLineOf(blk.text) || `#${i + 1}`}</span>}
              meta={
                <>
                  <span>{fmtBytes(blk.bytes)}</span>
                  <CopyButton getText={() => blk.text} />
                </>
              }
            >
              <TextBody text={blk.text} markdown={markdown} />
            </Fold>
          ))}
        </Fold>
      )}

      {view.tools.length > 0 && (
        <Fold
          title={t("panel.tools")}
          meta={<span>{view.tools.length} · {fmtBytes(view.toolsBytes)}</span>}
        >
          {view.tools.map((tool, i) => (
            <Fold
              key={i}
              title={
                <>
                  <span style={{ flexShrink: 0 }}>{tool.name}</span>
                  {tool.params.length > 0 && (
                    <span style={{ color: "var(--color-muted)", flexShrink: 0 }}>
                      ({tool.params.length}{tool.params.some((p) => p.required) ? "*" : ""})
                    </span>
                  )}
                </>
              }
              meta={
                <>
                  <span>{fmtBytes(tool.bytes)}</span>
                  <CopyButton getText={() => prettyJson(tool.raw)} />
                </>
              }
            >
              <ToolBody tool={tool} markdown={markdown} />
            </Fold>
          ))}
        </Fold>
      )}

      <Fold
        defaultOpen
        title={t("panel.messages")}
        meta={<span>{view.messages.length} · {fmtBytes(view.messagesBytes)}</span>}
      >
        {view.messages.map((m, i) => (
          <Fold
            key={i}
            defaultOpen={i === view.messages.length - 1}
            title={
              <>
                <span style={{ color: roleColor(m.role), flexShrink: 0 }}>{m.role}</span>
                <span style={{ color: "var(--color-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.parts.map((p) => p.title).join(" | ")}
                </span>
              </>
            }
            meta={<span>{fmtBytes(m.bytes)}</span>}
          >
            {m.parts.map((part, j) => <PartView key={j} part={part} markdown={markdown} />)}
          </Fold>
        ))}
      </Fold>

      <RawJsonFold value={payload} />
    </div>
  );
}

function UsageChips({ usage }: { usage: UsageView }): ReactNode {
  const { t } = useTranslation();
  const items: { label: string; value: number | undefined; key: string }[] = [
    { label: "↑", value: usage.input, key: "panel.usageInput" },
    { label: "↓", value: usage.output, key: "panel.usageOutput" },
    { label: "⇄", value: usage.cacheRead, key: "panel.usageCacheRead" },
    { label: "Σ", value: usage.totalTokens, key: "panel.usageTotal" },
  ];
  return (
    <>
      {items.map((it) => it.value !== undefined && (
        <span key={it.key} title={t(it.key)} style={{ color: "var(--color-muted)", fontSize: "var(--font-size-xs)", flexShrink: 0 }}>
          {it.label}{fmtCount(it.value)}
        </span>
      ))}
      {usage.cost !== undefined && usage.cost > 0 && (
        <span title={t("panel.usageCost")} style={{ color: "var(--color-muted)", fontSize: "var(--font-size-xs)", flexShrink: 0 }}>
          ${usage.cost.toFixed(4)}
        </span>
      )}
    </>
  );
}

export function ResponseMessageView({ message }: { message: unknown }): ReactNode {
  const { t } = useTranslation();
  const view = useMemo(() => describeResponse(message), [message]);
  const markdown = useMarkdownComponent();

  if (!view.recognized) {
    return (
      <div>
        <div style={hintStyle}>{t("panel.unrecognizedResponse")}</div>
        <RawJsonFold value={message} />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "2px 0" }}>
        {view.stopReason !== undefined && <Chip label={view.stopReason} />}
        <UsageChips usage={view.usage ?? {}} />
        <span style={{ marginLeft: "auto", color: "var(--color-muted)", fontSize: "var(--font-size-xs)", flexShrink: 0 }}>
          {fmtBytes(view.totalBytes)}
        </span>
      </div>
      {view.parts.map((part, i) => (
        <PartView key={i} part={part} markdown={markdown} defaultOpen={part.kind === "text"} />
      ))}
      <RawJsonFold value={message} />
    </div>
  );
}
