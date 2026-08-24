// client/pi —— pi 内核原生配置的中性适配器(kernel 配置 TAB 用)。
//
// 把 pi 的原生形状(~/.pi/agent/settings.json 的扁平 typed schema)翻译成中性 KernelConfigApi:
//   get()   = 读整份 settings.json 出 JSON
//   set()   = 全量替换写回(删除字段随之消失),返回落盘后整份 JSON
//   schema()= 字段描述表(43 字段)+ .d.ts 未知字段兜底 → KernelConfigField[]
//
// 文案纪律(机制/内容分离):本文件只产出 **i18n key**(label/description/group),不写死文案字面值。
// 文案由 pi-manager 的语言资源(locales/*/kernel.json)贡献,经共享表单 t() 解析。字段描述表
// 此前在壳插件 pi-manager/core/field-descriptors.ts 硬编码中文,已下沉到此并去掉字面值。
// 依赖只向内:client 只 import core/domain(契约)+ 同层 pi-settings-store。
import { join } from "node:path";
import type { KernelConfigApi, KernelConfigField } from "../../core/domain/context";
import type { PiSettingsStore } from "./pi-settings-store";
import { parseSettingsSchema } from "./pi-settings-store";

/** pi 字段描述类型(自 pi-manager 迁入;kv-fixed 是定键数字映射)。 */
type PiFieldType = "boolean" | "string" | "number" | "select" | "string[]" | "kv-fixed";

/** pi 字段描述(不含文案——label/description/group 由 schema() 派生 i18n key)。 */
interface PiFieldDescriptor {
  key: string;
  type: PiFieldType;
  options?: { value: string; label: string }[];
  kvKeys?: string[];
  default?: unknown;
  /** 分组 slug(model/queue/compaction/tools/skills/ui/paths)。 */
  group: string;
}

/** i18n key 派生:label → kernel.fields.<key>;description → kernel.fieldDescs.<key>;group → kernel.groups.<slug>。 */
const labelKey = (key: string): string => `kernel.fields.${key}`;
const descKey = (key: string): string => `kernel.fieldDescs.${key}`;
const groupKey = (slug: string): string => `kernel.groups.${slug}`;

/** pi 底座 settings 全字段描述表(方案 D:硬编码全字段 + 未知字段兜底)。
 *  依据 pi 底座 settings-manager.d.ts 的 Settings 接口(0.80.x)。settings.json 里有但
 *  本表没有的字段 → 由 .d.ts schema 兜底映射成「json」只读展示。 */
const PI_FIELD_DESCRIPTORS: PiFieldDescriptor[] = [
  // ==================== 模型与推理 ====================
  { key: "defaultProvider", type: "string", group: "model" },
  { key: "defaultModel", type: "string", group: "model" },
  {
    key: "defaultThinkingLevel", type: "select", group: "model",
    options: [
      { value: "off", label: "off — 关" }, { value: "minimal", label: "minimal — 极简" },
      { value: "low", label: "low — 低" }, { value: "medium", label: "medium — 中(推荐)" },
      { value: "high", label: "high — 高" }, { value: "xhigh", label: "xhigh — 极高" },
    ], default: "medium",
  },
  { key: "enabledModels", type: "string[]", group: "model" },
  { key: "hideThinkingBlock", type: "boolean", group: "model" },
  { key: "thinkingBudgets", type: "kv-fixed", group: "model", kvKeys: ["minimal", "low", "medium", "high"] },

  // ==================== 队列与传输 ====================
  {
    key: "steeringMode", type: "select", group: "queue",
    options: [{ value: "all", label: "all — 全部插入(推荐)" }, { value: "one-at-a-time", label: "one-at-a-time — 一次一条" }], default: "all",
  },
  {
    key: "followUpMode", type: "select", group: "queue",
    options: [{ value: "all", label: "all" }, { value: "one-at-a-time", label: "one-at-a-time" }], default: "all",
  },
  {
    key: "transport", type: "select", group: "queue",
    options: [{ value: "auto", label: "auto — 自动(推荐)" }, { value: "sse", label: "sse — 流式" }, { value: "http", label: "http — 非流式" }], default: "auto",
  },
  { key: "httpIdleTimeoutMs", type: "number", default: 0, group: "queue" },
  { key: "websocketConnectTimeoutMs", type: "number", default: 0, group: "queue" },
  { key: "httpProxy", type: "string", group: "queue" },

  // ==================== 压缩与重试 ====================
  { key: "compaction.enabled", type: "boolean", default: true, group: "compaction" },
  { key: "compaction.reserveTokens", type: "number", default: 16384, group: "compaction" },
  { key: "compaction.keepRecentTokens", type: "number", default: 20000, group: "compaction" },
  { key: "retry.enabled", type: "boolean", default: true, group: "compaction" },
  { key: "retry.maxRetries", type: "number", group: "compaction" },
  { key: "retry.baseDelayMs", type: "number", group: "compaction" },
  { key: "retry.provider.timeoutMs", type: "number", group: "compaction" },
  { key: "retry.provider.maxRetries", type: "number", group: "compaction" },
  { key: "retry.provider.maxRetryDelayMs", type: "number", group: "compaction" },
  { key: "branchSummary.reserveTokens", type: "number", group: "compaction" },
  { key: "branchSummary.skipPrompt", type: "boolean", group: "compaction" },

  // ==================== 工具与 Shell ====================
  { key: "shellPath", type: "string", group: "tools" },
  { key: "shellCommandPrefix", type: "string", group: "tools" },
  { key: "npmCommand", type: "string[]", group: "tools" },
  { key: "externalEditor", type: "string", group: "tools" },
  { key: "images.autoResize", type: "boolean", group: "tools" },
  { key: "images.blockImages", type: "boolean", group: "tools" },
  { key: "terminal.showImages", type: "boolean", default: true, group: "tools" },
  { key: "terminal.imageWidthCells", type: "number", default: 0, group: "tools" },
  { key: "terminal.clearOnShrink", type: "boolean", group: "tools" },
  { key: "terminal.showTerminalProgress", type: "boolean", group: "tools" },
  { key: "markdown.codeBlockIndent", type: "string", group: "tools" },

  // ==================== 技能与启动 ====================
  {
    key: "defaultProjectTrust", type: "select", group: "skills",
    options: [{ value: "ask", label: "ask — 每次询问(推荐)" }, { value: "always", label: "always — 总是信任" }, { value: "never", label: "never — 从不信任" }], default: "ask",
  },
  { key: "enableSkillCommands", type: "boolean", default: true, group: "skills" },
  { key: "quietStartup", type: "boolean", group: "skills" },
  { key: "collapseChangelog", type: "boolean", group: "skills" },
  { key: "enableInstallTelemetry", type: "boolean", group: "skills" },
  { key: "enableAnalytics", type: "boolean", group: "skills" },
  { key: "trackingId", type: "string", group: "skills" },

  // ==================== 界面与终端 ====================
  { key: "theme", type: "string", group: "ui" },
  {
    key: "treeFilterMode", type: "select", group: "ui",
    options: [
      { value: "default", label: "default — 默认" }, { value: "no-tools", label: "no-tools — 不显示工具节点" },
      { value: "user-only", label: "user-only — 只显示用户消息" }, { value: "labeled-only", label: "labeled-only — 只显示有标签的" },
      { value: "all", label: "all — 显示全部" },
    ], default: "default",
  },
  {
    key: "doubleEscapeAction", type: "select", group: "ui",
    options: [{ value: "fork", label: "fork — 分支" }, { value: "tree", label: "tree — 打开会话树" }, { value: "none", label: "none — 无" }], default: "fork",
  },
  { key: "editorPaddingX", type: "number", default: 0, group: "ui" },
  { key: "outputPad", type: "number", default: 0, group: "ui" },
  { key: "autocompleteMaxVisible", type: "number", default: 0, group: "ui" },
  { key: "showHardwareCursor", type: "boolean", group: "ui" },
  { key: "showCacheMissNotices", type: "boolean", group: "ui" },
  { key: "warnings.anthropicExtraUsage", type: "boolean", group: "ui" },

  // ==================== 路径与扩展 ====================
  { key: "sessionDir", type: "string", group: "paths" },
  { key: "lastChangelogVersion", type: "string", group: "paths" },
  { key: "extensions", type: "string[]", group: "paths" },
  { key: "packages", type: "string[]", group: "paths" },
  { key: "skills", type: "string[]", group: "paths" },
  { key: "prompts", type: "string[]", group: "paths" },
  { key: "themes", type: "string[]", group: "paths" },
];

/** .d.ts 的类型字符串 → 中性字段类型(未知/枚举/嵌套一律 json 只读)。 */
function schemaTypeToFieldType(t: string): KernelConfigField["type"] {
  if (t === "boolean") return "boolean";
  if (t === "number") return "number";
  if (t === "string") return "string";
  if (t.endsWith("[]") || t.startsWith("Array<")) return "string[]";
  return "json";
}

/** pi 配置 → 中性 KernelConfigApi。 */
export function createPiConfigApi(
  piSettingsStore: PiSettingsStore,
  opts: { installDir: string | null; homeDir: string },
): KernelConfigApi {
  const resolvePaths = [
    process.cwd(),
    join(opts.homeDir, ".npm-global"),
    "/usr/local/lib",
  ];

  const schema = async (): Promise<KernelConfigField[]> => {
    const out: KernelConfigField[] = [];
    const seen = new Set<string>();
    // 已知字段:用描述表(含 type/options/group,label/description 派生 i18n key)。
    for (const d of PI_FIELD_DESCRIPTORS) {
      seen.add(d.key);
      out.push({
        key: d.key,
        type: d.type === "kv-fixed" ? "kv" : d.type,
        label: labelKey(d.key),
        description: descKey(d.key),
        options: d.options,
        kvKeys: d.kvKeys,
        default: d.default,
        group: groupKey(d.group),
      });
    }
    // 未知字段:.d.ts schema 兜底(底座升级加字段不丢)。
    for (const f of parseSettingsSchema(opts.installDir, resolvePaths)) {
      if (seen.has(f.key)) continue;
      out.push({ key: f.key, type: schemaTypeToFieldType(f.type), group: groupKey("other") });
    }
    return out;
  };

  return {
    get: () => Promise.resolve(piSettingsStore.get()),
    async set(obj) {
      await piSettingsStore.replace(obj);
      return piSettingsStore.get();
    },
    schema,
  };
}
