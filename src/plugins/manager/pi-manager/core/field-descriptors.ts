// pi 底座 settings 字段描述表(方案 D:硬编码全字段 + 未知字段兜底)。
//
// 依据 pi 底座 settings-manager.d.ts 的 Settings 接口(0.80.x)。
// **全字段覆盖**:顶层 43 + 嵌套展平,每项带 label + 说明 + 类型 + 枚举 + 默认。
// settings.json 里有但本表没有的字段 → renderer 降级"未知字段"展示。
// 底座升级加字段:本表没的自动以"未知"出现,说明等后续补。
//
// ⚠ 偏离文档(标注):这些字段写 ~/.pi/agent/settings.json(底座配置,非 ~/.pi-desktop)。

/** 字段类型(决定渲染控件)。 */
export type FieldType = "boolean" | "string" | "number" | "select" | "string[]";

/** 字段描述。 */
export interface FieldDescriptor {
  key: string;
  label: string;
  description: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  default?: unknown;
  group: string;
}

/** 全字段描述表。 */
export const FIELD_DESCRIPTORS: FieldDescriptor[] = [
  // ==================== 模型与推理 ====================
  { key: "defaultProvider", label: "默认 Provider", description: "默认模型供应商 id(如 anthropic、openai,或 models.json 里自定义的 provider key)", type: "string", group: "模型与推理" },
  { key: "defaultModel", label: "默认模型", description: "默认模型 id(provider/model 形式,如 anthropic/claude-sonnet-4-5)", type: "string", group: "模型与推理" },
  {
    key: "defaultThinkingLevel", label: "默认 Thinking", description: "默认思考强度(thinking level),影响推理深度与 token 消耗", type: "select", group: "模型与推理",
    options: [
      { value: "off", label: "off — 关" }, { value: "minimal", label: "minimal — 极简" },
      { value: "low", label: "low — 低" }, { value: "medium", label: "medium — 中(推荐)" },
      { value: "high", label: "high — 高" }, { value: "xhigh", label: "xhigh — 极高" },
    ], default: "medium",
  },
  { key: "enabledModels", label: "模型白名单", description: "逗号分隔 glob(如 anthropic/*, openai/gpt-*),留空=全部可用;非白名单的模型不可选", type: "string[]", group: "模型与推理" },
  { key: "hideThinkingBlock", label: "隐藏思考块", description: "是否在对话界面隐藏 thinking/reasoning 块(仍参与推理,只控制展示)", type: "boolean", group: "模型与推理" },
  {
    key: "thinkingBudgets", label: "Thinking 预算", description: "每档 thinking level 的 token 预算上限(minimal/low/medium/high),0=不限", type: "select", group: "模型与推理",
    options: [{ value: "minimal", label: "minimal 预算" }, { value: "low", label: "low 预算" }, { value: "medium", label: "medium 预算" }, { value: "high", label: "high 预算" }],
  },

  // ==================== 队列与传输 ====================
  {
    key: "steeringMode", label: "Steering 模式", description: "用户中途插入转向消息的方式:all=全部追加到队列、one-at-a-time=一次一条需等待", type: "select", group: "队列与传输",
    options: [{ value: "all", label: "all — 全部插入(推荐)" }, { value: "one-at-a-time", label: "one-at-a-time — 一次一条" }], default: "all",
  },
  {
    key: "followUpMode", label: "Follow-up 模式", description: "连续消息排队方式:all=全部排队、one-at-a-time=一次一条需等待", type: "select", group: "队列与传输",
    options: [{ value: "all", label: "all" }, { value: "one-at-a-time", label: "one-at-a-time" }], default: "all",
  },
  {
    key: "transport", label: "Transport", description: "LLM 请求传输方式:auto=自动选择、sse=流式、http=非流式", type: "select", group: "队列与传输",
    options: [{ value: "auto", label: "auto — 自动(推荐)" }, { value: "sse", label: "sse — 流式" }, { value: "http", label: "http — 非流式" }], default: "auto",
  },
  { key: "httpIdleTimeoutMs", label: "HTTP 空闲超时", description: "HTTP/SSE 连接空闲超时(毫秒),超时自动断开重连;0=用默认值", type: "number", default: 0, group: "队列与传输" },
  { key: "websocketConnectTimeoutMs", label: "WebSocket 连接超时", description: "WebSocket 连接超时(毫秒),0=用默认值", type: "number", default: 0, group: "队列与传输" },
  { key: "httpProxy", label: "HTTP 代理", description: "HTTP/HTTPS 代理地址(如 http://127.0.0.1:7890),空=不走代理", type: "string", group: "队列与传输" },

  // ==================== 压缩与重试 ====================
  { key: "compaction.enabled", label: "自动压缩", description: "开启上下文自动压缩(对话接近 contextWindow 时自动摘要压缩)", type: "boolean", default: true, group: "压缩与重试" },
  { key: "compaction.reserveTokens", label: "压缩 reserve", description: "为模型回复预留的 token 数(压缩后留出空间给新回复)", type: "number", default: 16384, group: "压缩与重试" },
  { key: "compaction.keepRecentTokens", label: "压缩 keep", description: "保留不摘要的最近 token 数(最近 N token 原样保留,更早的才摘要)", type: "number", default: 20000, group: "压缩与重试" },
  { key: "retry.enabled", label: "请求重试", description: "开启 LLM 请求失败自动重试(网络错/5xx/限流)", type: "boolean", default: true, group: "压缩与重试" },
  { key: "retry.maxRetries", label: "重试次数", description: "最大重试次数(超过即放弃)", type: "number", group: "压缩与重试" },
  { key: "retry.baseDelayMs", label: "重试基础延迟", description: "重试基础延迟(毫秒),实际延迟指数增长 base * 2^attempt", type: "number", group: "压缩与重试" },
  { key: "retry.provider.timeoutMs", label: "Provider 超时", description: "单个 provider 级请求超时(毫秒),覆盖全局", type: "number", group: "压缩与重试" },
  { key: "retry.provider.maxRetries", label: "Provider 重试次数", description: "单个 provider 级最大重试次数", type: "number", group: "压缩与重试" },
  { key: "retry.provider.maxRetryDelayMs", label: "Provider 重试延迟", description: "单个 provider 级重试最大延迟(毫秒)", type: "number", group: "压缩与重试" },
  { key: "branchSummary.reserveTokens", label: "分支摘要 reserve", description: "会话树分支跳转时,为摘要预留的 token 数", type: "number", group: "压缩与重试" },
  { key: "branchSummary.skipPrompt", label: "分支摘要跳过提示", description: "分支摘要时是否跳过额外提示词(skipPrompt=true 不加摘要指令)", type: "boolean", group: "压缩与重试" },

  // ==================== 工具与 Shell ====================
  { key: "shellPath", label: "Shell 路径", description: "bash 工具用的 shell 路径(如 /bin/zsh),空=系统默认 shell", type: "string", group: "工具与 Shell" },
  { key: "shellCommandPrefix", label: "Shell 命令前缀", description: "执行 shell 命令时的前缀(如 source venv/bin/activate &&)", type: "string", group: "工具与 Shell" },
  { key: "npmCommand", label: "npm 命令", description: "npm 命令(逗号分隔多参数,如 npx,--yes),空=用 npm", type: "string[]", group: "工具与 Shell" },
  { key: "externalEditor", label: "外部编辑器", description: "外部编辑器命令(如 code --wait),用于编辑长文本时调起", type: "string", group: "工具与 Shell" },
  { key: "images.autoResize", label: "图片自动缩放", description: "自动缩放图片到终端可显示宽度", type: "boolean", group: "工具与 Shell" },
  { key: "images.blockImages", label: "阻止图片", description: "阻止图片显示(不加载图片,省流量)", type: "boolean", group: "工具与 Shell" },
  { key: "terminal.showImages", label: "终端展示图片", description: "终端是否展示图片(需终端支持图片协议)", type: "boolean", default: true, group: "工具与 Shell" },
  { key: "terminal.imageWidthCells", label: "图片宽度(字符)", description: "图片显示宽度(终端字符列数),0=自动", type: "number", default: 0, group: "工具与 Shell" },
  { key: "terminal.clearOnShrink", label: "压缩时清屏", description: "上下文压缩后是否清屏重绘(减少残留)", type: "boolean", group: "工具与 Shell" },
  { key: "terminal.showTerminalProgress", label: "显示终端进度", description: "显示终端工具执行进度条", type: "boolean", group: "工具与 Shell" },
  { key: "markdown.codeBlockIndent", label: "代码块缩进", description: "代码块缩进字符串(如 '  ' 两个空格)", type: "string", group: "工具与 Shell" },

  // ==================== 技能与启动 ====================
  {
    key: "defaultProjectTrust", label: "默认项目信任", description: "打开新项目时的默认信任策略(影响 agent 能否执行项目内命令)", type: "select", group: "技能与启动",
    options: [{ value: "ask", label: "ask — 每次询问(推荐)" }, { value: "always", label: "always — 总是信任" }, { value: "never", label: "never — 从不信任" }], default: "ask",
  },
  { key: "enableSkillCommands", label: "Skill 斜杠命令", description: "启用 skill 的斜杠命令补全(如 /code-review)", type: "boolean", default: true, group: "技能与启动" },
  { key: "quietStartup", label: "安静启动", description: "启动时减少输出(changelog/版本信息等不打)", type: "boolean", group: "技能与启动" },
  { key: "collapseChangelog", label: "折叠 changelog", description: "启动时 changelog 默认折叠(不展开)", type: "boolean", group: "技能与启动" },
  { key: "enableInstallTelemetry", label: "安装遥测", description: "允许安装时收集匿名遥测数据", type: "boolean", group: "技能与启动" },
  { key: "enableAnalytics", label: "使用分析", description: "允许收集匿名使用分析数据", type: "boolean", group: "技能与启动" },
  { key: "trackingId", label: "跟踪 ID", description: "匿名分析用的跟踪 id(自动生成,可清空)", type: "string", group: "技能与启动" },

  // ==================== 界面与终端 ====================
  { key: "theme", label: "终端主题", description: "终端主题 id(底座 TUI 主题,非桌面主题),如 dark/light", type: "string", group: "界面与终端" },
  {
    key: "treeFilterMode", label: "会话树过滤", description: "会话树显示模式:控制哪些节点显示", type: "select", group: "界面与终端",
    options: [
      { value: "default", label: "default — 默认" }, { value: "no-tools", label: "no-tools — 不显示工具节点" },
      { value: "user-only", label: "user-only — 只显示用户消息" }, { value: "labeled-only", label: "labeled-only — 只显示有标签的" },
      { value: "all", label: "all — 显示全部" },
    ], default: "default",
  },
  {
    key: "doubleEscapeAction", label: "双击 Esc 动作", description: "双击 Esc 时的动作:fork 分支、tree 打开会话树、none 无动作", type: "select", group: "界面与终端",
    options: [{ value: "fork", label: "fork — 分支" }, { value: "tree", label: "tree — 打开会话树" }, { value: "none", label: "none — 无" }], default: "fork",
  },
  { key: "editorPaddingX", label: "编辑器左右留白", description: "编辑器左右留白(字符数),0=无留白", type: "number", default: 0, group: "界面与终端" },
  { key: "outputPad", label: "输出留白", description: "输出块上下留白:0=无、1=有", type: "number", default: 0, group: "界面与终端" },
  { key: "autocompleteMaxVisible", label: "补全最大可见", description: "自动补全列表最大可见项数,0=不限", type: "number", default: 0, group: "界面与终端" },
  { key: "showHardwareCursor", label: "硬件光标", description: "使用硬件光标(终端光标渲染)", type: "boolean", group: "界面与终端" },
  { key: "showCacheMissNotices", label: "缓存未命中提示", description: "prompt cache 未命中时显示提示(用于调试缓存命中率)", type: "boolean", group: "界面与终端" },
  { key: "warnings.anthropicExtraUsage", label: "Anthropic 超额告警", description: "Anthropic API 超出额度时显示告警", type: "boolean", group: "界面与终端" },

  // ==================== 路径与扩展 ====================
  { key: "sessionDir", label: "会话目录", description: "会话存储目录(默认 ~/.pi/agent/sessions),空=用默认", type: "string", group: "路径与扩展" },
  { key: "lastChangelogVersion", label: "上次 changelog 版本", description: "已展示 changelog 的底座版本(自动管理,勿手动改)", type: "string", group: "路径与扩展" },
  { key: "extensions", label: "扩展路径", description: "底座扩展路径列表(每行一个路径,如 ~/.pi/extensions/my-ext)", type: "string[]", group: "路径与扩展" },
  { key: "packages", label: "包来源", description: "底座资源包来源(每行一个 npm 包名或 git 路径)", type: "string[]", group: "路径与扩展" },
  { key: "skills", label: "Skill 路径", description: "Skill 目录路径列表(每行一个路径)", type: "string[]", group: "路径与扩展" },
  { key: "prompts", label: "Prompt 路径", description: "Prompt 模板目录路径列表", type: "string[]", group: "路径与扩展" },
  { key: "themes", label: "主题路径", description: "终端主题目录路径列表(底座 TUI 主题,非桌面主题)", type: "string[]", group: "路径与扩展" },
];

/** 按 key 查描述。 */
export const DESCRIPTOR_BY_KEY = new Map(FIELD_DESCRIPTORS.map((f) => [f.key, f]));

/** 按 group 分组(渲染用)。 */
export const FIELD_GROUPS: string[] = [...new Set(FIELD_DESCRIPTORS.map((f) => f.group))];
