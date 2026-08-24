// client/pi —— pi 内核原生配置的中性适配器(kernel 配置 TAB 用)。
//
// 把 pi 的原生形状(~/.pi/agent/settings.json 的扁平 typed schema)翻译成中性 KernelConfigApi:
//   get()    = 读整份 settings.json 出 JSON
//   set()    = 全量替换写回(删除字段随之消失),返回落盘后整份 JSON
//   describe()= 完整自描述(标题 + 说明 + 字段清单,文案字面值内联),壳只做哑渲染。
//
// 「内核自己维护自己的信息」:字段、控件类型、标题、文案全由本适配器自持并一次性吐出,
// 壳(共享表单)不替内核维护任何文案、不做 i18n key 间接。文案的本地化(如需)是内核层的
// 内部事务,不泄漏进壳。
// 依赖只向内:client 只 import core/domain(契约)+ 同层 pi-settings-store。
import { join } from "node:path";
import type { KernelConfigApi, KernelConfigField, KernelConfigDescriptor, PiSettingsApi } from "../../core/domain/context";
import { parseSettingsSchema } from "./pi-settings-store";

/** pi 字段描述类型(自 pi-manager 迁入;kv-fixed 是定键数字映射)。 */
type PiFieldType = "boolean" | "string" | "number" | "select" | "string[]" | "kv-fixed";

/** pi 字段描述(文案字面值内联——内核自持)。 */
interface PiFieldDescriptor {
  key: string;
  type: PiFieldType;
  label: string;
  description: string;
  options?: { value: string; label: string }[];
  kvKeys?: string[];
  default?: unknown;
  /** 分组名(字面值)。 */
  group: string;
}

/** pi 底座 settings 全字段描述表(方案 D:硬编码全字段 + 未知字段兜底)。
 *  依据 pi 底座 settings-manager.d.ts 的 Settings 接口(0.80.x)。settings.json 里有但
 *  本表没有的字段 → 由 .d.ts schema 兜底映射成「json」只读展示。 */
const PI_FIELD_DESCRIPTORS: PiFieldDescriptor[] = [
  // ==================== 模型与推理 ====================
  { key: "defaultProvider", type: "string", label: "默认 Provider", description: "默认模型供应商 id(如 anthropic、openai,或 models.json 里自定义的 provider key)", group: "模型与推理" },
  { key: "defaultModel", type: "string", label: "默认模型", description: "默认模型 id(provider/model 形式,如 anthropic/claude-sonnet-4-5)", group: "模型与推理" },
  {
    key: "defaultThinkingLevel", type: "select", label: "默认 Thinking", description: "默认思考强度(thinking level),影响推理深度与 token 消耗", group: "模型与推理",
    options: [
      { value: "off", label: "off — 关" }, { value: "minimal", label: "minimal — 极简" },
      { value: "low", label: "low — 低" }, { value: "medium", label: "medium — 中(推荐)" },
      { value: "high", label: "high — 高" }, { value: "xhigh", label: "xhigh — 极高" },
    ], default: "medium",
  },
  { key: "enabledModels", type: "string[]", label: "模型白名单", description: "glob 列表(如 anthropic/*, openai/gpt-*),回车添加一条;留空=全部可用,非白名单的模型不可选", group: "模型与推理" },
  { key: "hideThinkingBlock", type: "boolean", label: "隐藏思考块", description: "是否在对话界面隐藏 thinking/reasoning 块(仍参与推理,只控制展示)", group: "模型与推理" },
  { key: "thinkingBudgets", type: "kv-fixed", label: "Thinking 预算", description: "每档 thinking level 的 token 预算上限,留空=不限制", group: "模型与推理", kvKeys: ["minimal", "low", "medium", "high"] },

  // ==================== 队列与传输 ====================
  {
    key: "steeringMode", type: "select", label: "Steering 模式", description: "用户中途插入转向消息的方式:all=全部追加到队列、one-at-a-time=一次一条需等待", group: "队列与传输",
    options: [{ value: "all", label: "all — 全部插入(推荐)" }, { value: "one-at-a-time", label: "one-at-a-time — 一次一条" }], default: "all",
  },
  {
    key: "followUpMode", type: "select", label: "Follow-up 模式", description: "连续消息排队方式:all=全部排队、one-at-a-time=一次一条需等待", group: "队列与传输",
    options: [{ value: "all", label: "all" }, { value: "one-at-a-time", label: "one-at-a-time" }], default: "all",
  },
  {
    key: "transport", type: "select", label: "Transport", description: "LLM 请求传输方式:auto=自动选择、sse=流式、http=非流式", group: "队列与传输",
    options: [{ value: "auto", label: "auto — 自动(推荐)" }, { value: "sse", label: "sse — 流式" }, { value: "http", label: "http — 非流式" }], default: "auto",
  },
  { key: "httpIdleTimeoutMs", type: "number", label: "HTTP 空闲超时", description: "HTTP/SSE 连接空闲超时(毫秒),超时自动断开重连;0=用默认值", default: 0, group: "队列与传输" },
  { key: "websocketConnectTimeoutMs", type: "number", label: "WebSocket 连接超时", description: "WebSocket 连接超时(毫秒),0=用默认值", default: 0, group: "队列与传输" },
  { key: "httpProxy", type: "string", label: "HTTP 代理", description: "HTTP/HTTPS 代理地址(如 http://127.0.0.1:7890),空=不走代理", group: "队列与传输" },

  // ==================== 压缩与重试 ====================
  { key: "compaction.enabled", type: "boolean", label: "自动压缩", description: "开启上下文自动压缩(对话接近 contextWindow 时自动摘要压缩)", default: true, group: "压缩与重试" },
  { key: "compaction.reserveTokens", type: "number", label: "压缩 reserve", description: "为模型回复预留的 token 数(压缩后留出空间给新回复)", default: 16384, group: "压缩与重试" },
  { key: "compaction.keepRecentTokens", type: "number", label: "压缩 keep", description: "保留不摘要的最近 token 数(最近 N token 原样保留,更早的才摘要)", default: 20000, group: "压缩与重试" },
  { key: "retry.enabled", type: "boolean", label: "请求重试", description: "开启 LLM 请求失败自动重试(网络错/5xx/限流)", default: true, group: "压缩与重试" },
  { key: "retry.maxRetries", type: "number", label: "重试次数", description: "最大重试次数(超过即放弃)", group: "压缩与重试" },
  { key: "retry.baseDelayMs", type: "number", label: "重试基础延迟", description: "重试基础延迟(毫秒),实际延迟指数增长 base * 2^attempt", group: "压缩与重试" },
  { key: "retry.provider.timeoutMs", type: "number", label: "Provider 超时", description: "单个 provider 级请求超时(毫秒),覆盖全局", group: "压缩与重试" },
  { key: "retry.provider.maxRetries", type: "number", label: "Provider 重试次数", description: "单个 provider 级最大重试次数", group: "压缩与重试" },
  { key: "retry.provider.maxRetryDelayMs", type: "number", label: "Provider 重试延迟", description: "单个 provider 级重试最大延迟(毫秒)", group: "压缩与重试" },
  { key: "branchSummary.reserveTokens", type: "number", label: "分支摘要 reserve", description: "会话树分支跳转时,为摘要预留的 token 数", group: "压缩与重试" },
  { key: "branchSummary.skipPrompt", type: "boolean", label: "分支摘要跳过提示", description: "分支摘要时是否跳过额外提示词(skipPrompt=true 不加摘要指令)", group: "压缩与重试" },

  // ==================== 工具与 Shell ====================
  { key: "shellPath", type: "string", label: "Shell 路径", description: "bash 工具用的 shell 路径(如 /bin/zsh),空=系统默认 shell", group: "工具与 Shell" },
  { key: "shellCommandPrefix", type: "string", label: "Shell 命令前缀", description: "执行 shell 命令时的前缀(如 source venv/bin/activate &&)", group: "工具与 Shell" },
  { key: "npmCommand", type: "string[]", label: "npm 命令", description: "npm 命令 argv 形式,回车添加一个参数(如先加 npx 再加 --yes);空=用 npm", group: "工具与 Shell" },
  { key: "externalEditor", type: "string", label: "外部编辑器", description: "外部编辑器命令(如 code --wait),用于编辑长文本时调起", group: "工具与 Shell" },
  { key: "images.autoResize", type: "boolean", label: "图片自动缩放", description: "自动缩放图片到终端可显示宽度", group: "工具与 Shell" },
  { key: "images.blockImages", type: "boolean", label: "阻止图片", description: "阻止图片显示(不加载图片,省流量)", group: "工具与 Shell" },
  { key: "terminal.showImages", type: "boolean", label: "终端展示图片", description: "终端是否展示图片(需终端支持图片协议)", default: true, group: "工具与 Shell" },
  { key: "terminal.imageWidthCells", type: "number", label: "图片宽度(字符)", description: "图片显示宽度(终端字符列数),0=自动", default: 0, group: "工具与 Shell" },
  { key: "terminal.clearOnShrink", type: "boolean", label: "压缩时清屏", description: "上下文压缩后是否清屏重绘(减少残留)", group: "工具与 Shell" },
  { key: "terminal.showTerminalProgress", type: "boolean", label: "显示终端进度", description: "显示终端工具执行进度条", group: "工具与 Shell" },
  { key: "markdown.codeBlockIndent", type: "string", label: "代码块缩进", description: "代码块缩进字符串(如 '  ' 两个空格)", group: "工具与 Shell" },

  // ==================== 技能与启动 ====================
  {
    key: "defaultProjectTrust", type: "select", label: "默认项目信任", description: "打开新项目时的默认信任策略(影响 agent 能否执行项目内命令)", group: "技能与启动",
    options: [{ value: "ask", label: "ask — 每次询问(推荐)" }, { value: "always", label: "always — 总是信任" }, { value: "never", label: "never — 从不信任" }], default: "ask",
  },
  { key: "enableSkillCommands", type: "boolean", label: "Skill 斜杠命令", description: "启用 skill 的斜杠命令补全(如 /code-review)", default: true, group: "技能与启动" },
  { key: "quietStartup", type: "boolean", label: "安静启动", description: "启动时减少输出(changelog/版本信息等不打)", group: "技能与启动" },
  { key: "collapseChangelog", type: "boolean", label: "折叠 changelog", description: "启动时 changelog 默认折叠(不展开)", group: "技能与启动" },
  { key: "enableInstallTelemetry", type: "boolean", label: "安装遥测", description: "允许安装时收集匿名遥测数据", group: "技能与启动" },
  { key: "enableAnalytics", type: "boolean", label: "使用分析", description: "允许收集匿名使用分析数据", group: "技能与启动" },
  { key: "trackingId", type: "string", label: "跟踪 ID", description: "匿名分析用的跟踪 id(自动生成,可清空)", group: "技能与启动" },

  // ==================== 界面与终端 ====================
  { key: "theme", type: "string", label: "终端主题", description: "终端主题 id(底座 TUI 主题,非桌面主题),如 dark/light", group: "界面与终端" },
  {
    key: "treeFilterMode", type: "select", label: "会话树过滤", description: "会话树显示模式:控制哪些节点显示", group: "界面与终端",
    options: [
      { value: "default", label: "default — 默认" }, { value: "no-tools", label: "no-tools — 不显示工具节点" },
      { value: "user-only", label: "user-only — 只显示用户消息" }, { value: "labeled-only", label: "labeled-only — 只显示有标签的" },
      { value: "all", label: "all — 显示全部" },
    ], default: "default",
  },
  {
    key: "doubleEscapeAction", type: "select", label: "双击 Esc 动作", description: "双击 Esc 时的动作:fork 分支、tree 打开会话树、none 无动作", group: "界面与终端",
    options: [{ value: "fork", label: "fork — 分支" }, { value: "tree", label: "tree — 打开会话树" }, { value: "none", label: "none — 无" }], default: "fork",
  },
  { key: "editorPaddingX", type: "number", label: "编辑器左右留白", description: "编辑器左右留白(字符数),0=无留白", default: 0, group: "界面与终端" },
  { key: "outputPad", type: "number", label: "输出留白", description: "输出块上下留白:0=无、1=有", default: 0, group: "界面与终端" },
  { key: "autocompleteMaxVisible", type: "number", label: "补全最大可见", description: "自动补全列表最大可见项数,0=不限", default: 0, group: "界面与终端" },
  { key: "showHardwareCursor", type: "boolean", label: "硬件光标", description: "使用硬件光标(终端光标渲染)", group: "界面与终端" },
  { key: "showCacheMissNotices", type: "boolean", label: "缓存未命中提示", description: "prompt cache 未命中时显示提示(用于调试缓存命中率)", group: "界面与终端" },
  { key: "warnings.anthropicExtraUsage", type: "boolean", label: "Anthropic 超额告警", description: "Anthropic API 超出额度时显示告警", group: "界面与终端" },

  // ==================== 路径与扩展 ====================
  { key: "sessionDir", type: "string", label: "会话目录", description: "会话存储目录(默认 ~/.pi/agent/sessions),空=用默认", group: "路径与扩展" },
  { key: "lastChangelogVersion", type: "string", label: "上次 changelog 版本", description: "已展示 changelog 的底座版本(自动管理,勿手动改)", group: "路径与扩展" },
  { key: "extensions", type: "string[]", label: "扩展路径", description: "底座扩展路径列表(如 ~/.pi/extensions/my-ext),回车添加一条", group: "路径与扩展" },
  { key: "packages", type: "string[]", label: "包来源", description: "底座资源包来源(npm 包名或 git 路径),回车添加一条;对象形式 {source, autoload, ...} 在此只读,需直接编辑 settings.json", group: "路径与扩展" },
  { key: "skills", type: "string[]", label: "Skill 路径", description: "Skill 目录路径列表,回车添加一条", group: "路径与扩展" },
  { key: "prompts", type: "string[]", label: "Prompt 路径", description: "Prompt 模板目录路径列表,回车添加一条", group: "路径与扩展" },
  { key: "themes", type: "string[]", label: "主题路径", description: "终端主题目录路径列表(底座 TUI 主题,非桌面主题),回车添加一条", group: "路径与扩展" },
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
  piSettings: PiSettingsApi,
  opts: { installDir: string | null; homeDir: string },
): KernelConfigApi {
  const resolvePaths = [
    process.cwd(),
    join(opts.homeDir, ".npm-global"),
    "/usr/local/lib",
  ];

  const describe = async (): Promise<KernelConfigDescriptor> => {
    const fields: KernelConfigField[] = [];
    const seen = new Set<string>();
    // 已知字段:用描述表(含 type/options/group,label/description 字面值)。
    for (const d of PI_FIELD_DESCRIPTORS) {
      seen.add(d.key);
      fields.push({
        key: d.key,
        type: d.type === "kv-fixed" ? "kv" : d.type,
        label: d.label,
        description: d.description,
        options: d.options,
        kvKeys: d.kvKeys,
        default: d.default,
        group: d.group,
      });
    }
    // 未知字段:.d.ts schema 兜底(底座升级加字段不丢)。
    for (const f of parseSettingsSchema(opts.installDir, resolvePaths)) {
      if (seen.has(f.key)) continue;
      fields.push({ key: f.key, type: schemaTypeToFieldType(f.type), group: "其他" });
    }
    return {
      title: "Pi 配置",
      description: "编辑 pi 底座配置(~/.pi/agent/settings.json)。常用项有说明,其余字段自动展示(底座升级新字段不丢)。",
      fields,
    };
  };

  return {
    get: () => Promise.resolve(piSettings.get()),
    async set(obj) {
      await piSettings.replace(obj);
      return piSettings.get();
    },
    describe,
  };
}
