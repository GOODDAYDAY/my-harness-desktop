// pi 底座 settings 字段描述表(方案 D:硬编码 24 项 + 未知字段兜底)。
//
// 依据 pi 底座 0.80.7 settings-manager.d.ts 的 Settings 接口。
// 常用 24 项硬编码:label + 说明 + 类型 + 枚举选项 + 默认值(预设说明)。
// settings.json 里有但本表没有的字段 → renderer 降级"未知字段"展示(不丢)。
// 底座升级加字段:本表没的自动以"未知"出现,说明等后续补。
//
// ⚠ 偏离文档(标注):这些字段写 ~/.pi/agent/settings.json(底座配置,非 ~/.pi-desktop)。
// 文档说壳不替底座管配置,但 settings.json 是底座标准契约,写标准字段不算重复领域知识。

/** 字段类型(决定渲染控件)。 */
export type FieldType = "boolean" | "string" | "number" | "select" | "string[]";

/** 字段描述。 */
export interface FieldDescriptor {
  /** settings.json 的 key(嵌套用点路径,如 compaction.enabled) */
  key: string;
  /** 显示名 */
  label: string;
  /** 说明文案(预设) */
  description: string;
  /** 控件类型 */
  type: FieldType;
  /** select 类型的枚举选项 */
  options?: { value: string; label: string }[];
  /** 默认值(底座默认,展示用) */
  default?: unknown;
  /** 分组(渲染时分块) */
  group: string;
}

/** 24 项常用字段描述(按底座 Settings 接口)。 */
export const FIELD_DESCRIPTORS: FieldDescriptor[] = [
  // 模型与推理
  { key: "defaultProvider", label: "默认 Provider", description: "默认模型供应商(如 anthropic/openai)", type: "string", group: "模型与推理" },
  { key: "defaultModel", label: "默认模型", description: "默认模型 id(provider/model 形式)", type: "string", group: "模型与推理" },
  {
    key: "defaultThinkingLevel", label: "默认 Thinking", description: "默认思考强度", type: "select", group: "模型与推理",
    options: [
      { value: "off", label: "关" }, { value: "minimal", label: "极简" },
      { value: "low", label: "低" }, { value: "medium", label: "中" },
      { value: "high", label: "高" }, { value: "xhigh", label: "极高" },
    ], default: "medium",
  },
  { key: "enabledModels", label: "模型白名单", description: "逗号分隔 glob(如 anthropic/*, openai/gpt-*),留空=全部", type: "string[]", group: "模型与推理" },
  { key: "hideThinkingBlock", label: "隐藏思考块", description: "是否隐藏思考块展示", type: "boolean", group: "模型与推理" },

  // 队列与传输
  {
    key: "steeringMode", label: "Steering 模式", description: "转向消息插入方式", type: "select", group: "队列与传输",
    options: [{ value: "all", label: "all — 全部插入" }, { value: "one-at-a-time", label: "one-at-a-time" }], default: "all",
  },
  {
    key: "followUpMode", label: "Follow-up 模式", description: "后续消息排队方式", type: "select", group: "队列与传输",
    options: [{ value: "all", label: "all" }, { value: "one-at-a-time", label: "one-at-a-time" }], default: "all",
  },
  {
    key: "transport", label: "Transport", description: "LLM 请求传输方式", type: "select", group: "队列与传输",
    options: [{ value: "auto", label: "auto" }, { value: "sse", label: "sse" }, { value: "http", label: "http" }], default: "auto",
  },
  { key: "httpIdleTimeoutMs", label: "HTTP 空闲超时", description: "HTTP 空闲超时(毫秒)", type: "number", default: 0, group: "队列与传输" },

  // 压缩与重试
  { key: "compaction.enabled", label: "自动压缩", description: "开启上下文自动压缩", type: "boolean", default: true, group: "压缩与重试" },
  { key: "compaction.reserveTokens", label: "压缩 reserve", description: "为回复预留的 token 数", type: "number", default: 16384, group: "压缩与重试" },
  { key: "compaction.keepRecentTokens", label: "压缩 keep", description: "保留不摘要的最近 token", type: "number", default: 20000, group: "压缩与重试" },
  { key: "retry.enabled", label: "请求重试", description: "开启请求失败重试", type: "boolean", default: true, group: "压缩与重试" },
  { key: "retry.maxRetries", label: "重试次数", description: "最大重试次数", type: "number", group: "压缩与重试" },
  { key: "retry.baseDelayMs", label: "重试基础延迟", description: "重试基础延迟(毫秒)", type: "number", group: "压缩与重试" },

  // 工具与 Shell
  { key: "shellPath", label: "Shell 路径", description: "bash 工具用的 shell 路径(空=系统默认)", type: "string", group: "工具与 Shell" },
  { key: "shellCommandPrefix", label: "Shell 命令前缀", description: "shell 命令前缀", type: "string", group: "工具与 Shell" },
  { key: "npmCommand", label: "npm 命令", description: "npm 命令(逗号分隔多参数)", type: "string[]", group: "工具与 Shell" },
  { key: "images.autoResize", label: "图片自动缩放", description: "自动缩放图片", type: "boolean", group: "工具与 Shell" },
  { key: "terminal.showImages", label: "展示图片", description: "终端展示图片", type: "boolean", default: true, group: "工具与 Shell" },
  { key: "images.blockImages", label: "阻止图片", description: "阻止图片显示", type: "boolean", group: "工具与 Shell" },

  // 技能与启动
  {
    key: "defaultProjectTrust", label: "默认项目信任", description: "打开新项目时的默认信任策略", type: "select", group: "技能与启动",
    options: [{ value: "ask", label: "ask — 每次询问" }, { value: "always", label: "always — 总是信任" }, { value: "never", label: "never — 从不信任" }], default: "ask",
  },
  { key: "enableSkillCommands", label: "Skill 斜杠命令", description: "启用 skill 斜杠命令", type: "boolean", default: true, group: "技能与启动" },
  { key: "quietStartup", label: "安静启动", description: "安静启动(减少启动输出)", type: "boolean", group: "技能与启动" },
];

/** 按 key 查描述。 */
export const DESCRIPTOR_BY_KEY = new Map(FIELD_DESCRIPTORS.map((f) => [f.key, f]));

/** 按 group 分组(渲染用)。 */
export const FIELD_GROUPS: string[] = [...new Set(FIELD_DESCRIPTORS.map((f) => f.group))];
