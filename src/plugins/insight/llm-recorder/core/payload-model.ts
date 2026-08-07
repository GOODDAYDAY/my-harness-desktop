// llm-recorder payload 拆解模型 —— 纯 TS，不 import react/ctx，可裸单测。
// 请求体是 provider 原生形状（Anthropic/OpenAI 各有不同，设计 §2.1 明确不归一化），
// 拆解尽力而为：认出 messages 数组即按结构化处理，认不出（recognized=false）视图退回原始 JSON。
// 尺寸一律 UTF-8 字节（TextEncoder），与落盘行尺寸同口径——面板旧版用 JSON.stringify 的
// 字符数当字节数，中文内容会系统性偏小，这里修正。

export interface PayloadPart {
  kind: "text" | "thinking" | "toolUse" | "toolResult" | "toolCall" | "other";
  bytes: number;
  /** 展示标题：工具名、文本首行等。 */
  title: string;
  /** 压扁截断后的预览文本。 */
  preview: string;
  /** 原始内容（展开看全量用）：文本类为 string，其余为原始块。 */
  raw: unknown;
  /** tool_result 的 is_error 标记。 */
  isError?: boolean;
}

export interface MessageView {
  role: string;
  bytes: number;
  parts: PayloadPart[];
}

export interface SystemBlockView {
  bytes: number;
  text: string;
}

export interface ToolParamView {
  name: string;
  /** "string" / "number" / "array<object>" 等,认不出为 "?"。 */
  type: string;
  required: boolean;
  description?: string;
}

export interface ToolView {
  name: string;
  bytes: number;
  raw: unknown;
  description?: string;
  params: ToolParamView[];
}

export interface ParamEntry {
  key: string;
  value: unknown;
}

export interface RequestView {
  recognized: boolean;
  model?: string;
  /** messages/system/tools 之外的键（max_tokens、stream、thinking 等）。 */
  params: ParamEntry[];
  system: SystemBlockView[];
  systemBytes: number;
  tools: ToolView[];
  toolsBytes: number;
  messages: MessageView[];
  messagesBytes: number;
  totalBytes: number;
}

export interface UsageView {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: number;
}

export interface ResponseView {
  recognized: boolean;
  model?: string;
  stopReason?: string;
  usage?: UsageView;
  parts: PayloadPart[];
  totalBytes: number;
}

const PREVIEW_MAX = 240;
const TITLE_MAX = 60;

/** JSON 序列化后的 UTF-8 字节数；不可序列化返回 0。 */
export function byteSize(value: unknown): number {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return 0;
    return new TextEncoder().encode(s).length;
  } catch {
    return 0;
  }
}

/** 安全 stringify（循环引用等返回空串）。 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** 压扁空白、截断，做单行预览。 */
export function previewOf(text: string, max: number = PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 首个非空行，截断，做标题。 */
export function firstLineOf(text: string, max: number = TITLE_MAX): string {
  const line = text.split("\n").map((s) => s.trim()).find((s) => s.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function textPart(text: string): PayloadPart {
  return {
    kind: "text",
    bytes: byteSize(text),
    title: firstLineOf(text),
    preview: previewOf(text),
    raw: text,
  };
}

/** tool_result 的 content 可能是 string 或块数组，抽出纯文本做预览。 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isRecord(b) && b.type === "text" ? asString(b.text) ?? "" : ""))
      .filter((s) => s.length > 0)
      .join("\n");
  }
  return "";
}

/** 单个 content 块 → PayloadPart；不认识的形状归 other，不丢信息。 */
export function blockToPart(block: unknown): PayloadPart {
  if (typeof block === "string") return textPart(block);
  if (isRecord(block)) {
    const type = asString(block.type) ?? "";
    switch (type) {
      case "text": {
        const t = asString(block.text);
        if (t !== undefined) return textPart(t);
        break;
      }
      case "thinking": {
        const t = asString(block.thinking);
        if (t !== undefined) {
          return { kind: "thinking", bytes: byteSize(t), title: firstLineOf(t), preview: previewOf(t), raw: t };
        }
        break;
      }
      case "tool_use": {
        const name = asString(block.name) ?? "?";
        return {
          kind: "toolUse", bytes: byteSize(block), title: name,
          preview: previewOf(safeStringify(block.input)), raw: block,
        };
      }
      case "tool_result": {
        const text = toolResultText(block.content);
        return {
          kind: "toolResult", bytes: byteSize(block),
          title: text ? firstLineOf(text) : "?",
          preview: text ? previewOf(text) : previewOf(safeStringify(block)),
          raw: block, isError: block.is_error === true,
        };
      }
      case "toolCall": {
        const name = asString(block.name) ?? "?";
        return {
          kind: "toolCall", bytes: byteSize(block), title: name,
          preview: previewOf(safeStringify(block.arguments)), raw: block,
        };
      }
      default:
        break;
    }
  }
  return {
    kind: "other", bytes: byteSize(block),
    title: isRecord(block) ? (asString(block.type) ?? "json") : "json",
    preview: previewOf(safeStringify(block)), raw: block,
  };
}

/** message content 的统一拆块：string / 块数组 / 缺失 三种形态。 */
export function contentToParts(content: unknown): PayloadPart[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content.length > 0 ? [textPart(content)] : [];
  if (Array.isArray(content)) return content.map(blockToPart);
  return [blockToPart(content)];
}

/** Anthropic 工具名在顶层，OpenAI 藏在 function 里，都取。 */
function toolName(tool: unknown): string {
  if (!isRecord(tool)) return "?";
  const direct = asString(tool.name);
  if (direct !== undefined) return direct;
  const fn = tool.function;
  if (isRecord(fn)) return asString(fn.name) ?? "?";
  return "?";
}

/** Anthropic description/input_schema 在顶层，OpenAI 在 function 里。 */
function toolBody(tool: unknown): Record<string, unknown> {
  if (!isRecord(tool)) return {};
  if (isRecord(tool.function)) return tool.function;
  return tool;
}

function schemaType(prop: unknown): string {
  if (!isRecord(prop)) return "?";
  const t = asString(prop.type) ?? "?";
  if (t === "array" && isRecord(prop.items)) {
    const inner = asString(prop.items.type);
    if (inner !== undefined) return `array<${inner}>`;
  }
  return t;
}

/** input_schema/parameters 的 properties → 参数行；认不出的形状返回空列表。 */
export function toolParams(schema: unknown): ToolParamView[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.filter((r): r is string => typeof r === "string"))
    : new Set<string>();
  return Object.entries(schema.properties).map(([name, prop]) => ({
    name,
    type: schemaType(prop),
    required: required.has(name),
    description: isRecord(prop) ? asString(prop.description) : undefined,
  }));
}

const KNOWN_REQUEST_KEYS = new Set(["model", "messages", "system", "tools"]);

/** 请求体拆解：认不出（非对象或无 messages 数组）时 recognized=false，视图退回原始 JSON。 */
export function describeRequest(payload: unknown): RequestView {
  const totalBytes = byteSize(payload);
  const empty: RequestView = {
    recognized: false, params: [], system: [], systemBytes: 0,
    tools: [], toolsBytes: 0, messages: [], messagesBytes: 0, totalBytes,
  };
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return empty;

  const system: SystemBlockView[] = [];
  if (typeof payload.system === "string") {
    system.push({ bytes: byteSize(payload.system), text: payload.system });
  } else if (Array.isArray(payload.system)) {
    for (const blk of payload.system) {
      const t = isRecord(blk) ? asString(blk.text) : undefined;
      system.push(t !== undefined ? { bytes: byteSize(blk), text: t } : { bytes: byteSize(blk), text: safeStringify(blk) });
    }
  }

  const tools: ToolView[] = [];
  if (Array.isArray(payload.tools)) {
    for (const t of payload.tools) {
      const body = toolBody(t);
      const schema = body.input_schema ?? body.parameters;
      tools.push({
        name: toolName(t),
        bytes: byteSize(t),
        raw: t,
        description: asString(body.description),
        params: toolParams(schema),
      });
    }
  }

  const messages: MessageView[] = (payload.messages as unknown[]).map((m) => ({
    role: isRecord(m) ? (asString(m.role) ?? "?") : "?",
    bytes: byteSize(m),
    parts: contentToParts(isRecord(m) ? m.content : undefined),
  }));

  const params: ParamEntry[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (!KNOWN_REQUEST_KEYS.has(key)) params.push({ key, value });
  }

  const sum = (xs: { bytes: number }[]): number => xs.reduce((s, x) => s + x.bytes, 0);
  return {
    recognized: true,
    model: asString(payload.model),
    params,
    system, systemBytes: sum(system),
    tools, toolsBytes: sum(tools),
    messages, messagesBytes: sum(messages),
    totalBytes,
  };
}

/** usage 提取（行内摘要与展开视图共用，不做整体 stringify，便宜）。 */
export function peekUsage(message: unknown): UsageView | undefined {
  if (!isRecord(message)) return undefined;
  const u = message.usage;
  if (!isRecord(u)) return undefined;
  const cost = isRecord(u.cost) ? asNumber(u.cost.total) : undefined;
  const view: UsageView = {
    input: asNumber(u.input),
    output: asNumber(u.output),
    cacheRead: asNumber(u.cacheRead),
    cacheWrite: asNumber(u.cacheWrite),
    totalTokens: asNumber(u.totalTokens),
    cost,
  };
  const hasAny = Object.values(view).some((v) => v !== undefined);
  return hasAny ? view : undefined;
}

/** 响应消息拆解：pi 组装态 assistant 消息（content 块数组 + usage + stopReason）。 */
export function describeResponse(message: unknown): ResponseView {
  const totalBytes = byteSize(message);
  const empty: ResponseView = { recognized: false, parts: [], totalBytes };
  if (!isRecord(message) || !Array.isArray(message.content)) return empty;
  return {
    recognized: true,
    model: asString(message.model),
    stopReason: asString(message.stopReason),
    usage: peekUsage(message),
    parts: contentToParts(message.content),
    totalBytes,
  };
}
